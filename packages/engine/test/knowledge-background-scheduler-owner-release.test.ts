import { expect, test } from 'bun:test';
import { BackgroundSelfImproveScheduler } from '../platform/src/platform/knowledge/semantic/background-scheduler.js';
import type { KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.js';

function result(candidateGaps: number): KnowledgeSemanticSelfImproveResult {
  return { scannedGaps: 0, candidateGaps, createdGaps: 0, repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0,
    searched: 0, ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0, closedGaps: 0, queuedTasks: 0,
    taskIds: [], ingestedSourceIds: [], errors: [] };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(candidateGaps: number, clock = { now: 0 }) {
  const timers: (() => void)[] = [];
  const scheduler = new BackgroundSelfImproveScheduler({
    run: async () => result(candidateGaps), enabled: () => true,
    minDelayMs: () => 0, backoffMs: () => 3_600_000, now: () => clock.now,
    schedule(callback) { timers.push(callback); },
  });
  // The owner table is private; its size is the retained-memory cost this guards.
  const ownerCount = () => (scheduler as unknown as { owners: Map<unknown, unknown> }).owners.size;
  return { scheduler, timers, ownerCount };
}

test('callers whose runs all settled leave no owner behind, so long-lived signals do not accumulate them', async () => {
  const f = fixture(1);
  const callers = Array.from({ length: 50 }, () => new AbortController());
  for (const caller of callers) f.scheduler.queue({ signal: caller.signal, knowledgeSpaceId: 'space', gapIds: ['g'], reason: 'answer' });
  expect(f.ownerCount()).toBe(50);
  for (const fire of f.timers.splice(0)) { fire(); await flush(); }
  expect(f.ownerCount()).toBe(0);
  await f.scheduler.dispose();
});

test('a caller still inside its zero-gap backoff keeps its owner', async () => {
  const f = fixture(0);
  const caller = new AbortController();
  f.scheduler.queue({ signal: caller.signal, knowledgeSpaceId: 'space', reason: 'reindex' });
  for (const fire of f.timers.splice(0)) { fire(); await flush(); }
  expect(f.ownerCount()).toBe(1);
  await f.scheduler.dispose();
});

test('an owner whose zero-gap backoff has lapsed is released by the next request from any caller', async () => {
  const clock = { now: 0 };
  const f = fixture(0, clock);
  const callers = Array.from({ length: 5 }, () => new AbortController());
  for (const caller of callers) f.scheduler.queue({ signal: caller.signal, knowledgeSpaceId: 'space', reason: 'reindex' });
  for (const fire of f.timers.splice(0)) { fire(); await flush(); }
  expect(f.ownerCount()).toBe(5);
  clock.now = 3_600_001;
  f.scheduler.queue({ signal: new AbortController().signal, knowledgeSpaceId: 'other', reason: 'reindex' });
  expect(f.ownerCount()).toBe(1);
  await f.scheduler.dispose();
});
