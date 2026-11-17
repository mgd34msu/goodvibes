/**
 * One memory file, more than one app: the daemon, a terminal and the memory
 * command each open it with their own MemoryStore. A memory one of them adds
 * is read by the others, no write erases another's, and a record and its
 * search-index entry land and leave together.
 */
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { MemoryStore, planMemoryRecord } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
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

const summaries = (store: MemoryStore) => store.retrieve().map((record) => record.summary).sort();

test('a memory one app adds is read at once by another app on the same file, and no app erases another\'s', async () => {
  const { open } = setup();
  const a = await open();
  const shared = await a.add({ cls: 'fact', summary: 'written by A before B opened' });
  const b = await open();
  const fromB = await b.add({ cls: 'fact', summary: 'written by B' });

  // A sees B's row without reopening, and its own later writes keep it.
  expect(a.get(fromB.id)?.summary).toBe('written by B');
  const fromA = await a.add({ cls: 'fact', summary: 'written by A after B' });
  expect(a.review(shared.id, { state: 'reviewed', reviewedBy: 'operator' })?.reviewState).toBe('reviewed');
  expect(b.get(fromA.id)?.summary).toBe('written by A after B');
  await a.save();

  const reopened = await open();
  expect(summaries(reopened)).toEqual(['written by A after B', 'written by A before B opened', 'written by B']);
  expect(reopened.get(shared.id)?.reviewState).toBe('reviewed');
});

test('two adds in flight together and a review during an add each land once', async () => {
  const { open } = setup();
  const store = await open();
  const other = await store.add({ cls: 'fact', summary: 'other record' });
  const both = await Promise.allSettled([store.add({ cls: 'fact', summary: 'first' }), store.add({ cls: 'fact', summary: 'second' })]);
  expect(both.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const pending = store.add({ cls: 'fact', summary: 'third' });
  store.review(other.id, { state: 'reviewed' });
  await pending;
  await store.save();

  const reopened = await open();
  expect(summaries(reopened)).toEqual(['first', 'other record', 'second', 'third']);
  expect(reopened.get(other.id)?.reviewState).toBe('reviewed');
});

test('a resent add whose reply was lost stores the memory once, and a different memory under that id is refused', async () => {
  const { open } = setup();
  const store = await open();
  const id = planMemoryRecord({ cls: 'fact', summary: 'sent twice' }).id;
  const first = await store.add({ id, cls: 'fact', summary: 'sent twice' });
  const again = await store.add({ id, cls: 'fact', summary: 'sent twice' });
  expect(again.id).toBe(first.id);
  await expect(store.add({ id, cls: 'fact', summary: 'something else' })).rejects.toThrow();
  expect((await open()).retrieve().map((record) => record.id)).toEqual([id]);
});

test('an insert the caller refuses is taken out again, so nothing is stored', async () => {
  const { open } = setup();
  const store = await open();
  const plan = planMemoryRecord({ cls: 'fact', summary: 'refused at the insert' });
  await expect(store.add({ cls: 'fact', summary: 'refused at the insert' }, undefined, {
    id: plan.id, createdAt: plan.createdAt, onInserted: () => { throw new Error('caller refused'); },
  })).rejects.toThrow('caller refused');
  expect(store.get(plan.id)).toBeNull();
  expect((await open()).get(plan.id)).toBeNull();
});

test('a record and its search-index entry land together and leave together', async () => {
  const { open } = setup(true);
  const store = await open();
  // The start-up pass has nothing to index; let it finish so only the writes below move the index.
  await store.rebuildVectorIndexAsync();
  expect(store.vectorStats().available).toBe(true);
  expect(store.vectorStats().indexedRecords).toBe(0);

  const record = await store.add({ cls: 'fact', summary: 'deploys go through the release pipeline' });
  expect(store.vectorStats().indexedRecords).toBe(1);
  expect(store.delete(record.id)).toBe(true);
  expect(store.vectorStats().indexedRecords).toBe(0);
});

test('a terminal that falls back from the daemon to its own store reads what the daemon wrote, and writes to the same file', async () => {
  const { open } = setup();
  const local = await open();
  const spine = new MemorySpineClient({ local: createLocalMemoryAccess(new MemoryRegistry(local)) });
  const unreachable = () => Promise.reject(new Error('the daemon is not reached in this proof'));
  const transport: MemoryTransport = { add: unreachable, honestSearch: unreachable, get: unreachable, updateReview: unreachable, delete: unreachable };
  spine.activate(transport);

  // The daemon owns the file while the terminal is its client.
  const daemon = await open();
  const daemonRecord = await daemon.add({ cls: 'fact', summary: 'written by the daemon' });

  spine.deactivate('heartbeat probe failed');
  expect((await spine.get(daemonRecord.id))?.summary).toBe('written by the daemon');
  await spine.add({ cls: 'fact', summary: 'written locally after detach' });

  expect(summaries(await open())).toEqual(['written by the daemon', 'written locally after detach']);
});
