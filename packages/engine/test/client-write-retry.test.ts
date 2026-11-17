// Proves: A write the daemon does not deduplicate is sent again after a 5xx or a lost response; or a deduplicated write is retried with a new key on each attempt.
// Red when: The transport retries a mutating call the contract does not mark as replay-safe, or it makes the Idempotency-Key inside the attempt loop.

import { expect, test } from 'bun:test';
import { createOperatorRemoteClient } from '../operator-client/src/client-core.js';
import { createHttpTransport, type HttpRetryPolicy } from '../transport-http/src/index.js';
import { getOperatorContract } from '../contracts/src/index.js';

interface Arrival { readonly method: string; readonly path: string; readonly key: string | null }

/** The network at the fetch seam: records what reached the wire and answers from a script, one entry per attempt. */
function daemon(script: ReadonlyArray<'503' | 'lost' | 'ok'>) {
  const arrivals: Arrival[] = [];
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    arrivals.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, key: headers.get('Idempotency-Key') });
    const step = script[arrivals.length - 1] ?? 'ok';
    if (step === 'lost') throw new TypeError('fetch failed: connection reset');
    return new Response(step === '503' ? '{"error":"unavailable"}' : '{}', { status: step === '503' ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
  }, { preconnect: () => {} });
  return { fetch, arrivals };
}

function client(fetch: typeof globalThis.fetch, retry?: HttpRetryPolicy) {
  const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:3210', fetch, ...(retry ? { retry } : {}) });
  return createOperatorRemoteClient(transport, getOperatorContract(), { validateResponses: false });
}

test('a session message the daemon cannot recognise as a repeat is sent once after a 503; a read under the same transport is retried', async () => {
  const retry: HttpRetryPolicy = { maxAttempts: 3, retryOnMethods: ['GET', 'POST'], baseDelayMs: 1, maxDelayMs: 1 };
  const write = daemon(['503', 'ok']);
  await expect(client(write.fetch, retry).sessions.messages.create('s-1', { body: 'hello' })).rejects.toThrow();
  expect(write.arrivals.map((arrival) => arrival.method)).toEqual(['POST']);

  const read = daemon(['503', 'ok']);
  await client(read.fetch, retry).sessions.list();
  expect(read.arrivals.map((arrival) => arrival.method)).toEqual(['GET', 'GET']);
});

test('a contract start retried after a lost response carries the same key on every attempt', async () => {
  const start = daemon(['lost', 'ok']);
  await client(start.fetch).invoke('contracts.start', { ask: 'Add a parser for every documented input form.' });
  expect(start.arrivals).toHaveLength(2);
  expect(start.arrivals[0]!.key).toBeTruthy();
  expect(start.arrivals[1]!.key).toBe(start.arrivals[0]!.key);
});
