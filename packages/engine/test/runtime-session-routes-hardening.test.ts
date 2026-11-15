/** Session route behaviour around ids, retried messages, agent binding and the record projection. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import { createDaemonRuntimeSessionRouteHandlers, toSharedSessionRecordResponse } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { dispatchSessionRoutes } from '../daemon-api/src/sessions.js';
import { dispatchTaskRoutes } from '../daemon-api/src/tasks.js';
import { dispatchRemoteRoutes } from '../daemon-api/src/remote.js';

function serve(options: { bindAgent?: () => Promise<unknown>; spawn?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-routes-hardening-'));
  const broker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'),
    routeBindings: {
      start: async () => {}, getBinding: () => null, resolve: () => null,
      patchBinding: async () => null,
    } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  const published: unknown[] = [];
  const cancelled: string[] = [];
  const bindable = options.bindAgent
    ? new Proxy(broker, { get: (target, prop, receiver) => prop === 'bindAgent' ? options.bindAgent : Reflect.get(target, prop, receiver) })
    : broker;
  const context = {
    sessionBroker: bindable,
    requireAdmin: () => null,
    parseJsonBody: (request: Request) => request.json(),
    parseOptionalJsonBody: (request: Request) => request.json(),
    recordApiResponse: (_request: Request, _path: string, response: Response) => response,
    queueSurfaceReplyFromBinding: () => {},
    publishConversationFollowup: (_sessionId: string, event: unknown) => { published.push(event); },
    agentManager: { cancel: (agentId: string) => { cancelled.push(agentId); }, getStatus: () => null },
    trySpawnAgent: () => options.spawn
      ? { id: 'agent-1', status: 'running', task: 'x', tools: [], startedAt: 0 }
      : (() => { throw new Error('no spawn expected'); })(),
  } as unknown as DaemonRuntimeRouteContext;
  const handlers = {
    ...createDaemonRuntimeSessionRouteHandlers(context),
    getIntegrationSessions: () => { throw new Error('not under test'); },
  };
  const call = async (path: string, init?: RequestInit) =>
    await dispatchSessionRoutes(new Request(`http://daemon.invalid${path}`, init), handlers as never) ?? new Response('Not found', { status: 404 });
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { broker, published, cancelled, call, post, stop: async () => { await broker.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test('a session id that needs escaping is found by every session route', async () => {
  const f = serve();
  try {
    await f.broker.createSession({ id: 'my session/one', kind: 'tui' });
    const encoded = encodeURIComponent('my session/one');
    expect((await f.call(`/api/sessions/${encoded}`)).status).toBe(200);
    expect((await f.call(`/api/sessions/${encoded}/messages`)).status).toBe(200);
    expect((await f.call(`/api/sessions/${encoded}/inputs`)).status).toBe(200);
    expect((await f.post(`/api/sessions/${encoded}/close`, {})).status).toBe(200);
  } finally { await f.stop(); }
});

test('a malformed escape in a session id is a 400, not a lookup of the raw text', async () => {
  const f = serve();
  try {
    const response = await f.call('/api/sessions/%E0%A4');
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('INVALID_PATH_ENCODING');
  } finally { await f.stop(); }
});

test('a retried message with the same client messageId adds one turn', async () => {
  const f = serve();
  try {
    await f.broker.createSession({ id: 's-chat', kind: 'companion-chat' });
    const first = await f.post('/api/sessions/s-chat/messages', { body: 'hello', messageId: 'client-1' });
    const retry = await f.post('/api/sessions/s-chat/messages', { body: 'hello', messageId: 'client-1' });
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ messageId: 'client-1', routedTo: 'conversation', sessionId: 's-chat' });
    expect(f.published).toHaveLength(1);
    expect(f.broker.getMessages('s-chat', 10)).toHaveLength(1);
    // Without a messageId every send is its own turn.
    await f.post('/api/sessions/s-chat/messages', { body: 'again' });
    await f.post('/api/sessions/s-chat/messages', { body: 'again' });
    expect(f.broker.getMessages('s-chat', 10)).toHaveLength(3);
  } finally { await f.stop(); }
});

test('a messageId that is not a plain token is refused before anything is stored', async () => {
  const f = serve();
  try {
    await f.broker.createSession({ id: 's-chat', kind: 'companion-chat' });
    const response = await f.post('/api/sessions/s-chat/messages', { body: 'hello', messageId: 'has space' });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('INVALID_MESSAGE_ID');
    expect(f.broker.getMessages('s-chat', 10)).toHaveLength(0);
  } finally { await f.stop(); }
});

test('an agent that cannot be bound to its input is cancelled and the input ends with the reason', async () => {
  const f = serve({ spawn: true, bindAgent: async () => { throw new Error('store is read-only'); } });
  try {
    await f.broker.createSession({ id: 's-bind', kind: 'tui' });
    const response = await f.post('/api/sessions/s-bind/follow-up', { body: 'do it' });
    expect(response.status).toBe(500);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe('SESSION_AGENT_BIND_FAILED');
    expect(body.error).toContain('store is read-only');
    expect(f.cancelled).toEqual(['agent-1']);
    const inputs = f.broker.getInputs('s-bind', 10);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ state: 'failed' });
  } finally { await f.stop(); }
});

test('the session record carries its permission mode and an unknown kind unchanged', () => {
  const record = toSharedSessionRecordResponse('s-1', {
    id: 's-1', kind: 'plugin-surface', channelPermissionMode: 'ask', channelPermissionModeRevision: 3,
    createdAt: 1, updatedAt: 2,
  });
  expect(record.kind).toBe('plugin-surface');
  expect(record.channelPermissionMode).toBe('ask');
  expect(record.channelPermissionModeRevision).toBe(3);
});

test('task and remote routes decode ids the same way', async () => {
  const seen: string[] = [];
  const record = (name: string) => (id: string) => { seen.push(`${name}:${id}`); return Response.json({}); };
  const taskHandlers = { getRuntimeTask: record('task'), getTaskStatus: record('status') };
  await dispatchTaskRoutes(new Request('http://daemon.invalid/api/tasks/a%20b'), taskHandlers as never);
  await dispatchTaskRoutes(new Request('http://daemon.invalid/task/c%2Fd'), taskHandlers as never);
  const remoteHandlers = { disconnectRemotePeer: record('peer') };
  await dispatchRemoteRoutes(new Request('http://daemon.invalid/api/remote/peers/e%20f/disconnect', { method: 'POST' }), remoteHandlers as never);
  expect(seen).toEqual(['task:a b', 'status:c/d', 'peer:e f']);
});

test('closing a live hosted session is refused with the verb that ends it; a closed one is left alone', async () => {
  const f = serve();
  try {
    await f.broker.createSession({ id: 's-hosted', kind: 'hosted' as never });
    const refused = await f.post('/api/sessions/s-hosted/close', {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'HOSTED_SESSION_STILL_RUNNING' });
    expect(f.broker.getSession('s-hosted')?.status).toBe('active');
    await f.broker.closeSession('s-hosted');
    expect((await f.post('/api/sessions/s-hosted/close', {})).status).toBe(200);
  } finally { await f.stop(); }
});
