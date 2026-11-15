/**
 * Relay reachability follows the settings it is given while the daemon runs,
 * and its start/stop cannot race. The relay transport is a fake socket that
 * counts creations; nothing connects anywhere.
 */
import { describe, expect, test } from 'bun:test';
import { createRelayReachability, type RelayReachabilityConfig } from '../platform/src/platform/relay/reachability.ts';
import { wrapDispatchWithStepUp, type StepUpGateState } from '../platform/src/platform/relay/daemon-wiring.ts';
import { STEP_UP_ASSERTION_HEADER } from '../platform/src/platform/relay/step-up-policy.ts';
import { RELAY_VIA_HEADER, type RelayClientWebSocket } from '@goodvibes-jev/engine/daemon-api';
import type { SerializedRelayIdentity } from '@goodvibes-jev/engine/transport-core/relay';

function fakeSockets(): { impl: (url: string) => RelayClientWebSocket; opened: string[]; closed: () => number } {
  const opened: string[] = [];
  let closed = 0;
  return {
    opened,
    closed: () => closed,
    impl: (url) => {
      opened.push(url);
      return { binaryType: '', send() {}, close() { closed++; }, addEventListener() {} };
    },
  };
}

function identityStore(options: { hold?: Promise<void> } = {}): { load(): Promise<SerializedRelayIdentity | null>; save(i: SerializedRelayIdentity): Promise<void>; saves: number } {
  let saved: SerializedRelayIdentity | null = null;
  const store = {
    saves: 0,
    async load() { if (options.hold) await options.hold; return saved; },
    async save(identity: SerializedRelayIdentity) { saved = identity; store.saves++; },
  };
  return store;
}

const dispatch = async (): Promise<Response> => new Response('dispatched');
const baseConfig: RelayReachabilityConfig = { enabled: true, url: 'wss://relay.example/ws', rendezvousId: '', label: '' };

describe('relay reachability start and stop', () => {
  test('two overlapping starts open one registration', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const sockets = fakeSockets();
    const store = identityStore({ hold });
    const relay = createRelayReachability({ config: baseConfig, featureFlagEnabled: true, identityStore: store, dispatch, webSocketImpl: sockets.impl });
    const first = relay.start();
    const second = relay.start();
    release();
    await Promise.all([first, second]);
    expect(sockets.opened).toHaveLength(1);
    expect(store.saves).toBe(1);
    relay.stop();
  });

  test('a stop that arrives while a start is loading the identity leaves nothing registered', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const sockets = fakeSockets();
    const relay = createRelayReachability({ config: baseConfig, featureFlagEnabled: true, identityStore: identityStore({ hold }), dispatch, webSocketImpl: sockets.impl });
    const starting = relay.start();
    relay.stop();
    release();
    await starting;
    expect(sockets.opened).toHaveLength(0);
    expect(relay.rendezvousId).toBeNull();
  });

  test('a start after a stop during the first identity load reuses that load: one identity saved', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const sockets = fakeSockets();
    const store = identityStore({ hold });
    const relay = createRelayReachability({ config: baseConfig, featureFlagEnabled: true, identityStore: store, dispatch, webSocketImpl: sockets.impl });
    const abandoned = relay.start();
    relay.stop();
    const live = relay.start();
    release();
    await Promise.all([abandoned, live]);
    expect(store.saves).toBe(1);
    expect(sockets.opened).toHaveLength(1);
    relay.stop();
  });

  test('a restart keeps the rendezvous id it generated', async () => {
    const rids: string[] = [];
    const sockets = fakeSockets();
    const relay = createRelayReachability({
      config: baseConfig, featureFlagEnabled: true, identityStore: identityStore(), dispatch, webSocketImpl: sockets.impl,
      onRendezvousId: (rid) => rids.push(rid),
    });
    await relay.start();
    const first = relay.rendezvousId;
    relay.stop();
    await relay.start();
    expect(rids).toHaveLength(1);
    expect(relay.rendezvousId).toBe(first);
    relay.stop();
  });
});

describe('relay reachability follows its settings', () => {
  test('turning relay.enabled off and on again is applied by reconcile', async () => {
    let config = baseConfig;
    const sockets = fakeSockets();
    const relay = createRelayReachability({ config: () => config, featureFlagEnabled: true, identityStore: identityStore(), dispatch, webSocketImpl: sockets.impl });
    await relay.start();
    expect(relay.status).toBe('connecting');
    config = { ...config, enabled: false };
    expect(relay.status).toBe('disabled');
    await relay.reconcile();
    expect(relay.rendezvousId).toBeNull();
    expect(sockets.closed()).toBe(1);
    config = { ...config, enabled: true };
    await relay.reconcile();
    expect(relay.rendezvousId).not.toBeNull();
    expect(sockets.opened).toHaveLength(2);
    relay.stop();
  });

  test('a changed relay url is applied by reconcile, an unchanged one is left alone', async () => {
    let config = baseConfig;
    const sockets = fakeSockets();
    const relay = createRelayReachability({ config: () => config, featureFlagEnabled: true, identityStore: identityStore(), dispatch, webSocketImpl: sockets.impl });
    await relay.start();
    await relay.reconcile();
    expect(sockets.opened).toHaveLength(1);
    config = { ...config, url: 'wss://other.example/ws' };
    await relay.reconcile();
    expect(sockets.opened).toHaveLength(2);
    relay.stop();
  });
});

describe('the step-up gate reads its settings per request', () => {
  const relayed = (method: string, path: string, extra: Record<string, string> = {}): Request =>
    new Request(`http://daemon.local${path}`, { method, headers: { [RELAY_VIA_HEADER]: '1', ...extra } });

  function gateWith(state: Partial<StepUpGateState>) {
    const gate: StepUpGateState = { relayEnabled: () => true, requireStepUp: () => false, rendezvousId: () => null, ...state };
    return wrapDispatchWithStepUp(dispatch, gate, async () => ({ ok: false, reason: 'assertion-missing' }));
  }

  test('turning the requirement on takes effect on the next mutating relay call', async () => {
    let required = false;
    const gated = gateWith({ requireStepUp: () => required });
    expect((await gated(relayed('POST', '/api/approvals/claim')))?.status).toBe(200);
    required = true;
    expect((await gated(relayed('POST', '/api/approvals/claim')))?.status).toBe(401);
  });

  test('a relay call after relay access was turned off is refused, a LAN call is not', async () => {
    let enabled = true;
    const gated = gateWith({ relayEnabled: () => enabled });
    expect((await gated(relayed('GET', '/api/approvals')))?.status).toBe(200);
    enabled = false;
    expect((await gated(relayed('GET', '/api/approvals')))?.status).toBe(503);
    expect((await gated(new Request('http://daemon.local/api/approvals')))?.status).toBe(200);
  });

  test('the assertion is verified for this request, with its session and rendezvous', async () => {
    const seen: unknown[] = [];
    const gate: StepUpGateState = { relayEnabled: () => true, requireStepUp: () => true, rendezvousId: () => 'rid-1' };
    const gated = wrapDispatchWithStepUp(dispatch, gate, async (_assertion, context) => { seen.push(context); return { ok: true }; });
    await gated(relayed('POST', '/api/sessions/s%201/close', { [STEP_UP_ASSERTION_HEADER]: 'x' }));
    expect(seen).toEqual([{ method: 'POST', path: '/api/sessions/s%201/close', sessionId: 's 1', rendezvousId: 'rid-1' }]);
  });
});
