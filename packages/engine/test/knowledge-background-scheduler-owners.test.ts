import { expect, test } from 'bun:test';
import { BackgroundSelfImproveScheduler, MAX_PENDING_BACKGROUND_KEYS } from '../platform/src/platform/knowledge/semantic/background-scheduler.js';
import type { KnowledgeSemanticSelfImproveInput, KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.js';

function result(candidateGaps = 1): KnowledgeSemanticSelfImproveResult {
  return { scannedGaps: 0, candidateGaps, createdGaps: 0, repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0,
    searched: 0, ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0, closedGaps: 0, queuedTasks: 0,
    taskIds: [], ingestedSourceIds: [], errors: [] };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(options: { run?: (input: KnowledgeSemanticSelfImproveInput) => Promise<KnowledgeSemanticSelfImproveResult>; paused?: () => boolean } = {}) {
  let now = 0;
  const timers: { callback: () => void; at: number; signal: AbortSignal | undefined }[] = [];
  const runs: KnowledgeSemanticSelfImproveInput[] = [];
  const scheduler = new BackgroundSelfImproveScheduler({
    run(input) { runs.push(input); return options.run?.(input) ?? Promise.resolve(result()); },
    enabled: () => true, isPaused: options.paused,
    minDelayMs: () => 5_000, backoffMs: () => 3_600_000, now: () => now,
    schedule(callback, delayMs, signal) { timers.push({ callback, at: now + delayMs, signal }); },
  });
  const advance = async (duration: number) => {
    now += duration;
    for (;;) {
      const index = timers.findIndex(timer => timer.at <= now);
      if (index < 0) break;
      timers.splice(index, 1)[0]!.callback(); await flush();
    }
  };
  return { scheduler, runs, timers, advance };
}

test('identical scopes retain independent caller owners and cancellation cannot transfer between them', async () => {
  const a = new AbortController(), b = new AbortController(), f = fixture();
  f.scheduler.queue({ signal: a.signal, knowledgeSpaceId: 'same', gapIds: ['a'], reason: 'answer' });
  f.scheduler.queue({ signal: b.signal, knowledgeSpaceId: 'same', gapIds: ['b'], reason: 'answer' });
  expect(f.timers).toHaveLength(2);
  const firstSignal = f.timers[0]!.signal, secondSignal = f.timers[1]!.signal;
  expect(firstSignal).not.toBe(secondSignal); a.abort();
  expect(firstSignal?.aborted).toBe(true); expect(secondSignal?.aborted).toBe(false);
  await f.advance(5_000);
  expect(f.runs).toHaveLength(1); expect(f.runs[0]!.gapIds).toEqual(['b']);
  expect(f.runs[0]!.signal).toBe(secondSignal);
  await f.scheduler.dispose();
});

test('zero-gap backoff belongs to the exact caller and cannot suppress another caller', async () => {
  const a = new AbortController(), b = new AbortController(), f = fixture({ run: async () => result(0) });
  const input = { knowledgeSpaceId: 'same', reason: 'reindex' as const };
  f.scheduler.queue({ ...input, signal: a.signal }); await f.advance(5_000);
  f.scheduler.queue({ ...input, signal: a.signal });
  f.scheduler.queue({ ...input, signal: b.signal }); await f.advance(5_000);
  expect(f.runs).toHaveLength(2); expect(f.runs[0]!.signal).not.toBe(f.runs[1]!.signal);
  await f.scheduler.dispose();
});

test('same-owner pending force intent is preserved even without new gap IDs', async () => {
  const owner = new AbortController(), f = fixture();
  f.scheduler.queue({ signal: owner.signal, knowledgeSpaceId: 'same', reason: 'answer', force: false, gapIds: ['original'] });
  f.scheduler.queue({ signal: owner.signal, knowledgeSpaceId: 'same', reason: 'answer', force: true });
  expect(f.timers).toHaveLength(1); await f.advance(5_000);
  expect(f.runs).toHaveLength(1); expect(f.runs[0]!.force).toBe(true); expect(f.runs[0]!.gapIds).toEqual(['original']);
  await f.scheduler.dispose();
});

test('cardinality collapse retains its originating owner and force while independent callers keep their scope', async () => {
  const a = new AbortController(), b = new AbortController(), f = fixture();
  for (let i = 0; i < MAX_PENDING_BACKGROUND_KEYS; i++) f.scheduler.queue({ signal: a.signal, sourceIds: [`a-${i}`], reason: 'ingest' });
  f.scheduler.queue({ signal: a.signal, sourceIds: ['overflow-a'], reason: 'ingest', force: false });
  f.scheduler.queue({ signal: a.signal, sourceIds: ['overflow-b'], reason: 'ingest', force: true });
  f.scheduler.queue({ signal: b.signal, sourceIds: ['independent'], reason: 'ingest' });
  expect(f.timers).toHaveLength(MAX_PENDING_BACKGROUND_KEYS + 2);
  const aSignal = f.timers[0]!.signal, bSignal = f.timers.at(-1)!.signal;
  await f.advance(5_000);
  const sweep = f.runs.find(input => !input.sourceIds?.length && !input.knowledgeSpaceId);
  expect(sweep?.signal).toBe(aSignal); expect(sweep?.force).toBe(true);
  expect(f.runs.find(input => input.sourceIds?.[0] === 'independent')?.signal).toBe(bSignal);
  a.abort(); expect(aSignal?.aborted).toBe(true); expect(bSignal?.aborted).toBe(false);
  await f.scheduler.dispose();
});

test('aborting an overflow owner cancels its scoped and collapsed timers without cancelling another owner', async () => {
  const a = new AbortController(), b = new AbortController(), f = fixture();
  for (let i = 0; i < 20; i++) f.scheduler.queue({ signal: a.signal, sourceIds: [`a-${i}`], reason: 'ingest', force: true });
  f.scheduler.queue({ signal: b.signal, sourceIds: ['b'], reason: 'ingest' });
  a.abort(); await f.advance(5_000);
  expect(f.runs).toHaveLength(1); expect(f.runs[0]!.sourceIds).toEqual(['b']);
  expect(f.runs[0]!.signal?.aborted).toBe(false); await f.scheduler.dispose();
});

test('pause rearming retains the same owner and an aborted stale callback cannot rearm itself', async () => {
  const owner = new AbortController(), f = fixture({ paused: () => true });
  f.scheduler.queue({ signal: owner.signal, knowledgeSpaceId: 'paused' });
  const signal = f.timers[0]!.signal; await f.advance(5_000);
  expect(f.runs).toHaveLength(0); expect(f.timers).toHaveLength(1); expect(f.timers[0]!.signal).toBe(signal);
  const stale = f.timers.pop()!.callback; owner.abort(); stale();
  expect(f.timers).toHaveLength(0); expect(f.runs).toHaveLength(0); await f.scheduler.dispose();
});

test('same-owner force arriving mid-run rearms once under that same owner', async () => {
  const owner = new AbortController(), pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>();
  let first = true;
  const f = fixture({ run: async () => { if (first) { first = false; return pending.promise; } return result(); } });
  const input = { signal: owner.signal, knowledgeSpaceId: 'same', reason: 'answer' as const };
  f.scheduler.queue(input); await f.advance(5_000);
  f.scheduler.queue({ ...input, force: true }); pending.resolve(result(0)); await flush();
  await f.advance(5_000);
  expect(f.runs).toHaveLength(2); expect(f.runs[1]!.force).toBe(true);
  expect(f.runs[1]!.signal).toBe(f.runs[0]!.signal); await f.scheduler.dispose();
});

test('owner abort during a run retires its forced gap rearm without dropping independent work', async () => {
  const a = new AbortController(), b = new AbortController(), pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>();
  let first = true;
  const f = fixture({ run: async () => { if (first) { first = false; return pending.promise; } return result(); } });
  f.scheduler.queue({ signal: a.signal, knowledgeSpaceId: 'same', gapIds: ['a'] }); await f.advance(5_000);
  f.scheduler.queue({ signal: a.signal, knowledgeSpaceId: 'same', gapIds: ['a-later'], force: true });
  f.scheduler.queue({ signal: b.signal, knowledgeSpaceId: 'same', gapIds: ['b'] });
  a.abort(); pending.resolve(result(0)); await flush(); await f.advance(5_000);
  expect(f.runs).toHaveLength(2); expect(f.runs[0]!.signal?.aborted).toBe(true);
  expect(f.runs[1]!.gapIds).toEqual(['b']); expect(f.runs[1]!.signal?.aborted).toBe(false);
  await f.scheduler.dispose();
});

test('dispose aborts timers and active runs synchronously and waits for their actual drainage', async () => {
  const pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>(), f = fixture({ run: () => pending.promise });
  f.scheduler.queue({ knowledgeSpaceId: 'running' }); await f.advance(5_000);
  f.scheduler.queue({ knowledgeSpaceId: 'queued' });
  const stale = f.timers[0]!.callback, disposing = f.scheduler.dispose();
  expect(f.scheduler.dispose()).toBe(disposing);
  expect(f.runs[0]!.signal?.aborted).toBe(true); expect(f.timers[0]!.signal?.aborted).toBe(true);
  let drained = false; void disposing.then(() => { drained = true; }); await flush(); expect(drained).toBe(false);
  stale(); f.scheduler.queue({ knowledgeSpaceId: 'late' }); expect(f.runs).toHaveLength(1); expect(f.timers).toHaveLength(1);
  pending.resolve(result()); await disposing; expect(drained).toBe(true);
});

test('a consumed callback cannot execute a later rearmed slot before its own floor', async () => {
  const pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>(), f = fixture({ run: () => pending.promise });
  const input = { knowledgeSpaceId: 'same', reason: 'answer' as const };
  f.scheduler.queue(input); const old = f.timers[0]!.callback; await f.advance(5_000);
  f.scheduler.queue({ ...input, gapIds: ['new'] }); pending.resolve(result(0)); await flush();
  old(); expect(f.runs).toHaveLength(1); expect(f.timers).toHaveLength(1);
  await f.scheduler.dispose();
});

test('disposal owns a late run rejection and drains before releasing its join', async () => {
  const pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>(), f = fixture({ run: () => pending.promise });
  const unhandled: unknown[] = [], observer = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', observer);
  try {
    f.scheduler.queue({ knowledgeSpaceId: 'running' }); await f.advance(5_000);
    const disposing = f.scheduler.dispose(); pending.reject(new Error('late original run rejection'));
    await disposing; await flush(); expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', observer); }
});

test('a run callback that disposes synchronously is already registered in that disposal join', async () => {
  const pending = Promise.withResolvers<KnowledgeSemanticSelfImproveResult>();
  let disposing: Promise<void> | undefined;
  const f = fixture({ run: () => { disposing = f.scheduler.dispose(); return pending.promise; } });
  f.scheduler.queue({ knowledgeSpaceId: 'reentrant-close' }); await f.advance(5_000);
  expect(disposing).toBeDefined(); expect(f.runs[0]!.signal?.aborted).toBe(true);
  let drained = false; void disposing!.then(() => { drained = true; }); await flush(); expect(drained).toBe(false);
  pending.resolve(result()); await disposing; expect(drained).toBe(true);
});
