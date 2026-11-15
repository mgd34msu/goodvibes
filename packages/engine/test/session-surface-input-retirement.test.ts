/**
 * An input queued for a surface ends when no surface is left to collect it,
 * instead of keeping the daemon busy until the session closes.
 */
import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import { SURFACE_ROUTE_FRESHNESS_MS } from '../platform/src/platform/control-plane/session-broker-sessions.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

function makeBroker() {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = { start: async () => {}, stop: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager;
  const broker = disposables.add(new SharedSessionBroker({
    store, routeBindings, agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
  const events: string[] = [];
  broker.setEventPublisher((_channel, payload) => { events.push((payload as { event: string }).event); });
  return { broker, events };
}

async function queuedForSurface(broker: SharedSessionBroker) {
  await broker.register({ sessionId: 's1', kind: 'tui', participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: Date.now() } });
  const submission = await broker.steerMessage({ sessionId: 's1', surfaceKind: 'web', surfaceId: 'surface:web', body: 'steer', allowSpawnFallback: true });
  expect(submission.mode).toBe('queued-for-surface');
  return submission.input.id;
}
const stateOf = (broker: SharedSessionBroker, id: string) => broker.getInputs('s1').find((entry) => entry.id === id);

describe('inputs queued for a surface that is gone', () => {
  test('are failed with a reason once the surface has not heartbeated for the routing window', async () => {
    const { broker, events } = makeBroker();
    const id = await queuedForSurface(broker);
    expect(broker.getSession('s1')?.pendingInputCount).toBe(1);
    const retired = await broker.retireAbandonedSurfaceInputs(Date.now() + SURFACE_ROUTE_FRESHNESS_MS + 1_000);
    expect(retired.map((entry) => entry.id)).toEqual([id]);
    expect(stateOf(broker, id)?.state).toBe('failed');
    expect(stateOf(broker, id)?.error).toContain('stopped heartbeating');
    expect(broker.getSession('s1')?.pendingInputCount).toBe(0);
    expect(events).toContain('session-input-failed');
  });

  test('stay queued while the surface is still heartbeating', async () => {
    const { broker } = makeBroker();
    const id = await queuedForSurface(broker);
    // Within the window the surface's last heartbeat is still fresh.
    expect(await broker.retireAbandonedSurfaceInputs(Date.now() + SURFACE_ROUTE_FRESHNESS_MS - 5_000)).toEqual([]);
    expect(stateOf(broker, id)?.state).toBe('queued');
  });

  test('are failed at once when the last surface detaches, and kept while another surface remains', async () => {
    const { broker } = makeBroker();
    const id = await queuedForSurface(broker);
    await broker.register({ sessionId: 's1', kind: 'tui', participant: { surfaceKind: 'tui', surfaceId: 'surface:second', lastSeenAt: Date.now() } });
    await broker.detachParticipant('s1', 'surface:tui');
    expect(stateOf(broker, id)?.state).toBe('queued');
    await broker.detachParticipant('s1', 'surface:second');
    expect(stateOf(broker, id)?.state).toBe('failed');
    expect(broker.getSession('s1')?.pendingInputCount).toBe(0);
  });

  test('are not judged until a window has passed since the broker loaded', async () => {
    const { broker } = makeBroker();
    const id = await queuedForSurface(broker);
    expect(await broker.retireAbandonedSurfaceInputs(Date.now() + 1_000)).toEqual([]);
    expect(stateOf(broker, id)?.state).toBe('queued');
  });
});
