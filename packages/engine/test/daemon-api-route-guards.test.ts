/**
 * Request checks in the daemon API route layer: values that would otherwise be
 * coerced into their opposite (channel policy flags), a URL that names one
 * target while the body names another, path escapes, knowledge listings that
 * claimed to be complete, and the fields a client asked for but the route
 * never read.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonChannelRouteHandlers } from '../daemon-api/src/channel-routes.js';
import type { DaemonChannelRouteContext } from '../daemon-api/src/channel-route-types.js';
import { createDaemonControlRouteHandlers, type ControlRouteContext } from '../daemon-api/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-api/src/gateway-rest-routes.js';
import { dispatchOperatorRoutes } from '../daemon-api/src/operator.js';
import { dispatchAutomationRoutes } from '../daemon-api/src/automation.js';
import { dispatchDaemonApiRoutes } from '../daemon-api/src/api-router.js';
import { createDaemonKnowledgeRouteHandlers } from '../daemon-api/src/knowledge-routes.js';
import type { DaemonKnowledgeRouteContext } from '../daemon-api/src/knowledge-route-types.js';
import { contractWorkSnapshot, type ContractWorkFields } from '../contracts/src/contract-work.js';

type Json = Record<string, unknown>;

function jsonRequest(method: string, url: string, body?: Json): Request {
  return new Request(`http://daemon.test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Handlers where every method records its call and answers 200, so a test can see which one was reached. */
function recordingHandlers(): { readonly handlers: never; readonly calls: Array<{ name: string; args: unknown[] }> } {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const handlers = new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => { calls.push({ name: String(name), args }); return new Response('ok'); },
  }) as never;
  return { handlers, calls };
}

describe('channel policy', () => {
  function channelContext(): { readonly context: DaemonChannelRouteContext; readonly upserts: Json[] } {
    const upserts: Json[] = [];
    const context = {
      requireAdmin: () => null,
      parseJsonBody: async (req: Request) => await req.json() as Json,
      channelPolicy: {
        listPolicies: () => [],
        upsertPolicy: async (_surface: string, input: Json) => { upserts.push(input); return input; },
        listAudit: () => [],
      },
      channelPlugins: { resolveTarget: async () => null, authorizeActorAction: async () => ({ allowed: true }) },
    } as unknown as DaemonChannelRouteContext;
    return { context, upserts };
  }

  test('the string "false" is refused, not read as true, and nothing is written', async () => {
    const { context, upserts } = channelContext();
    const response = await createDaemonChannelRouteHandlers(context).patchChannelPolicy('telegram', jsonRequest('PATCH', '/p', { allowDirectMessages: 'false' })) as Response;
    expect(response.status).toBe(400);
    expect(String(((await response.json()) as Json).error)).toContain('allowDirectMessages');
    expect(upserts).toEqual([]);
  });

  test('a mistyped dmPolicy is refused instead of silently dropped', async () => {
    const { context, upserts } = channelContext();
    const response = await createDaemonChannelRouteHandlers(context).patchChannelPolicy('telegram', jsonRequest('PATCH', '/p', { allowDirectMessages: false, dmPolicy: 'denied' })) as Response;
    expect(response.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  test('a group policy with a string flag is refused too', async () => {
    const { context, upserts } = channelContext();
    const response = await createDaemonChannelRouteHandlers(context).postChannelPolicy('telegram', jsonRequest('POST', '/p', { groupPolicies: [{ groupId: 'g', requireMention: '0' }] })) as Response;
    expect(response.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  test('well-typed fields are applied', async () => {
    const { context, upserts } = channelContext();
    const response = await createDaemonChannelRouteHandlers(context).patchChannelPolicy('telegram', jsonRequest('PATCH', '/p', { allowDirectMessages: false, dmPolicy: 'deny', allowlistUserIds: ['1'] })) as Response;
    expect(response.status).toBe(200);
    expect(upserts).toEqual([{ allowDirectMessages: false, dmPolicy: 'deny', allowlistUserIds: ['1'] }]);
  });

  test('an authorization check for a target that does not resolve is refused, not answered as "no target"', async () => {
    const { context } = channelContext();
    const response = await createDaemonChannelRouteHandlers(context).postChannelAuthorize('telegram', jsonRequest('POST', '/a', { target: 'nobody', actionId: 'send' })) as Response;
    expect(response.status).toBe(404);
  });
});

describe('a gateway verb reached by its REST path', () => {
  function controlContext(): { readonly context: ControlRouteContext; readonly invoked: Json[] } {
    const invoked: Json[] = [];
    const context = {
      gatewayMethods: { get: () => ({ access: 'authenticated' }) },
      resolveAuthenticatedPrincipal: () => ({ principalId: 'p', principalKind: 'user', admin: false, scopes: [] }),
      parseOptionalJsonBody: async (req: Request) => (req.body ? await req.json() as Json : null),
      extractAuthToken: () => 'token',
      requireAdmin: () => null,
      invokeGatewayMethodCall: async (input: Json) => { invoked.push(input); return { status: 200, ok: true, body: {} }; },
    } as unknown as ControlRouteContext;
    return { context, invoked };
  }

  test('a body field that names another target than the URL is refused and the verb is not called', async () => {
    const { context, invoked } = controlContext();
    const handlers = createDaemonControlRouteHandlers(context);
    const response = await handlers.invokeGatewayRestVerb({
      methodId: 'skills.update',
      req: jsonRequest('POST', '/api/skills/alpha/update', { name: 'beta', body: 'x' }),
      params: { name: 'alpha' },
    }) as Response;
    expect(response.status).toBe(400);
    expect(invoked).toEqual([]);
  });

  test('a query parameter that names another target is refused too', async () => {
    const { context, invoked } = controlContext();
    const response = await createDaemonControlRouteHandlers(context).invokeGatewayRestVerb({
      methodId: 'channels.drafts.delete',
      req: jsonRequest('DELETE', '/api/channels/drafts/mine?draftId=other'),
      params: { draftId: 'mine' },
    }) as Response;
    expect(response.status).toBe(400);
    expect(invoked).toEqual([]);
  });

  test('repeating the same value is fine, and the path value is what the verb receives', async () => {
    const { context, invoked } = controlContext();
    const response = await createDaemonControlRouteHandlers(context).invokeGatewayRestVerb({
      methodId: 'skills.update',
      req: jsonRequest('POST', '/api/skills/alpha/update?name=alpha', { name: 'alpha', body: 'x' }),
      params: { name: 'alpha' },
    }) as Response;
    expect(response.status).toBe(200);
    expect(invoked[0]!.query).toEqual({ name: 'alpha' });
    expect(invoked[0]!.body).toEqual({ name: 'alpha', body: 'x' });
  });

  function startRequest(key: string | null, body: Json): Request {
    return new Request('http://daemon.test/api/contracts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) },
      body: JSON.stringify(body),
    });
  }

  test('a repeated contract dispatch with the same Idempotency-Key gets the first contract and starts no second one', async () => {
    const { context, invoked } = controlContext();
    let started = 0;
    (context as unknown as { invokeGatewayMethodCall: (input: Json) => Promise<unknown> }).invokeGatewayMethodCall = async (input) => {
      invoked.push(input);
      started += 1;
      return { status: 201, ok: true, body: { contractId: `contract-${started}` } };
    };
    const handlers = createDaemonControlRouteHandlers(context);
    const first = await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k1', { goal: 'a' }), params: {} }) as Response;
    const replay = await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k1', { goal: 'a' }), params: {} }) as Response;
    expect(await first.json()).toEqual({ contractId: 'contract-1' });
    expect(await replay.json()).toEqual({ contractId: 'contract-1' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(started).toBe(1);
  });

  test('the same Idempotency-Key on a different contract request is refused, and without a key every dispatch starts a contract', async () => {
    const { context, invoked } = controlContext();
    const handlers = createDaemonControlRouteHandlers(context);
    await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k2', { goal: 'a' }), params: {} });
    const reused = await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k2', { goal: 'b' }), params: {} }) as Response;
    expect(reused.status).toBe(409);
    expect(invoked.length).toBe(1);
    await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest(null, { goal: 'a' }), params: {} });
    await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest(null, { goal: 'a' }), params: {} });
    expect(invoked.length).toBe(3);
  });

  test('a refused dispatch is not remembered, so the same key can be retried', async () => {
    const { context } = controlContext();
    let calls = 0;
    (context as unknown as { invokeGatewayMethodCall: (input: Json) => Promise<unknown> }).invokeGatewayMethodCall = async () => {
      calls += 1;
      return calls === 1 ? { status: 503, ok: false, body: { error: 'busy' } } : { status: 201, ok: true, body: { contractId: 'c' } };
    };
    const handlers = createDaemonControlRouteHandlers(context);
    expect((await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k3', { goal: 'a' }), params: {} }) as Response).status).toBe(503);
    expect((await handlers.invokeGatewayRestVerb({ methodId: 'contracts.start', req: startRequest('k3', { goal: 'a' }), params: {} }) as Response).status).toBe(201);
  });

  test('the explicit-request claim is passed on as the caller\'s own assertion', async () => {
    const { context, invoked } = controlContext();
    const request = new Request('http://daemon.test/api/power/status', { headers: { 'x-goodvibes-explicit-user-request': 'true' } });
    await createDaemonControlRouteHandlers(context).invokeGatewayRestVerb({ methodId: 'power.status.get', req: request, params: {} });
    expect((invoked[0]!.context as Json).explicitUserRequest).toBe(true);
  });
});

describe('percent-encoded path segments', () => {
  test('a malformed escape is a 400 from the gateway table, not a thrown URIError', async () => {
    const response = await dispatchGatewayRestRoutes(jsonRequest('GET', '/api/skills/%E0%A4%A'), { invokeGatewayRestVerb: async () => new Response('ok') });
    expect(response?.status).toBe(400);
  });

  test('the same holds through the whole dispatcher, and twice (the 400 is a fresh response each time)', async () => {
    const { handlers } = recordingHandlers();
    const first = await dispatchDaemonApiRoutes(jsonRequest('GET', '/api/skills/%E0%A4'), handlers);
    const second = await dispatchDaemonApiRoutes(jsonRequest('GET', '/api/skills/%E0%A4'), handlers);
    expect(first?.status).toBe(400);
    expect(second?.status).toBe(400);
    expect(await second?.json()).toEqual({ error: 'INVALID_PATH_ENCODING', code: 'INVALID_PATH_ENCODING' });
  });

  test('a reserved character in an id reaches the handler as the id the client sent', async () => {
    const { handlers, calls } = recordingHandlers();
    await dispatchOperatorRoutes(jsonRequest('POST', '/api/watchers/team%3Aci/start'), handlers);
    await dispatchOperatorRoutes(jsonRequest('PATCH', '/api/channels/policies/my%20surface'), handlers);
    await dispatchOperatorRoutes(jsonRequest('DELETE', '/api/routes/bindings/a%2Fb'), handlers);
    await dispatchOperatorRoutes(jsonRequest('POST', '/api/approvals/x%3A1/approve'), handlers);
    expect(calls.map((call) => [call.name, call.args[0]])).toEqual([
      ['watcherAction', 'team:ci'],
      ['patchChannelPolicy', 'my surface'],
      ['deleteRouteBinding', 'a/b'],
      ['approvalAction', 'x:1'],
    ]);
  });

  test('the automation table decodes and answers a malformed escape the same way', async () => {
    const { handlers, calls } = recordingHandlers();
    await dispatchAutomationRoutes(jsonRequest('POST', '/api/automation/jobs/job%3A1/run'), handlers);
    expect([calls[0]?.name, calls[0]?.args[0]]).toEqual(['runAutomationJobNow', 'job:1']);
    expect((await dispatchAutomationRoutes(jsonRequest('POST', '/api/automation/jobs/%E0%A4/run'), handlers))?.status).toBe(400);
  });

  test('a job delete reaches the gateway table only; the automation table does not answer it', async () => {
    const wired = recordingHandlers();
    await dispatchDaemonApiRoutes(jsonRequest('DELETE', '/api/automation/jobs/job1'), wired.handlers);
    expect(wired.calls.map((call) => call.name)).toEqual(['invokeGatewayRestVerb']);
    expect(await dispatchAutomationRoutes(jsonRequest('DELETE', '/api/automation/jobs/job1'), wired.handlers)).toBeNull();
    expect(wired.calls.map((call) => call.name)).toEqual(['invokeGatewayRestVerb']);
  });
});

describe('knowledge routes', () => {
  interface KnowledgeStubs {
    readonly context: DaemonKnowledgeRouteContext;
    readonly calls: { search: Json[]; ingestArtifact: Json[]; reviewIssue: Json[]; runRefinement: Json[]; ingestUrl: Json[]; ask: Json[]; render: Json[] };
  }

  function knowledgeContext(service: Json = {}, graphql?: (input: Json) => Promise<Json>): KnowledgeStubs {
    const calls = { search: [] as Json[], ingestArtifact: [] as Json[], reviewIssue: [] as Json[], runRefinement: [] as Json[], ingestUrl: [] as Json[], ask: [] as Json[], render: [] as Json[] };
    const context = {
      artifactStore: { create: async () => ({ id: 'a1' }), createFromStream: async () => ({ id: 'art-1' }) },
      configManager: { get: () => false },
      requireAdmin: () => null,
      resolveAuthenticatedPrincipal: () => ({ principalId: 'admin-user', principalKind: 'user', admin: true, scopes: ['*'] }),
      parseJsonBody: async (req: Request) => await req.json() as Json,
      parseOptionalJsonBody: async (req: Request) => (req.body ? await req.json() as Json : null),
      inspectGraphqlAccess: () => ({ operation: 'query', requiredScopes: [] }),
      knowledgeGraphqlService: { schemaText: '', execute: graphql ?? (async () => ({ data: {} })) },
      knowledgeService: {
        querySources: async () => ({ total: 0, items: [] }),
        queryNodes: async () => ({ total: 0, items: [] }),
        searchScoped: async (input: Json, options: Json) => { calls.search.push({ input, options }); return []; },
        ask: async (input: Json, options: Json) => { calls.ask.push({ input, options }); return { ok: true }; },
        renderProjection: async (input: Json, options: Json) => { calls.render.push({ input, options }); return { ok: true }; },
        ingestArtifact: async (input: Json) => { calls.ingestArtifact.push(input); return { ok: true }; },
        reviewIssue: async (input: Json) => { calls.reviewIssue.push(input); return { ok: true }; },
        runRefinement: async (input: Json) => { calls.runRefinement.push(input); return { ok: true }; },
        ingestUrl: async (input: Json) => { calls.ingestUrl.push(input); return { ok: true }; },
        listConsolidationCandidates: () => [{ id: 'c' }],
        listUsageRecords: () => [],
        ...service,
      },
    } as unknown as DaemonKnowledgeRouteContext;
    return { context, calls };
  }

  const request = (url: string, init?: RequestInit) => new Request(`http://daemon.test${url}`, init);

  test('a paged sources listing that could not load every record says so', async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`, updatedAt: 100 - index }));
    const { context } = knowledgeContext({ querySources: async () => ({ total: 7000, items }) });
    const response = await createDaemonKnowledgeRouteHandlers(context).getKnowledgeSources(new URL('http://daemon.test/api/knowledge/sources?limit=2'), request('/api/knowledge/sources?limit=2')) as Response;
    const body = await response.json() as Json;
    expect(body.truncated).toBe(true);
    expect(body.total).toBe(7000);
    expect(body.loaded).toBe(3);
    expect(body.hasMore).toBe(true);
  });

  test('a complete paged listing carries no truncation marker', async () => {
    const items = [{ id: 's1', updatedAt: 2 }];
    const { context } = knowledgeContext({ querySources: async () => ({ total: 1, items }) });
    const response = await createDaemonKnowledgeRouteHandlers(context).getKnowledgeSources(new URL('http://daemon.test/api/knowledge/sources?limit=2'), request('/api/knowledge/sources?limit=2')) as Response;
    expect((await response.json() as Json).truncated).toBeUndefined();
  });

  test('a filter value that is not one of the accepted values is a 400 naming them', async () => {
    const { context } = knowledgeContext();
    const handlers = createDaemonKnowledgeRouteHandlers(context);
    const plural = await handlers.getKnowledgeCandidates(new URL('http://daemon.test/api/knowledge/candidates?subjectKind=sources')) as Response;
    expect(plural.status).toBe(400);
    expect(String(((await plural.json()) as Json).error)).toContain('source, node, issue');
    const typo = await handlers.getKnowledgeCandidates(new URL('http://daemon.test/api/knowledge/candidates?status=pendng')) as Response;
    expect(typo.status).toBe(400);
    const empty = await handlers.getKnowledgeCandidates(new URL('http://daemon.test/api/knowledge/candidates?status=&subjectKind=')) as Response;
    expect(empty.status).toBe(200);
    const usage = await handlers.getKnowledgeUsage(new URL('http://daemon.test/api/knowledge/usage?usageKind=nope')) as Response;
    expect(usage.status).toBe(400);
  });

  test('the reviewer recorded is the authenticated principal, whatever the body claims', async () => {
    const { context, calls } = knowledgeContext();
    await createDaemonKnowledgeRouteHandlers(context).postKnowledgeReviewIssue('issue-1', jsonRequest('POST', '/r', { action: 'accept', reviewer: 'owner' }));
    expect(calls.reviewIssue[0]!.reviewer).toBe('admin-user');
  });

  test('an upload cannot name the ingested source\'s uri, path or private-host flag', async () => {
    const { context, calls } = knowledgeContext();
    const form = new FormData();
    form.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    form.set('uri', 'https://attacker.example/page');
    form.set('path', '/etc/passwd');
    form.set('allowPrivateHosts', 'true');
    form.set('title', 'Notes');
    const response = await createDaemonKnowledgeRouteHandlers(context).postKnowledgeIngestArtifact(new Request('http://daemon.test/api/knowledge/ingest/artifact', { method: 'POST', body: form })) as Response;
    expect(response.status).toBe(201);
    expect(calls.ingestArtifact[0]).toEqual({ artifactId: 'art-1', title: 'Notes' });
  });

  test('search and packet run under the caller\'s captured authorization', async () => {
    const { context, calls } = knowledgeContext();
    await createDaemonKnowledgeRouteHandlers(context).postKnowledgeSearch(jsonRequest('POST', '/s', { query: 'q' }));
    const options = calls.search[0]!.options as Json;
    expect(typeof options.assertCurrent).toBe('function');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('ask and projection rendering run under the caller\'s captured authorization', async () => {
    const { context, calls } = knowledgeContext();
    const handlers = createDaemonKnowledgeRouteHandlers(context);
    await handlers.postKnowledgeAsk(jsonRequest('POST', '/a', { query: 'q' }));
    await handlers.postKnowledgeRenderProjection(jsonRequest('POST', '/p', { kind: 'overview' }));
    expect((calls.ask[0]!.options as Json).signal).toBeInstanceOf(AbortSignal);
    const render = calls.render[0]!.options as Json;
    expect(typeof render.assertCurrent).toBe('function');
    expect(render.signal).toBeInstanceOf(AbortSignal);
  });

  test('a store failure while ingesting is a 5xx, and an unparsable url is the caller\'s 400', async () => {
    const { context } = knowledgeContext({ ingestUrl: async () => { throw new Error('SQLITE_FULL'); } });
    const handlers = createDaemonKnowledgeRouteHandlers(context);
    expect((await handlers.postKnowledgeIngestUrl(jsonRequest('POST', '/i', { url: 'https://example.com/a' })) as Response).status).toBeGreaterThanOrEqual(500);
    expect((await handlers.postKnowledgeIngestUrl(jsonRequest('POST', '/i', { url: 'not a url' })) as Response).status).toBe(400);
  });

  test('a GraphQL failure inside a resolver is a 500; a malformed document stays a 400', async () => {
    const storeDown = knowledgeContext({}, async () => ({ errors: [{ message: 'store unavailable' }] }));
    const down = await createDaemonKnowledgeRouteHandlers(storeDown.context).executeKnowledgeGraphql(jsonRequest('POST', '/g', { query: '{ x }' })) as Response;
    expect(down.status).toBe(500);
    const badDocument = knowledgeContext({}, async () => ({ errors: [{ message: 'Syntax Error', locations: [{ line: 1, column: 1 }] }] }));
    const bad = await createDaemonKnowledgeRouteHandlers(badDocument.context).executeKnowledgeGraphql(jsonRequest('POST', '/g', { query: '{ x' })) as Response;
    expect(bad.status).toBe(400);
  });

  test('the refinement run keeps the time budget the caller asked for', async () => {
    const { context, calls } = knowledgeContext();
    await createDaemonKnowledgeRouteHandlers(context).postKnowledgeRunRefinement(jsonRequest('POST', '/refine', { knowledgeSpaceId: 's', maxRunMs: 5000 }));
    expect(calls.runRefinement[0]).toEqual({ knowledgeSpaceId: 's', maxRunMs: 5000 });
  });
});

describe('contract work snapshot', () => {
  const base: ContractWorkFields = {
    id: 'c1',
    status: 'awaiting-owner',
    sessionId: 's',
    ownerAgentId: 'o',
    createdAt: 1_000,
    escalations: [],
    decisions: [{ at: 2_000 }],
  };

  test('raising or answering an escalation moves updatedAt', () => {
    const raised = contractWorkSnapshot({ ...base, escalations: [{ id: 'e1', at: 5_000, question: 'which?' }] });
    expect(raised.updatedAt).toBe(new Date(5_000).toISOString());
    const answered = contractWorkSnapshot({ ...base, escalations: [{ id: 'e1', at: 5_000, question: 'which?', resolvedAt: 9_000 }] });
    expect(answered.updatedAt).toBe(new Date(9_000).toISOString());
  });
});
