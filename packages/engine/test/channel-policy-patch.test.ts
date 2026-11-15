/**
 * channel-policy-patch.test.ts
 *
 * Tests for PATCH /api/channels/policies/:surface.
 *
 * - PATCH with partial body → 200, response policy reflects merged fields
 * - PATCH without admin context → requireAdmin rejects (returns non-null Response)
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonChannelRouteHandlers } from '../daemon-api/src/channel-routes.js';
import { dispatchOperatorRoutes } from '../daemon-api/src/operator.js';
import type { DaemonChannelRouteContext } from '../daemon-api/src/channel-route-types.js';
import type { DaemonApiRouteHandlers } from '../daemon-api/src/context.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type PolicyRecord = Record<string, unknown>;

function makePolicyStore(initial: PolicyRecord = {}): {
  policies: Map<string, PolicyRecord>;
  service: DaemonChannelRouteContext['channelPolicy'];
} {
  const policies = new Map<string, PolicyRecord>([['slack', initial]]);

  const service: DaemonChannelRouteContext['channelPolicy'] = {
    listPolicies: () => [...policies.values()],
    upsertPolicy: async (surface, input) => {
      const existing = policies.get(surface) ?? {};
      const merged = { ...existing, ...input };
      policies.set(surface, merged);
      return merged;
    },
    listAudit: () => [],
  };
  return { policies, service };
}

function makeChannelPlugins(): DaemonChannelRouteContext['channelPlugins'] {
  return {
    listAccounts: async () => [],
    getAccount: async () => null,
    getSetupSchema: async () => null,
    doctor: async () => null,
    listRepairActions: async () => [],
    getLifecycleState: async () => null,
    runAccountAction: async () => null,
    listCapabilities: async () => [],
    listTools: async () => [],
    listAgentTools: () => [],
    runTool: async () => null,
    listOperatorActions: async () => [],
    runOperatorAction: async () => null,
    resolveTarget: async () => null,
    authorizeActorAction: async () => null,
    resolveAllowlist: async () => null,
    editAllowlist: async () => null,
    listStatus: async () => [],
    queryDirectory: async () => [],
  };
}

function makeContext(
  channelPolicy: DaemonChannelRouteContext['channelPolicy'],
  requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () => null,
): DaemonChannelRouteContext {
  return {
    channelPlugins: makeChannelPlugins(),
    channelPolicy,
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    requireAdmin,
    surfaceRegistry: { list: () => [] },
  };
}

function makePatchRequest(surface: string, body: unknown): Request {
  return new Request(`http://localhost/api/channels/policies/${surface}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/channels/policies/:surface: partial update', () => {
  test('PATCH with partial body → 200 and response reflects merged policy', async () => {
    const { service } = makePolicyStore({ enabled: false, requireMention: false });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Merged: enabled from patch, requireMention from existing
    expect(body['enabled']).toBe(true);
    expect(body['requireMention']).toBe(false);
  });

  test('PATCH with multiple fields → all merged into response', async () => {
    const { service } = makePolicyStore({ enabled: false, allowDirectMessages: false, requireMention: true });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true, allowDirectMessages: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['enabled']).toBe(true);
    expect(body['allowDirectMessages']).toBe(true);
    expect(body['requireMention']).toBe(true); // preserved from existing
  });

  test('PATCH with empty body → 200, existing policy unchanged', async () => {
    const { service } = makePolicyStore({ enabled: true, requireMention: false });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', {}),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['enabled']).toBe(true);
    expect(body['requireMention']).toBe(false);
  });
});

describe('PATCH /api/channels/policies/:surface: admin guard', () => {
  test('PATCH without admin context → requireAdmin response returned', async () => {
    const { service } = makePolicyStore({});
    // Simulate requireAdmin returning a 403
    const requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () =>
      new Response(JSON.stringify({ error: 'Admin required' }), { status: 403 });
    const ctx = makeContext(service, requireAdmin);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true }),
    );
    expect(res.status).toBe(403);
  });

  for (const method of ['patchChannelPolicy', 'postChannelPolicy'] as const) {
    test(`${method} refused by requireAdmin never reaches upsertPolicy and leaves the stored policy unchanged`, async () => {
      const { policies, service } = makePolicyStore({ enabled: true, requireMention: true });
      let upserts = 0;
      const recording: DaemonChannelRouteContext['channelPolicy'] = {
        ...service,
        upsertPolicy: async (surface, input) => { upserts += 1; return service.upsertPolicy(surface, input); },
      };
      const requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () =>
        new Response(JSON.stringify({ error: 'Admin required' }), { status: 403 });
      const handlers = createDaemonChannelRouteHandlers(makeContext(recording, requireAdmin));

      const res = await handlers[method]('slack', makePatchRequest('slack', { enabled: false, requireMention: false }));

      expect(res.status).toBe(403);
      expect(upserts).toBe(0);
      expect(policies.get('slack')).toEqual({ enabled: true, requireMention: true });
    });
  }
});

describe('channel policy writes: wrong-typed values', () => {
  const wrongTyped: Array<[string, unknown]> = [
    ['enabled', 'false'],
    ['enabled', 0],
    ['allowDirectMessages', 'false'],
    ['requireMention', '0'],
  ];
  for (const method of ['patchChannelPolicy', 'postChannelPolicy'] as const) {
    for (const [field, value] of wrongTyped) {
      test(`${method} refuses ${field}: ${JSON.stringify(value)} with 400 and changes nothing`, async () => {
        const { policies, service } = makePolicyStore({ enabled: true, allowDirectMessages: true, requireMention: true });
        const handlers = createDaemonChannelRouteHandlers(makeContext(service));

        const res = await handlers[method]('slack', makePatchRequest('slack', { [field]: value }));

        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(field);
        expect(policies.get('slack')).toEqual({ enabled: true, allowDirectMessages: true, requireMention: true });
      });
    }
  }
});

describe('channel optional JSON bodies', () => {
  test('POST channel tool returns parser errors even without a content-length hint', async () => {
    let toolCalled = false;
    const { service } = makePolicyStore({});
    const baseContext = makeContext(service);
    const ctx: DaemonChannelRouteContext = {
      ...baseContext,
      parseOptionalJsonBody: async () => new Response('Bad JSON', { status: 400 }),
      channelPlugins: {
        ...baseContext.channelPlugins,
        runTool: async () => {
          toolCalled = true;
          return { ok: true };
        },
      },
    };
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.postChannelTool(
      'slack',
      'send-message',
      new Request('http://localhost/api/channels/slack/tools/send-message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(res.status).toBe(400);
    expect(toolCalled).toBe(false);
  });
});

describe('PATCH /api/channels/policies/:surface: field filter', () => {
  test('an unknown field is refused by name and nothing reaches upsertPolicy', async () => {
    let called = false;
    const channelPolicy: DaemonChannelRouteContext['channelPolicy'] = {
      listPolicies: () => [],
      upsertPolicy: async (_surface, patch) => {
        called = true;
        return patch as Record<string, unknown>;
      },
      listAudit: () => [],
    };
    const handlers = createDaemonChannelRouteHandlers(makeContext(channelPolicy));

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true, dmPolcy: 'deny' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(called).toBe(false);
  });
});

describe('POST /api/channels/allowlist/:surface/edit: an access list change is never half-read', () => {
  test('a wrongly typed field or an unknown key is refused by name and the allowlist is not touched', async () => {
    const edits: unknown[] = [];
    const ctx = makeContext(makePolicyStore().service);
    ctx.channelPlugins.editAllowlist = async (_surface, input) => { edits.push(input); return { ok: true } as never; };
    const handlers = createDaemonChannelRouteHandlers(ctx);
    const edit = (body: unknown) => handlers.postChannelAllowlistEdit('slack', new Request('http://localhost/api/channels/allowlist/slack/edit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    for (const body of [{ remove: 'U123' }, { add: [123] }, { kind: 'users' }, { remov: ['U123'] }]) {
      const res = await edit(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(edits).toHaveLength(0);
    expect((await edit({ remove: ['U123'], kind: 'user' })).status).toBe(200);
    expect(edits).toEqual([{ remove: ['U123'], kind: 'user' }]);
  });
});

describe('PATCH /api/channels/policies/:surface: dispatcher integration', () => {
  test('PATCH via dispatchOperatorRoutes routes to patchChannelPolicy and merges fields', async () => {
    // Existing policy: { enabled: true, rate_limit: 5 }
    // Patch: { enabled: false }
    // Expected response: { enabled: false, rate_limit: 5 }
    const { service } = makePolicyStore({ enabled: true, rate_limit: 5 });
    const ctx = makeContext(service);
    const channelHandlers = createDaemonChannelRouteHandlers(ctx);
    const handlers = { ...channelHandlers } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/channels/policies/slack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    // Patch applied: enabled flipped
    expect(body['enabled']).toBe(false);
    // Existing field preserved via merge
    expect(body['rate_limit']).toBe(5);
  });

  test('PATCH via dispatcher with admin gate: requireAdmin 403 short-circuits before handler', async () => {
    const { policies, service } = makePolicyStore({ enabled: true });
    const requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () =>
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    const ctx = makeContext(service, requireAdmin);
    const channelHandlers = createDaemonChannelRouteHandlers(ctx);
    const handlers = { ...channelHandlers } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/channels/policies/slack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(policies.get('slack')).toEqual({ enabled: true });
  });
});
