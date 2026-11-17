// Proves: A notification or an inbound chat message is lost.
// Red when: Dead letters live in memory only or a resend does not remove its row, a Socket Mode envelope is acknowledged before it was taken, or ntfy suppresses a repeat by its text.
// Proves: A notification that could not be sent is lost when a resend of it fails again.
// Red when: A resend that fails again drops the dead letter (or duplicates it). notification-message-loss.test.ts only ever resends successfully; add the failing resend to its restart case (the list and its file still hold the one entry).
/**
 * Notifications and inbound chat messages are not lost: a failed notification
 * outlives a restart and can be resent, a Slack Socket Mode envelope is only
 * acknowledged once it was taken, and ntfy suppresses repeats by what they
 * announce, not by their words.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { Notifier } from '../platform/src/platform/integrations/notifier.ts';
import { SlackSocketModeClient, type SlackIntegration } from '../platform/src/platform/integrations/slack.ts';
import { NtfyIntegration, ntfyOutboundDedup } from '../platform/src/platform/integrations/ntfy.ts';
import { DeliveryError, DeliveryQueue } from '../platform/src/platform/integrations/delivery.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  ntfyOutboundDedup.reset();
});

const terminal = () => new DeliveryError('synthetic terminal failure', 'terminal');
/** A delivery queue holding one dead letter. */
async function seeded() {
  const queue = new DeliveryQueue();
  await queue.enqueue('fixture', 'retained', 'original synthetic payload', async () => { throw terminal(); });
  return queue;
}

describe('failed notifications', () => {
  test('survive a restart and are delivered by a resend, which empties the list and its file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-dead-letters-'));
    dirs.push(dir);
    const file = join(dir, 'dead-letters.json');
    const refusing = { postWebhook: async () => { throw new HttpStatusError('HTTP 404: webhook revoked', { status: 404 }); } } as unknown as SlackIntegration;
    const before = new Notifier({ slack: refusing });
    before.persistDeadLetters(file);
    await expect(before.notify('AGENT_COMPLETED', { summary: 'done' })).rejects.toThrow();
    expect(before.listDeadLetters()).toHaveLength(1);
    await before.close();

    const sent: string[] = [];
    const working = { postWebhook: async (text: string) => { sent.push(text); } } as unknown as SlackIntegration;
    const after = new Notifier({ slack: working });
    after.persistDeadLetters(file);
    try {
      const [entry] = after.listDeadLetters();
      expect(entry).toMatchObject({ channel: 'slack', event: 'AGENT_COMPLETED', status: 404 });
      expect(await after.replayDeadLetters([entry!.id, 'slack:missing'])).toEqual([
        { id: entry!.id, outcome: 'delivered' },
        { id: 'slack:missing', outcome: 'not-found' },
      ]);
      expect(sent).toHaveLength(1);
      expect(after.listDeadLetters()).toHaveLength(0);
      expect((JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(0);
    } finally {
      await after.close();
    }
  });

  test('a replay that fails again leaves one row, not two', async () => {
    const queue = await seeded();
    try {
      const result = await queue.replay(async () => { throw terminal(); });
      expect(result.map((entry) => entry.outcome)).toEqual(['dead_letter']);
      expect(queue.getDlq().map((entry) => entry.payload)).toEqual(['original synthetic payload']);
    } finally { await queue.close(); }
  });
});

class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.emit('open', {}));
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close(): void { this.readyState = 3; }
  emit(type: string, event: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn(event); }
}

describe('Slack Socket Mode acknowledgement', () => {
  test('is sent after the envelope was taken, and withheld when taking it failed so Slack delivers it again', async () => {
    const order: string[] = [];
    let fail = false;
    const client = new SlackSocketModeClient({
      appToken: 'xapp',
      integration: { appsConnectionsOpen: async () => ({ ok: true, url: 'wss://slack.test' }) } as unknown as SlackIntegration,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      // The acknowledgement deadline never fires here: the order is what is measured.
      setTimer: () => () => {},
      onEnvelope: async (envelope) => {
        order.push(`handled ${envelope.envelope_id}`);
        if (fail) throw new Error('the session could not take it');
      },
    });
    await client.start();
    const socket = FakeSocket.last;
    const deliver = async (id: string): Promise<void> => {
      socket.emit('message', { data: JSON.stringify({ envelope_id: id, type: 'events_api', payload: {} }) });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    await deliver('e1');
    fail = true;
    await deliver('e2');
    expect(order).toEqual(['handled e1', 'handled e2']);
    expect(socket.sent).toEqual([{ envelope_id: 'e1' }]);
    client.stop();
  });
});

describe('ntfy repeat suppression', () => {
  test('is by announced identity: different identities with the same words are both sent, a repeat is suppressed and says so', async () => {
    const received: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => { received.push(body); res.writeHead(200).end('{}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const ntfy = new NtfyIntegration(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await ntfy.publish('t', 'Done.', { announces: 'agent:a1:final:1' })).toBe('sent');
      expect(await ntfy.publish('t', 'Done.', { announces: 'agent:a2:final:1' })).toBe('sent');
      expect(await ntfy.publish('t', 'Done, again.', { announces: 'agent:a1:final:1' })).toBe('suppressed');
      expect(received).toEqual(['Done.', 'Done.']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
