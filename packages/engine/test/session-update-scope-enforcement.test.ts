/**
 * session-update-scope-enforcement.test.ts
 *
 * What a principal may receive on the control-plane event stream is decided
 * once, when it subscribes, from the event descriptors' access and scopes. A
 * non-admin principal never receives setting values, approvals, session
 * lifecycle or transcripts, live or replayed, whatever scopes it holds and
 * whatever kind its socket names; an admin and an internal stream that carries
 * no principal scopes receive everything.
 */

import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

/** Every read scope a non-admin user is granted. */
const NON_ADMIN_SCOPES = ['read:events', 'read:sessions', 'read:remote', 'read:tasks', 'read:config'] as const;
const ADMIN_ONLY_BROADCASTS = ['session-update', 'hosted-session-update', 'approval-update'] as const;

function makeGateway(): { gateway: ControlPlaneGateway; bus: RuntimeEventBus } {
  const bus = new RuntimeEventBus();
  return { gateway: new ControlPlaneGateway({ runtimeBus: bus, featureFlags: createFeatureFlagManager() }), bus };
}

function publishAdminOnly(gateway: ControlPlaneGateway): void {
  for (const event of ADMIN_ONLY_BROADCASTS) gateway.publishEvent(event, { secret: event });
  // An undeclared broadcast nobody addressed (a companion follow-up, a plugin's event).
  gateway.publishEvent('conversation.followup.companion', { secret: 'transcript' });
}

describe('the event stream grant is decided once, from the descriptors', () => {
  test('a non-admin principal receives no admin-only event live or replayed, even naming itself a tui', () => {
    const { gateway } = makeGateway();
    publishAdminOnly(gateway);
    for (const clientKind of ['web', 'tui'] as const) {
      const events: string[] = [];
      const { clientId, domains } = gateway.openWebSocketClient({
        clientKind, scopes: NON_ADMIN_SCOPES, admin: false, domains: ['config', 'turn', 'tools', 'tasks'],
      }, (event) => events.push(event));
      publishAdminOnly(gateway);
      gateway.publishEvent('remote-peer', { peer: 'p' });
      expect(domains).toEqual(['tasks']);
      for (const event of ADMIN_ONLY_BROADCASTS) expect(events).not.toContain(event);
      expect(events).not.toContain('conversation.followup.companion');
      expect(events).toContain('remote-peer');
      gateway.closeWebSocketClient(clientId);
    }
  });

  test('an event addressed to the client by id still reaches it', () => {
    const { gateway } = makeGateway();
    const events: string[] = [];
    const { clientId } = gateway.openWebSocketClient({ clientKind: 'web', scopes: NON_ADMIN_SCOPES, admin: false }, (event) => events.push(event));
    gateway.publishEvent('companion-chat.chunk', { text: 'hi' }, { clientId });
    expect(events).toContain('companion-chat.chunk');
    gateway.closeWebSocketClient(clientId);
  });

  test('an admin and an internal stream with no scopes receive everything', () => {
    const { gateway } = makeGateway();
    publishAdminOnly(gateway);
    for (const options of [{ clientKind: 'web' as const, scopes: ['read:events'], admin: true }, { clientKind: 'web' as const }]) {
      const events: string[] = [];
      const { clientId } = gateway.openWebSocketClient(options, (event) => events.push(event));
      for (const event of ADMIN_ONLY_BROADCASTS) expect(events).toContain(event);
      gateway.closeWebSocketClient(clientId);
    }
  });

  test('a principal that loses admin stops receiving admin-only domains and events', () => {
    const { gateway } = makeGateway();
    const events: string[] = [];
    const { clientId } = gateway.openWebSocketClient({ clientKind: 'web', scopes: NON_ADMIN_SCOPES, admin: true, domains: ['config', 'tasks'] }, (event) => events.push(event));
    gateway.regrantClient(clientId, { admin: false, scopes: NON_ADMIN_SCOPES });
    events.length = 0;
    publishAdminOnly(gateway);
    for (const event of ADMIN_ONLY_BROADCASTS) expect(events).not.toContain(event);
    gateway.closeWebSocketClient(clientId);
  });

  test('an SSE stream that asks only for domains the credential may not read is refused, and says which', async () => {
    const { gateway } = makeGateway();
    const res = gateway.createEventStream(new Request('http://localhost/api/control-plane/events'), {
      clientKind: 'web', transport: 'sse', principalId: 'u', principalKind: 'user', scopes: NON_ADMIN_SCOPES, admin: false, domains: ['config', 'gate'],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'EVENT_ACCESS_DENIED', withheldDomains: ['config', 'gate'] });
  });

  test('a credential holding no event scope is refused the stream', async () => {
    const { gateway } = makeGateway();
    const res = gateway.createEventStream(new Request('http://localhost/api/control-plane/events'), {
      clientKind: 'web', transport: 'sse', principalId: 'u', principalKind: 'user', scopes: [], admin: false,
    });
    expect(res.status).toBe(403);
  });
});
