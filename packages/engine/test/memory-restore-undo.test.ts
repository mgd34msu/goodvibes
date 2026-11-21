// Proves: Restoring memory from a copy does not keep what it replaced, or a restore that cannot keep it empties the store.
// Red when: The memory restore stops writing the undo copy before it clears the records, or carries on when that copy could not be written.
// Proves: A restore of the latest memory copy sent again, as the SDK does by itself for a call it may repeat, puts back the records the first restore replaced.
// Red when: `latest` names the undo copy the first restore just wrote, so the repeated restore reverts memory and still answers success.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
import { newStoreSnapshotPath, snapshotStoreFile } from '../platform/src/platform/state/store-snapshots.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

useMemoryReadings();

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const summaries = (registry: MemoryRegistry) => registry.getAll().map((record) => record.summary).sort();

test('a restore keeps what it replaced as an undo copy, and a restore that cannot write that copy changes nothing', async () => {
  const root = makeProjectTempDir('memory-restore-undo');
  const path = join(root, 'memory.sqlite');
  const store = new MemoryStore(path, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }) });
  cleanups.push(() => store.close());
  await store.init();
  const registry = new MemoryRegistry(store);

  await registry.add({ cls: 'fact', summary: 'memory A' });
  await store.save();
  const copy = snapshotStoreFile(path, 'manual');
  expect(copy).not.toBeNull();
  await registry.add({ cls: 'fact', summary: 'memory B' });

  const restored = await registry.restoreSnapshot(copy!.split('/').at(-1)!);
  expect(summaries(registry)).toEqual(['memory A']);
  await registry.restoreSnapshot(restored.undoSnapshot);
  expect(summaries(registry)).toEqual(['memory A', 'memory B']);

  // A directory where the undo copy's journal must go, so the copy cannot be written (the clock is the test's).
  const realNow = Date.now;
  const at = realNow();
  mkdirSync(`${newStoreSnapshotPath(path, 'pre-restore', at)}-journal`);
  Date.now = () => at;
  try {
    await expect(registry.restoreSnapshot(copy!.split('/').at(-1)!)).rejects.toThrow('nothing was changed');
  } finally {
    Date.now = realNow;
  }
  expect(summaries(registry)).toEqual(['memory A', 'memory B']);
});

test('a restore of the latest copy sent twice restores the same copy twice and does not undo itself', async () => {
  const root = makeProjectTempDir('memory-restore-latest');
  const path = join(root, 'memory.sqlite');
  const store = new MemoryStore(path, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }) });
  cleanups.push(() => store.close());
  await store.init();
  const registry = new MemoryRegistry(store);

  await registry.add({ cls: 'fact', summary: 'memory A' });
  await store.save();
  const copy = snapshotStoreFile(path, 'manual');
  expect(copy).not.toBeNull();
  await registry.add({ cls: 'fact', summary: 'memory B' });

  const first = await registry.restoreSnapshot('latest');
  expect(summaries(registry)).toEqual(['memory A']);
  const second = await registry.restoreSnapshot('latest');
  expect(second.restored).toBe(first.restored);
  expect(summaries(registry)).toEqual(['memory A']);
  // The first restore's undo copy is still there by its exact name.
  await registry.restoreSnapshot(first.undoSnapshot);
  expect(summaries(registry)).toEqual(['memory A', 'memory B']);
});
