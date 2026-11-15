/**
 * What the method catalog promises a caller must be what the handler does:
 * who may call a verb, which inputs it needs, and what its published text says.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDaemonChannelRouteHandlers,
  createDaemonIntegrationRouteHandlers,
  createDaemonKnowledgeRefinementRouteHandlers,
  createDaemonKnowledgeRouteHandlers,
  createDaemonMediaRouteHandlers,
  createDaemonRemoteRouteHandlers,
  createDaemonRuntimeAutomationRouteHandlers,
  createDaemonRuntimeRouteHandlers,
  createDaemonRuntimeSessionRouteHandlers,
  createDaemonSystemRouteHandlers,
  dispatchDaemonApiRoutes,
} from '@goodvibes-jev/engine/daemon-api';
import type { DaemonApiRouteHandlers } from '@goodvibes-jev/engine/daemon-api';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { GatewayMethodDescriptor } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import { validateInvocationInput } from '../platform/src/platform/control-plane/invoke-input-validation.ts';
import { builtinGatewayChannelMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-channels.ts';
import { builtinGatewayControlAutomationMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-control-automation.ts';
import { builtinGatewayControlCompanionMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-control-companion.ts';
import { builtinGatewayControlCoreMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-control-core.ts';
import { builtinGatewayKnowledgeMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-knowledge.ts';
import { CI_WATCH_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-ci.ts';
import { SESSION_UPDATE_INTENT_MAP, builtinGatewayEventDescriptors } from '../platform/src/platform/control-plane/method-catalog-events.ts';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';

const catalog = new GatewayMethodCatalog();

function descriptor(id: string): GatewayMethodDescriptor {
  const found = catalog.get(id);
  if (!found) throw new Error(`method not in catalog: ${id}`);
  return found;
}

const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);

function refusedFor(id: string, principal: { scopes: readonly string[]; admin: boolean }): number | null {
  const denied = helper.validateGatewayInvocation(descriptor(id), principal);
  return denied ? denied.status : null;
}

describe('a verb whose handler refuses non-admins says so in its descriptor', () => {
  // The real handlers, with a context whose only behaviour is to refuse a
  // non-admin caller. Any handler that answers 403 before touching another
  // service is gating on admin; the descriptor has to say the same, because the
  // invoke gate and every client's availability filter read `access`, not the
  // handler.
  const denied = (): Response => Response.json({ error: 'admin required' }, { status: 403 });
  const context = { requireAdmin: denied } as never;
  const real: Record<string, unknown> = {
    ...createDaemonChannelRouteHandlers(context),
    ...createDaemonIntegrationRouteHandlers(context),
    ...createDaemonKnowledgeRefinementRouteHandlers(context),
    ...createDaemonKnowledgeRouteHandlers(context),
    ...createDaemonMediaRouteHandlers(context),
    ...createDaemonRemoteRouteHandlers(context),
    ...createDaemonRuntimeRouteHandlers(context),
    ...createDaemonSystemRouteHandlers(context),
    ...createDaemonRuntimeAutomationRouteHandlers(context),
    ...createDaemonRuntimeSessionRouteHandlers(context),
  };
  const inert = (): Response => Response.json({ inert: true });
  const handlers = new Proxy(real, {
    get: (target, property) => (typeof property === 'string' && property in target ? target[property] : inert),
  }) as unknown as DaemonApiRouteHandlers;

  async function answersForbidden(method: string, path: string): Promise<boolean | null> {
    const request = new Request(`http://probe.invalid${path.replace(/\{[^/}]+\}/g, 'x')}`, { method });
    try {
      const response = await dispatchDaemonApiRoutes(request, handlers);
      return response === null ? null : response.status === 403;
    } catch {
      // A handler that got past the admin gate and reached a service the stub
      // does not carry.
      return false;
    }
  }

  test('every http verb answered 403 by withAdmin / requireAdmin is access:admin', async () => {
    const mismatched: string[] = [];
    let exercised = 0;
    for (const method of catalog.list()) {
      if (!method.http) continue;
      const forbidden = await answersForbidden(method.http.method, method.http.path);
      if (forbidden === null) continue;
      exercised += 1;
      if (forbidden && method.access !== 'admin') mismatched.push(`${method.id} (${method.access})`);
    }
    // A probe that reached no route would pass vacuously.
    expect(exercised).toBeGreaterThan(250);
    expect(mismatched).toEqual([]);
  });
});

describe('verbs that decide who may act', () => {
  test('sessions.permissionMode.set is refused for a principal that only holds write:sessions', () => {
    expect(refusedFor('sessions.permissionMode.set', { scopes: ['write:sessions'], admin: false })).toBe(403);
    expect(refusedFor('sessions.permissionMode.set', { scopes: ['write:sessions'], admin: true })).toBeNull();
  });

  test('a read-scoped principal cannot take rewind requests or learn a host id', () => {
    const readOnly = { scopes: ['read:sessions'], admin: false };
    expect(refusedFor('rewind.conversation.requests.take', readOnly)).toBe(403);
    expect(refusedFor('rewind.conversation.hosts.list', readOnly)).toBe(403);
    expect(refusedFor('rewind.conversation.requests.take', { scopes: ['write:sessions'], admin: false })).toBeNull();
  });

  test('a read-scoped principal cannot list or read retained device captures', () => {
    const readOnly = { scopes: ['read:remote'], admin: false };
    expect(refusedFor('devices.artifacts.list', readOnly)).toBe(403);
    expect(refusedFor('devices.artifacts.read', readOnly)).toBe(403);
    expect(refusedFor('devices.artifacts.read', { scopes: ['write:remote'], admin: false })).toBeNull();
  });

  test('fleet.attempts.judge, a paid model call that records a proposal, needs write:fleet', () => {
    expect(refusedFor('fleet.attempts.judge', { scopes: ['read:fleet'], admin: false })).toBe(403);
    expect(refusedFor('fleet.attempts.judge', { scopes: ['write:fleet'], admin: false })).toBeNull();
  });
});

describe('every {param} in an advertised path is a required input', () => {
  const modules: Record<string, readonly GatewayMethodDescriptor[]> = {
    channels: builtinGatewayChannelMethodDescriptors,
    automation: builtinGatewayControlAutomationMethodDescriptors,
    companion: builtinGatewayControlCompanionMethodDescriptors,
    'session-core': builtinGatewayControlCoreMethodDescriptors,
    knowledge: builtinGatewayKnowledgeMethodDescriptors,
  };

  test.each(Object.keys(modules))('%s descriptors declare and require their path parameters', (name) => {
    const gaps: string[] = [];
    for (const method of modules[name] ?? []) {
      const params = [...(method.http?.path.matchAll(/\{([^}]+)\}/g) ?? [])].map((match) => match[1] as string);
      const schema = method.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
      for (const param of params) {
        if (!schema.properties || !(param in schema.properties) || !schema.required?.includes(param)) {
          gaps.push(`${method.id}:${param}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  test('a call that omits the path parameter fails validation naming it', () => {
    const error = validateInvocationInput(descriptor('channels.accounts.action.default'), { accountId: 'a' });
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.detail).toContain('surface');
  });
});

describe('automation schedules', () => {
  test.each(['automation.jobs.create', 'automation.schedules.create'])(
    '%s rejects an interval or one-shot schedule that omits kind, which the handler would read as cron',
    (id) => {
      expect(validateInvocationInput(descriptor(id), { prompt: 'x', every: '5m' })?.code).toBe('INVALID_INPUT');
      expect(validateInvocationInput(descriptor(id), { prompt: 'x', at: '2030-01-01T00:00:00Z' })?.code).toBe('INVALID_INPUT');
    },
  );

  test.each(['automation.jobs.create', 'automation.schedules.create'])('%s accepts each schedule form that works', (id) => {
    expect(validateInvocationInput(descriptor(id), { prompt: 'x', kind: 'every', every: '5m' })).toBeNull();
    expect(validateInvocationInput(descriptor(id), { prompt: 'x', kind: 'at', at: '2030-01-01T00:00:00Z' })).toBeNull();
    expect(validateInvocationInput(descriptor(id), { prompt: 'x', cron: '* * * * *' })).toBeNull();
    expect(validateInvocationInput(descriptor(id), { prompt: 'x', schedule: { expression: '* * * * *' } })).toBeNull();
  });
});

describe('published text', () => {
  test('control.session_update names every wire event of every intent', () => {
    const event = builtinGatewayEventDescriptors.find((candidate) => candidate.id === 'control.session_update');
    expect(event).toBeDefined();
    for (const wireEvents of Object.values(SESSION_UPDATE_INTENT_MAP)) {
      for (const wireEvent of wireEvents) expect(event?.description).toContain(wireEvent);
    }
  });

  test('fleet.attempts.pick says that nothing is applied without confirm', () => {
    expect(descriptor('fleet.attempts.pick').description).toContain('confirm: true');
    expect(descriptor('fleet.attempts.pick').description).toContain('applied: false');
  });

  test('email.draft.create does not claim a confirmation step its input has no field for', () => {
    const method = descriptor('email.draft.create');
    expect(method.description).not.toContain('Requires explicit confirmation');
    expect((method.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty('confirm');
  });

  test('push.subscriptions.list names only fields the public subscription view carries', () => {
    expect(descriptor('push.subscriptions.list').description).not.toContain('hash');
  });

  test('control.status describes receipt consumption as at most once', () => {
    expect(descriptor('control.status').description).not.toContain('exactly once');
  });
});

describe('ci watch records', () => {
  test('a watch created under a native owner validates against its published schema', () => {
    const watch = {
      id: 'w1',
      continuationId: 'c1',
      repo: 'o/r',
      deliveryChannel: 'webui',
      triggerFixSession: false,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(firstJsonSchemaFailure(CI_WATCH_SCHEMA, watch)).toBeUndefined();
  });
});
