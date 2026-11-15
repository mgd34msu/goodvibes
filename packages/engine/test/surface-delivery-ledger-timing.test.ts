import { expect, test } from 'bun:test';
import { recordSurfaceDeliveryAttempt } from '../platform/src/platform/daemon/facade-composition.js';
import type { ResolvedDaemonFacadeRuntime } from '../platform/src/platform/daemon/facade-types.js';

function ledger() {
  const synced: { startedAt?: number; endedAt?: number; status: string; target: { surfaceKind: string } }[] = [];
  const runtime = { runtimeDispatch: { syncDeliveryAttempt: (record: never) => { synced.push(record); } } } as unknown as ResolvedDaemonFacadeRuntime;
  return { synced, record: (phase: 'queued' | 'started' | 'succeeded' | 'failed', surfaceKind: string, starts: Map<string, number>) =>
    recordSurfaceDeliveryAttempt(runtime, { deliveryId: 'delivery-1', agentId: 'agent-1', surfaceKind, targetId: 'chat', phase }, starts) };
}

test('a finished delivery keeps the start time of its started phase, so the ledger shows how long it took', () => {
  const { synced, record } = ledger(); const starts = new Map<string, number>();
  let now = 1_000;
  const clock = Date.now; Date.now = () => now;
  try {
    record('queued', 'telegram', starts);
    now = 2_000; record('started', 'telegram', starts);
    now = 2_750; record('succeeded', 'telegram', starts);
  } finally { Date.now = clock; }
  expect(synced.map(entry => [entry.status, entry.startedAt, entry.endedAt])).toEqual([['pending', undefined, undefined], ['sending', 2_000, undefined], ['sent', 2_000, 2_750]]);
  expect(starts.size).toBe(0);
});

test('a surface kind outside the route list keeps its own name in the ledger', () => {
  const { synced, record } = ledger();
  record('queued', 'email', new Map());
  expect(synced[0]!.target.surfaceKind).toBe('email');
});
