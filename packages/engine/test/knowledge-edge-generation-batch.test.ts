import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeRecordAdmissionHeldError } from '../platform/src/platform/knowledge/store-record-snapshot.js';
import { loadSqlJsEngine, SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';

const stores: KnowledgeStore[] = [], roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const first of ['page', 'store'] as const) {
test(`canonical page generation bindings cold-load without a module cycle (${first} first)`, async () => {
  const pagePath = fileURLToPath(new URL('../platform/src/platform/knowledge/home-graph/page-read-set.ts', import.meta.url));
  const storePath = fileURLToPath(new URL('../platform/src/platform/knowledge/store.ts', import.meta.url));
  const paths = first === 'page' ? [pagePath, storePath] : [storePath, pagePath];
  const script = `await import(${JSON.stringify(paths[0])}); await import(${JSON.stringify(paths[1])}); process.stdout.write('cold-load-complete');`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
  expect(output).toBe('cold-load-complete');
});
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-edge-generation-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const backing: unknown = Reflect.get(store, 'sqlite');
  if (!(backing instanceof SQLiteStore)) throw new Error('Original SQLite owner unavailable');
  const source = await store.upsertSource({ id: 'source', connectorId: 'edge-batch', sourceType: 'document', title: 'Original edge source', status: 'indexed' });
  const first = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'first-node',
    relation: 'documents', metadata: { exact: 'original' } });
  const second = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'second-node',
    relation: 'documents', metadata: { exact: 'second' } });
  return { store, sqlite: backing, first, second };
}

test('closed edge generation batches preserve requested order, duplicates and absence without exposing row bodies', async () => {
  const { store, first, second } = await fixture();
  const firstGeneration = store.getEdgeSnapshot(first.id).generation, secondGeneration = store.getEdgeSnapshot(second.id).generation;
  expect(typeof firstGeneration).toBe('string'); expect(typeof secondGeneration).toBe('string');
  const result = store.getEdgeGenerations([second.id, 'missing-edge', first.id, second.id]);
  expect(result).toEqual([secondGeneration, null, firstGeneration, secondGeneration]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(store.getEdgeGenerations([])).toEqual([]);
});

for (const mutation of ['changed', 'removed', 'replaced'] as const) {
test(`an edge generation batch observes an actually ${mutation} original edge`, async () => {
  const { store, sqlite, first } = await fixture();
  const original = store.getEdgeGenerations([first.id])[0];
  if (mutation === 'changed') {
    sqlite.run('UPDATE knowledge_edges SET metadata = ? WHERE id = ?', [' {"exact":"original"}', first.id]);
    await sqlite.save();
  } else {
    await store.deleteEdge(first.id);
    if (mutation === 'replaced') await store.replaceEdgeRecord(first);
  }
  const current = store.getEdgeGenerations([first.id])[0];
  if (mutation === 'removed') expect(current).toBeNull();
  else { expect(typeof current).toBe('string'); expect(current).not.toBe(original); }
  expect(current).toBe(store.getEdgeSnapshot(first.id).generation);
});
}

for (const malformed of ['accessor', 'named', 'hole', 'number', 'prototype'] as const) {
test(`edge generation IDs reject a ${malformed} array before entering a persisted read frame`, async () => {
  const { store, sqlite, first } = await fixture();
  const ids = [first.id]; let accessed = false;
  if (malformed === 'accessor') Object.defineProperty(ids, '0', { enumerable: true, get() { accessed = true; return first.id; } });
  if (malformed === 'named') Object.defineProperty(ids, 'extra', { value: 'not selected' });
  if (malformed === 'hole') Reflect.deleteProperty(ids, '0');
  if (malformed === 'number') Reflect.set(ids, '0', 1);
  if (malformed === 'prototype') Object.setPrototypeOf(ids, Object.create(Array.prototype));
  const frame = spyOn(sqlite, 'assertPersistedReadFrame');
  try {
    expect(() => store.getEdgeGenerations(ids)).toThrow(TypeError);
    expect(accessed).toBe(false);
    expect(frame).not.toHaveBeenCalled();
  } finally { frame.mockRestore(); }
});
}

test('a swallowed malformed edge selection still retires its enclosing actual read frame', async () => {
  const { store, first } = await fixture();
  const malformed = [first.id]; Reflect.set(malformed, '0', false);
  let consumed = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    try { store.getEdgeGenerations(malformed); } catch { /* Deliberately test a swallowed invalid selection. */ }
    store.getEdgeGenerations([first.id]);
    consumed = true;
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(consumed).toBe(false);
});

test('the edge batch exit fence catches actual native alias restore even when every generation was cached', async () => {
  const { store, sqlite, first } = await fixture();
  let filename: string | undefined;
  await sqlite.transactPersisted(db => {
    const selected = db.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof selected !== 'string') throw new Error('Original native database file unavailable');
    filename = selected;
    db.run('UPDATE knowledge_edges SET metadata = metadata WHERE id = ?', [first.id]);
    return { changed: true, value: undefined };
  }, () => {});
  if (!filename) throw new Error('Actual native writer did not supply its database file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  let observer: { mockRestore(): void } | undefined, changed = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [filename]);
  try {
    expect(() => store.assertRecordSnapshotFrame(() => {
      store.getEdgeGenerations([first.id]);
      const frame: unknown = Reflect.get(sqlite, 'persistedReadFrame');
      if (!frame || typeof frame !== 'object') throw new Error('Actual native read frame unavailable');
      const cached: unknown = Reflect.get(frame, 'generations');
      if (!(cached instanceof Map)) throw new Error('Original generation cache unavailable');
      const memo: Map<unknown, unknown> = cached, read = memo.get.bind(memo);
      const key = JSON.stringify(['knowledge_edges', 'id', first.id]);
      observer = spyOn(memo, 'get').mockImplementation(entry => {
        const value = read(entry);
        if (!changed && entry === key) {
          changed = true;
          alias.run('UPDATE original.knowledge_edges SET metadata = ? WHERE id = ?', ['{"exact":"foreign"}', first.id]);
          alias.run('UPDATE original.knowledge_edges SET metadata = ? WHERE id = ?', [JSON.stringify(first.metadata), first.id]);
        }
        return value;
      });
      store.getEdgeGenerations([first.id, first.id]);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(changed).toBe(true);
    expect(consumed).toBe(false);
  } finally { observer?.mockRestore(); alias.close(); }
});
