/**
 * The coordinator's own lifecycle, and what it reports about it.
 *
 * Covers a stop that lands while start() is still resolving which surfaces
 * this node can serve, a surface whose consumer would not stop, the status of
 * a node that fell back to reading everything itself, and a surface
 * re-registered while its previous election was still standing down.
 */
import { describe, expect, test } from 'bun:test';
import { ClusterCoordinator } from '../platform/src/platform/cluster/coordinator.js';
import { ClusterElection } from '../platform/src/platform/cluster/election-node.js';
import { ClusterSurfaceRegistry } from '../platform/src/platform/cluster/surface-registry.js';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { MemoryClusterBus } from '../platform/src/platform/cluster/memory-transport.js';
import { decodeMessage } from '../platform/src/platform/cluster/protocol.js';
import { providerSurface } from '../platform/src/platform/cluster/surface-id.js';
import type { ClusterConsumerGate, ClusterTransport } from '../platform/src/platform/cluster/types.js';
import { socketProviderGate } from '../platform/src/platform/daemon/facade-cluster.js';
import { settings, SILENT } from './cluster-harness.js';

const surface = providerSurface('custom', 'coordinator-lifecycle');

async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function rig(enabled = true, transportOverride?: Partial<ClusterTransport>) {
  const clock = new FakeClusterClock();
  const bus = new MemoryClusterBus();
  const inner = bus.createTransport('node');
  const events: string[] = [];
  const transport: ClusterTransport = {
    start: async (receive) => { events.push('transport:start'); await inner.start(receive); },
    stop: () => inner.stop(),
    describe: () => inner.describe(),
    send: async (raw) => { events.push(`send:${decodeMessage(raw, '').message?.type}`); await inner.send(raw); },
    ...transportOverride,
  };
  const coordinator = new ClusterCoordinator({
    settings: settings({ enabled }), version: '1.0.0', stateDirectory: '/unused', nodeId: 'node',
    logger: SILENT, clock, random: () => 0, transport,
  });
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) { clock.advance(Math.min(50, ms - elapsed)); await flush(); }
  }
  return { coordinator, clock, events, advance };
}

function gate(id: string, events: string[], overrides: Partial<ClusterConsumerGate> = {}): ClusterConsumerGate {
  return { id, surface, start: async () => { events.push(`${id}:start`); },
    stop: async () => { events.push(`${id}:stop`); }, ...overrides };
}

describe('cluster coordinator: stop during start', () => {
  for (const enabled of [true, false]) {
    test(`a stop while start() is still preparing leaves nothing running (election ${enabled ? 'on' : 'off'})`, async () => {
      const { coordinator, events, advance } = rig(enabled);
      const prepared = Promise.withResolvers<void>();
      coordinator.onPrepare(async () => {
        await prepared.promise;
        coordinator.register(gate('late', events));
      });
      const starting = coordinator.start();
      const stopping = coordinator.stop();
      prepared.resolve();
      await Promise.all([starting, stopping]);
      await advance(5_000);
      expect(events).not.toContain('transport:start');
      expect(events).not.toContain('late:start');
      expect(coordinator.running).toBe(false);
      // And a later start works as normal.
      await coordinator.start();
      await advance(1_100);
      expect(events).toContain('late:start');
      await coordinator.stop();
    });
  }

  test('a second start() joins the first rather than returning before it has finished', async () => {
    const { coordinator, events } = rig(false);
    const prepared = Promise.withResolvers<void>();
    coordinator.onPrepare(async () => {
      await prepared.promise;
      coordinator.register(gate('joined', events));
    });
    const first = coordinator.start();
    let secondDone = false;
    const second = coordinator.start().then(() => { secondDone = true; });
    await flush();
    expect(secondDone).toBe(false);
    prepared.resolve();
    await Promise.all([first, second]);
    expect(events).toContain('joined:start');
    await coordinator.stop();
  });
});

describe('cluster coordinator: a consumer that will not stop', () => {
  test('the surface is fenced, says so, and is not contested again on wake', async () => {
    const { coordinator, clock, events, advance } = rig();
    coordinator.registerOwned(gate('stuck', events, {
      stop: async () => { events.push('stuck:stop-rejected'); throw new Error('did not drain'); },
    }));
    await coordinator.start();
    await advance(1_100);
    expect(coordinator.holdsSurface(surface)).toBe(true);

    coordinator.reportConsumerConflict('terminated by other getUpdates request', surface);
    await advance(100);
    expect(events).toContain('stuck:stop-rejected');
    expect(events).not.toContain('send:RESIGN');
    expect(coordinator.status().surfaces[0]?.role).toBe('fenced');
    expect(coordinator.status().role).toBe('fenced');

    events.length = 0;
    clock.advanceWallOnly(600_000);
    await advance(10_000);
    expect(events).not.toContain('stuck:start');
    expect(events).not.toContain('send:CLAIM');
    expect(coordinator.status().surfaces[0]?.role).toBe('fenced');
    await coordinator.stop().catch(() => {});
  });
});

describe('cluster coordinator: a consumer added to a surface this node already holds', () => {
  test('is started without restarting the consumer that is already reading', async () => {
    const { coordinator, events, advance } = rig();
    coordinator.register(gate('first', events));
    await coordinator.start();
    await advance(1_100);
    expect(coordinator.holdsSurface(surface)).toBe(true);
    expect(events.filter((event) => event === 'first:start')).toHaveLength(1);

    coordinator.register(gate('sibling', events));
    await advance(100);
    expect(events.filter((event) => event === 'sibling:start')).toHaveLength(1);
    expect(events.filter((event) => event === 'first:start')).toHaveLength(1);
    await coordinator.stop();
  });

  test('a sibling that fails to start is retried while the first keeps reading', async () => {
    const { coordinator, events, advance } = rig();
    let attempts = 0;
    coordinator.register(gate('first', events));
    await coordinator.start();
    await advance(1_100);
    coordinator.register(gate('sibling', events, { start: async () => {
      attempts += 1;
      events.push('sibling:start');
      if (attempts === 1) throw new Error('not yet');
    } }));
    await advance(100);
    expect(coordinator.status().surfaces[0]?.consuming).toBe(true);
    await advance(40_000);
    expect(attempts).toBe(2);
    expect(events.filter((event) => event === 'first:start')).toHaveLength(1);
    await coordinator.stop();
  });
});

describe('cluster coordinator: status says how surfaces are decided', () => {
  test('a node that could not join the group reports a fallback, and holds what it reads', async () => {
    const { coordinator, events } = rig(true, { start: async () => { throw new Error('EADDRINUSE'); } });
    coordinator.register(gate('fallback', events));
    await coordinator.start();
    expect(events).toContain('fallback:start');
    expect(coordinator.status().coordination).toBe('ungated-fallback');
    expect(coordinator.holdsSurface(surface)).toBe(true);
    await coordinator.stop();
  });

  test('switched off and elected nodes say which they are', async () => {
    const off = rig(false);
    await off.coordinator.start();
    expect(off.coordinator.status().coordination).toBe('ungated-disabled');
    await off.coordinator.stop();
    const on = rig(true);
    await on.coordinator.start();
    expect(on.coordinator.status().coordination).toBe('elected');
    await on.coordinator.stop();
  });
});

describe('cluster election: a surface registered again while it stands down', () => {
  test('the old consumer stops before RESIGN, and the new one starts only after it', async () => {
    const clock = new FakeClusterClock();
    const bus = new MemoryClusterBus();
    const inner = bus.createTransport('node');
    const events: string[] = [];
    const registry = new ClusterSurfaceRegistry(SILENT);
    const election = new ClusterElection({
      nodeId: 'node', version: '1.0.0', settings: settings(), clock, logger: SILENT, registry, random: () => 0,
      transport: {
        start: (receive) => inner.start(receive), stop: () => inner.stop(), describe: () => inner.describe(),
        send: async (raw) => { events.push(`send:${decodeMessage(raw, '').message?.type}`); await inner.send(raw); },
      },
    });
    const oldStopped = Promise.withResolvers<void>();
    const unregisterOld = registry.register(gate('old', events, {
      stop: async () => { events.push('old:stopping'); await oldStopped.promise; events.push('old:stopped'); },
    }));
    await election.start();
    for (let i = 0; i < 30; i++) { clock.advance(50); await flush(); }
    expect(events).toContain('old:start');

    events.length = 0;
    unregisterOld();
    registry.register(gate('new', events));
    await flush();
    oldStopped.resolve();
    for (let i = 0; i < 60; i++) { clock.advance(50); await flush(); }

    const resign = events.indexOf('send:RESIGN');
    expect(resign).toBeGreaterThan(events.indexOf('old:stopped'));
    expect(events.indexOf('old:stopped')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('new:start')).toBeGreaterThan(resign);
    await election.stop();
  });
});

describe('cluster socket gates: a provider that refuses to connect', () => {
  function runtime(results: { ok: boolean; message: string }[], beforeAnswer?: () => void) {
    const calls: string[] = [];
    return {
      calls,
      start: async (kind: 'slack' | 'discord') => {
        calls.push(`${kind}:start`);
        beforeAnswer?.();
        const next = results.shift() ?? { ok: true, message: 'started' };
        return { ...next, surface: kind, status: { surface: kind, running: next.ok, configured: true, transport: 'socket-mode', metadata: {} } } as never;
      },
      stop: (kind: 'slack' | 'discord') => { calls.push(`${kind}:stop`); return { ok: true } as never; },
    };
  }

  test('a refused start rejects and hands the surface on', async () => {
    const reported = Promise.withResolvers<string>();
    const provider = runtime([{ ok: false, message: 'invalid_auth' }]);
    const socketGate = socketProviderGate(provider, 'slack', providerSurface('slack', 'T1'), (message) => reported.resolve(message));
    await expect(socketGate.start({ replayFromMs: null, reason: 'test' })).rejects.toThrow('invalid_auth');
    // The report is deferred off the gate's own start; wait for it, not for a clock.
    expect(await reported.promise).toBe('invalid_auth');
  });

  test('a start cancelled by the gate\'s own stop is not reported as a failure', async () => {
    const failures: string[] = [];
    const secondReport = Promise.withResolvers<void>();
    let socketGate: ClusterConsumerGate;
    const provider = runtime(
      [{ ok: false, message: 'cancelled by stop()' }, { ok: false, message: 'invalid_auth' }],
      (() => {
        let first = true;
        return () => { if (first) { first = false; void socketGate.stop('handoff'); } };
      })(),
    );
    socketGate = socketProviderGate(provider, 'slack', providerSurface('slack', 'T1'), (message) => {
      failures.push(message);
      secondReport.resolve();
    });
    await socketGate.start({ replayFromMs: null, reason: 'test' });
    // A genuine refusal after the cancelled one. Deferred reports run in the
    // order they were scheduled, so if the cancelled start had been reported
    // it would already be in `failures` ahead of this one.
    await expect(socketGate.start({ replayFromMs: null, reason: 'test' })).rejects.toThrow('invalid_auth');
    await secondReport.promise;
    expect(failures).toEqual(['invalid_auth']);
  });
});
