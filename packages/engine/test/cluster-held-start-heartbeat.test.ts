import { expect, test } from 'bun:test';
import { SurfaceElection } from '../platform/src/platform/cluster/election.js';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { ClusterHoldingsLedger } from '../platform/src/platform/cluster/holdings.js';
import { deriveClusterTiming } from '../platform/src/platform/cluster/timing.js';
import { settings } from './cluster-harness.js';
async function turns() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test.each([false, true])('held startup heartbeats remain owned, and shutdown joins pending send (%s rejects) then original consumer drain', async rejects => {
  const clock = new FakeClusterClock(), start = Promise.withResolvers<void>(), stop = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const events: string[] = [];
  let holdHeartbeat = false;
  const election = new SurfaceElection({ surfaceId: 'fixture-surface', label: 'fixture', kind: 'inbox', random: () => 0, host: {
    nodeId: 'fixture-node', version: '3.1.2', clock, timing: deriveClusterTiming(settings()),
    ledger: new ClusterHoldingsLedger({ holderTtlMs: 3000, candidateTtlMs: 30000 }), canServe: () => true, tryReserveYield: () => false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    async send(type) { events.push(type); if (type === 'HEARTBEAT' && holdHeartbeat) { entered.resolve(); try { await send.promise; } finally { events.push('send-drained'); } } },
    async startConsumer() { events.push('start'); await start.promise; events.push('started'); },
    async stopConsumer() { events.push('stop'); await stop.promise; events.push('stopped'); },
  } });
  await election.start(); clock.advance(1100); await turns();
  expect(events).toContain('start'); expect(events).not.toContain('started');
  clock.advance(4000); await turns();
  expect(events).toContain('HEARTBEAT'); expect(election.status().consuming).toBe(false);
  start.resolve(); await election.settled();
  holdHeartbeat = true; clock.advance(1000); await entered.promise;
  const stopping = election.stop(); let closed = false; void stopping.then(() => { closed = true; }); await turns();
  expect(closed).toBe(false); expect(events).not.toContain('stop'); expect(events).not.toContain('RESIGN');
  if (rejects) send.reject(Error('Synthetic heartbeat transport failure')); else send.resolve();
  await turns(); expect(events).toContain('stop'); expect(events).not.toContain('RESIGN'); expect(closed).toBe(false);
  stop.resolve(); await stopping;
  expect(events.indexOf('send-drained')).toBeLessThan(events.indexOf('stop'));
  expect(events.indexOf('stopped')).toBeLessThan(events.indexOf('RESIGN'));
  const final = [...events]; clock.advance(10000); await turns(); expect(events).toEqual(final); expect(election.currentRole).toBe('stopped');
});
