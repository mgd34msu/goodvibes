import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import * as atomicStore from '../platform/src/platform/utils/atomic-json-store.js';
import { KnowledgeStore, captureKnowledgePendingNode } from '../platform/src/platform/knowledge/store.js';
import { prepareKnowledgeRecordAdmission } from '../platform/src/platform/knowledge/store-record-snapshot.js';
import { captureSQLiteActivationPublication, type SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(async () => { installJudgmentPort(previous); await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(memory = false) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-deferred-activation-')); roots.push(root);
  const path = memory ? ':memory:' : join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  await store.upsertSource({ id: 'manual', connectorId: 'test', sourceType: 'manual', title: 'Device manual', status: 'indexed' });
  await store.upsertExtraction({ sourceId: 'manual', extractorId: 'test', format: 'text', excerpt: 'Device has four ports and a local display.' });
  const inputs = ['ports', 'display'].map(id => ({ id, kind: 'fact' as const, slug: id, title: id, summary: 'Device has four ports and a local display.', sourceId: 'manual', status: 'active' as const }));
  return { store, path, inputs };
}

test.each([false, true])('one prepared two-fact pass survives its own actual deferred writes (memory=%s)', async memory => {
  const f = await fixture(memory), prepared = await f.store.prepareNodeWrites(f.inputs, { requireAccepted: true });
  const before = memory ? null : readFileSync(f.path);
  await f.store.batch(async () => {
    const first = await f.store.upsertPreparedNode(prepared, 0);
    f.store.assertPreparedNodeWrites(prepared);
    if (before !== null) {
      expect(readFileSync(f.path)).toEqual(before);
      expect(() => prepareKnowledgeRecordAdmission(f.store, 'node', first)).toThrow();
    }
    await f.store.upsertPreparedNode(prepared, 1);
    f.store.assertPreparedNodeWrites(prepared);
  });
  f.store.assertPreparedNodeWrites(prepared);
  for (const input of f.inputs) prepareKnowledgeRecordAdmission(f.store, 'node', f.store.getNode(input.id)!).assertCurrent();
  if (before !== null) {
    const published = readFileSync(f.path);
    renameSync(f.path, `${f.path}.published`); writeFileSync(f.path, before);
    expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
    expect(readFileSync(`${f.path}.published`)).toEqual(published);
    expect(readFileSync(f.path)).toEqual(before);
  }
});

test.each(['before-rename', 'after-rename'] as const)('failed %s save cannot acknowledge a prepared local write', async phase => {
  const f = await fixture(), prepared = await f.store.prepareNodeWrites(f.inputs, { requireAccepted: true });
  const write = atomicStore.writeFileAtomic; let entered = false;
  const fault = () => { entered = true; throw new Error('Fixture activation publication failure'); };
  const spy = spyOn(atomicStore, 'writeFileAtomic').mockImplementation((path, bytes, options) => {
    if (path !== f.path) return write(path, bytes, options);
    if (phase === 'before-rename') return fault();
    return write(path, bytes, { ...options, onEffect(published) { options?.onEffect?.(published); if (published) fault(); } });
  });
  try {
    await expect(f.store.batch(async () => {
      await f.store.upsertPreparedNode(prepared, 0);
      f.store.assertPreparedNodeWrites(prepared);
      await f.store.upsertPreparedNode(prepared, 1);
    })).rejects.toThrow();
  } finally { spy.mockRestore(); }
  expect(entered).toBe(true);
  expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
  const pending = f.store.getNode(f.inputs[0]!.id);
  expect(pending).not.toBeNull();
  expect(() => captureKnowledgePendingNode(f.store, pending!)).toThrow();
  const afterFailure = readFileSync(f.path);
  // A later actual successful retry cannot revive an already failed pass.
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
  await sqlite.save().catch(() => {});
  expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
  if (phase === 'after-rename') expect(readFileSync(f.path)).toEqual(afterFailure);
});

test('a genuine newer local row retires the original pending write before its next fact', async () => {
  const f = await fixture(), prepared = await f.store.prepareNodeWrites(f.inputs, { requireAccepted: true });
  await f.store.batch(async () => {
    await f.store.upsertPreparedNode(prepared, 0);
    const current = f.store.getNode(f.inputs[0]!.id)!;
    await f.store.upsertNode({ ...current, summary: 'An independent newer local edit.' });
    expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
    await expect(f.store.upsertPreparedNode(prepared, 1)).rejects.toThrow();
    expect(f.store.getNode(f.inputs[1]!.id)).toBeNull();
    expect(f.store.getNode(current.id)?.summary).toBe('An independent newer local edit.');
  });
});

test('a copied owner cannot issue the private deferred-publication observation', () => {
  expect(() => captureSQLiteActivationPublication({} as SQLiteStore, 'fact', 'kr-' + 'a'.repeat(32))).toThrow();
});

test('only the exact issued pending row can prepare another write without admitting an unissued copy', async () => {
  const f = await fixture(), prepared = await f.store.prepareNodeWrites(f.inputs, { requireAccepted: true });
  await f.store.batch(async () => {
    const first = await f.store.upsertPreparedNode(prepared, 0);
    expect(captureKnowledgePendingNode(f.store, first)?.state()).toBe('pending');
    expect(captureKnowledgePendingNode(f.store, structuredClone(first))).toBeUndefined();
    expect(captureKnowledgePendingNode({ ...f.store } as KnowledgeStore, first)).toBeUndefined();
    const other = await fixture(true);
    expect(captureKnowledgePendingNode(other.store, first)).toBeUndefined();
    expect(() => prepareKnowledgeRecordAdmission(f.store, 'node', first)).toThrow();
    const nodes = Object.getOwnPropertyDescriptor(f.store, 'nodes')?.value as Map<string, typeof first>;
    const copy = structuredClone(first); nodes.set(first.id, copy);
    try { await expect(f.store.upsertNode({ ...copy, summary: 'Unissued cached replacement.' })).rejects.toThrow(); }
    finally { nodes.set(first.id, first); }
    f.store.assertPreparedNodeWrites(prepared);
    await f.store.upsertPreparedNode(prepared, 1);
  });
});

test('pending-node preparation cannot adopt an identical-byte replacement of its original database', async () => {
  const f = await fixture(), prepared = await f.store.prepareNodeWrites(f.inputs, { requireAccepted: true });
  const before = readFileSync(f.path);
  await f.store.batch(async () => {
    const first = await f.store.upsertPreparedNode(prepared, 0);
    renameSync(f.path, `${f.path}.original`); writeFileSync(f.path, before);
    expect(() => captureKnowledgePendingNode(f.store, first)).toThrow();
    await expect(f.store.upsertNode({ ...first, summary: 'A new interpretation must retain its original database.' })).rejects.toThrow();
    expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
  });
  // The existing byte-CAS batch may acknowledge its already admitted first
  // write. Retirement must still prevent every subsequent interpretation.
  expect(f.store.getRecordSnapshot('node', f.inputs[0]!.id).record?.summary).toBe(f.inputs[0]!.summary);
  expect(f.store.getNode(f.inputs[1]!.id)).toBeNull();
  expect(() => f.store.assertPreparedNodeWrites(prepared)).toThrow();
  expect(readFileSync(`${f.path}.original`)).toEqual(before);
});
