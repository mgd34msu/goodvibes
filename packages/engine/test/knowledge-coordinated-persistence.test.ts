import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, KnowledgeStoreConflictError } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { SQLiteStore } from '@goodvibes-jev/engine/platform/platform/state';
import { createSchema, KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.js';
import * as lockModule from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { acquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'knowledge-coordinated-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });
const job = (id: string) => ({ id, jobId: 'fixture-job', status: 'completed' as const, mode: 'inline' as const });
async function open(file: string) { const store = new KnowledgeStore({ dbPath: file }); await store.init(); return store; }

test('ordinary stale source and other-table saves refuse to replace a newer whole image, then reload it', async () => {
  const file = path();
  const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  await second.upsertJobRun(job('other-owner'));
  const bytes = readFileSync(file);
  const refused = await first.upsertSource(source('stale-write')).then(() => null, (error: unknown) => error);
  expect(refused).toBeInstanceOf(KnowledgeStoreConflictError);
  expect(refused).toMatchObject({ reloaded: true, retryable: true });
  expect(readFileSync(file)).toEqual(bytes);
  // The refused write is dropped from memory and the winner's rows are adopted.
  expect(first.getSource('stale-write')).toBeNull();
  expect(first.getJobRun('other-owner')).not.toBeNull();
  expect(await first.upsertSourceIfCurrent(source('conditional'), null)).toMatchObject({ kind: 'written' });
  await first.upsertSource(source('retried'));
  const third = await open(file);
  expect(third.getJobRun('other-owner')).not.toBeNull();
  expect(third.getSource('stale-write')).toBeNull();
  expect(third.getSource('retried')).not.toBeNull();
});

test('overlapping saves on one handle publish in admission order without dropping later rows', async () => {
  const file = path(); const store = await open(file);
  const results = await Promise.all([store.upsertSource(source('first')), store.upsertJobRun(job('middle')), store.upsertSource(source('last'))]);
  expect(results.map(record => record.id)).toEqual(['first', 'middle', 'last']);
  const reopened = await open(file);
  expect(reopened.listSources().map(record => record.id).sort()).toEqual(['first', 'last']);
  expect(reopened.getJobRun('middle')).not.toBeNull();
  expect(await store.upsertSourceIfCurrent(source('after-queue'), null)).toMatchObject({ kind: 'written' });
});

test('an unchanged save queued behind fresh-image adoption cannot restore the earlier image', async () => {
  const file = path();
  const store = new SQLiteStore(file, { coordinated: true });
  const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)');
  await store.init(schema); store.run("INSERT INTO fixture VALUES ('original')"); await store.save();
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`);
  const guarded = store.transactPersisted(db => { db.run("UPDATE fixture SET value = 'guarded'"); return { changed: true, value: 'written' }; }, () => {});
  const queuedSave = store.save();
  // Attach rejection handling before releasing either queued operation.
  const settledSave = queuedSave.then(() => ({ kind: 'written' }), (error: unknown) => ({ kind: 'error', error }));
  release();
  expect(await guarded).toEqual({ kind: 'completed', value: 'written' });
  const saveOutcome = await settledSave;
  const reopened = new SQLiteStore(file); await reopened.init(schema);
  expect(reopened.exec('SELECT value FROM fixture')[0]?.values).toEqual([['guarded']]);
  expect(saveOutcome).toMatchObject({ kind: 'error', error: { message: 'SQLiteStore: persisted state changed; captured image was superseded' } });
  store.close(); reopened.close();
});

test('a stale batch preserves current disk and reloads only after the batch settles', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  let bytes: Buffer<ArrayBuffer> | undefined;
  await expect(first.batch(async () => {
    await first.upsertJobRun(job('pending-local'));
    await second.upsertSource(source('other-owner'));
    bytes = readFileSync(file);
    // Still inside the batch: its pending row is not discarded underneath it.
    expect(first.getJobRun('pending-local')).not.toBeNull();
  })).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
  expect(readFileSync(file)).toEqual(bytes!);
  expect(first.getJobRun('pending-local')).toBeNull();
  expect(first.getSource('other-owner')).not.toBeNull();
  const reopened = await open(file);
  expect(reopened.getSource('other-owner')).not.toBeNull();
  expect(reopened.getJobRun('pending-local')).toBeNull();
});

test('persisted snapshot reads observe a new owner without replacing a pending local image', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  const oldGeneration = first.getSourceGeneration('original');
  await second.upsertSource({ ...source('original'), title: 'new owner' });
  expect(first.getSourceSnapshot({ id: 'original' }).source?.title).toBe('new owner');
  expect(first.getSourceGeneration('original')).not.toBe(oldGeneration);
  expect(first.getSource('original')?.title).toBeUndefined();
});

test('directory and database symlink aliases coordinate the same persisted file', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const alias = `${file}.alias`; symlinkSync(file, alias);
  const second = await open(alias);
  const directoryAlias = join(dirname(file), 'directory-alias'); symlinkSync(dirname(file), directoryAlias, 'dir');
  const third = await open(join(directoryAlias, 'knowledge.sqlite'));
  const outcomes = await Promise.all([first.upsertSourceIfCurrent(source('contended'), null), second.upsertSourceIfCurrent(source('contended'), null), third.upsertSourceIfCurrent(source('contended'), null)]);
  expect(outcomes.map(result => result.kind).sort()).toEqual(['held', 'held', 'written']);
  expect((await open(file)).getSource('contended')).not.toBeNull();
  expect(readFileSync(alias)).toEqual(readFileSync(file));
});

test('a dangling database symlink and its missing target share one first-write identity', async () => {
  const file = path(); const alias = `${file}.alias`; symlinkSync(file, alias);
  const linked = await open(alias); const direct = await open(file);
  const results = await Promise.all([
    linked.upsertSourceIfCurrent({ ...source('first-write'), metadata: { owner: 'alias' } }, null),
    direct.upsertSourceIfCurrent({ ...source('first-write'), metadata: { owner: 'direct' } }, null),
  ]);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  expect(readFileSync(alias)).toEqual(readFileSync(file));
  expect((await open(file)).getSource('first-write')?.metadata.owner).toBe('alias');
});

test('relative chained aliases preserve both links and share the missing target on first write', async () => {
  const file = path(); const firstAlias = join(dirname(file), 'first-alias'); const secondAlias = join(dirname(file), 'second-alias');
  symlinkSync('second-alias', firstAlias); symlinkSync('knowledge.sqlite', secondAlias);
  const first = await open(firstAlias); const second = await open(secondAlias); const direct = await open(file);
  const results = await Promise.all([
    first.upsertSourceIfCurrent({ ...source('chain-first-write'), metadata: { owner: 'chain' } }, null),
    second.upsertSourceIfCurrent(source('chain-first-write'), null),
    direct.upsertSourceIfCurrent(source('chain-first-write'), null),
  ]);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'held', 'written']);
  expect(readlinkSync(firstAlias)).toBe('second-alias');
  expect(readlinkSync(secondAlias)).toBe('knowledge.sqlite');
  expect(readFileSync(firstAlias)).toEqual(readFileSync(file));
  expect(readFileSync(secondAlias)).toEqual(readFileSync(file));
  expect(first.getSourceSnapshot({ id: 'chain-first-write' }).source?.metadata.owner).toBe('chain');
  expect(direct.getSourceSnapshot({ id: 'chain-first-write' }).source?.metadata.owner).toBe('chain');
});

test('a symlink cycle is refused without replacing links or creating lock/database files', async () => {
  const file = path(); const firstAlias = join(dirname(file), 'first-alias'); const secondAlias = join(dirname(file), 'second-alias');
  symlinkSync('second-alias', firstAlias); symlinkSync('first-alias', secondAlias);
  const before = readdirSync(dirname(file)).sort();
  const store = new KnowledgeStore({ dbPath: firstAlias });
  const result = await store.init().then(() => null, (error: unknown) => error);
  expect(result).toMatchObject({ code: 'ELOOP' });
  expect(store.isReady).toBe(false);
  expect(readdirSync(dirname(file)).sort()).toEqual(before);
  expect(readlinkSync(firstAlias)).toBe('second-alias');
  expect(readlinkSync(secondAlias)).toBe('first-alias');
});

test('an unresolved target directory fails without falling back to replacing its alias', async () => {
  const file = path(); const alias = join(dirname(file), 'unresolved-alias');
  symlinkSync('missing-directory/knowledge.sqlite', alias);
  const before = readdirSync(dirname(file)).sort();
  const store = new KnowledgeStore({ dbPath: alias });
  const result = await store.init().then(() => null, (error: unknown) => error);
  expect(result).toMatchObject({ code: 'ENOENT' });
  expect(store.isReady).toBe(false);
  expect(readdirSync(dirname(file)).sort()).toEqual(before);
  expect(readlinkSync(alias)).toBe('missing-directory/knowledge.sqlite');
  expect(existsSync(join(dirname(file), 'missing-directory'))).toBe(false);
});

test('hardlinked aliases are refused before a coordinated store can replace one name', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  linkSync(file, `${file}.hardlink`);
  const bytes = readFileSync(file);
  await expect(first.upsertSource(source('replacement'))).rejects.toThrow('unsupported coordinated file identity');
  expect(readFileSync(file)).toEqual(bytes);
});

test('initialization and a held creation do not create a database or publish schema bytes', async () => {
  const file = path(); const store = await open(file);
  expect(existsSync(file)).toBe(false);
  expect(await store.upsertSourceIfCurrent(source('missing'), 'a'.repeat(64))).toMatchObject({ kind: 'held', reason: 'source-changed' });
  expect(existsSync(file)).toBe(false);
});

test('concurrent KnowledgeStore initialization coordinates an existing schema migration', async () => {
  const file = path(); const legacy = new SQLiteStore(file);
  await legacy.init(createSchema, { schemaVersion: 0 }); await legacy.save(); legacy.close();
  const [first, second] = await Promise.all([open(file), open(file)]);
  expect(first.isReady && second.isReady).toBe(true);
  const results = await Promise.all([first.upsertSourceIfCurrent(source('after-migration'), null), second.upsertSourceIfCurrent(source('after-migration'), null)]);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  expect((await open(file)).getSource('after-migration')).not.toBeNull();
});

test('initialization persists settled-run retention before the first guarded source action', async () => {
  const file = path(); const seed = await open(file);
  await seed.batch(async () => {
    for (let index = 0; index < 501; index++) await seed.upsertJobRun({ ...job(`retained-${index}`), status: 'running' });
  });
  // Model an older file containing an over-cap settled history; current normal
  // upserts already prune their own completed records.
  const legacy = new SQLiteStore(file); await legacy.init(createSchema, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  legacy.run("UPDATE knowledge_job_runs SET status = 'completed'"); await legacy.save(); legacy.close();
  const reopened = await open(file);
  expect(reopened.listJobRuns(1000)).toHaveLength(500);
  expect(await reopened.upsertSourceIfCurrent(source('first-guarded'), null)).toMatchObject({ kind: 'written' });
  const disk = new SQLiteStore(file); await disk.init(createSchema, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  expect(disk.exec('SELECT COUNT(*) FROM knowledge_job_runs')[0]?.values).toEqual([[500]]);
  disk.close();
  expect((await open(file)).getSource('first-guarded')).not.toBeNull();
});

test('an initialization retention conflict refuses stale persistence and a retry reloads the winning owner', async () => {
  const file = path(); const seed = await open(file);
  await seed.batch(async () => {
    for (let index = 0; index < 501; index++) await seed.upsertJobRun({ ...job(`retained-${index}`), status: 'running' });
  });
  const writer = new SQLiteStore(file, { coordinated: true }); await writer.init(createSchema, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  writer.run("UPDATE knowledge_job_runs SET status = 'completed'"); await writer.save();
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`);
  const target = new KnowledgeStore({ dbPath: file });
  // Initialization is waiting on the held lock once it has asked for it, so the
  // ordinary writer below is guaranteed to queue after it.
  const requested = Promise.withResolvers<void>(), acquire = lockModule.acquireCrossProcessLock;
  const lockSpy = spyOn(lockModule, 'acquireCrossProcessLock').mockImplementation((...args) => { requested.resolve(); return acquire(...args); });
  const initialization = target.init().then(() => ({ kind: 'ready' }), (error: unknown) => ({ kind: 'error', error }));
  try { await requested.promise; } finally { lockSpy.mockRestore(); }
  writer.run('UPDATE knowledge_job_runs SET result = ? WHERE id = ?', [JSON.stringify({ owner: 'winner' }), 'retained-500']);
  const saved = writer.save();
  release();
  await saved;
  const winningBytes = readFileSync(file);
  expect(await initialization).toMatchObject({ kind: 'error', error: { message: 'SQLiteStore: persisted state changed; pending local changes were not saved' } });
  expect(target.isReady).toBe(false);
  expect(readFileSync(file)).toEqual(winningBytes);
  await target.init();
  expect(target.getJobRun('retained-500')?.result).toEqual({ owner: 'winner' });
  expect(await target.upsertSourceIfCurrent(source('after-retry'), null)).toMatchObject({ kind: 'written' });
  const reopened = await open(file);
  expect(reopened.getJobRun('retained-500')?.result).toEqual({ owner: 'winner' });
  expect(reopened.getSource('after-retry')).not.toBeNull();
  writer.close();
});

test('a failed coordinated migration restores the original bytes while it owns the file', async () => {
  const file = path(); const legacy = new SQLiteStore(file);
  await legacy.init(createSchema, { schemaVersion: 0 }); await legacy.save(); legacy.close();
  const original = readFileSync(file);
  const failing = new SQLiteStore(file, { coordinated: true });
  await expect(failing.init(createSchema, { schemaVersion: 1, migrations: [{ toVersion: 1, migrate(db) { db.run('DROP TABLE knowledge_sources'); throw new Error('fixture migration refused'); } }] })).rejects.toThrow('fixture migration refused');
  expect(readFileSync(file)).toEqual(original);
  const reopened = await open(file);
  expect(await reopened.upsertSourceIfCurrent(source('after-failure'), null)).toMatchObject({ kind: 'written' });
});

test('unrelated SQLiteStore callers keep the existing default save behavior', async () => {
  const file = path(); const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)');
  const first = new SQLiteStore(file); await first.init(schema); await first.save();
  const second = new SQLiteStore(file); await second.init(schema);
  first.run("INSERT INTO fixture VALUES ('first')"); await first.save();
  second.run("INSERT INTO fixture VALUES ('second')"); await second.save();
  const third = new SQLiteStore(file); await third.init(schema);
  expect(third.exec('SELECT value FROM fixture')[0]?.values).toEqual([['second']]);
  first.close(); second.close(); third.close();
});

test('default in-memory subclasses retain their existing batch save lifecycle', async () => {
  class RecordingStore extends SQLiteStore {
    calls = 0;
    override save() { this.calls += 1; return super.save(); }
  }
  const store = new RecordingStore(':memory:');
  await store.init(db => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)'));
  await store.batch(async () => { await store.save(); });
  expect(store.calls).toBe(1);
  store.close();
});

test('an ordinary writer holding a stale image cannot undo a guarded write from another handle', async () => {
  const file = path(); await (await open(file)).upsertSource(source('original'));
  const ordinary = await open(file), guarded = await open(file);
  expect(await guarded.upsertSourceIfCurrent(source('guarded-source'), null)).toMatchObject({ kind: 'written' });
  const refused = await ordinary.upsertJobRun(job('ordinary-job')).then(() => null, (error: unknown) => error);
  expect(refused).toBeInstanceOf(KnowledgeStoreConflictError);
  const reopened = await open(file);
  expect(reopened.getSource('guarded-source')).not.toBeNull();
  expect(reopened.getSource('original')).not.toBeNull();
  expect(reopened.getJobRun('ordinary-job')).toBeNull();
  // After the reload the refused writer's retry lands on top of the guarded row.
  await ordinary.upsertJobRun(job('ordinary-job'));
  const final = await open(file);
  expect(final.getSource('guarded-source')).not.toBeNull();
  expect(final.getJobRun('ordinary-job')).not.toBeNull();
});

test('a guarded write after an ordinary write from another handle keeps both rows', async () => {
  const file = path(); await (await open(file)).upsertSource(source('original'));
  const ordinary = await open(file), guarded = await open(file);
  await ordinary.upsertJobRun(job('ordinary-job'));
  expect(await guarded.upsertSourceIfCurrent(source('guarded-source'), null)).toMatchObject({ kind: 'written' });
  const reopened = await open(file);
  expect(reopened.getSource('original')).not.toBeNull();
  expect(reopened.getSource('guarded-source')).not.toBeNull();
  expect(reopened.getJobRun('ordinary-job')).not.toBeNull();
});
