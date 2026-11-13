import { describe, expect, test } from 'bun:test';
import { ClusterElection } from '../platform/src/platform/cluster/election-node.js';
import { ClusterSurfaceRegistry } from '../platform/src/platform/cluster/surface-registry.js';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { settings } from './cluster-harness.js';
import type { ClusterLogger, ClusterTransport } from '../platform/src/platform/cluster/types.js';

const SILENT: ClusterLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function rig(failStarts: number) {
  let startCalls = 0;
  let stopCalls = 0;
  let listening = false;
  const transport: ClusterTransport = {
    start: async () => {
      startCalls++;
      if (startCalls <= failStarts) throw new Error('bind failed');
      listening = true;
    },
    send: async () => {},
    stop: async () => { stopCalls++; listening = false; },
    describe: () => ({ mode: 'in-memory', group: 'test', port: 0, peers: [] }),
  };
  const clock = new FakeClusterClock();
  const registry = new ClusterSurfaceRegistry(SILENT);
  const node = new ClusterElection({
    nodeId: 'node-a', version: '1.0.0', settings: settings(), transport, clock, logger: SILENT, registry,
  });
  return { node, clock, registry, calls: () => ({ startCalls, stopCalls, listening }) };
}

describe('cluster node start', () => {
  test('a failed transport start leaves the node startable', async () => {
    const { node, calls } = rig(1);
    await expect(node.start()).rejects.toThrow('bind failed');
    await node.start(); // retry must actually run, not no-op on a stale running flag
    expect(calls().startCalls).toBe(2);
    expect(calls().listening).toBe(true);
    await node.stop();
    expect(calls().listening).toBe(false);
  });

  test('a failed start leaves no watchdog timer or registry subscription behind', async () => {
    const { node, clock, registry } = rig(1);
    await expect(node.start()).rejects.toThrow('bind failed');
    // A watchdog armed by a failed start would tick and keep re-arming forever.
    expect(clock.pendingTimers).toBe(0);
    expect((registry as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });
});
