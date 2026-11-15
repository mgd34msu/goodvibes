import { afterEach, expect, test } from 'bun:test';
import { classifyKnowledgeError, getAgentKnowledgeJson, postAgentKnowledgeJson } from '../../cli/agent-knowledge-runtime.ts';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function host(answer: (route: string) => Response) {
  const requests: Array<{ route: string; authorization: string | null; body: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    requests.push({ route, authorization: request.headers.get('authorization'), body: await request.text() });
    return answer(route);
  } });
  servers.push(server);
  return { requests, connection: { baseUrl: server.url.origin, token: 'isolated-http-token', tokenPath: 'isolated fixture' } };
}

test('a POST carries the operator credential and the input to the Agent route, once', async () => {
  const f = host(() => Response.json({ source: { id: 'source-1' } }));
  const result = await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs', metadata: { origin: 'cli' } });
  expect(result).toMatchObject({ source: { id: 'source-1' } });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ route: '/api/goodvibes-agent/knowledge/ingest/url', authorization: 'Bearer isolated-http-token' });
  expect(JSON.parse(f.requests[0]!.body)).toEqual({ url: 'https://example.com/docs', metadata: { origin: 'cli' } });
});

test('content naming Home Assistant, a home graph or a default namespace is an ordinary answer', async () => {
  const f = host(() => Response.json({ sources: [
    { id: 's1', title: 'Home Assistant docs' },
    { id: 's2', snippet: 'Google Home graph notes' },
    { id: 's3', snippet: 'metadata:\n  namespace: default' },
  ] }));
  const result = await getAgentKnowledgeJson<{ sources: unknown[] }>(f.connection, '/api/goodvibes-agent/knowledge/sources', { limit: 10 });
  expect(result.sources).toHaveLength(3);
});

test('a refusal carries the host\'s own words and the status', async () => {
  const f = host(() => Response.json({ error: 'File does not exist: /tmp/nope.pdf' }, { status: 400 }));
  let failure: unknown;
  try { await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/artifact', { path: '/tmp/nope.pdf' }); }
  catch (error) { failure = error; }
  const result = await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/ingest/artifact');
  expect(result).toMatchObject({ kind: 'connected_host_error', status: 400, error: 'File does not exist: /tmp/nope.pdf (HTTP 400)' });
  expect(result.next?.length).toBeGreaterThan(0);
  expect(f.requests).toHaveLength(1);
});

test('an unknown id is not found, without a second request', async () => {
  const f = host(() => Response.json({ error: 'Unknown knowledge item: k1' }, { status: 404 }));
  let failure: unknown;
  try { await getAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/items/k1'); }
  catch (error) { failure = error; }
  const result = await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/items/k1');
  expect(result.kind).toBe('not_found');
  expect(f.requests.map((request) => request.route)).toEqual(['/api/goodvibes-agent/knowledge/items/k1']);
});

test('a missing route on a running host is incompatible; nothing listening is unavailable', async () => {
  const f = host((route) => route === '/status' ? Response.json({ ok: true }) : new Response('', { status: 404 }));
  let failure: unknown;
  try { await getAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/nodes'); }
  catch (error) { failure = error; }
  expect((await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/nodes')).kind).toBe('connected_host_incompatible');

  const nothing = { baseUrl: 'http://127.0.0.1:1', token: 'isolated-http-token', tokenPath: 'isolated fixture' };
  try { await getAgentKnowledgeJson(nothing, '/api/goodvibes-agent/knowledge/nodes'); failure = undefined; }
  catch (error) { failure = error; }
  expect((await classifyKnowledgeError(failure, nothing, '/api/goodvibes-agent/knowledge/nodes')).kind).toBe('connected_host_unavailable');
});

test('a cancelled call is not reported as a host failure', async () => {
  const f = host(() => Response.json({ ok: true }));
  const controller = new AbortController();
  controller.abort();
  let failure: unknown;
  try { await getAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/sources', {}, { signal: controller.signal }); }
  catch (error) { failure = error; }
  await expect(classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/sources', { signal: controller.signal })).rejects.toBeDefined();
  expect(f.requests).toHaveLength(0);
});
