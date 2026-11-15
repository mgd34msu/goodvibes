/**
 * One ntfy message the daemon cannot process must not take its topic down.
 *
 * ntfy replays from the last message this node finished, so a message whose
 * handler fails comes straight back on the reconnect. Retrying it a few times
 * is right (the failure may be transient); retrying it for as long as the
 * server caches it is a dead topic. And the stream that delivered it has to be
 * closed when it fails, or it keeps feeding messages behind the reconnect.
 */
import { describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GOODVIBES_NTFY_REMOTE_TOPIC, NtfyIntegration, type NtfyMessage } from '../platform/src/platform/integrations/ntfy.js';
import { ChannelProviderRuntimeManager } from '../platform/src/platform/channels/provider-runtime.js';
import { ChannelIngressAlarm } from '../platform/src/platform/channels/ingress-alarm.js';
import type { SurfaceAdapterContext } from '../platform/src/platform/adapters/types.js';

interface TopicServer {
  readonly baseUrl: string;
  readonly openConnections: () => number;
  readonly requests: string[];
  close(): Promise<void>;
}

/** An ntfy server that honours `since=<id>` and holds every stream open. */
async function serveTopic(topic: string, messages: readonly Record<string, unknown>[]): Promise<TopicServer> {
  const open = new Set<ServerResponse>();
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' || !req.url?.includes('/json')) { res.writeHead(404).end(); return; }
    requests.push(req.url);
    const since = new URL(req.url, 'http://local').searchParams.get('since');
    const start = messages.findIndex((message) => message.id === since);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    open.add(res);
    // The socket, not the response: Bun's server does not emit `close` on a
    // response whose client hung up.
    req.socket.on('close', () => { open.delete(res); });
    res.write(JSON.stringify({ event: 'open', topic }) + '\n');
    for (const message of messages.slice(start + 1)) res.write(JSON.stringify(message) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    openConnections: () => open.size,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function waitFor(predicate: () => boolean, label: string, ceilingMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ceilingMs) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function message(id: string, topic: string, body: string): Record<string, unknown> {
  return { id, time: 1_700_000_000, event: 'message', topic, message: body };
}

describe('ntfy: a message whose handler fails', () => {
  test('closes the stream that delivered it, so nothing behind it is read twice', async () => {
    const topic = 'gv-close-on-fail';
    const run = `${Date.now()}`;
    const server = await serveTopic(topic, [
      message(`a-${run}`, topic, 'first'),
      message(`b-${run}`, topic, 'second'),
      message(`c-${run}`, topic, 'third'),
    ]);
    const seen: string[] = [];
    let failuresLeft = 1;
    const abort = new AbortController();
    try {
      const subscription = new NtfyIntegration(server.baseUrl).subscribeJsonStream(topic, async (incoming: NtfyMessage) => {
        if (incoming.event !== 'message') return;
        seen.push(String(incoming.message));
        if (incoming.message === 'second' && failuresLeft > 0) { failuresLeft -= 1; throw new Error('handler failed'); }
      }, { signal: abort.signal, reconnectDelayMs: 20 });
      await waitFor(() => seen.filter((body) => body === 'third').length >= 1, 'the third message');
      // The failed stream must not also deliver the third message: it would
      // arrive before the replayed second one, so the order is the proof.
      expect(seen).toEqual(['first', 'second', 'second', 'third']);
      await waitFor(() => server.openConnections() === 1, 'the failed stream closing');
      abort.abort();
      await subscription;
      await waitFor(() => server.openConnections() === 0, 'the stream closing on abort');
    } finally {
      abort.abort();
      await server.close();
    }
  }, 20_000);

  test('the provider runtime retries it a bounded number of times, then reports it and moves on', async () => {
    const topic = GOODVIBES_NTFY_REMOTE_TOPIC;
    const run = `${Date.now()}`;
    const server = await serveTopic(topic, [
      message(`p1-${run}`, topic, 'before'),
      message(`p2-${run}`, topic, 'poison'),
      message(`p3-${run}`, topic, 'after'),
    ]);
    const posted: string[] = [];
    const alarms: string[] = [];
    const alarm = new ChannelIngressAlarm({ notify: (_surface, text) => { alarms.push(text); } });
    const context = {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: () => '' },
      authorizeSurfaceIngress: async () => ({ allowed: true }),
      postNtfyRemoteChatMessage: async (input: { body: string }) => {
        posted.push(input.body);
        if (input.body === 'poison') throw new Error('remote chat is down');
        return {};
      },
    } as unknown as SurfaceAdapterContext;
    const manager = new ChannelProviderRuntimeManager({
      configManager: {
        get: (key: string) => (key === 'surfaces.ntfy.baseUrl' ? server.baseUrl : ''),
      },
      serviceRegistry: { resolveSecret: async () => null },
      buildSurfaceAdapterContext: () => context,
      ingressAlarm: alarm,
    } as unknown as ConstructorParameters<typeof ChannelProviderRuntimeManager>[0]);
    try {
      await manager.startNtfyTopic(topic, { replayFromMs: 1 });
      await waitFor(() => posted.includes('after'), 'the message behind the failing one', 15_000);
      // The recovery notice is sent once the message behind the poison went through.
      await waitFor(() => alarms.length >= 2, 'the topic-moving-again notice');
      const poisonAttempts = posted.filter((body) => body === 'poison').length;
      expect(poisonAttempts).toBeGreaterThan(1);
      expect(poisonAttempts).toBeLessThanOrEqual(5);
      expect(posted.filter((body) => body === 'before')).toHaveLength(1);
      expect(posted.filter((body) => body === 'after')).toHaveLength(1);
      // Told once that it was skipped, then once that the topic is moving again.
      expect(alarms).toHaveLength(2);
      expect(alarms[0]).toContain('remote chat is down');
      expect(manager.runningNtfyTopics()).toEqual([topic]);
      expect(server.openConnections()).toBe(1);
    } finally {
      manager.stopNtfyTopic(topic);
      await server.close();
    }
  }, 30_000);
});
