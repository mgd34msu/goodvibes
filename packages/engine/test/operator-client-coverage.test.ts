/**
 * The operator client covers the operator contract: every shorthand of the
 * client sends the HTTP method and path the contract gives its method id, a
 * method without a REST binding is refused before anything is sent, and
 * responses are held to the contract (a mixed-version daemon's session record
 * still passes). The daemon is a fetch stand-in that records what reached the
 * wire.
 */
import { describe, expect, test } from 'bun:test';
import { createOperatorApiClient } from '../operator-client/src/index.js';
import { createOperatorRemoteClient } from '../operator-client/src/client-core.js';
import { createHttpTransport } from '../transport-http/src/index.js';
import { getOperatorContract } from '../contracts/src/index.js';
import { GoodVibesError } from '../errors/src/index.js';
import { buildOperatorContract } from '../platform/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Bun's `typeof fetch` includes a `preconnect` static method that plain mock
 * functions don't have. Attach a no-op stub so test doubles satisfy the type
 * without pretending to implement real preconnect behavior.
 */
function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, {
    preconnect: (_url: string | URL, _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => {},
  });
}

function makeTransport(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createHttpTransport({
    baseUrl: 'http://127.0.0.1:3210',
    fetch: withPreconnect(fetch),
  });
}

describe('createOperatorRemoteClient: a method with no REST binding', () => {
  test('is refused as a contract error before anything is sent', async () => {
    let requests = 0;
    const transport = makeTransport(async () => { requests++; return createJsonResponse({ ok: true }); });
    const contract = { operator: { methods: [{ id: 'internal.only', description: 'internal only', http: null }] } };
    const client = createOperatorRemoteClient(transport, contract as unknown as ReturnType<typeof getOperatorContract>);
    const caught = await client.invoke('internal.only' as never).then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(GoodVibesError);
    expect((caught as GoodVibesError).category).toBe('contract');
    expect(requests).toBe(0);
  });
});

describe('createOperatorApiClient: responses are held to the contract', () => {
  // A field the published schema does not declare: a strict client must refuse the answer, not pass it on.
  const undeclared = { capturedAt: 0, providers: [], configuredCount: 0, issueCount: 0, internalOnly: true };

  test('by default a response the contract does not allow is refused', async () => {
    const client = createOperatorApiClient({ baseUrl: 'http://127.0.0.1:3210', fetch: withPreconnect(async () => createJsonResponse(undeclared)) });
    const caught = await client.accounts.snapshot().then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(GoodVibesError);
    expect((caught as GoodVibesError).category).toBe('contract');
  });

  test('with validateResponses: false the same response is passed through', async () => {
    const client = createOperatorApiClient({ baseUrl: 'http://127.0.0.1:3210', validateResponses: false, fetch: withPreconnect(async () => createJsonResponse(undeclared)) });
    expect(await client.accounts.snapshot()).toMatchObject({ internalOnly: true });
  });
});

// ---------------------------------------------------------------------------
// Shorthand bindings: every shorthand must reach the contract route of the
// method id it names (HTTP method and exact URL), with its body or query.
// ---------------------------------------------------------------------------

type SrcClient = ReturnType<typeof createOperatorRemoteClient>;

interface ShorthandCase {
  /** The operator method id the shorthand is documented to invoke. */
  readonly id: string;
  readonly call: (client: SrcClient) => Promise<unknown>;
  /** Path parameter values, substituted into the contract path. */
  readonly pathParams?: Readonly<Record<string, string>>;
  /** Request body expected on the wire (non-GET routes). */
  readonly body?: Record<string, unknown>;
  /** Query string expected on the wire (GET routes). */
  readonly query?: string;
}

const SHORTHAND_CASES: readonly ShorthandCase[] = [
  { id: 'sessions.create', call: (c) => c.sessions.create({ task: 'hello' }), body: { task: 'hello' } },
  { id: 'sessions.turns.cancel', call: (c) => c.sessions.turns.cancel({ sessionId: 's-1', expectedTurnId: 't-1' }), pathParams: { sessionId: 's-1' }, body: { expectedTurnId: 't-1' } },
  { id: 'sessions.get', call: (c) => c.sessions.get('s-1'), pathParams: { sessionId: 's-1' } },
  { id: 'sessions.list', call: (c) => c.sessions.list() },
  { id: 'sessions.messages.create', call: (c) => c.sessions.messages.create('s-1', { body: 'hi' }), pathParams: { sessionId: 's-1' }, body: { body: 'hi' } },
  { id: 'sessions.messages.list', call: (c) => c.sessions.messages.list('s-1', { limit: 5 }), pathParams: { sessionId: 's-1' }, query: '?limit=5' },
  { id: 'sessions.inputs.list', call: (c) => c.sessions.inputs.list('s-1'), pathParams: { sessionId: 's-1' } },
  { id: 'sessions.inputs.cancel', call: (c) => c.sessions.inputs.cancel('s-1', 'in-1'), pathParams: { sessionId: 's-1', inputId: 'in-1' } },
  { id: 'sessions.inputs.deliver', call: (c) => c.sessions.inputs.deliver('s-1', 'in-1'), pathParams: { sessionId: 's-1', inputId: 'in-1' } },
  { id: 'sessions.followUp', call: (c) => c.sessions.followUp({ sessionId: 's-1', body: 'more' }), pathParams: { sessionId: 's-1' }, body: { body: 'more' } },
  { id: 'sessions.steer', call: (c) => c.sessions.steer({ sessionId: 's-1', body: 'left' }), pathParams: { sessionId: 's-1' }, body: { body: 'left' } },
  { id: 'sessions.close', call: (c) => c.sessions.close('s-1'), pathParams: { sessionId: 's-1' } },
  { id: 'sessions.reopen', call: (c) => c.sessions.reopen('s-1'), pathParams: { sessionId: 's-1' } },
  { id: 'tasks.create', call: (c) => c.tasks.create({ task: 'ship it' }), body: { task: 'ship it' } },
  { id: 'tasks.get', call: (c) => c.tasks.get('t-1'), pathParams: { taskId: 't-1' } },
  { id: 'tasks.list', call: (c) => c.tasks.list() },
  { id: 'tasks.status', call: (c) => c.tasks.status({ agentId: 'a-1' }), pathParams: { agentId: 'a-1' } },
  { id: 'tasks.cancel', call: (c) => c.tasks.cancel('t-1'), pathParams: { taskId: 't-1' } },
  { id: 'tasks.retry', call: (c) => c.tasks.retry('t-1'), pathParams: { taskId: 't-1' } },
  { id: 'approvals.list', call: (c) => c.approvals.list() },
  { id: 'approvals.claim', call: (c) => c.approvals.claim('a-1'), pathParams: { approvalId: 'a-1' } },
  { id: 'approvals.approve', call: (c) => c.approvals.approve('a-1'), pathParams: { approvalId: 'a-1' } },
  { id: 'approvals.deny', call: (c) => c.approvals.deny('a-1'), pathParams: { approvalId: 'a-1' } },
  { id: 'approvals.cancel', call: (c) => c.approvals.cancel('a-1'), pathParams: { approvalId: 'a-1' } },
  { id: 'providers.list', call: (c) => c.providers.list() },
  { id: 'providers.get', call: (c) => c.providers.get('p-1'), pathParams: { providerId: 'p-1' } },
  { id: 'providers.usage.get', call: (c) => c.providers.usage('p-1'), pathParams: { providerId: 'p-1' } },
  { id: 'accounts.snapshot', call: (c) => c.accounts.snapshot() },
  { id: 'local_auth.status', call: (c) => c.localAuth.status() },
  { id: 'control.snapshot', call: (c) => c.control.snapshot() },
  { id: 'control.status', call: (c) => c.control.status() },
  { id: 'control.contract', call: (c) => c.control.contract() },
  { id: 'control.methods.list', call: (c) => c.control.methods.list() },
  { id: 'control.methods.get', call: (c) => c.control.methods.get('sessions.get'), pathParams: { methodId: 'sessions.get' } },
  { id: 'control.auth.current', call: (c) => c.control.auth.current() },
  { id: 'control.auth.login', call: (c) => c.control.auth.login({ username: 'u', password: 'p' }), body: { username: 'u', password: 'p' } },
  { id: 'control.events.catalog', call: (c) => c.control.events.catalog() },
  { id: 'telemetry.snapshot', call: (c) => c.telemetry.snapshot() },
  { id: 'telemetry.events.list', call: (c) => c.telemetry.events() },
  { id: 'telemetry.errors.list', call: (c) => c.telemetry.errors() },
  { id: 'telemetry.traces.list', call: (c) => c.telemetry.traces() },
  { id: 'telemetry.metrics.get', call: (c) => c.telemetry.metrics() },
  { id: 'telemetry.otlp.traces', call: (c) => c.telemetry.otlp.traces() },
  { id: 'telemetry.otlp.logs', call: (c) => c.telemetry.otlp.logs() },
  { id: 'telemetry.otlp.metrics', call: (c) => c.telemetry.otlp.metrics() },
];

describe('createOperatorRemoteClient (src): shorthand method bindings', () => {
  function expectedPath(id: string, pathParams: Readonly<Record<string, string>>): { method: string; path: string } {
    const route = getOperatorContract().operator.methods.find((method) => method.id === id)?.http;
    if (!route) throw new Error(`contract has no HTTP route for ${id}`);
    const path = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = pathParams[name];
      if (value === undefined) throw new Error(`case for ${id} gives no value for {${name}}`);
      return encodeURIComponent(value);
    });
    return { method: route.method, path };
  }

  test.each(SHORTHAND_CASES.map((entry) => [entry.id, entry] as const))('%s sends the contract route of that method id', async (_id, entry) => {
    const sent: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const transport = makeTransport(async (input, init) => {
      sent.push({ url: String(input), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      return createJsonResponse({});
    });
    const client = createOperatorRemoteClient(transport, getOperatorContract(), { validateResponses: false });

    await entry.call(client);

    const expected = expectedPath(entry.id, entry.pathParams ?? {});
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe(expected.method);
    expect(sent[0]?.url).toBe(`http://127.0.0.1:3210${expected.path}${entry.query ?? ''}`);
    if (expected.method !== 'GET' && entry.body) expect(sent[0]?.body).toEqual(entry.body);
  });

  test('the table covers every shorthand method of the client', () => {
    // A shorthand added to the client without a row here would escape the route check above.
    const walk = (node: unknown, prefix: string, out: string[]): void => {
      if (typeof node === 'function') { out.push(prefix); return; }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, prefix ? `${prefix}.${key}` : key, out);
      }
    };
    const client = createOperatorRemoteClient(makeTransport(async () => createJsonResponse({})), getOperatorContract());
    const { transport: _transport, contract: _contract, listOperations: _l, getOperation: _g, invoke: _i, stream: _s, ...groups } = client;
    const shorthands: string[] = [];
    walk(groups, '', shorthands);
    // The two stream openers need a live stream.
    const exempt = new Set(['control.events.stream', 'telemetry.stream']);
    expect(shorthands.filter((name) => !exempt.has(name)).length).toBe(SHORTHAND_CASES.length);
  });

  test('sessions.create validates the shared-session shape returned by daemon routes', async () => {
    const createdAt = Date.now();
    const client = createOperatorRemoteClient(
      makeTransport(async () => createJsonResponse({
        session: {
          id: 'sess-1',
          kind: 'tui',
          project: 'unknown',
          title: 'Test session',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          lastActivityAt: createdAt,
          messageCount: 0,
          pendingInputCount: 0,
          routeIds: [],
          surfaceKinds: [],
          participants: [],
          metadata: { nested: { values: [null, true, 3, 'native', { deeper: ['value'] }] } },
        },
      }, 201)),
      buildOperatorContract(new GatewayMethodCatalog()),
    );

    const result = await client.sessions.create({ title: 'Test session' });
    const session = result.session as Record<string, unknown>;
    expect(session.kind).toBe('tui');
    expect(session.lastActivityAt).toBe(createdAt);
    expect(session.metadata).toEqual({ nested: { values: [null, true, 3, 'native', { deeper: ['value'] }] } });
  });

  test('sessions.get tolerates a wire response that omits project (mixed-version daemon)', async () => {
    // Regression coverage for docs/decisions/2026-07-05-session-wire-mixed-version.md:
    // an older/mixed-version daemon may omit `project` on a shared-session record.
    // The JSON-schema response gate in validateJsonSchemaResponse (client-core.ts)
    // must not reject the response before normalizeSharedSessionRecord gets a
    // chance to backfill `project` to 'unknown', i.e. `project` must not be in
    // SHARED_SESSION_RECORD_SCHEMA's required list.
    const createdAt = Date.now();
    const client = createOperatorRemoteClient(
      makeTransport(async () => createJsonResponse({
        session: {
          id: 'sess-legacy',
          kind: 'tui',
          // project intentionally omitted
          title: 'Legacy session',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          lastActivityAt: createdAt,
          messageCount: 0,
          pendingInputCount: 0,
          routeIds: [],
          surfaceKinds: [],
          participants: [],
          metadata: { nested: [{ value: 'legacy' }, null] },
        },
        messages: [],
      })),
      buildOperatorContract(new GatewayMethodCatalog()),
    );

    const result = await client.sessions.get('sess-legacy');
    const session = result.session as Record<string, unknown>;
    expect(session.id).toBe('sess-legacy');
    expect(session.project).toBeUndefined(); // schema-gate layer does not backfill; that's normalizeSharedSessionRecord's job
    expect(session.metadata).toEqual({ nested: [{ value: 'legacy' }, null] });
  });

  test('tasks.status without its agentId is refused before any request is sent', async () => {
    let requests = 0;
    const client = createOperatorRemoteClient(makeTransport(async () => { requests++; return createJsonResponse({ ok: true }); }), getOperatorContract(), { validateResponses: false });
    // agentId is required at the type level; a caller that forgets it must not send a malformed request.
    const status = client.tasks.status as unknown as () => Promise<unknown>;
    let caught: unknown = null;
    try { await status(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GoodVibesError);
    expect(requests).toBe(0);
  });
});
