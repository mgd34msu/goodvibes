/** Regression source only. Execution is deferred until coding is complete. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const UUID = '12345678-1234-4234-9234-123456789abc';
const id = `artifact-${opaqueUuid(UUID)}`;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'artifact-original-leaves-')), root = join(home, 'artifacts');
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new ArtifactStore({ rootDir: root });
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(UUID); cleanup.push(() => uuid.mockRestore());
  return { home, root, store, content: join(root, `${id}.data`), metadata: join(root, `${id}.json`) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('an exclusive content collision preserves the existing leaf and cancels an unopened waiting producer', async () => {
  const f = fixture(); writeFileSync(f.content, 'original owner bytes', { mode: 0o600 }); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(f.store.createFromStream({ stream, kind: 'file', filename: 'payload.bin' })).rejects.toThrow();
  expect(cancelled).toBe(true); expect(readFileSync(f.content, 'utf8')).toBe('original owner bytes');
  expect(existsSync(f.metadata)).toBe(false); expect(f.store.list()).toEqual([]);
});

test('an exclusive metadata collision never truncates or removes the other owner’s metadata', async () => {
  const f = fixture(); writeFileSync(f.metadata, 'foreign original metadata', { mode: 0o600 });
  await expect(f.store.createFromStream({ stream: ['payload'], kind: 'file', filename: 'payload.bin' })).rejects.toThrow();
  expect(readFileSync(f.metadata, 'utf8')).toBe('foreign original metadata'); expect(existsSync(f.content)).toBe(false);
});

test('a producer rejection removes only its created content and never touches unrelated names', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'unrelated'), 'keep');
  async function* rejected() { yield 'partial'; throw new Error('producer failed'); }
  await expect(f.store.createFromStream({ stream: rejected(), kind: 'file', filename: 'payload.bin' })).rejects.toThrow('producer failed');
  expect(readdirSync(f.root)).toEqual(['unrelated']);
});

test('a producer ignoring cancellation cannot keep a closed writer alive or publish its later chunk', async () => {
  const f = fixture(), entered = deferred<void>(), next = deferred<IteratorResult<string>>(), controller = new AbortController(); let returned = false;
  const stream: AsyncIterable<string> = { [Symbol.asyncIterator]() { return { next() { entered.resolve(); return next.promise; },
    async return() { returned = true; return { value: undefined, done: true }; } }; } };
  const writing = f.store.createFromStream({ stream, kind: 'file', filename: 'payload.bin' }, { signal: controller.signal });
  await entered.promise; controller.abort(new Error('owner cancelled')); await expect(writing).rejects.toThrow('owner cancelled');
  expect(returned).toBe(true); expect(readdirSync(f.root)).toEqual([]);
  next.resolve({ value: 'too late', done: false }); await Promise.resolve(); expect(readdirSync(f.root)).toEqual([]);
});

test('an ignored Web Stream cancellation promise does not acquire cleanup rights to a colliding file', async () => {
  const f = fixture(); writeFileSync(f.content, 'other owner', { mode: 0o600 }); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  await expect(f.store.createFromStream({ stream, kind: 'file', filename: 'payload.bin' })).rejects.toThrow();
  expect(cancelled).toBe(true); expect(readFileSync(f.content, 'utf8')).toBe('other owner');
});

test('later asynchronous inference/currentness failure cleans the original spool only', async () => {
  const f = fixture(); let completed = false;
  async function* stream() { yield 'payload'; completed = true; }
  await expect(f.store.createFromStream({ stream: stream(), mimeType: 'application/x-unknown', filename: 'payload.xyz' }, {
    assertCurrent() { if (completed && existsSync(f.content) && statSync(f.content).size > 0) throw new Error('original owner retired'); },
  })).rejects.toThrow('original owner retired');
  expect(readdirSync(f.root)).toEqual([]);
});

test('a legitimate existing root alias works, and retargeting it never publishes or cleans another directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'artifact-owned-alias-')), original = join(home, 'original'), outside = join(home, 'outside'), alias = join(home, 'alias');
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const originalStore = new ArtifactStore({ rootDir: original }); new ArtifactStore({ rootDir: outside }); symlinkSync(original, alias);
  const store = new ArtifactStore({ rootDir: alias });
  const saved = await store.createFromStream({ stream: ['original'], kind: 'file', filename: 'original.bin' });
  expect((await store.readContent(saved.id)).buffer.toString()).toBe('original'); expect(originalStore.storagePath).toBe(original);
  const entered = deferred<void>(), finish = deferred<void>();
  async function* delayed() { yield 'partial'; entered.resolve(); await finish.promise; yield 'later'; }
  const writing = store.createFromStream({ stream: delayed(), kind: 'file', filename: 'next.bin' });
  await entered.promise; unlinkSync(alias); symlinkSync(outside, alias); writeFileSync(join(outside, 'sentinel'), 'keep'); finish.resolve();
  await expect(writing).rejects.toThrow(); expect(readdirSync(outside)).toEqual(['sentinel']);
  expect(readdirSync(original).sort()).toEqual([`${saved.id}.data`, `${saved.id}.json`].sort());
});

test('a physically replaced canonical root never adopts or removes its replacement’s filenames', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>();
  async function* delayed() { yield 'partial'; entered.resolve(); await finish.promise; yield 'later'; }
  const writing = f.store.createFromStream({ stream: delayed(), kind: 'file', filename: 'payload.bin' });
  await entered.promise; renameSync(f.root, join(f.home, 'old-root')); new ArtifactStore({ rootDir: f.root });
  writeFileSync(f.content, 'replacement content', { mode: 0o600 }); writeFileSync(f.metadata, 'replacement metadata', { mode: 0o600 }); finish.resolve();
  await expect(writing).rejects.toThrow(); expect(readFileSync(f.content, 'utf8')).toBe('replacement content');
  expect(readFileSync(f.metadata, 'utf8')).toBe('replacement metadata');
});

test('replacing a completed spool before publication never transfers cleanup ownership', async () => {
  const f = fixture(); let completed = false, replaced = false;
  async function* stream() { yield 'payload'; completed = true; }
  await expect(f.store.createFromStream({ stream: stream(), kind: 'file', filename: 'payload.bin' }, {
    assertCurrent() {
      if (!completed || replaced || !existsSync(f.content) || statSync(f.content).size === 0) return;
      renameSync(f.content, join(f.root, 'original-spool')); writeFileSync(f.content, 'foreign replacement', { mode: 0o600 }); replaced = true;
    },
  })).rejects.toThrow();
  expect(replaced).toBe(true); expect(readFileSync(f.content, 'utf8')).toBe('foreign replacement'); expect(existsSync(f.metadata)).toBe(false);
});

test('normal artifact deletion cannot remove a same-name replacement file', async () => {
  const f = fixture(), saved = await f.store.createFromStream({ stream: ['owned'], kind: 'file', filename: 'saved.bin' });
  const path = join(f.root, `${saved.id}.data`); unlinkSync(path); writeFileSync(path, 'foreign replacement', { mode: 0o600 });
  expect(f.store.delete(saved.id)).toBe(false); expect(readFileSync(path, 'utf8')).toBe('foreign replacement');
});

test('cancellation as kind inference yields removes the completed spool without publishing metadata', async () => {
  const f = fixture(), controller = new AbortController();
  await expect(f.store.createFromStream({ stream: ['payload'], filename: 'payload.xyz',
    get mimeType() { controller.abort(new Error('inference owner retired')); return 'application/x-unknown'; },
  }, { signal: controller.signal })).rejects.toThrow('inference owner retired');
  expect(readdirSync(f.root)).toEqual([]);
});

test.each([0, 0o777])('exclusive artifacts get readable private files even with umask %i', async mask => {
  const f = fixture(), previous = process.umask(mask); cleanup.push(() => { process.umask(previous); });
  const saved = await f.store.createFromStream({ stream: ['private payload'], kind: 'file', filename: 'private.bin' });
  expect(saved.id).toBe(id); expect(saved.id.slice('artifact-'.length).replace(/-/g, '')).toHaveLength(32);
  expect(saved.id).not.toMatch(/\d/); expect(statSync(f.content).mode & 0o777).toBe(0o600); expect(statSync(f.metadata).mode & 0o777).toBe(0o600);
  expect((await f.store.readContent(saved.id)).buffer.toString()).toBe('private payload');
});

test('imported metadata cannot make expiration delete an arbitrary sibling file', () => {
  const f = fixture(), target = join(f.root, 'foreign.data'); writeFileSync(target, 'foreign original', { mode: 0o600 });
  writeFileSync(f.metadata, JSON.stringify({ id, contentPath: target, metadataPath: f.metadata, expiresAt: 1 }), { mode: 0o600 });
  const reloaded = new ArtifactStore({ rootDir: f.root }); expect(reloaded.list()).toEqual([]); expect(readFileSync(target, 'utf8')).toBe('foreign original');
});
