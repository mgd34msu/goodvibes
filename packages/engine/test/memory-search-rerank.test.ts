/**
 * MemoryStore search ranking: retrieval (the SQL filter, the vector index) is
 * code, and the `engine.state.memory-search` rerank orders what retrieval found
 * whenever there is a query. With no query the order is structural
 * (compareByTrust: unflagged first, then confidence, then recency). A search
 * costs one rerank request for its whole shortlist. The review queue is
 * ordered in code from the stored fields, with no request.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { MemoryEmbeddingProviderRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import type { MemoryRecord } from '../platform/src/platform/state/index.js';
import { SqliteVecMemoryIndex } from '../platform/src/platform/state/memory-vector-store.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';
// The field-name reading no longer exists (the activity log masks locally); a request naming it is unexpected.
const fieldKind = { name: 'engine.redaction.field-kind', items: { kind: { question: {} as Record<string, unknown> } } };

function memoryRequests(readings: Pick<ReturnType<typeof useMemoryReadings>, 'requests'>, battery: 'engine.state.memory-search' | 'engine.state.memory-review-priority') {
  for (const request of readings.requests) {
    if (request.context?.battery === battery) continue;
    expect(request.context?.battery).toBe(fieldKind.name);
    expect(request.questions).toEqual({ kind: fieldKind.items.kind.question });
    const state = request.state;
    if (!state || typeof state !== 'object' || Array.isArray(state) || !('field' in state) || typeof state.field !== 'string') {
      throw new Error('Unexpected memory logger privacy projection');
    }
    expect(state).toEqual({ field: state.field });
    expect(['ready', 'id', 'cls', 'path']).toContain(state.field);
  }
  return readings.requests.filter(request => request.context?.battery === battery);
}


const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function openStore(enableVectorIndex: boolean): Promise<MemoryStore> {
  const root = mkdtempSync(join(tmpdir(), 'gv-memory-rerank-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex,
  });
  await store.init();
  return store;
}

const MATCH: Record<string, number> = {
  'deploy note: staging uses deploy/staging.sh': 0.62,
  'deploy note: production rollouts are blue-green via deploy/rollout.sh': 0.94,
  'deploy note: the deploy bot posts to #releases': 0.2,
};

describe('MemoryStore.search with a query', () => {
  const readings = useMemoryReadings({ searchMatch: (_query, candidate) => MATCH[candidate.summary] ?? 0.05 });

  test('orders what the SQL filter retrieved by the rerank, not by where the words appear', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'runbook', summary: 'deploy note: the deploy bot posts to #releases', review: { confidence: 95 } });
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh', review: { confidence: 90 } });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh', review: { confidence: 60 } });
    await store.add({ cls: 'fact', summary: 'the test runner is bun test' });

    const found = await store.search({ query: 'deploy', limit: 2 });
    expect(found.map((record) => record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    // Only the three records the SQL filter retrieved were read, all in one request.
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(1);
    const request = memoryRequests(readings, 'engine.state.memory-search')[0]!.state as { query: string; candidates: unknown[] };
    expect(request.query).toBe('deploy');
    expect(request.candidates).toHaveLength(3);
    // The same search again reads nothing: the readings are kept per query and record revision.
    await store.search({ query: 'deploy', limit: 2 });
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(1);
    store.close();
  });

  test('only the shortlist is reranked; the rest follow in retrieval order', async () => {
    readings.use({ searchMatch: () => 0.9 });
    const store = await openStore(false);
    for (let index = 0; index < 20; index += 1) {
      await store.add({ cls: 'fact', summary: `alpha note ${index}`, review: { confidence: 40 + index } });
    }
    const found = await store.search({ query: 'alpha', limit: 1 });
    expect(found).toHaveLength(1);
    // limit 1 reranks max(1 + 5, 8) = 8 of the 20 retrieved records, in one request.
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(1);
    expect((memoryRequests(readings, 'engine.state.memory-search')[0]!.state as { candidates: unknown[] }).candidates).toHaveLength(8);
    store.close();
  });

  test('no query: structural order, no request', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'flagged but confident', review: { state: 'stale', confidence: 99 } });
    await store.add({ cls: 'fact', summary: 'modest', review: { confidence: 60 } });
    await store.add({ cls: 'fact', summary: 'confident', review: { confidence: 80 } });
    const found = await store.search({});
    expect(found.map((record) => record.summary)).toEqual(['confident', 'modest', 'flagged but confident']);
    expect(store.retrieve({}).map((record) => record.summary)).toEqual(['confident', 'modest', 'flagged but confident']);
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(0);
    store.close();
  });

  test('a query search with no judgment port installed throws', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'alpha' });
    const previous = installJudgmentPort(undefined);
    try {
      await expect(store.search({ query: 'alpha' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
      store.close();
    }
  });
});

describe('MemoryStore.searchSemantic', () => {
  const readings = useMemoryReadings({ searchMatch: (_query, candidate) => MATCH[candidate.summary] ?? 0.05 });

  test('the vector index shortlists, the rerank orders, and score is the probability on 0 to 100', async () => {
    const store = await openStore(true);
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: the deploy bot posts to #releases' });
    await store.rebuildVectorIndexAsync();
    expect(store.vectorStats().available).toBe(true);

    const candidates = store.semanticCandidates({ query: 'how do we deploy to production' });
    expect(candidates.length).toBe(3);
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(0);

    const results = await store.searchSemantic({ query: 'how do we deploy to production', limit: 2 });
    expect(results.map((entry) => entry.record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    expect(results[0]!.score).toBeCloseTo(94);
    expect(results[0]!.similarity).toBeGreaterThan(0);
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(1);
    store.close();
  });

  test('with the index disabled the literal search is reranked and reported with similarity 0', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh' });
    const results = await store.searchSemantic({ query: 'deploy' });
    expect(results.map((entry) => entry.record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    expect(results.map((entry) => entry.similarity)).toEqual([0, 0]);
    expect(results[1]!.score).toBeCloseTo(62);
    store.close();
  });

  test('no query: retrieval order, score is the record confidence, no request', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'one', review: { confidence: 70 } });
    const results = await store.searchSemantic({});
    expect(results.map((entry) => entry.score)).toEqual([70]);
    expect(memoryRequests(readings, 'engine.state.memory-search')).toHaveLength(0);
    store.close();
  });
});

describe('SqliteVecMemoryIndex staleOnly', () => {
  test('returns only records flagged stale or contradicted, never a fresh low-confidence one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-memory-vector-stale-'));
    roots.push(root);
    const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
    const index = new SqliteVecMemoryIndex(join(root, 'memory.vec.sqlite'), undefined, registry);
    await index.init();
    const record = (id: string, reviewState: MemoryRecord['reviewState'], confidence: number): MemoryRecord => ({
      id, scope: 'project', cls: 'fact', summary: `deploy note ${id}`, tags: [], provenance: [], reviewState, confidence, createdAt: 1, updatedAt: 1,
    });
    const records = [record('stale', 'stale', 90), record('contradicted', 'contradicted', 90), record('fresh-low', 'fresh', 20)];
    await index.syncAsync(records, { force: true });
    expect(index.stats().available).toBe(true);
    const ids = index.search('deploy note', { staleOnly: true }).map((candidate) => candidate.id).sort();
    expect(ids).toEqual(['contradicted', 'stale']);
    index.close();
  });
});

describe('MemoryStore.reviewQueue', () => {
  const readings = useMemoryReadings();

  test('orders from the stored fields with no request: flagged first, then unreviewed low confidence, then reviewed', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'pattern', summary: 'reviewed convention', review: { state: 'reviewed', confidence: 92 } });
    await store.add({ cls: 'constraint', summary: 'stale runtime note', review: { state: 'stale', confidence: 70, staleReason: 'aged out' } });
    await store.add({ cls: 'incident', summary: 'unverified guess', review: { confidence: 35 } });
    const queue = await store.reviewQueue(2);
    expect(queue.map((record) => record.summary)).toEqual(['stale runtime note', 'unverified guess']);
    expect(memoryRequests(readings, 'engine.state.memory-review-priority')).toHaveLength(0);
    store.close();
  });

  test('works with no judgment port installed', async () => {
    const store = await openStore(false);
    expect(await store.reviewQueue(5)).toEqual([]);
    await store.add({ cls: 'fact', summary: 'anything' });
    const previous = installJudgmentPort(undefined);
    try {
      expect((await store.reviewQueue(5)).map((record) => record.summary)).toEqual(['anything']);
    } finally {
      installJudgmentPort(previous);
      store.close();
    }
  });
});
