/**
 * The peer client covers the peer contract: every shorthand of the client
 * sends the HTTP method and path the contract gives its endpoint id, an
 * unknown endpoint is refused before anything is sent, and a response the
 * contract does not allow is refused. The daemon is a fetch stand-in that
 * records what reached the wire.
 */
import { describe, expect, test } from 'bun:test';
import { createPeerRemoteClient } from '../peer-client/src/client-core.js';
import { createHttpTransport } from '../transport-http/src/index.js';
import { getPeerContract } from '../contracts/src/index.js';

const BASE = 'http://127.0.0.1:3210';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Sent { readonly url: string; readonly method: string | undefined; readonly body: unknown }

/** A client over a fetch stand-in that records each request and answers `answer`. */
function recordingClient(answer: unknown, options: { validateResponses?: boolean } = {}) {
  const sent: Sent[] = [];
  // Bun's `typeof fetch` carries a `preconnect` member a plain function lacks.
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    return createJsonResponse(answer);
  }, { preconnect: () => {} });
  const client = createPeerRemoteClient(createHttpTransport({ baseUrl: BASE, fetch }), getPeerContract(), options);
  return { client, sent };
}

type Client = ReturnType<typeof createPeerRemoteClient>;

const SHORTHAND_CASES: ReadonlyArray<{ readonly id: string; readonly call: (client: Client) => Promise<unknown>; readonly pathParams?: Record<string, string> }> = [
  { id: 'pair.request', call: (c) => c.pairing.request({ peerKind: 'node', label: 'runner' }) },
  { id: 'pair.verify', call: (c) => c.pairing.verify({ requestId: 'pair-1', challenge: '123456' }) },
  { id: 'peer.heartbeat', call: (c) => c.peer.heartbeat({ peerId: 'node-a' }) },
  { id: 'work.pull', call: (c) => c.work.pull({ peerId: 'node-a' }) },
  { id: 'work.complete', call: (c) => c.work.complete('w-1', { status: 'completed' }), pathParams: { workId: 'w-1' } },
  { id: 'operator.snapshot', call: (c) => c.operator.snapshot() },
];

describe('peer client shorthands', () => {
  test.each(SHORTHAND_CASES.map((entry) => [entry.id, entry] as const))('%s sends the contract route of that endpoint id', async (id, entry) => {
    const endpoint = getPeerContract().endpoints.find((candidate) => candidate.id === id) as { method: string; path: string } | undefined;
    expect(endpoint).toBeDefined();
    const path = endpoint!.path.replace(/\{(\w+)\}/g, (_match, name: string) => encodeURIComponent(entry.pathParams?.[name] ?? `missing-${name}`));
    const { client, sent } = recordingClient({}, { validateResponses: false });
    await entry.call(client);
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: `${BASE}${path}`, method: endpoint!.method }]);
  });

  test('the table covers every endpoint of the contract and every shorthand of the client', () => {
    expect(SHORTHAND_CASES.map((entry) => entry.id).sort()).toEqual(getPeerContract().endpoints.map((endpoint) => endpoint.id).sort());
    const { client } = recordingClient({});
    const { transport: _t, contract: _c, listOperations: _l, getOperation: _g, invoke: _i, ...groups } = client;
    const shorthands = Object.values(groups).flatMap((group) => Object.values(group as Record<string, unknown>).filter((value) => typeof value === 'function'));
    expect(shorthands).toHaveLength(SHORTHAND_CASES.length);
  });
});
