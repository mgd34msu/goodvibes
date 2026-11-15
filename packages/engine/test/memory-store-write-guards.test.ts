import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { MemoryStore, type MemoryBundle, type MemoryRecord } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { runHonestMemorySearch } from '../platform/src/platform/state/memory-recall-contract.ts';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

useMemoryReadings();

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(enableVectorIndex = false) {
  const root = makeProjectTempDir('memory-write-guards');
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
  const open = async () => {
    const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: embeddings, enableVectorIndex });
    cleanups.push(() => store.close());
    await store.init();
    return store;
  };
  return { open, embeddings };
}

function bundleRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return { id: 'mem_ok', scope: 'project', cls: 'fact', summary: 'valid record', tags: [], provenance: [], reviewState: 'fresh', confidence: 60, createdAt: now, updatedAt: now, ...overrides };
}

function bundleOf(records: unknown[], links: unknown[] = []): MemoryBundle {
  return { schemaVersion: 'v1', exportedAt: Date.now(), scope: 'all', recordCount: records.length, linkCount: links.length, records, links } as MemoryBundle;
}

describe('a write the read path would refuse is refused when written', () => {
  test('an update with an unknown scope throws, and every later read still works', async () => {
    const store = await (await setup()).open();
    const added = await store.add({ cls: 'fact', summary: 'stays readable' });
    expect(() => store.update(added.id, { scope: 'workspace' as never })).toThrow(/scope/);
    expect(store.retrieve({})).toHaveLength(1);
    expect(store.get(added.id)?.scope).toBe('project');
  });

  test('an add with tags that are not an array, or an unknown class, stores nothing', async () => {
    const store = await (await setup()).open();
    await expect(store.add({ cls: 'fact', summary: 'x', tags: 'abc' as never })).rejects.toThrow(/tags/);
    await expect(store.add({ cls: 'note' as never, summary: 'x' })).rejects.toThrow(/cls/);
    await expect(store.add({ cls: 'fact', summary: '   ' })).rejects.toThrow(/summary/);
    expect(store.retrieve({})).toHaveLength(0);
  });
});

describe('importing a bundle', () => {
  test('a bundle with one malformed record imports nothing', async () => {
    const store = await (await setup()).open();
    await expect(store.importBundle(bundleOf([bundleRecord(), { id: 'mem_bad' }]))).rejects.toThrow(/record #2/);
    expect(store.retrieve({})).toHaveLength(0);
  });

  test('a bundle without a records array is refused by name', async () => {
    const store = await (await setup()).open();
    await expect(store.importBundle({} as MemoryBundle)).rejects.toThrow(/records/);
  });

  test('more records than the limit is refused before any is read', async () => {
    const store = await (await setup()).open();
    const tooMany = Array.from({ length: 10_001 }, (_, index) => ({ id: `mem_${index}` }));
    await expect(store.importBundle(bundleOf(tooMany))).rejects.toThrow(/exceeds the limit/);
  });

  test('a failure while writing removes the rows already inserted', async () => {
    const store = await (await setup()).open();
    const original = SQLiteStore.prototype.run;
    const run = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function (this: SQLiteStore, sql: string, params?: never) {
      if (typeof sql === 'string' && sql.includes('INSERT INTO memory_records') && Array.isArray(params) && params[0] === 'mem_b') throw new Error('constraint failed');
      return Reflect.apply(original, this, [sql, params]);
    });
    cleanups.push(() => run.mockRestore());
    await expect(store.importBundle(bundleOf([bundleRecord({ id: 'mem_a' }), bundleRecord({ id: 'mem_b', summary: 'second' })]))).rejects.toThrow(/constraint failed/);
    run.mockRestore();
    expect(store.retrieve({})).toHaveLength(0);
  });

  test('an imported record arrives unreviewed at no more than the baseline confidence; a flag is kept', async () => {
    const store = await (await setup()).open();
    await store.importBundle(bundleOf([
      bundleRecord({ id: 'mem_claims', reviewState: 'reviewed', reviewedBy: 'owner', reviewedAt: 5, confidence: 100 }),
      bundleRecord({ id: 'mem_flagged', summary: 'flagged', reviewState: 'contradicted', confidence: 90, staleReason: 'disagrees' }),
    ]));
    const claims = store.get('mem_claims')!;
    expect([claims.reviewState, claims.confidence, claims.reviewedBy, claims.reviewedAt]).toEqual(['fresh', 60, undefined, undefined]);
    expect(store.get('mem_flagged')!.reviewState).toBe('contradicted');
  });
});

describe('a save that fails is not reported as remembered', () => {
  test('add rejects, and says the change may be lost', async () => {
    const store = await (await setup()).open();
    const save = spyOn(SQLiteStore.prototype, 'save').mockRejectedValue(new Error('disk full'));
    cleanups.push(() => save.mockRestore());
    await expect(store.add({ cls: 'fact', summary: 'will not persist' })).rejects.toThrow(/could not be saved.*disk full/);
  });
});

describe('a listener that throws does not undo a stored memory', () => {
  test('add still resolves and later listeners still run', async () => {
    const store = await (await setup()).open();
    const registry = new MemoryRegistry(store);
    let later = 0;
    registry.subscribe(() => { throw new Error('panel bug'); });
    registry.subscribe(() => { later += 1; });
    const added = await registry.add({ cls: 'fact', summary: 'stored once' });
    expect(registry.get(added.id)?.summary).toBe('stored once');
    expect(later).toBe(1);
    expect(registry.getAll()).toHaveLength(1);
  });
});

describe('semantic search applies the same filters as the literal path', () => {
  test('tags narrow the candidates', async () => {
    const store = await (await setup(true)).open();
    await store.add({ cls: 'fact', summary: 'deploy plan for staging', tags: ['alpha'] });
    await store.add({ cls: 'fact', summary: 'deploy plan for production', tags: ['beta'] });
    const found = store.semanticCandidates({ query: 'deploy plan', tags: ['alpha'] });
    expect(found.map((entry) => entry.record.tags)).toEqual([['alpha']]);
  });

  test('asking for contradicted records returns them', async () => {
    const store = await (await setup(true)).open();
    await store.add({ cls: 'fact', summary: 'deploy plan one', review: { state: 'contradicted' } });
    await store.add({ cls: 'fact', summary: 'deploy plan two' });
    const found = store.semanticCandidates({ query: 'deploy plan', reviewState: 'contradicted' });
    expect(found.map((entry) => entry.record.summary)).toEqual(['deploy plan one']);
  });
});

describe('an index that cannot embed is said to be unavailable', () => {
  test('an async-only default provider gives a stated reason, not an empty "semantic" result', async () => {
    const { open, embeddings } = setup(true);
    embeddings.register({ id: 'async-only', label: 'Async only', dimensions: 384, embed: async () => ({ vector: new Float32Array(384), dimensions: 384 }) }, { makeDefault: true });
    const store = await open();
    await store.add({ cls: 'fact', summary: 'deploy plan' });
    const result = await runHonestMemorySearch(store, { query: 'deploy', semantic: true });
    expect(result.mode).toBe('literal');
    expect(result.indexUnavailableReason).toContain('async-only');
    expect(result.records.map((record) => record.summary)).toEqual(['deploy plan']);
  });
});

describe('who a review is recorded as', () => {
  test('a caller cannot claim the consolidation reviewer; the automated pass can', async () => {
    const store = await (await setup()).open();
    const registry = new MemoryRegistry(store);
    const added = await registry.add({ cls: 'fact', summary: 'claimed review' });
    const claimed = registry.review(added.id, { state: 'reviewed', reviewedBy: ' Consolidation ' });
    expect(claimed?.reviewState).toBe('reviewed');
    expect(claimed?.reviewedBy).toBe('operator');
    const named = registry.review(added.id, { state: 'reviewed', reviewedBy: 'alex' });
    expect(named?.reviewedBy).toBe('alex');
    const automated = registry.review(added.id, { state: 'stale', reviewedBy: 'consolidation' }, { automatedReview: true });
    expect(automated?.reviewedBy).toBe('consolidation');
  });

  test('a record added with the consolidation reviewer is recorded as operator', async () => {
    const store = await (await setup()).open();
    const registry = new MemoryRegistry(store);
    const claimed = await registry.add({ cls: 'fact', summary: 'claimed at add', review: { state: 'reviewed', confidence: 90, reviewedBy: 'consolidation' } });
    expect(claimed.reviewState).toBe('reviewed');
    expect(claimed.reviewedBy).toBe('operator');
    const named = await registry.add({ cls: 'fact', summary: 'named at add', review: { state: 'reviewed', confidence: 90, reviewedBy: 'alex' } });
    expect(named.reviewedBy).toBe('alex');
  });
});
