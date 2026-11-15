/**
 * Per-surface role safety: who may contest a surface, and when.
 *
 * Each test drives the real election over the in-memory bus and fake clock
 * from cluster-harness.ts, with consumers whose start or stop the test holds
 * or fails, because those are the windows where a node used to promote itself
 * beside a holder, retry against a conflict faster than its backoff, or come
 * back after it was stopped.
 */
import { describe, expect, test } from 'bun:test';
import { SurfaceElection } from '../platform/src/platform/cluster/election.js';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { ClusterHoldingsLedger } from '../platform/src/platform/cluster/holdings.js';
import { deriveClusterTiming } from '../platform/src/platform/cluster/timing.js';
import {
  addNode,
  advance,
  createWorld,
  flush,
  keyFor,
  roleOf,
  settings,
  startNode,
  SILENT,
  type TestNode,
  type World,
} from './cluster-harness.js';

const SURFACE = 'ntfy-roles';

/** One surface's election with no peers: every datagram is recorded and goes nowhere. */
function directElection(clock: FakeClusterClock, sent: string[]): SurfaceElection {
  return new SurfaceElection({
    surfaceId: 'roles-direct', label: 'roles', kind: 'custom', random: () => 0,
    host: {
      nodeId: 'direct', version: '1.0.0', clock, timing: deriveClusterTiming(settings()),
      ledger: new ClusterHoldingsLedger({ holderTtlMs: 3_000, candidateTtlMs: 9_000 }),
      logger: SILENT, canServe: () => true, tryReserveYield: () => false,
      send: async (type) => { sent.push(type); }, startConsumer: async () => {}, stopConsumer: async () => {},
    },
  });
}

/** Register a consumer whose start does not finish until the test says so. */
function registerHeldGate(world: World, node: TestNode, held: string[]): () => void {
  let resolve: () => void = () => {};
  const gate = new Promise<void>((done) => { resolve = done; });
  node.registry.register({
    id: `${node.id}-held`,
    surface: keyFor(SURFACE),
    start: async () => {
      held.push(node.id);
      world.events.push(`${node.id}:${SURFACE}:start-entered`);
      await gate;
    },
    stop: async () => {},
  });
  return resolve;
}

/**
 * Heartbeats well apart from the boot probe and the election window, the
 * shape of the real 30/90/3 defaults, so a holder's periodic heartbeat cannot
 * paper over the window between taking a surface and its consumer coming up.
 */
const SLOW_HEARTBEAT = { heartbeatSeconds: 3, masterTimeoutSeconds: 9, bootProbeSeconds: 1 };

describe('cluster surface roles: a holder still starting its consumer', () => {
  test('no standby promotes itself while the new holder\'s consumer start is in flight', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-h', surfaces: [SURFACE], settings: SLOW_HEARTBEAT });
    await startNode(world, holder);
    await advance(world, 1_100);

    const entered: string[] = [];
    const releases: (() => void)[] = [];
    const a = addNode(world, { id: 'node-a', surfaces: [], jitter: 0, settings: SLOW_HEARTBEAT });
    releases.push(registerHeldGate(world, a, entered));
    const b = addNode(world, { id: 'node-b', surfaces: [], jitter: 0.99, settings: SLOW_HEARTBEAT });
    releases.push(registerHeldGate(world, b, entered));
    await startNode(world, a);
    // B's watchdog ticks just after A's, so B notices the dead holder moments
    // after A has already claimed the surface.
    await advance(world, 500);
    await startNode(world, b);
    await advance(world, 4_000);
    expect(roleOf(a, SURFACE)).toBe('standby');
    expect(roleOf(b, SURFACE)).toBe('standby');

    // The holder dies without a word, and whoever wins next takes many
    // seconds to bring its consumer up.
    world.bus.partition(holder.transport, 'crashed');
    await advance(world, 30_000);

    expect(entered).toHaveLength(1);
    const masters = [a, b].filter((node) => roleOf(node, SURFACE) === 'master');
    expect(masters).toHaveLength(1);
    for (const release of releases) release();
    await flush(world);
  });

  test('a booting node is answered by a holder whose consumer start is still in flight', async () => {
    const world = createWorld();
    const entered: string[] = [];
    const first = addNode(world, { id: 'node-a', surfaces: [], settings: SLOW_HEARTBEAT });
    const release = registerHeldGate(world, first, entered);
    await startNode(world, first);
    await advance(world, 1_100);
    expect(entered).toEqual(['node-a']);

    const late = addNode(world, { id: 'node-b', surfaces: [], settings: SLOW_HEARTBEAT });
    registerHeldGate(world, late, entered);
    await startNode(world, late);
    await advance(world, 5_000);

    expect(entered).toEqual(['node-a']);
    expect(roleOf(late, SURFACE)).toBe('standby');
    release();
    await flush(world);
  });
});

describe('cluster surface roles: consumer conflict backoff', () => {
  test('repeated conflicts back off past the crash timeout instead of retrying at it', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, node);
    await advance(world, 1_100);

    const gapsMs: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      expect(roleOf(node, SURFACE)).toBe('master');
      node.election.reportConsumerConflict('terminated by other getUpdates request');
      await flush(world);
      let waited = 0;
      while (roleOf(node, SURFACE) !== 'master' && waited < 120_000) {
        await advance(world, 100);
        waited += 100;
      }
      gapsMs.push(waited);
    }
    const timing = deriveClusterTiming(settings());
    expect(gapsMs[gapsMs.length - 1]!).toBeGreaterThan(timing.masterTimeoutMs * 2);
    expect(gapsMs[gapsMs.length - 1]!).toBeLessThanOrEqual(timing.consumerConflictBackoffMaxMs + 2_000);
  });
});

describe('cluster surface roles: a stop is final until the next start', () => {
  test('a conflict re-probe that fires as stop() is queued does not rejoin the election', async () => {
    const clock = new FakeClusterClock();
    const sent: string[] = [];
    const election = directElection(clock, sent);
    await election.start();
    clock.advance(1_100);
    await election.settled();
    expect(election.currentRole).toBe('master');
    election.reportConsumerConflict('refused');
    await election.settled();
    expect(election.currentRole).toBe('standby');

    // The stop is queued, and the backoff timer fires before it runs.
    const stopping = election.stop();
    clock.advance(60_000);
    await stopping;
    clock.advance(60_000);
    await election.settled();
    expect(election.currentRole).toBe('stopped');
  });

  test('start() and stop() in the same tick leave the surface stopped', async () => {
    const clock = new FakeClusterClock();
    const sent: string[] = [];
    const election = directElection(clock, sent);
    const starting = election.start();
    const stopping = election.stop();
    await Promise.all([starting, stopping]);
    clock.advance(10_000);
    await election.settled();
    expect(election.currentRole).toBe('stopped');
    expect(sent).not.toContain('CLAIM');
  });
});

describe('cluster surface roles: a consumer that fails to start', () => {
  test('a holder whose consumers all fail to start reports not consuming and retries', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [] });
    let attempts = 0;
    node.registry.register({
      id: 'flaky',
      surface: keyFor(SURFACE),
      start: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('provider unreachable');
      },
      stop: async () => {},
    });
    await startNode(world, node);
    await advance(world, 1_100);
    expect(roleOf(node, SURFACE)).toBe('master');
    expect(attempts).toBe(1);
    const status = node.election.status().surfaces[0]!;
    expect(status.consuming).toBe(false);

    await advance(world, 1_100);
    expect(attempts).toBe(2);
    expect(node.election.status().surfaces[0]!.consuming).toBe(true);
    expect(roleOf(node, SURFACE)).toBe('master');
  });
});
