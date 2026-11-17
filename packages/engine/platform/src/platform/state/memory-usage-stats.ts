/**
 * memory-usage-stats.ts, per-memory usage counters.
 *
 * Answers "was injected context actually used?". The counters are columns on
 * the memory record itself (MemoryStore.recordUsage): how many times a memory
 * was injected into a prompt, how many of those injections had their use read
 * (memory-usage-detection.ts, one Jev reading per turn, not ground truth) and
 * how many were read as used. One update per turn, removed with the record,
 * the same counts for every product that shares the store.
 *
 * The counters feed the idle consolidation decay ordering (a memory read as
 * never used decays first) via `lookup`. A memory whose use was never read is
 * "not assessed", never "never referenced".
 */
import type { MemoryConsolidationUsageSignal } from './memory-consolidation.js';

export interface MemoryUsageEntry {
  readonly injectedCount: number;
  /** Injections whose use was read (decision models on); the rest were not assessed. */
  readonly assessedCount: number;
  readonly referencedCount: number;
  readonly lastInjectedAt: number | null;
  readonly lastReferencedAt: number | null;
}

export interface MemoryUsageTopEntry extends MemoryUsageEntry {
  readonly id: string;
}

/** One turn's use of memories, applied in one step. */
export interface MemoryUsageChange {
  readonly injected?: readonly string[] | undefined;
  readonly assessed?: readonly string[] | undefined;
  readonly referenced?: readonly string[] | undefined;
}

export interface MemoryUsageSummary {
  readonly totalTracked: number;
  readonly everInjected: number;
  /** Memories whose use was read at least once. */
  readonly assessed?: number | undefined;
  /** Memories injected but whose use was never read: not counted as never referenced. */
  readonly notAssessed?: number | undefined;
  readonly everReferenced: number;
  /** Memories read at least once and never read as used. */
  readonly neverReferenced: number;
  readonly mostReferenced: readonly MemoryUsageTopEntry[];
  readonly neverReferencedSample: readonly MemoryUsageTopEntry[];
  readonly signalNote: string;
}

/** Where the counters live: the memory store (MemoryStore / MemoryRegistry). */
export interface MemoryUsageSource {
  recordUsage(change: MemoryUsageChange, at?: number): Promise<void>;
  usage(id: string): MemoryUsageEntry | null;
  usageEntries(): readonly MemoryUsageTopEntry[];
}

export const MEMORY_USAGE_SIGNAL_NOTE =
  'Reference detection is a judgment reading: it says whether the model output used the injected memory\'s specific information, not ground truth that the memory changed the answer. A memory whose use was never read is counted as not assessed.';

export class MemoryUsageStatsStore {
  /** Over the memory store's own counters. */
  public constructor(private readonly source: MemoryUsageSource) {}

  /** One turn's use, one store update. */
  public async record(change: MemoryUsageChange, at: number = Date.now()): Promise<void> {
    await this.source.recordUsage(change, at);
  }

  public get(id: string): MemoryUsageEntry | null {
    return this.source.usage(id);
  }

  /**
   * Consolidation decay seam: a memory is offered for decay only when its use
   * was read at least once, so a memory nobody assessed keeps its confidence.
   */
  public lookup(id: string): MemoryConsolidationUsageSignal | undefined {
    return memoryUsageSignal(this.get(id));
  }

  public summary(sampleLimit = 5): MemoryUsageSummary {
    return summarizeMemoryUsage(this.source.usageEntries(), sampleLimit);
  }
}

/** The decay signal for one record's counters; undefined when its use was never read. */
export function memoryUsageSignal(entry: MemoryUsageEntry | null | undefined): MemoryConsolidationUsageSignal | undefined {
  if (!entry || entry.assessedCount === 0) return undefined;
  return { injectedCount: entry.injectedCount, referencedCount: entry.referencedCount, lastReferencedAt: entry.lastReferencedAt };
}

export function summarizeMemoryUsage(entries: readonly MemoryUsageTopEntry[], sampleLimit = 5): MemoryUsageSummary {
  const everInjected = entries.filter((entry) => entry.injectedCount > 0);
  const assessed = everInjected.filter((entry) => entry.assessedCount > 0);
  const everReferenced = entries.filter((entry) => entry.referencedCount > 0);
  const neverReferenced = assessed.filter((entry) => entry.referencedCount === 0);
  return {
    totalTracked: entries.length,
    everInjected: everInjected.length,
    assessed: assessed.length,
    notAssessed: everInjected.length - assessed.length,
    everReferenced: everReferenced.length,
    neverReferenced: neverReferenced.length,
    mostReferenced: [...everReferenced]
      .sort((left, right) => right.referencedCount - left.referencedCount || (right.lastReferencedAt ?? 0) - (left.lastReferencedAt ?? 0))
      .slice(0, Math.max(1, sampleLimit)),
    neverReferencedSample: [...neverReferenced]
      .sort((left, right) => right.injectedCount - left.injectedCount)
      .slice(0, Math.max(1, sampleLimit)),
    signalNote: MEMORY_USAGE_SIGNAL_NOTE,
  };
}
