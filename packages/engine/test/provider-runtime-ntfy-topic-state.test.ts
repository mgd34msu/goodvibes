/**
 * ntfy topics share one status, so what one topic reports must survive what
 * another topic does next.
 */
import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelProviderRuntimeManager } from '../platform/src/platform/channels/provider-runtime.js';

function manager(baseUrl: string, resolveSecret: () => Promise<string | null> = async () => null): ChannelProviderRuntimeManager {
  return new ChannelProviderRuntimeManager({
    configManager: { get: (key: string) => (key === 'surfaces.ntfy.baseUrl' ? baseUrl : '') },
    serviceRegistry: { resolveSecret },
    buildSurfaceAdapterContext: () => ({}),
  } as unknown as ConstructorParameters<typeof ChannelProviderRuntimeManager>[0]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ntfy provider runtime: per-topic state', () => {
  test('a topic the server refuses stays reported after another topic starts', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/refused/')) { res.writeHead(403).end('forbidden'); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ event: 'open', topic: 'working' }) + '\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const runtime = manager(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      await runtime.startNtfyTopic('refused');
      await waitFor(() => runtime.runningNtfyTopics().length === 0, 'the refused topic ending');
      await runtime.startNtfyTopic('working');
      const status = runtime.status('ntfy');
      expect(status.running).toBe(true);
      expect(status.lastError).toContain('refused');
      expect(status.lastError).toContain('403');
      runtime.stopNtfyTopic('refused');
      expect(runtime.status('ntfy').lastError).toBeUndefined();
    } finally {
      runtime.stop('ntfy');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a token that cannot be resolved does not leave the topic marked as running', async () => {
    const runtime = manager('http://127.0.0.1:9', async () => { throw new Error('secret store locked'); });
    const result = await runtime.startNtfyTopic('agent');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('secret store locked');
    expect(runtime.runningNtfyTopics()).toEqual([]);
    expect(runtime.status('ntfy').lastError).toContain('secret store locked');
  });
});
