import { describe, expect, test } from 'bun:test';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '../platform/src/platform/runtime/memory-spine/index.ts';
import type { HonestMemorySearchResult, MemoryRecord } from '../platform/src/platform/state/index.ts';

function record(summary: string): MemoryRecord {
  const now = Date.now();
  return {
    id: `mem_${summary}`, scope: 'project', cls: 'fact', summary, tags: [], provenance: [], reviewState: 'fresh',
    confidence: 60, createdAt: now, updatedAt: now,
  };
}

function honest(records: MemoryRecord[]): HonestMemorySearchResult {
  return {
    records, mode: 'literal', requestedSemantic: false, indexUnavailableReason: null, caveat: null, recallFiltered: false,
    excludedFlaggedCount: 0, excludedBelowFloorCount: 0, excludedOutOfWindowCount: 0, totalBeforeRecallFilter: records.length, recallFloor: 60,
  };
}

describe('refreshRecallSnapshot with overlapping refreshes', () => {
  test('a slow earlier refresh that finishes last does not replace the newer snapshot', async () => {
    const pending: Array<(result: HonestMemorySearchResult) => void> = [];
    const store = {
      honestSearch: () => new Promise<HonestMemorySearchResult>((resolve) => { pending.push(resolve); }),
    } as unknown as LocalMemoryStore;
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(store) } as never);

    const first = client.refreshRecallSnapshot({});
    const second = client.refreshRecallSnapshot({});
    await Promise.resolve();
    pending[1]!(honest([record('newer')]));
    await second;
    pending[0]!(honest([record('older')]));
    await first;

    const summaries = client.recallSnapshot().search?.records.map((r) => r.summary);
    expect(summaries).toEqual(['newer']);
  });
});
