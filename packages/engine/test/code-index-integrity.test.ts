/**
 * Code index integrity: embedding failures are reported instead of passing for
 * a completed build, a file's chunks are replaced in one transaction, an
 * unfinished first build is recognised when the provider changes, files
 * skipped for transient reasons keep their chunks, and a file that became
 * binary loses them.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../platform/src/platform/state/code-index-store.js';
import { createCodeIndexApi, type CodeIndexApiRegistry } from '../platform/src/platform/knowledge/knowledge-api.js';
import { createCodeIndexSchema, migrateCodeIndexSchema, countIndexedChunks, replaceFileChunks } from '../platform/src/platform/state/code-index-db.js';
import { loadSqliteVecExtension } from '../platform/src/platform/state/sqlite-vec-loader.js';
import { MEMORY_VECTOR_DIMS } from '../platform/src/platform/state/memory-vector-store.js';
import {
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  type MemoryEmbeddingProvider,
} from '../platform/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import * as codeFiles from '../platform/src/platform/state/code-file-observation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function provider(id: string, failOn?: (text: string) => boolean): MemoryEmbeddingProvider {
  const vector = (text: string, dimensions: number) => ({ vector: embedMemoryText(text, dimensions), dimensions });
  return {
    id, label: `Provider ${id}`, dimensions: 384, deterministic: true,
    embedSync: (request) => vector(request.text, request.dimensions),
    async embed(request) {
      if (failOn?.(request.text)) throw new Error(`provider ${id} unreachable`);
      return vector(request.text, request.dimensions);
    },
  };
}
function setup(first: MemoryEmbeddingProvider, files: Record<string, string>, options: ConstructorParameters<typeof CodeIndexStore>[3] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gv-code-index-integrity-')); roots.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, '.config') }) });
  registry.register(first, { makeDefault: true });
  const dbPath = join(root, 'index.sqlite');
  const open = (opts = options) => new CodeIndexStore(root, dbPath, registry, opts);
  return { root, registry, open, store: open() };
}

test('an embedding failure is reported on the build and the status, not as a clean build', async () => {
  const { store } = setup(provider('down', () => true), { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
  await store.init();
  const stats = await store.buildFull();
  expect(stats.filesIndexed).toBe(0);
  expect(stats.filesFailed).toBe(2);
  expect(stats.firstFailure).toContain('provider down unreachable');
  expect(store.stats().lastBuildError).toContain('provider down unreachable');
  store.close();
});

test('a run of failures stops the build with a reason instead of failing every file', async () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`f${n}.ts`, `export const v${n} = ${n};\n`]));
  let calls = 0;
  const { store } = setup(provider('down', () => { calls++; return true; }), files);
  await store.init();
  await expect(store.buildFull()).rejects.toThrow(/5 files in a row/);
  expect(calls).toBe(5);
  expect(store.stats().lastBuildError).toContain('build failed');
  store.close();
});

test('a build cut short by a failing file still records its provider, so a provider change is seen', async () => {
  const { registry, store } = setup(provider('first', text => text.includes('betaMarker')), {
    'a.ts': 'export const alphaMarker = 1;\n', 'b.ts': 'export const betaMarker = 2;\n',
  });
  await store.init();
  await store.buildFull();
  expect(store.stats().indexedChunks).toBeGreaterThan(0);
  registry.register(provider('second'), { makeDefault: true });
  expect(store.getProviderMismatch()).toContain('first');
  store.close();
});

test('an index holding chunks with no stamp is re-embedded by the next build', async () => {
  const { registry, store, open } = setup(provider('first'), { 'a.ts': 'export const alphaMarker = 1;\n' });
  await store.init();
  await store.buildFull();
  // Drop the stamp the way a legacy or cut-short index lacks it.
  const raw = new Database(join(store.stats().path));
  raw.run('DELETE FROM code_index_meta');
  raw.close();
  store.close();
  registry.register(provider('second'), { makeDefault: true });
  const reopened = open();
  await reopened.init();
  const stats = await reopened.buildFull();
  expect(stats.filesIndexed).toBe(1);
  expect(stats.filesUnchanged).toBe(0);
  expect(reopened.getProviderMismatch()).toBeNull();
  reopened.close();
});

test('replacing a file keeps the old chunks when a later chunk cannot be written', async () => {
  const db = new Database(':memory:');
  await loadSqliteVecExtension(db);
  createCodeIndexSchema(db);
  const chunk = (id: string, revision: string) => ({ chunkId: id, path: 'a.ts', lang: 'ts', symbol: id, kind: 'function', startLine: 1, endLine: 2, mtimeMs: 1, fileRevision: revision });
  const good = new Float32Array(MEMORY_VECTOR_DIMS).fill(0.1);
  replaceFileChunks(db, 'a.ts', [{ chunk: chunk('one', 'r1'), embedding: good }, { chunk: chunk('two', 'r1'), embedding: good }]);
  expect(countIndexedChunks(db)).toBe(2);
  expect(() => replaceFileChunks(db, 'a.ts', [
    { chunk: chunk('three', 'r2'), embedding: good }, { chunk: chunk('four', 'r2'), embedding: new Float32Array(3) },
  ])).toThrow();
  const rows = db.query<{ chunk_id: string; file_revision: string }, []>('SELECT chunk_id, file_revision FROM code_chunks ORDER BY chunk_id').all();
  expect(rows).toEqual([{ chunk_id: 'one', file_revision: 'r1' }, { chunk_id: 'two', file_revision: 'r1' }]);
  db.close();
});

test('a file that cannot be read during a rebuild keeps its chunks', async () => {
  const { root, store } = setup(provider('p'), { 'a.ts': 'export const alphaMarker = 1;\n', 'b.ts': 'export const betaMarker = 2;\n' });
  await store.init();
  await store.buildFull();
  const before = store.stats().indexedChunks;
  const real = codeFiles.readCodeIndexFile;
  const spy = spyOn(codeFiles, 'readCodeIndexFile').mockImplementation(async (rootDir, path, diagnostics, maxBytes) =>
    path === join(root, 'a.ts') ? null : real(rootDir, path, diagnostics, maxBytes));
  try {
    const stats = await store.buildFull();
    expect(stats.filesRemoved).toBe(0);
  } finally { spy.mockRestore(); }
  expect(store.stats().indexedChunks).toBe(before);
  store.close();
});

test('files left out by the file cap keep their chunks', async () => {
  const { open, store } = setup(provider('p'), { 'a.ts': 'export const alphaMarker = 1;\n', 'b.ts': 'export const betaMarker = 2;\n' });
  await store.init();
  await store.buildFull();
  const before = store.stats().indexedChunks;
  store.close();
  const capped = open({ maxFiles: 1 });
  await capped.init();
  const stats = await capped.buildFull();
  expect(stats.filesRemoved).toBe(0);
  expect(capped.stats().indexedChunks).toBe(before);
  capped.close();
});

test('a file that became binary loses its chunks when it is reindexed', async () => {
  const { root, store } = setup(provider('p'), { 'a.ts': 'export const alphaMarker = 1;\n' });
  await store.init();
  await store.buildFull();
  expect(store.stats().indexedChunks).toBeGreaterThan(0);
  writeFileSync(join(root, 'a.ts'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  const result = await store.reindexFile(join(root, 'a.ts'));
  expect(result.indexed).toBe(false);
  expect(store.stats().indexedChunks).toBe(0);
  store.close();
});

test('a failed query embedding is named in the status, and an unopened index says it did not build', async () => {
  const failing: MemoryEmbeddingProvider = { ...provider('q'), embed: async () => { throw new Error('query provider down'); } };
  const { store } = setup(failing, { 'a.ts': 'export const alphaMarker = 1;\n' });
  const unopened = await store.buildFull();
  expect(unopened.abortReason).toContain('the code index is not open');
  await store.init();
  expect(await store.search('alpha')).toEqual([]);
  expect(store.stats().lastSearchError).toContain('query provider down');
  store.close();
});

test('a search error does not outlive a later search that never embedded a query', async () => {
  let down = false;
  const flaky: MemoryEmbeddingProvider = { ...provider('first'), embed: async (request) => {
    if (down) throw new Error('query provider down');
    return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
  } };
  const { registry, store } = setup(flaky, { 'a.ts': 'export const alphaMarker = 1;\n' });
  await store.init();
  await store.buildFull();
  down = true;
  expect(await store.search('alpha')).toEqual([]);
  expect(store.stats().lastSearchError).toContain('query provider down');
  // A provider change sends the next search down the lexical path, which embeds nothing.
  registry.register(provider('second'), { makeDefault: true });
  expect(store.getProviderMismatch()).toContain('first');
  await store.search('zzzunmatched');
  expect(store.stats().lastSearchError).toBeUndefined();
  store.close();
});

test('migrating an index built at another vector width recreates the vector table at the current width', async () => {
  const db = new Database(':memory:');
  await loadSqliteVecExtension(db);
  db.run('CREATE VIRTUAL TABLE code_vectors USING vec0(embedding float[8], +chunk_id text)');
  db.run('CREATE TABLE code_chunks (rowid INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, lang TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT \'\', kind TEXT NOT NULL DEFAULT \'\', start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, mtime INTEGER NOT NULL, file_revision TEXT NOT NULL)');
  migrateCodeIndexSchema(db);
  const chunk = { chunkId: 'one', path: 'a.ts', lang: 'ts', symbol: 'one', kind: 'function', startLine: 1, endLine: 2, mtimeMs: 1, fileRevision: 'r1' };
  replaceFileChunks(db, 'a.ts', [{ chunk, embedding: new Float32Array(MEMORY_VECTOR_DIMS).fill(0.1) }]);
  expect(countIndexedChunks(db)).toBe(1);
  db.close();
});

test('the code index api refuses to report an unstarted or aborted reindex as an empty success', async () => {
  const aborted = { filesScanned: 0, filesIndexed: 0, filesUnchanged: 0, chunksIndexed: 0, chunksUnchanged: 0, filesRemoved: 0,
    skip: { tooLarge: 0, overFileCap: 0, overTotalBytes: 0, binary: 0, ignoredByGitignore: 0, readErrors: 0, chunkedByWindow: 0 },
    startedAt: 1, completedAt: 1, durationMs: 0, abortReason: 'build not started: the code index is not open' };
  const api = createCodeIndexApi({ buildFull: async () => aborted } as unknown as CodeIndexApiRegistry);
  await expect(api.reindex()).rejects.toThrow('build not started: the code index is not open');
  const { abortReason: _unused, ...finished } = aborted;
  const ok = createCodeIndexApi({ buildFull: async () => finished } as unknown as CodeIndexApiRegistry);
  expect((await ok.reindex()).filesIndexed).toBe(0);
});
