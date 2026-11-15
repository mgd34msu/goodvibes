/**
 * One memory file, more than one process image. sql.js loads the whole file
 * into memory and writes the whole image back, so a store that kept writing
 * the image it loaded at boot would erase every record another process (the
 * daemon, a second surface, the memory CLI) wrote since. These tests hold two
 * MemoryStore instances on one file the way two processes would.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { MemoryStore, MemoryStoreChangedOnDiskError, planMemoryRecord } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.ts';
import { Database } from 'bun:sqlite';
import { loadSqliteVecExtension } from '../platform/src/platform/state/sqlite-vec-loader.ts';
import { SqliteVecMemoryIndex } from '../platform/src/platform/state/memory-vector-store.ts';
import { MemorySpineClient, createLocalMemoryAccess, type MemoryTransport } from '../platform/src/platform/runtime/memory-spine/client.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

useMemoryReadings();

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(enableVectorIndex = false) {
  const root = makeProjectTempDir('memory-shared-file');
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
  const path = join(root, 'memory.sqlite');
  const open = async () => {
    const store = new MemoryStore(path, { embeddingRegistry: embeddings, enableVectorIndex });
    cleanups.push(() => store.close());
    await store.init();
    return store;
  };
  return { path, open };
}

test('a store refuses to write over records another process saved, then writes once it has reloaded', async () => {
  const { open } = setup();
  const a = await open();
  await a.add({ cls: 'fact', summary: 'written by A before B opened' });
  const b = await open();
  const fromB = await b.add({ cls: 'fact', summary: 'written by B' });

  await expect(a.add({ cls: 'fact', summary: 'written by A after B' })).rejects.toBeInstanceOf(MemoryStoreChangedOnDiskError);
  expect(a.get(fromB.id)?.summary).toBe('written by B');
  const retried = await a.add({ cls: 'fact', summary: 'written by A after B' });

  const reopened = await open();
  expect(reopened.retrieve().map((record) => record.summary).sort()).toEqual(
    ['written by A after B', 'written by A before B opened', 'written by B'],
  );
  expect(reopened.get(retried.id)).not.toBeNull();
});

test('a synchronous edit on a stale image is refused with nothing written, and succeeds after the reload', async () => {
  const { open } = setup();
  const a = await open();
  const shared = await a.add({ cls: 'fact', summary: 'shared record' });
  const b = await open();
  await b.add({ cls: 'fact', summary: 'only B knows this' });

  expect(() => a.review(shared.id, { state: 'reviewed', reviewedBy: 'operator' })).toThrow(MemoryStoreChangedOnDiskError);
  await a.reloadIfChanged();
  expect(a.review(shared.id, { state: 'reviewed', reviewedBy: 'operator' })?.reviewState).toBe('reviewed');

  const reopened = await open();
  expect(reopened.retrieve().map((record) => record.summary).sort()).toEqual(['only B knows this', 'shared record']);
  expect(reopened.get(shared.id)?.reviewState).toBe('reviewed');
});

test('returning from the daemon to local access reloads the local store before serving it', async () => {
  const { open } = setup();
  const local = await open();
  const spine = new MemorySpineClient({ local: createLocalMemoryAccess(new MemoryRegistry(local)) });
  const unreachable = () => Promise.reject(new Error('transport not used in this test'));
  const transport: MemoryTransport = { add: unreachable, honestSearch: unreachable, get: unreachable, updateReview: unreachable, delete: unreachable };
  spine.activate(transport);

  // The daemon owns the file while the surface is a client.
  const daemon = await open();
  const daemonRecord = await daemon.add({ cls: 'fact', summary: 'written by the daemon' });

  spine.deactivate('heartbeat probe failed');
  expect((await spine.get(daemonRecord.id))?.summary).toBe('written by the daemon');
  await spine.add({ cls: 'fact', summary: 'written locally after detach' });

  const reopened = await open();
  expect(reopened.retrieve().map((record) => record.summary).sort()).toEqual(['written by the daemon', 'written locally after detach']);
});

test('a ranked search still answers when another caller writes while it is ranking', async () => {
  const { open } = setup();
  const store = await open();
  await store.add({ cls: 'fact', summary: 'deploy runs through the release pipeline' });
  const pending = store.search({ query: 'deploy' });
  await store.add({ cls: 'fact', summary: 'unrelated write during ranking' });
  expect((await pending).map((record) => record.summary)).toEqual(['deploy runs through the release pipeline']);
});

test('a staged add whose row is saved reports success even when another write lands during the save', async () => {
  const { open } = setup();
  const store = await open();
  const other = await store.add({ cls: 'fact', summary: 'other record' });
  const original = SQLiteStore.prototype.save;
  let nested = false;
  const save = spyOn(SQLiteStore.prototype, 'save').mockImplementation(function (this: SQLiteStore) {
    const result = Reflect.apply(original, this, []) as Promise<boolean>;
    if (!nested) { nested = true; queueMicrotask(() => { store.update(other.id, { summary: 'edited during the save' }); }); }
    return result;
  });
  cleanups.push(() => save.mockRestore());
  const plan = planMemoryRecord({ cls: 'fact', summary: 'prepared record' });
  expect((await store.add({ cls: 'fact', summary: 'prepared record' }, undefined, { id: plan.id, createdAt: plan.createdAt })).id).toBe(plan.id);
  nested = false;
  const viaRegistry = planMemoryRecord({ cls: 'fact', summary: 'prepared through the registry' });
  expect((await new MemoryRegistry(store).add({ cls: 'fact', summary: 'prepared through the registry' }, undefined,
    { id: viaRegistry.id, createdAt: viaRegistry.createdAt })).id).toBe(viaRegistry.id);
  save.mockRestore();
  const reopened = await open();
  expect(reopened.get(plan.id)?.summary).toBe('prepared record');
  expect(reopened.get(viaRegistry.id)?.summary).toBe('prepared through the registry');
});

test('an insert callback that throws takes the row out again, so nothing is stored', async () => {
  const { open } = setup();
  const store = await open();
  const plan = planMemoryRecord({ cls: 'fact', summary: 'refused at the insert' });
  await expect(store.add({ cls: 'fact', summary: 'refused at the insert' }, undefined, {
    id: plan.id, createdAt: plan.createdAt, onInserted: () => { throw new Error('caller refused'); },
  })).rejects.toThrow('caller refused');
  expect(store.get(plan.id)).toBeNull();
  expect((await open()).get(plan.id)).toBeNull();
});

test('two adds in flight together, or an add with another write during its save, each succeed once', async () => {
  const { open } = setup();
  const store = await open();
  const other = await store.add({ cls: 'fact', summary: 'other record' });
  const both = await Promise.allSettled([store.add({ cls: 'fact', summary: 'first' }), store.add({ cls: 'fact', summary: 'second' })]);
  expect(both.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const pending = store.add({ cls: 'fact', summary: 'third' });
  store.review(other.id, { state: 'reviewed' });
  await pending;
  expect(store.retrieve({}).map((record) => record.summary).sort()).toEqual(['first', 'other record', 'second', 'third']);
});

test('an imported record that needs normalising is imported whole, with its links', async () => {
  const { open } = setup(true);
  const store = await open();
  const now = Date.now();
  const result = await store.importBundle({
    schemaVersion: 'v1', exportedAt: now, scope: 'all', recordCount: 2, linkCount: 1,
    records: [
      { id: 'mem_import_a', scope: 'project', cls: 'fact', summary: 'imported a', tags: [], provenance: [], reviewState: 'fresh', confidence: 52.5, createdAt: now, updatedAt: now },
      { id: 'mem_import_b', scope: 'project', cls: 'fact', summary: 'imported b', tags: [], provenance: [], reviewState: 'fresh', confidence: 60, createdAt: now, updatedAt: now },
    ],
    links: [{ fromId: 'mem_import_a', toId: 'mem_import_b', relation: 'relates', createdAt: now }],
  });
  expect(result).toEqual({ importedRecords: 2, skippedRecords: 0, importedLinks: 1 });
  expect(store.get('mem_import_a')?.confidence).toBe(53);
});

// The vector index can only open where the platform allows SQLite extension loading.
const vecLoadable = await (async () => {
  try { await loadSqliteVecExtension(new Database(':memory:')); return true; } catch { return false; }
})();

function blockedVectorIndex(): { index: SqliteVecMemoryIndex; unblock: () => void } {
  const root = makeProjectTempDir('memory-vector-flags');
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
  // A file where the index's directory should be makes the first open fail.
  const blocker = join(root, 'blocked');
  writeFileSync(blocker, 'not a directory');
  const index = new SqliteVecMemoryIndex(join(blocker, 'memory.vec.sqlite'), undefined, embeddings);
  cleanups.push(() => index.close());
  return { index, unblock: () => rmSync(blocker) };
}

test('a vector index that cannot open reports its error', async () => {
  const { index } = blockedVectorIndex();
  await index.init();
  expect(index.stats().error).toBeDefined();
});

test.skipIf(!vecLoadable)('the vector index reports what it is now: no old error after a later open succeeds, unavailable once closed', async () => {
  const { index, unblock } = blockedVectorIndex();
  await index.init();
  expect(index.stats().error).toBeDefined();
  unblock();
  await index.init();
  const opened = index.stats();
  expect(opened.available).toBe(true);
  expect(opened.error).toBeUndefined();
  index.close();
  expect(index.stats().available).toBe(false);
});

test('putting a record back to fresh clears the reviewer stamp, and a default stale reason names who marked it', async () => {
  const { open } = setup();
  const store = await open();
  const record = await store.add({ cls: 'fact', summary: 'reviewed then reset' });

  const reviewed = store.review(record.id, { state: 'reviewed', reviewedBy: 'alex' });
  expect(reviewed).toMatchObject({ reviewState: 'reviewed', reviewedBy: 'alex' });
  expect(reviewed?.reviewedAt).toBeNumber();

  const fresh = store.review(record.id, { state: 'fresh' });
  expect(fresh?.reviewState).toBe('fresh');
  expect(fresh?.reviewedAt).toBeUndefined();
  expect(fresh?.reviewedBy).toBeUndefined();
  expect(store.get(record.id)).toMatchObject({ reviewState: 'fresh' });
  expect(store.get(record.id)?.reviewedBy).toBeUndefined();

  const stale = store.review(record.id, { state: 'stale', reviewedBy: 'consolidation' });
  expect(stale?.staleReason).toBe('marked stale by consolidation');
});
