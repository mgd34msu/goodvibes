// Proves: A memory written by one app is not seen by, or is erased by, another app on the same file; or one of two writes made together is not stored.
// Red when: A store handle answers from a private copy or saves its whole view, or one of two adds made together (or a review during an add) is withdrawn or not committed.
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
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
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
