/** UNRUN: actual native artifact publication/cleanup mutual exclusion. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, renameSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, acquireArtifactPublication, tryAcquireArtifactPublication } from '../platform/src/platform/artifacts/store.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const directory = mkdtempSync(join(tmpdir(), 'artifact-publisher-')); roots.push(directory); return directory; }
test('fresh actual create returns a held native lease without a caller-await cleanup gap', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory });
  const created = await store.createForPublication({ text: 'page', filename: 'page.md', kind: 'document', mimeType: 'text/markdown', retentionMs: 0 });
  try { created.lease.assertCurrent(); created.original.assertCurrent(); expect(tryAcquireArtifactPublication(created.original)).toBeNull(); }
  finally { created.lease.release(); }
  const acquired = tryAcquireArtifactPublication(created.original); expect(acquired).not.toBeNull(); acquired?.release();
});
test('a separate real ArtifactStore observes the same physical metadata lease', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory }), created = await store.createForPublication({ text: 'page', retentionMs: 0 });
  try { const other = new ArtifactStore({ rootDir: directory }); expect(tryAcquireArtifactPublication(other.captureOriginal(created.artifact.id))).toBeNull(); }
  finally { created.lease.release(); }
});
test('original cleanup can remove its artifact then release the native lease without retaining an abandoned lock', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory }), artifact = await store.create({ text: 'page' }), record = store.getRecord(artifact.id)!;
  const original = store.captureOriginal(artifact.id), lease = await acquireArtifactPublication(original);
  original.deleteOriginal(); lease.release(); lease.release();
  expect(existsSync(record.metadataPath)).toBe(false); expect(existsSync(`${record.metadataPath}.projection-lock`)).toBe(false);
});
test('original parent retirement cannot release through a replacement alias', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory }), created = await store.createForPublication({ text: 'page' }), record = store.getRecord(created.artifact.id)!;
  const retained = `${directory}-retained`; roots.push(retained); renameSync(directory, retained);
  expect(() => created.lease.assertCurrent()).toThrow();
  let failure: unknown; try { created.lease.release(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  for (let repeat = 0; repeat < 2; repeat++) {
    let repeated: unknown; try { created.lease.release(); } catch (error) { repeated = error; }
    expect(repeated).toBe(failure);
  }
  expect(existsSync(join(retained, `${created.artifact.id}.json.projection-lock`))).toBe(true); expect(existsSync(record.metadataPath)).toBe(false);
});

test('current metadata inventory is classification only, and old unknown shapes are retained', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory });
  const older = await store.create({ kind: 'document', mimeType: 'text/markdown', text: 'older', retentionMs: 0, metadata: { generatedKnowledgePage: true, generatedProjection: true } });
  const { inspectGeneratedArtifactCleanupCandidates } = await import('../platform/src/platform/artifacts/store.ts');
  const inventory = inspectGeneratedArtifactCleanupCandidates(store); expect(inventory.candidates).toHaveLength(0); expect(inventory.preserved).toBe(1); expect(store.getRecord(older.id)).not.toBeNull();
});


test('async and nonvoid write owners are drained and refused before any artifact or lock leaf is created', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory });
  const asyncOwner = { assertCurrent: async () => { throw new Error('Async owner rejection must be drained.'); } };
  await expect(store.createForPublication({ text: 'body' }, asyncOwner)).rejects.toThrow('synchronously');
  await expect(store.create({ text: 'body' }, { assertCurrent: () => 1 })).rejects.toThrow('synchronously');
  await expect(store.createFromStream({ stream: ['body'] }, { assertCurrent: () => Promise.resolve() })).rejects.toThrow('synchronously');
  expect(readdirSync(directory)).toEqual([]);
});


test('retired artifact release preserves both the original lock and a foreign replacement lock', async () => {
  const directory = root(), store = new ArtifactStore({ rootDir: directory });
  const created = await store.createForPublication({ text: 'page' });
  const record = store.getRecord(created.artifact.id)!;
  const retained = `${directory}-retained`; roots.push(retained); renameSync(directory, retained);
  mkdirSync(directory); const foreignLock = `${record.metadataPath}.projection-lock`;
  writeFileSync(foreignLock, 'Foreign replacement owner', { mode: 0o600 });
  let failure: unknown; try { created.lease.release(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  for (let repeat = 0; repeat < 2; repeat++) {
    let repeated: unknown; try { created.lease.release(); } catch (error) { repeated = error; }
    expect(repeated).toBe(failure);
  }
  expect(readFileSync(foreignLock, 'utf8')).toBe('Foreign replacement owner');
  expect(existsSync(join(retained, `${created.artifact.id}.json.projection-lock`))).toBe(true);
});
