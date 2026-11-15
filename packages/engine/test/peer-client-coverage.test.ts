/**
 * Coverage backfill for packages/peer-client/src/client-core.ts and client.ts
 *
 * Targets:
 * - client-core.ts: listOperations, getOperation (including throw for unknown), invoke generic
 * - client.ts: createPeerApiClient (covered by existing peer-client.test.ts, but adding missing paths)
 */
import { describe, expect, test } from 'bun:test';
import { createPeerApiClient } from '../peer-client/src/index.js';
import { createPeerRemoteClient } from '../peer-client/src/client-core.js';
import { createHttpTransport } from '../transport-http/src/index.js';
import { getPeerContract } from '../contracts/src/index.js';
import { GoodVibesError } from '../errors/src/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Bun's `typeof fetch` carries a `preconnect` namespace member alongside the
 * call signature (bun-types globals.d.ts). A plain replacement function has
 * only the call signature, so it needs `preconnect` attached before it can
 * stand in wherever `typeof fetch` is required.
 */
function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

function makeTransport(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createHttpTransport({
    baseUrl: 'http://127.0.0.1:3210',
    fetch: stubFetch(fetch),
  });
}

describe('createPeerRemoteClient: listOperations / getOperation', () => {
  test('listOperations returns all endpoints from contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const endpoints = client.listOperations();
    expect(endpoints).toBeInstanceOf(Array);
    expect(endpoints).toHaveLength(contract.endpoints.length);
    expect(endpoints.some((e) => e.id === 'pair.request')).toBe(true);
  });

  test('getOperation returns the matching endpoint contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const endpoint = client.getOperation('pair.request');
    expect(endpoint.id).toBe('pair.request');
  });

  test('getOperation throws GoodVibesError for unknown endpoint id', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    expect(() => client.getOperation('does.not.exist')).toThrow(GoodVibesError);
    expect(() => client.getOperation('does.not.exist')).toThrow(/Unknown peer endpoint/);
  });

  test('response validation rejects unsupported peer response shapes', async () => {
    const transport = makeTransport(async () => createJsonResponse({ requestId: 'pair-1' }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    await expect(client.invoke('pair.request', { peerId: 'node-a', label: 'runner' })).rejects.toThrow(/Response validation failed/);
  });

  test('transport and contract are exposed as properties', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    expect(client.transport).toBe(transport);
    expect(client.contract).toBe(contract);
  });
});

describe('createPeerRemoteClient: invoke generic overload', () => {
  test('invoke with a valid endpoint id calls the transport', async () => {
    const calls: string[] = [];
    const transport = makeTransport(async (input, _init) => {
      calls.push(String(input));
      return createJsonResponse({ requestId: 'pair-1' });
    });
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const result = await client.invoke('pair.request', { peerId: 'node-a', label: 'runner' });
    expect(result).toMatchObject({ requestId: 'pair-1' });
    expect(calls).toHaveLength(1);
  });

  test('invoke rejects for unknown endpoint id', async () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    // The failure arrives on the returned promise, not as a synchronous throw.
    await expect(client.invoke('unknown.endpoint' as never)).rejects.toBeInstanceOf(GoodVibesError);
  });
});

describe('createPeerRemoteClient: shorthand methods', () => {
  test('pairing.verify calls the verify endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const platformClient = createPeerApiClient({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: stubFetch(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return createJsonResponse({ verified: true });
      }),
    });
    const result = await platformClient.pairing.verify({ requestId: 'pair-1', challenge: '123456' });
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3210/api/remote/pair/verify', method: 'POST' }]);
    expect(result).toMatchObject({ verified: true });
  });

  test('peer.heartbeat calls the heartbeat endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const platformClient = createPeerApiClient({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: stubFetch(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return createJsonResponse({ ok: true });
      }),
    });
    const result = await platformClient.peer.heartbeat({ peerId: 'node-a' });
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3210/api/remote/heartbeat', method: 'POST' }]);
    expect(result).toMatchObject({ ok: true });
  });

  test('work.pull calls the pull endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const platformClient = createPeerApiClient({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: stubFetch(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return createJsonResponse({ work: null });
      }),
    });
    const result = await platformClient.work.pull({ peerId: 'node-a' });
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3210/api/remote/work/pull', method: 'POST' }]);
    expect(result).toMatchObject({ work: null });
  });

  test('operator.snapshot calls the operator snapshot endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const platformClient = createPeerApiClient({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: stubFetch(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return createJsonResponse({ snapshot: {} });
      }),
    });
    const result = await platformClient.operator.snapshot();
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3210/api/remote', method: 'GET' }]);
    expect(result).toMatchObject({ snapshot: {} });
  });
});

describe('createPeerApiClient: getOperation is accessible', () => {
  test('getOperation returns endpoint contract from PeerApiClient', () => {
    const platformClient = createPeerApiClient({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: stubFetch(async () => createJsonResponse({ ok: true })),
    });
    const endpoint = platformClient.getOperation('pair.request');
    expect(endpoint.id).toBe('pair.request');
  });
});
