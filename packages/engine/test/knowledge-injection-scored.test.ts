/**
 * knowledge-injection.ts ranking: retrieval (confidence gate, review-state and
 * temporal exclusion, the vector index or shared words as shortlist builder)
 * is code; the order comes from ONE `engine.state.knowledge-injection` request
 * over the whole shortlist, and none when nothing was put forward.
 * `selectKnowledgeForTask` is exactly the scored list, mapped to injections
 * and sliced to the limit.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  buildKnowledgeInjectionPrompt,
  KNOWLEDGE_SCORE_SCALE,
  selectKnowledgeForTask,
  selectKnowledgeForTaskScored,
  forgetKnowledgeInjectionReadings,
} from '../platform/src/platform/state/knowledge-injection.js';
import type { MemoryRecord, MemorySemanticSearchResult } from '../platform/src/platform/state/memory-store.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project',
    cls: 'fact',
    summary: 'a record',
    detail: undefined,
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRegistry(records: MemoryRecord[], semantic: MemorySemanticSearchResult[] = []) {
  return {
    getAll: () => records,
    ...(semantic.length > 0 ? { semanticCandidates: () => semantic } : {}),
  };
}

const RELEVANCE: Record<string, number> = {
  'auth module uses JWT tokens': 0.93,
  'auth module rate limiting': 0.81,
  'auth module caching layer': 0.62,
  'auth module retry policy': 0.5,
  'unrelated deployment note': 0.04,
};

describe('knowledge-injection.ts: ranking through one knowledge-injection reading', () => {
  const readings = useMemoryReadings({
    relevance: (_task, _scope, record) => ({ relevant: RELEVANCE[record.summary] ?? 0.05 }),
  });
  beforeEach(() => forgetKnowledgeInjectionReadings());

  test('orders by the reading in one request, drops a clear no, and never reads gated records', async () => {
    const records = [
      makeRecord({ id: 'mem_c', summary: 'auth module rate limiting', confidence: 65 }),
      makeRecord({ id: 'mem_b', summary: 'unrelated deployment note' }),
      makeRecord({ id: 'mem_a', summary: 'auth module uses JWT tokens', reviewState: 'reviewed', confidence: 70 }),
      makeRecord({ id: 'mem_d', summary: 'low confidence auth note', confidence: 40 }),
      makeRecord({ id: 'mem_e', summary: 'contradicted auth note', reviewState: 'contradicted', confidence: 90 }),
      makeRecord({ id: 'mem_x', summary: 'expired auth note', validUntil: Date.now() - 1000 }),
    ];
    const scored = await selectKnowledgeForTaskScored(makeRegistry(records), 'fix the auth module', [], 2);
    expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_a', 'mem_c']);
    expect(scored[0]!.score).toBeCloseTo(0.93 * KNOWLEDGE_SCORE_SCALE);
    expect(scored[0]!.injection.ingestMode).toBe('keyword-ranked');
    expect(scored[0]!.injection.trustTier).toBe('reviewed');
    expect(readings.requests).toHaveLength(1);
    const candidates = (readings.requests[0]!.state as { candidates: { id: string }[] }).candidates.map((candidate) => candidate.id).sort();
    expect(candidates).toEqual(['mem_a', 'mem_c']);
  });

  test('a task nothing is similar to asks nothing, however many records there are', async () => {
    const records = Array.from({ length: 200 }, (_, index) => makeRecord({ id: `mem_${index}`, summary: `deployment note ${index}`, confidence: 90 }));
    expect(await selectKnowledgeForTaskScored(makeRegistry(records), 'what time is it', [], 3)).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });

  test('a related task is one request for the whole shortlist, and the same task asks nothing again', async () => {
    readings.use({ relevance: () => ({ relevant: 0.9 }) });
    const records = Array.from({ length: 30 }, (_, index) => makeRecord({ id: `mem_${index}`, summary: `deployment note ${index}` }));
    const registry = makeRegistry(records);
    await selectKnowledgeForTaskScored(registry, 'write the deployment note', [], 2);
    expect(readings.requests).toHaveLength(1);
    expect((readings.requests[0]!.state as { candidates: unknown[] }).candidates).toHaveLength(12);
    await selectKnowledgeForTaskScored(registry, 'write the deployment note', [], 2);
    expect(readings.requests).toHaveLength(1);
  });

  test('ids already injected are left out before anything is asked', async () => {
    const records = [makeRecord({ id: 'mem_a', summary: 'auth module uses JWT tokens' })];
    expect(await selectKnowledgeForTaskScored(makeRegistry(records), 'fix the auth module', [], 3, { excludeIds: new Set(['mem_a']) })).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });

  test('selectKnowledgeForTask is the scored list mapped to injections and sliced to the limit', async () => {
    const records = ['auth module uses JWT tokens', 'auth module rate limiting', 'auth module caching layer', 'auth module retry policy']
      .map((summary, index) => makeRecord({ id: `mem_${index}`, summary }));
    const registry = makeRegistry(records);
    const scored = await selectKnowledgeForTaskScored(registry, 'fix the auth module', [], 2);
    expect(scored.map((entry) => entry.injection.id).slice(0, 3)).toEqual(['mem_0', 'mem_1', 'mem_2']);
    const sliced = await selectKnowledgeForTask(registry, 'fix the auth module', [], 2);
    expect(sliced).toEqual(scored.slice(0, 2).map((entry) => entry.injection));
  });

  test('an empty registry makes no request and yields nothing', async () => {
    const registry = makeRegistry([]);
    expect(await selectKnowledgeForTask(registry, 'anything', [], 3)).toEqual([]);
    expect(await selectKnowledgeForTaskScored(registry, 'anything', [], 3)).toEqual([]);
    expect(readings.requests).toHaveLength(0);
    expect(buildKnowledgeInjectionPrompt([])).toBeNull();
  });

  test('the write scope reaches the reading', async () => {
    readings.use({ relevance: () => ({ relevant: 0.9 }) });
    const record = makeRecord({ id: 'mem_scope', summary: 'login form keeps its CSRF token in a hidden field' });
    const scored = await selectKnowledgeForTaskScored(makeRegistry([record]), 'unrelated task text', ['src/auth/login.ts'], 3);
    expect(scored).toHaveLength(1);
    const state = readings.requests[0]!.state as { query: { write_scope: string[] } };
    expect(state.query.write_scope).toEqual(['src/auth/login.ts']);
  });

  test('vector candidates above the similarity floor are the shortlist and label the ingest mode', async () => {
    readings.use({ relevance: () => ({ relevant: 0.9 }) });
    const close = makeRecord({ id: 'close', summary: 'semantic and text match' });
    const far = makeRecord({ id: 'far', summary: 'semantic only' });
    const registry = makeRegistry([close, far], [
      { record: close, distance: 0.4, similarity: 0.8, score: 80 },
      { record: far, distance: 1.4, similarity: 0.3, score: 30 },
    ]);
    const scored = await selectKnowledgeForTaskScored(registry, 'task', [], 3);
    expect(scored.map((entry) => entry.injection.id)).toEqual(['close']);
    expect(scored[0]!.injection.ingestMode).toBe('semantic-ranked');
    expect(scored[0]!.injection.reason).toContain('matched sqlite-vec semantic index (80%)');
  });

  test('a read with no judgment port installed throws', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      await expect(selectKnowledgeForTaskScored(makeRegistry([makeRecord({ id: 'a', summary: 'a task note' })]), 'task note')).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
