/** Closing a store while its open is still loading the vector extension must leave it cleanly closed. */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { CodeIndexStore } from '../platform/src/platform/state/code-index-store.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { SqliteVecMemoryIndex } from '../platform/src/platform/state/memory-vector-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function registry(root: string): MemoryEmbeddingProviderRegistry {
  return new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
}

test('a code index closed during its open stays closed, with no error from the abandoned open', async () => {
  const root = makeProjectTempDir('code-index-close-open');
  const store = new CodeIndexStore(root, ':memory:', registry(root));
  const opening = store.init();
  store.close();
  await opening;
  expect(store.stats().available).toBe(false);
  expect(store.stats().error).toBeUndefined();
  // It can still be opened afterwards.
  await store.init();
  expect(store.stats().available).toBe(true);
  store.close();
});

test('a vector index closed during its open stays closed, with no error from the abandoned open', async () => {
  const root = makeProjectTempDir('vector-close-open');
  const index = new SqliteVecMemoryIndex(':memory:', undefined, registry(root));
  const opening = index.init();
  index.close();
  await opening;
  expect(index.stats().available).toBe(false);
  expect(index.stats().error).toBeUndefined();
  index.close();
});

test('a build asked of a store that is not open says why nothing ran', async () => {
  const root = makeProjectTempDir('code-index-build-closed');
  const store = new CodeIndexStore(root, ':memory:', registry(root));
  await store.init();
  store.close();
  await store.buildFull();
  expect(store.stats().lastBuildError).toContain('the code index is not open');
  await store.init();
  await store.buildFull();
  expect(store.stats().lastBuildError).toBeUndefined();
  store.close();
});
