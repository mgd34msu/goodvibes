import { describe, expect, test } from 'bun:test';
import { MemoryUsageStatsStore, type MemoryUsageChange, type MemoryUsageEntry, type MemoryUsageSource, type MemoryUsageTopEntry } from '../platform/src/platform/state/index.js';

/**
 * The usage counters live on the memory record (MemoryStore.recordUsage); this
 * view must never call a memory whose use was not read "never referenced", or
 * offer it for decay.
 */
function source(): MemoryUsageSource {
  const rows = new Map<string, MemoryUsageEntry>();
  const bump = (ids: readonly string[] | undefined, apply: (entry: MemoryUsageEntry) => MemoryUsageEntry): void => {
    for (const id of ids ?? []) rows.set(id, apply(rows.get(id) ?? { injectedCount: 0, assessedCount: 0, referencedCount: 0, lastInjectedAt: null, lastReferencedAt: null }));
  };
  return {
    async recordUsage(change: MemoryUsageChange, at = 1) {
      bump(change.injected, (entry) => ({ ...entry, injectedCount: entry.injectedCount + 1, lastInjectedAt: at }));
      bump(change.assessed, (entry) => ({ ...entry, assessedCount: entry.assessedCount + 1 }));
      bump(change.referenced, (entry) => ({ ...entry, referencedCount: entry.referencedCount + 1, lastReferencedAt: at }));
    },
    usage: (id) => rows.get(id) ?? null,
    usageEntries: (): MemoryUsageTopEntry[] => [...rows].map(([id, entry]) => ({ id, ...entry })),
  };
}

describe('MemoryUsageStatsStore', () => {
  test('a memory whose use was never read is not assessed and never offered for decay', async () => {
    const store = new MemoryUsageStatsStore(source());
    await store.record({ injected: ['a', 'b', 'c'], assessed: ['a', 'b'], referenced: ['a'] }, 2);
    const summary = store.summary();
    expect(summary.everInjected).toBe(3);
    expect(summary.assessed).toBe(2);
    expect(summary.notAssessed).toBe(1);
    expect(summary.neverReferenced).toBe(1);
    expect(store.lookup('b')).toMatchObject({ injectedCount: 1, referencedCount: 0 });
    expect(store.lookup('c')).toBeUndefined();
  });
});
