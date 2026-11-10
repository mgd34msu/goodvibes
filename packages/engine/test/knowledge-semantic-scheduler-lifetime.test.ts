import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.ts';
import type { KnowledgeSemanticSelfImproveInput, KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const empty = (): KnowledgeSemanticSelfImproveResult => ({ scannedGaps: 0, processedGaps: 0, createdGaps: 0,
  repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0, linkedRepairs: 0,
  blockedGaps: 0, closedGaps: 0, queuedTasks: 0, taskIds: [], ingestedSourceIds: [], errors: [] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-semantic-scheduler-owner-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const scheduled: Array<{ callback: () => void; signal: AbortSignal | undefined }> = [];
  const service = new KnowledgeSemanticService(store, { gapRepairer: async () => {},
    scheduleSeam(callback, _delayMs, signal) { scheduled.push({ callback, signal }); },
  });
  cleanups.push(async () => { await service.dispose(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  await store.init();
  return { service, scheduled, store };
}

test('semantic service forwards the original owner cancellation into its actual scheduling seam', async () => {
  const f = await fixture(), owner = new AbortController();
  const improve = spyOn(f.service, 'selfImprove').mockResolvedValue(empty());
  try {
    f.service.queueBackgroundSelfImprove({ knowledgeSpaceId: 'owner-space', reason: 'reindex', signal: owner.signal });
    expect(f.scheduled).toHaveLength(1);
    expect(f.scheduled[0]?.signal).toBeDefined(); expect(f.scheduled[0]?.signal?.aborted).toBe(false);
    owner.abort(new Error('Original scheduling owner retired'));
    expect(f.scheduled[0]?.signal?.aborted).toBe(true);
    // A timer seam can ignore cancellation. The actual scheduler still must
    // refuse this retired callback before starting model or repair work.
    f.scheduled[0]!.callback();
    await Promise.resolve();
    expect(improve).not.toHaveBeenCalled();
  } finally { improve.mockRestore(); }
});

test('semantic service disposal retires its timer and joins an actual admitted background operation', async () => {
  const f = await fixture(), caller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const inputs: Array<KnowledgeSemanticSelfImproveInput | undefined> = [];
  const improve = spyOn(f.service, 'selfImprove').mockImplementation(async input => {
    inputs.push(input); entered.resolve(); await release.promise; return empty();
  });
  let drained = false;
  try {
    f.service.queueBackgroundSelfImprove({ knowledgeSpaceId: 'owner-space', reason: 'reindex', signal: caller.signal });
    f.scheduled[0]!.callback(); await entered.promise;
    expect(inputs).toHaveLength(1); expect(inputs[0]?.signal?.aborted).toBe(false);
    const stopping = f.service.dispose();
    void stopping.then(() => { drained = true; });
    expect(f.service.dispose()).toBe(stopping);
    expect(f.scheduled[0]?.signal?.aborted).toBe(true); expect(inputs[0]?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false); await Promise.resolve(); expect(drained).toBe(false);
    f.service.queueBackgroundSelfImprove({ knowledgeSpaceId: 'later-space', reason: 'reindex' });
    expect(f.scheduled).toHaveLength(1);
    release.resolve(); await stopping; expect(drained).toBe(true);
    f.scheduled[0]!.callback(); await Promise.resolve(); expect(inputs).toHaveLength(1);
  } finally { release.resolve(); await f.service.dispose(); improve.mockRestore(); }
});


test('foreground self-improvement coalesces only the original caller and one retired owner cannot erase another active run', async () => {
  const f = await fixture(), ownerA = new AbortController(), ownerB = new AbortController();
  const enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>(), releaseB = Promise.withResolvers<void>();
  const originalInit = f.store.init.bind(f.store); let initializations = 0;
  // Retain the genuine original init and hold only the two actual run-level
  // boundaries. Public selfImprove admission still executes unmodified.
  const initialization = spyOn(f.store, 'init').mockImplementation(async () => {
    await originalInit(); initializations++;
    if (initializations === 2) { enteredA.resolve(); await releaseA.promise; }
    if (initializations === 4) { enteredB.resolve(); await releaseB.promise; }
  });
  const first = f.service.selfImprove({ knowledgeSpaceId: 'same-space', signal: ownerA.signal }).catch((error: unknown) => error);
  let second: Promise<unknown> | undefined;
  try {
    await Promise.race([enteredA.promise, first.then(() => { throw new Error('First owner ended before its native run initialized'); })]);
    second = f.service.selfImprove({ knowledgeSpaceId: 'same-space', signal: ownerB.signal }).catch((error: unknown) => error);
    await Promise.race([enteredB.promise, second.then(() => { throw new Error('Independent owner was suppressed before its native run initialized'); })]);
    const sameA = await f.service.selfImprove({ knowledgeSpaceId: 'same-space', signal: ownerA.signal, limit: 31 });
    expect(sameA.coalesced).toBe(true); expect(sameA.requestedLimit).toBe(31);
    ownerA.abort(new Error('Only original owner A retired')); releaseA.resolve(); await first;
    expect(ownerB.signal.aborted).toBe(false);
    const sameB = await f.service.selfImprove({ knowledgeSpaceId: 'same-space', signal: ownerB.signal, limit: 37 });
    expect(sameB.coalesced).toBe(true); expect(sameB.requestedLimit).toBe(37);
    releaseB.resolve(); expect(await second).toMatchObject({ scannedGaps: 0, errors: [] });
    const freshB = await f.service.selfImprove({ knowledgeSpaceId: 'same-space', signal: ownerB.signal });
    expect(freshB.coalesced).not.toBe(true); expect(freshB.errors).toEqual([]);
  } finally {
    releaseA.resolve(); releaseB.resolve(); await first; await second; initialization.mockRestore();
  }
});
