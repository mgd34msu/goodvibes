import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.js';
import * as nativeFs from 'node:fs';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { loadSqlJsEngine, SQLiteStore, type SqlDatabase } from '../platform/src/platform/state/sqlite-store.js';
import { createWorkLedger } from '../platform/src/platform/workflow/work-ledger/service.js';
import { acquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import type { WorkLedgerDecision } from '../platform/src/platform/workflow/work-ledger/types.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'work-ledger-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file: string, projectId = 'project') {
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  const storage = await store.openWorkLedgerStorage(projectId);
  let id = 0;
  const ledger = createWorkLedger({ projectId, storage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId, actorId: 'owner', role: 'coordinator' });
  return { store, storage, ...ledger, actor };
}
const command = { type: 'create', requestId: 'request', expectedRevision: 0, title: 'Durable', goal: 'Persist', criteria: ['Atomic'] };

test('disk restart keeps original receipt, history and identities; ordinary save preserves ledger', async () => {
  const file = path(); const first = await open(file);
  const accepted = await first.service.execute(command, first.actor);
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted receipt');
  await first.store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { executionApproved: true } });
  await first.service.close(); await first.store.close();
  const second = await open(file);
  expect(await second.service.execute(command, second.actor)).toEqual({ ...accepted, replayed: true });
  expect((await second.service.history(0, second.actor))).toHaveLength(1);
  expect(second.store.getSource('source')?.metadata).toMatchObject({ executionApproved: true });
  expect((await second.service.readSnapshot(second.actor)).works[0]?.verification.state).toBe('unverified');
  expect(await second.service.execute({ ...command, title: 'Changed' }, second.actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  expect(await second.service.execute(command, first.actor)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
});

test('independent owners serialize competing revision and preserve unrelated projects', async () => {
  const file = path(); const first = await open(file); const second = await open(file);
  const results = await Promise.all([first.service.execute(command, first.actor), second.service.execute({ ...command, requestId: 'second' }, second.actor)]);
  expect(results.map(result => result.kind).sort()).toEqual(['accepted', 'rejected']);
  const other = await open(file, 'other');
  expect(await other.service.execute(command, other.actor)).toMatchObject({ kind: 'accepted' });
  expect((await first.service.history(0, first.actor))).toHaveLength(1);
  expect((await other.service.history(0, other.actor))).toHaveLength(1);
});

test('decision is synchronous, exactly once and detached', async () => {
  const first = await open(path()); let called = 0;
  await expect(first.storage.transaction((async () => ({ next: null, value: 1 })) as unknown as () => WorkLedgerDecision<number>)).rejects.toThrow('synchronous');
  expect(await first.storage.transaction(current => { called++; (current as { revision: number }).revision = 99; return { next: null, value: 'read' }; })).toBe('read');
  expect(called).toBe(1);
  expect((await first.storage.read() as { revision: number }).revision).toBe(0);
});

test('cross-owner polling catches up and subscription cleanup stops callbacks', async () => {
  const file = path(); const first = await open(file); const other = await open(file); const seen: number[] = [];
  const stop = first.storage.subscribe(state => { seen.push(state.revision); throw new Error('observer'); });
  await other.service.execute(command, other.actor);
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(seen).toContain(1); stop(); const count = seen.length;
  await other.service.execute({ ...command, requestId: 'next', expectedRevision: 1 }, other.actor);
  await new Promise(resolve => setTimeout(resolve, 160)); expect(seen).toHaveLength(count);
});

test('v1 migration adds ledger and native execution tables; legacy metadata is preserved and older open refuses v5', async () => {
  const file = path(); const seed = await open(file);
  await seed.store.upsertSource({ id: 'legacy', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { executionApproved: true, verifier: 'legacy-text', answers: ['yes'] } });
  await seed.store.close();
  const legacy = new SQLiteStore(file); await legacy.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  legacy.run('DROP TABLE work_ledgers'); legacy.run('PRAGMA user_version = 1'); await legacy.save(); legacy.close();
  const migrated = await open(file);
  expect(migrated.store.getSource('legacy')?.metadata).toMatchObject({ executionApproved: true, verifier: 'legacy-text', answers: ['yes'] });
  expect(await migrated.service.readSnapshot(migrated.actor)).toMatchObject({ revision: 0, works: [] });
  const oldBinary = new SQLiteStore(file);
  await expect(oldBinary.init(() => {}, { schemaVersion: 1 })).rejects.toThrow('newer version');
});

test('malformed ledger receipt/history is rejected without reset or publication', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor);
  const raw = new SQLiteStore(file); await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  const state = await first.storage.read() as { receipts: unknown[] };
  state.receipts = [];
  raw.run('UPDATE work_ledgers SET state_json = ?', [JSON.stringify(state)]); await raw.save(); raw.close();
  const bytes = readFileSync(file);
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_state' });
  await expect(first.service.readSnapshot(first.actor)).rejects.toThrow();
  expect(readFileSync(file)).toEqual(bytes);
});

test('owner close waits for a ledger write held on file ownership and then rejects new storage admission', async () => {
  const file = path(); const first = await open(file);
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`, { strictOwnership: true });
  const writing = first.service.execute(command, first.actor);
  await new Promise(resolve => setTimeout(resolve, 15));
  let settled = false; const closing = first.store.close().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); expect(settled).toBe(false);
  await expect(first.storage.read()).rejects.toThrow('closed');
  release(); expect(await writing).toMatchObject({ kind: 'accepted' }); await closing; expect(settled).toBe(true);
  const reopened = await open(file); expect((await reopened.service.history(0, reopened.actor))).toHaveLength(1);
});

test('missing ledger table in an established v5 database cannot be repaired by ordinary writes', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor); await first.store.close();
  const raw = new SQLiteStore(file); await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION }); raw.run('DROP TABLE work_ledgers'); await raw.save(); raw.close();
  const bytes = readFileSync(file);
  const owner = new KnowledgeStore({ dbPath: file }); stores.push(owner);
  await expect(owner.init()).rejects.toThrow('schema is missing or corrupt');
  await expect(owner.upsertSource({ id: 'must-not-repair', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('schema is missing or corrupt');
  await expect(owner.openWorkLedgerStorage('project')).rejects.toThrow('schema is missing or corrupt');
  expect(readFileSync(file)).toEqual(bytes);
});

test('KnowledgeStore close drains an admitted ordinary batch and its deferred save', async () => {
  const file = path(); const first = await open(file);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const batch = first.store.batch(async () => {
    await first.store.upsertSource({ id: 'batched', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
    entered(); await gate;
  });
  await ready;
  let closed = false; const closing = first.store.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); expect(closed).toBe(false);
  release(); await batch; await closing;
  expect((await open(file)).store.getSource('batched')).not.toBeNull();
});

for (const corrupt of [Buffer.alloc(0), Buffer.from('SQLite format 3\0'), Buffer.from('not a database')]) {
  test(`existing corrupt ${corrupt.length}-byte database cannot be treated as new`, async () => {
    const file = path(); writeFileSync(file, corrupt);
    const owner = new KnowledgeStore({ dbPath: file }); stores.push(owner);
    await expect(owner.openWorkLedgerStorage('project')).rejects.toThrow('existing database image is corrupt');
    await expect(owner.upsertSource({ id: 'must-not-repair', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('existing database image is corrupt');
    expect(readFileSync(file)).toEqual(corrupt);
  });
}

