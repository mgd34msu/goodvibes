/**
 * cluster-holder-recovery.test.ts, a holder that cannot read its surface, a
 * holder that is slow to stop, a shutdown that fails part-way, and an old
 * datagram played back.
 */
import { describe, expect, test } from 'bun:test';
import { SurfaceElection } from '../platform/src/platform/cluster/election.js';
import { ClusterElection } from '../platform/src/platform/cluster/election-node.js';
import { ClusterCoordinator } from '../platform/src/platform/cluster/coordinator.js';
import { ClusterSurfaceRegistry } from '../platform/src/platform/cluster/surface-registry.js';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { ClusterHoldingsLedger } from '../platform/src/platform/cluster/holdings.js';
import { deriveClusterTiming } from '../platform/src/platform/cluster/timing.js';
import { encodeMessage } from '../platform/src/platform/cluster/protocol.js';
import { providerSurface } from '../platform/src/platform/cluster/surface-id.js';
import type { ClusterConsumerGate, ClusterLogger, ClusterMessage } from '../platform/src/platform/cluster/types.js';
import { settings, SILENT } from './cluster-harness.js';

async function turns(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function electionRig(host: { startConsumer?: () => Promise<void>; stopConsumer?: () => Promise<void> }) {
  const clock = new FakeClusterClock();
  const events: string[] = [];
  const errors: string[] = [];
  const timing = deriveClusterTiming(settings());
  const election = new SurfaceElection({
    surfaceId: 'fixture-surface', label: 'fixture', kind: 'inbox', random: () => 0,
    host: {
      nodeId: 'fixture-node', version: '3.1.2', clock, timing,
      ledger: new ClusterHoldingsLedger({ holderTtlMs: 3000, candidateTtlMs: 30000 }), canServe: () => true, tryReserveYield: () => false,
      logger: { debug() {}, info() {}, warn() {}, error: (message) => { errors.push(message); } },
      async send(type) { events.push(type); },
      async startConsumer() { events.push('start'); await host.startConsumer?.(); },
      async stopConsumer() { events.push('stop'); await host.stopConsumer?.(); },
    },
  });
  async function advanceBy(ms: number, step = 250): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += step) { clock.advance(Math.min(step, ms - elapsed)); await turns(); }
  }
  return { election, clock, events, errors, timing, advanceBy };
}

describe('a holder whose consumer never starts', () => {
  test('it stops claiming the surface and hands it on, so a node that can read it is not kept waiting', async () => {
    const rig = electionRig({ startConsumer: async () => { throw new Error('the bot token was revoked'); } });
    await rig.election.start();
    await rig.advanceBy(1_100);
    expect(rig.election.currentRole).toBe('master');
    // Retries back off up to the master timeout; give it plenty of rounds.
    for (let round = 0; round < 40 && !rig.events.includes('RESIGN'); round++) await rig.advanceBy(rig.timing.masterTimeoutMs);
    expect(rig.events.filter((event) => event === 'start').length).toBeGreaterThan(1);
    expect(rig.events).toContain('RESIGN');
    expect(rig.events.lastIndexOf('start')).toBeLessThan(rig.events.indexOf('RESIGN'));
    expect(rig.election.currentRole).not.toBe('master');
    expect(rig.errors.some((message) => message.includes('handing the surface to another node'))).toBe(true);
    await rig.election.stop();
  });

  test('a consumer that starts on a later try is never handed on', async () => {
    let attempts = 0;
    const rig = electionRig({ startConsumer: async () => { attempts += 1; if (attempts < 3) throw new Error('not yet'); } });
    await rig.election.start();
    await rig.advanceBy(1_100);
    await rig.advanceBy(rig.timing.masterTimeoutMs * 4);
    expect(attempts).toBe(3);
    expect(rig.events).not.toContain('RESIGN');
    expect(rig.election.currentRole).toBe('master');
    await rig.election.stop();
  });
});

describe('a holder that is slow to stop its consumer', () => {
  test('it keeps announcing itself until the consumer has stopped, and only then resigns', async () => {
    const release = Promise.withResolvers<void>();
    const rig = electionRig({ stopConsumer: () => release.promise });
    await rig.election.start();
    await rig.advanceBy(1_100);
    expect(rig.election.currentRole).toBe('master');
    const stopping = rig.election.stop();
    await turns();
    expect(rig.events).toContain('stop');
    const stopIndex = rig.events.lastIndexOf('stop');
    // The stop outlasts several heartbeat intervals.
    await rig.advanceBy(rig.timing.heartbeatMs * 6);
    const during = rig.events.slice(stopIndex + 1);
    expect(during.filter((event) => event === 'HEARTBEAT').length).toBeGreaterThan(1);
    expect(during).not.toContain('RESIGN');
    release.resolve();
    await stopping;
    const after = rig.events.slice(stopIndex + 1);
    expect(after.at(-1)).toBe('RESIGN');
    // Nothing is announced after the farewell.
    const final = [...rig.events];
    await rig.advanceBy(rig.timing.heartbeatMs * 6);
    expect(rig.events).toEqual(final);
  });

  test('a stop that finishes at once sends no extra heartbeat before the farewell', async () => {
    const rig = electionRig({});
    await rig.election.start();
    await rig.advanceBy(1_100);
    const before = rig.events.length;
    await rig.election.stop();
    expect(rig.events.slice(before)).toEqual(['stop', 'RESIGN']);
  });
});

describe('shutting down with the election off', () => {
  const surfaces = [providerSurface('custom', 'recovery-a'), providerSurface('custom', 'recovery-b')];

  function gate(id: string, surface: ClusterConsumerGate['surface'], events: string[], failStop: boolean): ClusterConsumerGate {
    return {
      id, surface,
      start: async () => { events.push(`${id}:start`); },
      stop: async () => { events.push(`${id}:stop`); if (failStop) throw new Error(`${id} would not stop`); },
    };
  }

  test.each([0, 1])('one surface that will not stop does not leave the others running (failing surface %i)', async (failing) => {
    const events: string[] = [];
    const errors: string[] = [];
    const logger: ClusterLogger = { ...SILENT, error(message) { errors.push(message); } };
    const coordinator = new ClusterCoordinator({
      settings: settings({ enabled: false }), version: '1.0.0', stateDirectory: '/unused', nodeId: 'ungated-node', logger,
      clock: new FakeClusterClock(), random: () => 0,
      transport: { start: async () => {}, stop: async () => {}, send: async () => {}, describe: () => ({ mode: 'in-memory', group: '', port: 0, peers: [] }) },
    });
    surfaces.forEach((surface, index) => { coordinator.registerOwned(gate(`gate-${index}`, surface, events, index === failing)); });
    await coordinator.start();
    await turns();
    await coordinator.stop().catch(() => undefined);
    for (let index = 0; index < surfaces.length; index++) expect(events).toContain(`gate-${index}:stop`);
    expect(coordinator.status().consumersRunning).toBe(false);
  });
});

describe('an old datagram played back', () => {
  function rig() {
    const clock = new FakeClusterClock();
    let deliver: (raw: string) => void = () => {};
    const config = settings();
    const node = new ClusterElection({
      nodeId: 'listener', version: '1.0.0', settings: config, clock, logger: SILENT, registry: new ClusterSurfaceRegistry(SILENT),
      transport: {
        start: async (receive) => { deliver = receive; },
        send: async () => {}, stop: async () => {},
        describe: () => ({ mode: 'in-memory', group: 'test', port: 0, peers: [] }),
      },
    });
    const message = (type: ClusterMessage['type'], seq: number, ts: number): string => encodeMessage(
      { v: 1, type, surfaceId: null, nodeId: 'peer', nodeVersion: '1.0.0', seq, ts }, config.secret,
    );
    return { node, clock, deliver: (raw: string) => deliver(raw), message };
  }

  test('a captured datagram with a counter above the peer\'s current one is not accepted', async () => {
    const { node, clock, deliver, message } = rig();
    await node.start();
    const now = clock.now();
    deliver(message('PROBE', 10, now));
    expect(node.status().peers[0]?.lastMessageType).toBe('PROBE');
    // Captured three minutes earlier (inside the clock-skew window the decoder
    // accepts), before the peer restarted and its counter reset.
    deliver(message('HEARTBEAT', 500, now - 3 * 60_000));
    expect(node.status().peers[0]?.lastMessageType).toBe('PROBE');
    await node.stop();
  });

  test('a peer whose clock is a little behind is still heard', async () => {
    const { node, clock, deliver, message } = rig();
    await node.start();
    const now = clock.now();
    deliver(message('PROBE', 10, now));
    deliver(message('HEARTBEAT', 11, now - 30_000));
    expect(node.status().peers[0]?.lastMessageType).toBe('HEARTBEAT');
    await node.stop();
  });

  test('a restarted peer, whose counter starts over and whose clock moved on, is heard', async () => {
    const { node, clock, deliver, message } = rig();
    await node.start();
    const now = clock.now();
    deliver(message('PROBE', 900, now));
    deliver(message('HEARTBEAT', 1, now + 60_000));
    expect(node.status().peers[0]?.lastMessageType).toBe('HEARTBEAT');
    await node.stop();
  });

  test('a signed datagram from an hour ago is dropped even when no peer has been heard yet', async () => {
    const { node, clock, deliver, message } = rig();
    await node.start();
    deliver(message('PROBE', 1, clock.now() - 60 * 60_000));
    expect(node.status().peers).toHaveLength(0);
    deliver(message('PROBE', 2, clock.now()));
    expect(node.status().peers[0]?.lastMessageType).toBe('PROBE');
    await node.stop();
  });
});
