import { expect, test } from 'bun:test';
import { selectKnowledgeForTaskScored } from '../platform/src/platform/state/knowledge-injection.js';
import type { MemoryRecord } from '../platform/src/platform/state/memory-store.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

useMemoryReadings();

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id, scope: 'project', cls: 'fact', summary: 'auth module rule', tags: [], provenance: [], reviewState: 'fresh', confidence: 90, createdAt: 1, updatedAt: 1, ...overrides };
}

test('a record consolidation marked stale is not injected, whatever its confidence', async () => {
  // A merged-away duplicate keeps the confidence it had.
  const registry = { getAll: () => [record('mem_survivor'), record('mem_merged_away', { reviewState: 'stale', confidence: 90, staleReason: 'Duplicate of mem_survivor' })] };
  const scored = await selectKnowledgeForTaskScored(registry, 'fix the auth module');
  expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_survivor']);
});

test('a stale record the vector index ranks first is not injected either', async () => {
  const stale = record('mem_stale', { reviewState: 'stale' });
  const registry = {
    getAll: () => [record('mem_fresh', { summary: 'auth module cache' }), stale],
    semanticCandidates: () => [{ record: stale, distance: 0, similarity: 1, score: 100 }],
  };
  const scored = await selectKnowledgeForTaskScored(registry, 'fix the auth module');
  expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_fresh']);
});
