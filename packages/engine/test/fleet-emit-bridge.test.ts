/**
 * fleet-emit-bridge.test.ts
 *
 * The fleet emit-bridge turns the ProcessRegistry's coalesced snapshot tick into
 * poll-free lifecycle events on the runtime bus `fleet` domain. These tests drive
 * the bridge with hand-built snapshots and assert the derived per-node deltas:
 * seed-silence on the first snapshot, started/state-changed/finished, and the
 * blocked-on-user / unblocked pair around an attention transition.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { attachFleetEmitBridge, withFleetArchive } from '../platform/src/platform/runtime/fleet/index.js';
import type { FleetSnapshot, ProcessNode, ProcessRegistry, ProcessState, ProcessAttentionReason } from '../platform/src/platform/runtime/fleet/index.js';
import type { FleetEvent } from '../platform/src/platform/runtime/events/index.js';

function node(id: string, state: ProcessState, extra: Partial<ProcessNode> = {}): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: `label-${id}`,
    state,
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    ...extra,
  };
}

function attention(reason: ProcessAttentionReason): { needsAttention: { reason: ProcessAttentionReason } } {
  return { needsAttention: { reason } };
}

/**
 * A fake registry whose `subscribe` captures the listener so a test can push
 * snapshots synchronously; returns a real unsubscribe.
 */
function fakeRegistry(): {
  subscribe: (listener: (s: FleetSnapshot) => void) => () => void;
  push: (nodes: readonly ProcessNode[]) => void;
  subscriberCount: () => number;
} {
  const listeners = new Set<(s: FleetSnapshot) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (nodes) => {
      const snap: FleetSnapshot = { capturedAt: Date.now(), nodes };
      for (const l of listeners) l(snap);
    },
    subscriberCount: () => listeners.size,
  };
}

/** Collect fleet-domain events; dispatch is via queueMicrotask, so flush after. */
function collectFleetEvents(bus: RuntimeEventBus): { events: FleetEvent[] } {
  const events: FleetEvent[] = [];
  bus.onDomain('fleet', (envelope) => {
    events.push(envelope.payload as FleetEvent);
  });
  return { events };
}

async function flush(): Promise<void> {
  // Two macrotask hops comfortably drains the queued microtask dispatch.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('fleet emit-bridge', () => {
  test('first snapshot only seeds: it emits nothing', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 'trace-1' });

    reg.push([node('a', 'thinking'), node('b', 'executing-tool')]);
    await flush();

    expect(events).toHaveLength(0);
  });

  test('a node appearing after the seed emits FLEET_NODE_STARTED', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'thinking')]); // seed
    reg.push([node('a', 'thinking'), node('b', 'queued', { parentId: 'a' })]);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_STARTED', nodeId: 'b', state: 'queued', parentId: 'a' });
  });

  test('a coarse state change emits FLEET_NODE_STATE_CHANGED with previousState', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'thinking')]); // seed
    reg.push([node('a', 'executing-tool')]);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_STATE_CHANGED', nodeId: 'a', state: 'executing-tool', previousState: 'thinking' });
  });

  test('a transition into a terminal state emits FLEET_NODE_FINISHED (not state-changed)', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'executing-tool')]); // seed
    reg.push([node('a', 'done')]);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_FINISHED', nodeId: 'a', state: 'done', previousState: 'executing-tool' });
  });

  test('blocking on approval emits FLEET_NODE_BLOCKED_ON_USER and suppresses the redundant state-changed', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'executing-tool', { sessionRef: { sessionId: 's1', agentId: 'a' } })]); // seed
    reg.push([node('a', 'awaiting-approval', { sessionRef: { sessionId: 's1', agentId: 'a' }, ...attention('approval') })]);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'a', reason: 'approval', sessionId: 's1', agentId: 'a' });
  });

  test('clearing the block emits FLEET_NODE_UNBLOCKED plus the new state change', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'awaiting-approval', attention('approval'))]); // seed (already blocked)
    reg.push([node('a', 'executing-tool')]);
    await flush();

    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(['FLEET_NODE_STATE_CHANGED', 'FLEET_NODE_UNBLOCKED']);
    const unblocked = events.find((e) => e.type === 'FLEET_NODE_UNBLOCKED');
    expect(unblocked).toMatchObject({ nodeId: 'a', state: 'executing-tool' });
  });

  test('archiving and unarchiving a finished node emits nothing when the bridge watches the unfiltered registry', async () => {
    const bus = new RuntimeEventBus();
    const { events } = collectFleetEvents(bus);
    let nodes: readonly ProcessNode[] = [node('a', 'done'), node('live', 'thinking')];
    const listeners = new Set<(s: FleetSnapshot) => void>();
    const base: ProcessRegistry = {
      query: () => ({ capturedAt: 1, nodes }),
      getNode: (id) => nodes.find((n) => n.id === id) ?? null,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      interrupt: () => false,
      resume: () => false,
      kill: () => [],
      steer: () => ({ queued: false, reason: 'fake' }),
      dispose: () => {},
    };
    const archived = withFleetArchive(base);
    // The composition roots attach through `unfiltered`, so this is the registry they hand the bridge.
    expect(archived.unfiltered).toBe(base);
    attachFleetEmitBridge({ registry: archived.unfiltered, bus, traceId: () => 't' });
    const tick = (): void => { for (const l of listeners) l(base.query()); };

    tick(); // seed
    expect(archived.archive('a').archived).toBe(true);
    tick();
    expect(archived.unarchive('a')).toBe(1);
    tick();
    await flush();
    expect(events).toHaveLength(0);

    // Real transitions are still reported.
    nodes = [node('a', 'done'), node('live', 'done')];
    tick();
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_FINISHED', nodeId: 'live', previousState: 'thinking' });
  });

  test('a node that leaves the snapshot and returns is reported as newly started, never as finished', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });

    reg.push([node('a', 'thinking'), node('b', 'thinking')]); // seed
    reg.push([node('b', 'thinking')]); // a disappears: no event claimed from absence
    await flush();
    expect(events).toHaveLength(0);
    reg.push([node('a', 'thinking'), node('b', 'thinking')]);
    await flush();
    expect(events.map((e) => e.type)).toEqual(['FLEET_NODE_STARTED']);
  });

  test('a node that started and ended between snapshots emits STARTED then FINISHED, so a completion is not lost', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });
    reg.push([]); // seed
    reg.push([node('quick', 'done')]);
    await flush();
    expect(events.map((e) => e.type)).toEqual(['FLEET_NODE_STARTED', 'FLEET_NODE_FINISHED']);
  });

  test('a blocked node that leaves the snapshot emits UNBLOCKED, so its escalation stops', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });
    reg.push([node('a', 'awaiting-approval', { sessionRef: { sessionId: 's1', agentId: 'a' }, ...attention('approval') })]); // seed
    reg.push([]);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_UNBLOCKED', nodeId: 'a', sessionId: 's1' });
  });

  test('an emit failure is contained: the snapshot callback does not throw and later snapshots still emit', async () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const { events } = collectFleetEvents(bus);
    attachFleetEmitBridge({ registry: reg, bus, traceId: () => 't' });
    reg.push([node('a', 'thinking')]); // seed

    const emit = spyOn(bus, 'emit').mockImplementationOnce(() => { throw new Error('bus down'); });
    expect(() => reg.push([node('a', 'executing-tool')])).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
    await flush();
    expect(events).toHaveLength(0);

    reg.push([node('a', 'executing-tool')]);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FLEET_NODE_STATE_CHANGED', nodeId: 'a', previousState: 'thinking' });
  });

  test('unsubscribe detaches the registry subscription', () => {
    const bus = new RuntimeEventBus();
    const reg = fakeRegistry();
    const off = attachFleetEmitBridge({ registry: reg, bus });
    expect(reg.subscriberCount()).toBe(1);
    off();
    expect(reg.subscriberCount()).toBe(0);
  });
});
