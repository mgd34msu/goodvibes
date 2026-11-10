/** UNRUN: genuine configured owners, cross-family/other-process-style saved
 * references, original artifacts and zero-write inactive families. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as persistedImages from '../platform/src/platform/state/sqlite-store-persistence.ts';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.ts';
import { KnowledgeStore, captureKnowledgeArtifactReferenceOwner } from '../platform/src/platform/knowledge/store.ts';
import { configureKnowledgeArtifactReferences } from '../platform/src/platform/knowledge/artifact-reference-ensemble.ts';
import { createInactiveArtifactReferenceOwner } from '../platform/src/platform/knowledge/inactive-artifact-reference-owner.ts';
import { waitFor } from './_helpers/test-timeout.js';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(persisted = true) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-ensemble-')); roots.push(root);
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') }), store = new KnowledgeStore({ dbPath: join(root, 'knowledge-agent.sqlite') }); stores.push(store); await store.init();
  // Initialization is read-only. Most cases exercise a real clean published
  // family; create that baseline through an actual unrelated source mutation.
  if (persisted) await store.upsertSource({ id: 'clean-fixture-source', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'Clean family baseline' });
  configureKnowledgeArtifactReferences({ artifactStore: artifacts, controlPlaneDirectory: root, stores: [store] });
  const artifact = await artifacts.create({ kind: 'document', text: 'generated body', filename: 'page.md', retentionMs: 0 });
  return { root, artifacts, store, artifact };
}
test('a pending unpublished family preserves its artifact until a genuine clean publication permits retry', async () => {
  const f = await fixture(false), record = f.artifacts.getRecord(f.artifact.id)!;
  await f.store.batch(async () => {
    await f.store.upsertSource({ id: 'first-clean-source', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'First genuine publication' });
    expect(existsSync(f.store.storagePath)).toBe(false);
    expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held');
    expect(existsSync(record.contentPath)).toBe(true);
    expect(existsSync(f.store.storagePath)).toBe(false);
  });
  const published = readFileSync(f.store.storagePath);
  for (let turn = 0; existsSync(record.contentPath) && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(existsSync(record.contentPath)).toBe(false);
  expect(readFileSync(f.store.storagePath)).toEqual(published);
  for (const file of ['knowledge-wiki.sqlite', 'knowledge-home-graph.sqlite']) expect(existsSync(join(f.root, file))).toBe(false);
});
test('uninitialized families stay absent and exact configured zero-reference original is removed without changing any DB bytes', async () => {
  const f = await fixture(), before = readFileSync(f.store.storagePath), record = f.artifacts.getRecord(f.artifact.id)!;
  expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('deleted');
  expect(existsSync(record.contentPath)).toBe(false); expect(readFileSync(f.store.storagePath)).toEqual(before);
  for (const file of ['knowledge-wiki.sqlite', 'knowledge-home-graph.sqlite']) expect(existsSync(join(f.root, file))).toBe(false);
});
test('a persisted inactive wiki reference added by an independent owner beats the active agent cache', async () => {
  const f = await fixture(), wiki = new KnowledgeStore({ dbPath: join(f.root, 'knowledge-wiki.sqlite') }); stores.push(wiki); await wiki.init();
  await wiki.upsertSource({ id: 'saved-source', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'saved', artifactId: f.artifact.id });
  const before = readFileSync(wiki.storagePath);
  expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('referenced');
  expect(readFileSync(wiki.storagePath)).toEqual(before); expect(f.artifacts.getRecord(f.artifact.id)).not.toBeNull();
});
test('standalone/custom roots preserve rather than guessing a complete reference policy', async () => {
  const f = await fixture(), other = new ArtifactStore({ rootDir: join(f.root, 'custom') }), artifact = await other.create({ text: 'custom' });
  expect(await f.store.cleanupUnreferencedArtifact(other.captureOriginal(artifact.id))).toBe('unavailable'); expect(other.getRecord(artifact.id)).not.toBeNull();
  const standalone = new KnowledgeStore({ dbPath: join(f.root, 'standalone.sqlite') }); stores.push(standalone); await standalone.init();
  expect(await standalone.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('unavailable');
});
test('pending batch does not pretend unsaved source relations are absent', async () => {
  const f = await fixture();
  await f.store.batch(async () => {
    await f.store.upsertSource({ id: 'pending-source', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'pending', artifactId: f.artifact.id });
    expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held');
  });
  // The actual clean-save listener may still own this artifact's strict lease.
  // Once that admitted retry drains, a fresh read must see the persisted ref.
  const observed: { result: Awaited<ReturnType<KnowledgeStore['cleanupUnreferencedArtifact']>> } = { result: 'held' };
  await waitFor(async () => { observed.result = await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id)); return observed.result !== 'held'; });
  expect(observed.result).toBe('referenced');
  expect(f.artifacts.get(f.artifact.id)).not.toBeNull();
});
test('parsed/copied stores and replaced original sqlite slots cannot report a forged empty family', async () => {
  const f = await fixture(), fake = Object.create(KnowledgeStore.prototype) as KnowledgeStore; Object.defineProperties(fake, Object.getOwnPropertyDescriptors(f.store));
  expect(() => captureKnowledgeArtifactReferenceOwner(fake)).toThrow();
  const actual = Object.getOwnPropertyDescriptor(f.store, 'sqlite')!; Object.defineProperty(f.store, 'sqlite', { ...actual, value: { withArtifactReferenceReads: async () => ({ kind: 'completed', value: 'deleted' }) } });
  try { expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held'); }
  finally { Object.defineProperty(f.store, 'sqlite', actual); }
});
test('an original inactive parent replaced before claim is not recreated or used for reads/writes outside its source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inactive-reference-parent-')); roots.push(root);
  const owner = createInactiveArtifactReferenceOwner(join(root, 'knowledge-wiki.sqlite')), retained = `${root}-retained`; roots.push(retained); renameSync(root, retained);
  const foreign = mkdtempSync(join(tmpdir(), 'inactive-reference-foreign-')); roots.push(foreign); symlinkSync(foreign, root);
  await expect(owner.withReads(['artifact'], async () => false)).rejects.toThrow();
  expect(existsSync(join(foreign, 'knowledge-wiki.sqlite'))).toBe(false); expect(existsSync(join(foreign, 'knowledge-wiki.sqlite.knowledge-lock'))).toBe(false);
});
test('malformed or future inactive source is preserved and cannot establish no references', async () => {
  const f = await fixture(), path = join(f.root, 'knowledge-wiki.sqlite'), bytes = Buffer.from('not a SQLite database'); writeFileSync(path, bytes, { mode: 0o600 });
  expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held'); expect(readFileSync(path)).toEqual(bytes); expect(f.artifacts.getRecord(f.artifact.id)).not.toBeNull();
});

test('future inactive schema is not repaired, migrated, overwritten or interpreted as empty', async () => {
  const f = await fixture(), path = join(f.root, 'knowledge-wiki.sqlite');
  const { loadSqlJsEngine } = await import('../platform/src/platform/state/sqlite-store.ts'), engine = await loadSqlJsEngine(), raw = new engine.Database(readFileSync(f.store.storagePath));
  let bytes: Uint8Array; try { raw.run('PRAGMA user_version = 2147483647'); bytes = raw.export(); } finally { raw.close(); }
  writeFileSync(path, bytes!, { mode: 0o600 });
  expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held'); expect(readFileSync(path)).toEqual(Buffer.from(bytes!));
});

test('a deferred same-process candidate retries after the actual outer batch saves, without another explicit delete request', async () => {
  const f = await fixture(), record = f.artifacts.getRecord(f.artifact.id)!;
  await f.store.batch(async () => {
    await f.store.upsertSource({ id: 'unrelated', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'unrelated' });
    expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held');
    expect(existsSync(record.contentPath)).toBe(true);
  });
  for (let turn = 0; existsSync(record.contentPath) && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(existsSync(record.contentPath)).toBe(false);
});

test('restart discovers current-format orphan metadata while preserving unattributed older generated artifacts and a live publisher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-restart-')); roots.push(root);
  const initial = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const metadata = { generatedKnowledgePage: true, generatedProjection: true, projectionIdentityVersion: 1,
    projectionScopeKind: 'space', projectionSpaceId: 'project:test', knowledgeSpaceId: 'project:test', namespace: 'project:test', includeAllSpaces: false,
    targetKind: 'overview', targetId: 'overview', projectionKind: 'knowledge-overview' };
  const current = await initial.createForPublication({ kind: 'document', mimeType: 'text/markdown', filename: 'current.md', text: 'current', retentionMs: 0, metadata });
  const old = await initial.create({ kind: 'document', mimeType: 'text/markdown', filename: 'old.md', text: 'old', retentionMs: 0, metadata: { generatedKnowledgePage: true, generatedProjection: true, projectionKind: 'knowledge-overview' } });
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') }), store = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') }); stores.push(store); await store.init();
  configureKnowledgeArtifactReferences({ artifactStore: artifacts, controlPlaneDirectory: root, stores: [store] });
  // Genuine independent publisher lease still owns the original metadata.
  await store.upsertSource({ id: 'first-clean', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'clean' });
  expect(artifacts.getRecord(current.artifact.id)).not.toBeNull();
  current.lease.release();
  await store.upsertSource({ id: 'next-clean', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'clean again' });
  for (let turn = 0; artifacts.getRecord(current.artifact.id) && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(artifacts.getRecord(current.artifact.id)).toBeNull(); expect(artifacts.getRecord(old.id)).not.toBeNull();
});

test('substituting the original SQLite persistence receiver before inspection cannot select an unrelated empty database', async () => {
  const f = await fixture(), other = new KnowledgeStore({ dbPath: join(f.root, 'knowledge-home-graph.sqlite') }); stores.push(other); await other.init();
  const sqlite: object = Reflect.get(f.store, 'sqlite'), otherSqlite: object = Reflect.get(other, 'sqlite'), actual = Object.getOwnPropertyDescriptor(sqlite, 'persistence')!;
  Object.defineProperty(sqlite, 'persistence', { ...actual, value: Reflect.get(otherSqlite, 'persistence') });
  try { expect(await f.store.cleanupUnreferencedArtifact(f.artifacts.captureOriginal(f.artifact.id))).toBe('held'); expect(f.artifacts.getRecord(f.artifact.id)).not.toBeNull(); }
  finally { Object.defineProperty(sqlite, 'persistence', actual); }
});


test('a64-artifact restart batch reads each actual persisted family image once instead of opening one image per artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-batch-')); roots.push(root);
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const metadata = { generatedKnowledgePage: true, generatedProjection: true, projectionIdentityVersion: 1,
    projectionScopeKind: 'space', projectionSpaceId: 'project:test', knowledgeSpaceId: 'project:test', namespace: 'project:test', includeAllSpaces: false,
    targetKind: 'overview', targetId: 'overview', projectionKind: 'knowledge-overview' };
  const ids: string[] = [];
  for (let index = 0; index < 64; index++) {
    const created = await artifacts.createForPublication({ kind: 'document', mimeType: 'text/markdown', filename: 'current.md', text: `page${index}`, retentionMs: 0, metadata });
    ids.push(created.artifact.id); created.lease.release();
  }
  const owners = ['knowledge-wiki.sqlite', 'knowledge-agent.sqlite', 'knowledge-home-graph.sqlite'].map(file => new KnowledgeStore({ dbPath: join(root, file) })); stores.push(...owners); await Promise.all(owners.map(owner => owner.init()));
  await Promise.all(owners.map(owner => owner.upsertSource({ id: 'clean-fixture-source', connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'Clean family baseline' })));
  const nativeRead = persistedImages.readSQLitePersistedImage; let imageReads = 0;
  const read = spyOn(persistedImages, 'readSQLitePersistedImage').mockImplementation(owner => { imageReads++; return nativeRead(owner); });
  try {
    configureKnowledgeArtifactReferences({ artifactStore: artifacts, controlPlaneDirectory: root, stores: owners });
    for (let turn = 0; ids.some(id => artifacts.getRecord(id)) && turn < 500; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(ids.every(id => artifacts.getRecord(id) === null)).toBe(true); expect(imageReads).toBe(3);
  } finally { read.mockRestore(); }
});
