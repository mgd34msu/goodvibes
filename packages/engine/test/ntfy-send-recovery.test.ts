/**
 * What an ntfy client does when the network lets it down: a failed publish can
 * be sent again, a silent stream is replaced, and a WebSocket subscription
 * carries the account's credentials.
 */
import { describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NtfyIntegration, ntfyOutboundDedup } from '../platform/src/platform/integrations/ntfy.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 10_000) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ntfy publish after a failed send', () => {
  test('sends the same body again instead of treating it as a duplicate, and still suppresses a real duplicate', async () => {
    const received: string[] = [];
    let failNext = true;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        received.push(body);
        if (failNext) { failNext = false; res.writeHead(503).end('down'); return; }
        res.writeHead(200).end();
      });
    });
    try {
      const ntfy = new NtfyIntegration(await listen(server));
      const body = `approval needed ${received.length}-${Math.random()}`;
      await expect(ntfy.publish('t', body)).rejects.toThrow('503');
      await ntfy.publish('t', body);
      expect(received).toEqual([body, body]);
      // Delivered now: an immediate identical publish is the duplicate the guard exists for.
      await ntfy.publish('t', body);
      expect(received).toEqual([body, body]);
    } finally {
      await close(server);
      ntfyOutboundDedup.reset();
    }
  });
});

describe('ntfy subscribeJsonStream on a connection that goes silent', () => {
  test('reconnects instead of waiting for ever', async () => {
    let connections = 0;
    const server = createServer((req, res) => {
      connections += 1;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ event: 'open', topic: 'quiet' }) + '\n');
      req.socket.on('error', () => {});
    });
    const abort = new AbortController();
    const reconnects: unknown[] = [];
    try {
      const ntfy = new NtfyIntegration(await listen(server));
      const run = ntfy.subscribeJsonStream('quiet', () => {}, {
        signal: abort.signal,
        idleTimeoutMs: 40,
        reconnectDelayMs: 5,
        onReconnect: (error) => { reconnects.push(error); },
      });
      await waitFor(() => connections >= 2, 'a second connection');
      expect(reconnects.length).toBeGreaterThanOrEqual(1);
      expect(String((reconnects[0] as Error).message)).toContain('received nothing');
      abort.abort();
      await run;
    } finally {
      abort.abort();
      await close(server);
    }
  });
});

describe('ntfy connectWebSocket', () => {
  test('passes the token as the auth query parameter, and omits it without a token', () => {
    const urls: string[] = [];
    class FakeSocket {
      constructor(url: string) { urls.push(url); }
      addEventListener(): void {}
    }
    const impl = FakeSocket as unknown as typeof WebSocket;
    new NtfyIntegration('https://ntfy.example', 'tk_secret').connectWebSocket('alerts', () => {}, { WebSocketImpl: impl });
    new NtfyIntegration('https://ntfy.example').connectWebSocket('alerts', () => {}, { WebSocketImpl: impl });
    const withAuth = new URL(urls[0]!);
    expect(withAuth.protocol).toBe('wss:');
    expect(Buffer.from(withAuth.searchParams.get('auth')!, 'base64url').toString()).toBe('Bearer tk_secret');
    expect(new URL(urls[1]!).searchParams.has('auth')).toBe(false);
  });
});
