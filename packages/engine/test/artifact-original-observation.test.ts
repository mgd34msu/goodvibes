/** UNRUN: original physical/record binding without byte reads or hash guards. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, artifactOriginalId, removeOriginalArtifact } from '../sdk/src/platform/artifacts/store.ts';
import type { ArtifactOriginalObservation, ArtifactRecord } from '../sdk/src/platform/artifacts/types.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() { const root = mkdtempSync(join(tmpdir(), 'artifact-original-')); roots.push(root); const store = new ArtifactStore({ rootDir: root }), artifact = await store.create({ kind: 'document', text: 'original content', filename: 'document.txt' }); const record = store.getRecord(artifact.id); if (!record) throw Error('Missing actual stored artifact'); return { root, store, artifact, record }; }
test('capturing/rechecking a genuine artifact reads no content or metadata body', async () => {
  const f = await fixture(), read = spyOn(fs, 'readFileSync').mockImplementation(() => { throw Error('Unexpected body reread'); });
  try { const original = f.store.captureOriginal(f.artifact.id); original.assertCurrent(); expect(artifactOriginalId(original)).toBe(f.artifact.id); }
  finally { read.mockRestore(); }
});
test('same-byte original content replacement retires both observation and bound deletion', async () => {
  const f = await fixture(), original = f.store.captureOriginal(f.artifact.id), bytes = readFileSync(f.record.contentPath); renameSync(f.record.contentPath, `${f.record.contentPath}.retained`); writeFileSync(f.record.contentPath, bytes, { mode: 0o600 });
  expect(() => original.assertCurrent()).toThrow(); expect(() => removeOriginalArtifact(original)).toThrow(); expect(readFileSync(f.record.contentPath)).toEqual(bytes); expect(existsSync(f.record.metadataPath)).toBe(true);
});
test('same-byte metadata replacement cannot be adopted by the original removal closure', async () => {
  const f = await fixture(), original = f.store.captureOriginal(f.artifact.id), bytes = readFileSync(f.record.metadataPath); renameSync(f.record.metadataPath, `${f.record.metadataPath}.retained`); writeFileSync(f.record.metadataPath, bytes, { mode: 0o600 });
  expect(() => original.deleteOriginal()).toThrow(); expect(existsSync(f.record.contentPath)).toBe(true); expect(readFileSync(f.record.metadataPath)).toEqual(bytes);
});
test('serialized observations and prototype-borrowed stores cannot mint a native original deletion', async () => {
  const f = await fixture(), original = f.store.captureOriginal(f.artifact.id), copied = JSON.parse(JSON.stringify(original)) as ArtifactOriginalObservation;
  expect(() => artifactOriginalId(copied)).toThrow(); expect(() => removeOriginalArtifact(copied)).toThrow();
  const borrowed = Object.create(ArtifactStore.prototype) as ArtifactStore; Object.defineProperties(borrowed, Object.getOwnPropertyDescriptors(f.store)); expect(() => borrowed.captureOriginal(f.artifact.id)).toThrow();
  expect(existsSync(f.record.contentPath)).toBe(true);
});
test('a forged frozen cached record cannot enter the actual native creation registry', async () => {
  const f = await fixture(), original = f.store.captureOriginal(f.artifact.id), records = Reflect.get(f.store, 'records') as Map<string, ArtifactRecord>;
  records.set(f.artifact.id, Object.freeze({ ...f.record, metadata: Object.freeze({ forged: true }) }));
  try { expect(() => f.store.captureOriginal(f.artifact.id)).toThrow(); expect(() => original.deleteOriginal()).toThrow(); }
  finally { records.set(f.artifact.id, f.record); }
  expect(existsSync(f.record.contentPath)).toBe(true);
});
test('metadata changing during actual async metadata write cannot alter cached or persisted original provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-metadata-capture-')); roots.push(root); const store = new ArtifactStore({ rootDir: root }), metadata = { nested: { value: 'original' } }, nativeWrite = fs.writeFile;
  const replacement = ((path: fs.PathOrFileDescriptor, data: string, options: { encoding: BufferEncoding }, callback: (error: NodeJS.ErrnoException | null) => void) => { nativeWrite(path, data, options, error => { metadata.nested.value = 'changed during native write'; callback(error); }); }) as typeof fs.writeFile;
  const write = spyOn(fs, 'writeFile').mockImplementation(replacement); let id: string;
  try { id = (await store.create({ kind: 'document', text: 'body', metadata })).id; }
  finally { write.mockRestore(); }
  const record = store.getRecord(id!); if (!record) throw Error('Missing actual canonical record'); const saved = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as ArtifactRecord;
  expect(record.metadata).toEqual({ nested: { value: 'original' } }); expect(saved.metadata).toEqual(record.metadata); expect(record.metadata).not.toBe(metadata); expect(metadata.nested.value).toBe('changed during native write'); expect(Object.isFrozen(record)).toBe(true); expect(Object.isFrozen(record.metadata.nested)).toBe(true); store.captureOriginal(id!).assertCurrent();
});
test('live use expires while the same original can still be deleted without adopting another identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-live-expiry-')); roots.push(root); let now = 1000; const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try { const store = new ArtifactStore({ rootDir: root }), artifact = await store.create({ kind: 'document', text: 'body', retentionMs: 1000 }), record = store.getRecord(artifact.id); if (!record) throw Error('Missing actual expiring artifact'); const original = store.captureOriginal(artifact.id); now = 2001; expect(() => original.assertCurrent()).toThrow('expired'); expect(removeOriginalArtifact(original)).toBe(true); expect(existsSync(record.contentPath)).toBe(false); expect(existsSync(record.metadataPath)).toBe(false); }
  finally { clock.mockRestore(); }
});
test('a successful original removal retires a previously retained real byte-read guard', async () => {
  const f = await fixture(), acquired = await f.store.readContent(f.artifact.id), original = f.store.captureOriginal(f.artifact.id); expect(removeOriginalArtifact(original)).toBe(true); expect(() => acquired.assertCurrent?.()).toThrow(); expect(acquired.buffer.toString()).toBe('original content');
});

test('replacing native storage guard methods retires proof before a supplied accessor executes', async () => {
  const f = await fixture(), original = f.store.captureOriginal(f.artifact.id), owner: object = Reflect.get(f.store, 'storageOwner'); let calls = 0;
  Object.defineProperty(owner, 'assertImported', { configurable: true, get() { calls++; return () => {}; } });
  try { expect(() => original.assertCurrent()).toThrow(); expect(() => original.deleteOriginal()).toThrow(); expect(calls).toBe(0); }
  finally { Reflect.deleteProperty(owner, 'assertImported'); }
  expect(existsSync(f.record.contentPath)).toBe(true);
});
