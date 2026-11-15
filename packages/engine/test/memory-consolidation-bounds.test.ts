import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  runMemoryConsolidation,
} from '../platform/src/platform/state/index.js';
import type {
  MemoryConsolidationRegistry,
  MemoryConsolidationUsageSignal,
  MemoryRecord,
  ResolvedMemoryConsolidationConfig,
} from '../platform/src/platform/state/index.js';
import type { MemoryReviewPatch } from '../platform/src/platform/state/memory-store.js';
import { MemoryConsolidationScheduler } from '../platform/src/platform/state/memory-consolidation-scheduler.ts';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

/**
 * What a consolidation pass may do to a person's memory: it decays only what
 * the usage record shows was never referenced, it reads a bounded number of
 * pairs, it stops cleanly when a write is refused, and a failed pass is not
 * started over on the next wake.
 */
const readings = useMemoryReadings();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const cfg = (over: Partial<ResolvedMemoryConsolidationConfig> = {}): ResolvedMemoryConsolidationConfig => ({
  ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  ...over,
});

function rec(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, scope: 'project', cls: 'fact', summary: `fact ${id}`, tags: [], provenance: [], reviewState: 'fresh',
    confidence: 60, createdAt: NOW - 60 * DAY_MS, updatedAt: NOW - 60 * DAY_MS, ...overrides,
  };
}

class FakeRegistry implements MemoryConsolidationRegistry {
  readonly records = new Map<string, MemoryRecord>();
  reviewCalls = 0;
  /** Throws on this review call (1-based); never when undefined. */
  failReviewAt: number | undefined;
  constructor(records: readonly MemoryRecord[]) { for (const r of records) this.records.set(r.id, r); }
  getAll(): readonly MemoryRecord[] { return [...this.records.values()]; }
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    this.reviewCalls += 1;
    if (this.reviewCalls === this.failReviewAt) throw new Error('memory file changed on disk');
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: MemoryRecord = {
      ...existing,
      reviewState: patch.state ?? existing.reviewState,
      confidence: patch.confidence ?? existing.confidence,
      updatedAt: NOW,
      ...(patch.reviewedBy !== undefined ? { reviewedBy: patch.reviewedBy } : {}),
    };
    this.records.set(id, updated);
    return updated;
  }
  update(id: string, patch: { tags?: string[] }): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...(patch.tags ? { tags: patch.tags } : {}), updatedAt: NOW };
    this.records.set(id, updated);
    return updated;
  }
}

describe('decay needs a usage record', () => {
  const aged = [rec('old', { updatedAt: NOW - 50 * DAY_MS })];
  const decayConfig = cfg({ decayAgeDays: 45, decayConfidenceStep: 10, archiveConfidenceFloor: 40 });

  test('with no usage lookup, an aged record keeps its confidence', async () => {
    const reg = new FakeRegistry(aged);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: decayConfig, now: NOW, trigger: 'idle', idle: true });
    expect(receipt.decayed).toEqual([]);
    expect(receipt.archived).toEqual([]);
    expect(receipt.usageSignalAvailable).toBe(false);
    expect(reg.records.get('old')!.confidence).toBe(60);
  });

  test('a record the usage lookup has never seen is not known to be unused', async () => {
    const reg = new FakeRegistry(aged);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: decayConfig, now: NOW, trigger: 'idle', idle: true, usageLookup: () => undefined });
    expect(receipt.decayed).toEqual([]);
    expect(reg.records.get('old')!.confidence).toBe(60);
  });

  test('a record injected and never referenced still decays', async () => {
    const reg = new FakeRegistry(aged);
    const unused: MemoryConsolidationUsageSignal = { injectedCount: 4, referencedCount: 0, lastReferencedAt: null };
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: decayConfig, now: NOW, trigger: 'idle', idle: true, usageLookup: () => unused });
    expect(receipt.decayed.map((entry) => entry.id)).toEqual(['old']);
  });
});

describe('pair readings are bounded', () => {
  test('200 records of one class are not compared pair by pair', async () => {
    let pairReadings = 0;
    readings.use({ pair: () => { pairReadings += 1; return { link: 0, restates: false, conflicts: false }; } });
    const many = Array.from({ length: 200 }, (_, index) => rec(`r${index}`, { updatedAt: NOW - index * 1000 }));
    await runMemoryConsolidation({ memoryRegistry: new FakeRegistry(many), config: cfg(), now: NOW, trigger: 'idle', idle: true });
    // 200 records make 19,900 pairs; a pass reads a few hundred at most.
    expect(pairReadings).toBeGreaterThan(0);
    expect(pairReadings).toBeLessThanOrEqual(400);
  });

  test('pairs of the newest records are read first, pairs of the oldest are left for later', async () => {
    const seen = new Set<string>();
    readings.use({ pair: (a, b) => { seen.add(`${a.summary}|${b.summary}`); return { link: 0, restates: false, conflicts: false }; } });
    const many = Array.from({ length: 200 }, (_, index) => rec(`r${index}`, { summary: `fact r${index}`, updatedAt: NOW - index * 1000 }));
    await runMemoryConsolidation({ memoryRegistry: new FakeRegistry(many), config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(seen.has('fact r0|fact r1')).toBe(true);
    expect(seen.has('fact r198|fact r199')).toBe(false);
  });
});

describe('a refused write ends the pass with a receipt of what was applied', () => {
  test('merges applied before the failure are listed, later pairs are not attempted', async () => {
    // Three duplicate groups of two; the third review is refused.
    const groups = ['alpha', 'bravo', 'charlie'].flatMap((name, index) => [
      rec(`${name}-keep`, { summary: `${name} note`, reviewState: 'reviewed', confidence: 80, updatedAt: NOW - (index + 1) * 1000 }),
      rec(`${name}-dupe`, { summary: `${name} note`, updatedAt: NOW - (index + 1) * 1000 - 500 }),
    ]);
    const reg = new FakeRegistry(groups);
    reg.failReviewAt = 3;
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.note).toContain('memory file changed on disk');
    expect(receipt.merged.length).toBe(2);
    expect(receipt.merged.every((entry) => entry.duplicateIds.length === 1)).toBe(true);
    expect(receipt.note).toContain('stopped early');
    expect(reg.reviewCalls).toBe(3);
  });

  test('the survivor takes the duplicate\'s tags before the duplicate is marked stale', async () => {
    const survivor = rec('keep', { summary: 'same note', reviewState: 'reviewed', confidence: 80, tags: ['a'] });
    const dupe = rec('dupe', { summary: 'same note', tags: ['b'], updatedAt: NOW - 61 * DAY_MS });
    const reg = new FakeRegistry([survivor, dupe]);
    reg.failReviewAt = 1;
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(reg.records.get('keep')!.tags.sort()).toEqual(['a', 'b']);
    expect(reg.records.get('dupe')!.reviewState).toBe('fresh');
  });
});

describe('a failed pass is not started over on the next wake', () => {
  test('a registry that throws is run once, not on every tick', async () => {
    let reads = 0;
    const registry: MemoryConsolidationRegistry = {
      getAll: () => { reads += 1; throw new Error('provider outage'); },
      review: () => null,
      update: () => null,
    };
    const scheduler = new MemoryConsolidationScheduler({
      memoryRegistry: registry,
      configSource: { getRaw: () => ({ learning: { consolidation: { enabled: true } } }) },
      isIdle: () => true,
      now: () => NOW,
      setTimer: () => { const handle = setTimeout(() => {}, 1); handle.unref?.(); return handle; },
    });
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    expect(reads).toBe(1);
  });
});
