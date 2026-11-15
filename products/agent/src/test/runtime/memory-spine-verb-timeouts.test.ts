/**
 * memory-spine-verb-timeouts.test.ts
 *
 * One short abort timeout used to cover every memory verb, so a bundle export
 * against any non-trivial store was cut off and reported as a daemon failure.
 * Ordinary verbs keep the short bound; bundle, doctor, vector-stats and
 * semantic-search verbs get a long one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemorySpineRestTransport } from '../../runtime/memory-spine-rest-transport.ts';

describe('memory spine wire: per-verb timeouts', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => { server!.closeAllConnections(); server!.close(() => resolve()); });
    server = null;
  });

  test('an ordinary verb is aborted by the short bound while a bundle export outlives it', async () => {
    const held: ServerResponse[] = [];
    let exportArrived: () => void = () => {};
    const exportRequest = new Promise<void>((resolve) => { exportArrived = resolve; });
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      if (request.url?.includes('/export')) {
        held.push(response);
        exportArrived();
        return;
      }
      // Ordinary verbs are never answered.
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transport = createMemorySpineRestTransport({
      resolveConnection: () => ({ baseUrl, token: 'token' }),
      timeoutMs: 1,
      longTimeoutMs: 60_000,
    });

    // Started first: its 1ms-class timer, had it been applied, would fire
    // before the one the ordinary verb below is aborted by.
    const exported = transport.exportBundle!({});
    await exportRequest;
    await expect(transport.get('m-1')).rejects.toThrow();

    for (const response of held) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ bundle: { version: 1, records: [], links: [] } }));
    }
    const bundle = await exported;
    expect(bundle).toBeDefined();
  });
});
