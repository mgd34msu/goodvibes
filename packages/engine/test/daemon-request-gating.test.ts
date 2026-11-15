/**
 * The daemon HTTP front door: a route that throws still answers, an
 * authenticated caller is held to the scopes its catalog entry declares, a
 * surface the owner turned off refuses inbound traffic, and a purchase reply
 * set aside for several open windows tells the owner why.
 */
import { describe, expect, test } from 'bun:test';
import { gateGatewayBinding } from '../platform/src/platform/daemon/http/gateway-binding-gate.js';
import { isSurfaceIngressEnabled } from '../platform/src/platform/daemon/surface-policy.js';
import { tryResolvePaymentReplyFromChannel } from '../platform/src/platform/daemon/payment-reply.js';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.js';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.js';
import type { ChannelPolicyDecision } from '../platform/src/platform/channels/index.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

type Descriptor = NonNullable<ReturnType<Parameters<typeof gateGatewayBinding>[1]['gatewayMethods']['findByHttpBinding']>>;
const descriptor = (fields: Partial<Descriptor>): Descriptor => ({
  id: 'sessions.create', title: 't', description: 'd', category: 'sessions', scopes: ['write:sessions'], access: 'authenticated', ...fields,
}) as Descriptor;

function gate(found: Descriptor | null, principal: { admin: boolean; scopes: readonly string[] } | null) {
  return gateGatewayBinding(new Request('http://daemon.local/api/sessions', { method: 'POST' }), {
    gatewayMethods: { findByHttpBinding: () => found },
    authenticateRequest: () => principal ? { principal: { principalId: 'u', principalKind: 'user', ...principal } } : null,
    validateGatewayInvocation: (d, context) => {
      const missing = d.scopes.filter((scope) => !context?.scopes?.includes(scope));
      return missing.length === 0 ? null : { status: 403, ok: false, body: { error: `Missing required scope: ${missing.join(', ')}`, missingScopes: missing } };
    },
  });
}

describe('REST calls are held to the catalog entry for their URL', () => {
  test('a read-only caller is refused a write verb and the refusal names the missing scope', async () => {
    const refusal = gate(descriptor({}), { admin: false, scopes: ['read:sessions'] });
    expect(refusal?.status).toBe(403);
    expect(await refusal!.json()).toMatchObject({ missingScopes: ['write:sessions'] });
  });

  test('a caller holding the scope, and a URL with no catalog entry, pass', () => {
    expect(gate(descriptor({}), { admin: false, scopes: ['write:sessions'] })).toBeNull();
    expect(gate(null, { admin: false, scopes: [] })).toBeNull();
  });

  test('remote-peer methods and methods not invokable through dispatch are left to their own routes', () => {
    expect(gate(descriptor({ access: 'remote-peer' }), { admin: false, scopes: [] })).toBeNull();
    expect(gate(descriptor({ invokable: false }), { admin: false, scopes: [] })).toBeNull();
  });
});

describe('a surface the owner turned off', () => {
  const config = (value: boolean, tier: 'default' | 'user') => ({
    get: () => value,
    describeConfigKeySource: () => ({ tier, effectiveOrigin: tier }),
  }) as unknown as ConfigManager;

  test('refuses inbound traffic only when the owner set the switch, never for an unset default', () => {
    expect(isSurfaceIngressEnabled(config(false, 'user'), 'signal')).toBe(false);
    expect(isSurfaceIngressEnabled(config(false, 'default'), 'signal')).toBe(true);
    expect(isSurfaceIngressEnabled(config(true, 'user'), 'signal')).toBe(true);
  });

  test('has no opinion about a surface with no settings key', () => {
    expect(isSurfaceIngressEnabled(config(false, 'user'), 'tui')).toBe(true);
  });
});

function routerWith(overrides: Record<string, unknown>) {
  return new DaemonHttpRouter({
    configManager: { get: () => undefined },
    gatewayMethods: { findByHttpBinding: () => null, get: () => null, list: () => [] },
    controlPlaneGateway: {},
    runtimeStore: null,
    runtimeDispatch: null,
    authToken: () => null,
    authenticateRequest: () => ({ principal: { principalId: 'owner', principalKind: 'user', admin: true, scopes: [] } }),
    ...overrides,
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);
}

describe('the daemon HTTP router', () => {
  test('a webhook for a surface the owner turned off is refused before any adapter runs', async () => {
    let adapterRan = false;
    const router = routerWith({
      configManager: { get: (key: string) => key.startsWith('surfaces.') ? false : undefined, describeConfigKeySource: () => ({ tier: 'user', effectiveOrigin: 'user' }) },
      channelPlugins: { getByPath: () => ({ surface: 'signal' }), handleInbound: async () => { adapterRan = true; return new Response('ok'); } },
    });
    const response = await router.handleRequest(new Request('http://daemon.local/webhook/signal', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SURFACE_DISABLED' });
    expect(adapterRan).toBe(false);
  });

  test('a route that throws still answers with a JSON error that leaks nothing of the failure', async () => {
    const router = routerWith({
      channelPlugins: { getByPath: () => { throw new Error('open /var/lib/goodvibes/secret.db failed'); } },
    });
    const response = await router.handleRequest(new Request('http://daemon.local/webhook/signal', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('/var/lib/goodvibes');
  });

  test('a read-only user is refused a write verb by URL before the route sees it', async () => {
    let routed = false;
    const router = routerWith({
      gatewayMethods: { findByHttpBinding: () => descriptor({ scopes: ['write:sessions'] }), get: () => null, list: () => [] },
      authenticateRequest: () => ({ principal: { principalId: 'u', principalKind: 'user', admin: false, scopes: ['read:sessions'] } }),
      validateGatewayInvocation: () => ({ status: 403, ok: false, body: { error: 'Missing required scope for sessions.create: write:sessions' } }),
      dispatchApiRoutes: async () => { routed = true; return null; },
    });
    const response = await router.handleRequest(new Request('http://daemon.local/api/sessions', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(403);
    expect(routed).toBe(false);
  });
});

describe('a purchase reply set aside for several open windows', () => {
  const decision = { allowed: true, reason: 'ok', policy: { allowlistUserIds: ['owner-1'] } } as unknown as ChannelPolicyDecision;
  const soon = () => Date.now() + 60_000;

  test('tells the owner to answer the specific notice and leaves every window open', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ purchaseId: 'a', kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: 'Buying in 10 minutes unless you say stop: mouse.' });
    void inbox.waitForAnswer({ purchaseId: 'b', kind: 'approval', deadlineMs: soon(), channels: ['telegram'], notice: 'Purchase needs your OK: hub.' });
    const prompts: string[] = [];
    const offer = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: 'owner-1', text: 'yes' }, decision, inbox, undefined,
      { replyToOwner: async (text) => { prompts.push(text); } });
    expect(offer).toEqual({ consumed: false, reason: 'several-windows' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('specific notice');
    expect(inbox.pending).toBe(2);
  });

  test('a prompt that cannot be sent does not change the outcome', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ purchaseId: 'a', kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: 'n1' });
    void inbox.waitForAnswer({ purchaseId: 'b', kind: 'approval', deadlineMs: soon(), channels: ['telegram'], notice: 'n2' });
    const offer = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: 'owner-1', text: 'yes' }, decision, inbox, undefined,
      { replyToOwner: async () => { throw new Error('channel down'); } });
    expect(offer).toEqual({ consumed: false, reason: 'several-windows' });
    expect(inbox.pending).toBe(2);
  });
});
