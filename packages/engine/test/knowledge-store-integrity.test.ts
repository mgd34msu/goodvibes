/**
 * Knowledge rows survive a reopen and a second writer on the same file: a
 * write by one store never drops a row another store saved, a partial update
 * keeps the fields it did not name, a delete keeps what another source still
 * backs, and a delete that fails part-way leaves every row as it was.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createKnowledgeIssueOperatorMutation } from '../platform/src/platform/knowledge/store-lifecycle-authority.js';
import type { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-integrity-'));
  roots.push(root);
  return join(root, 'knowledge.sqlite');
}
async function open(file: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore({ dbPath: file });
  stores.push(store);
  await store.init();
  return store;
}
async function reopen(store: KnowledgeStore, file: string): Promise<KnowledgeStore> {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  return open(file);
}
const source = (id: string, extra: Record<string, unknown> = {}) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const, ...extra });
const fact = (id: string, sourceId: string, metadata: Record<string, unknown> = {}) => ({ id, kind: 'fact' as const, slug: id, title: id, confidence: 50, sourceId, metadata });

interface RunProbe { sqlite: Pick<SQLiteStore, 'run'> }
const sqliteOf = (store: KnowledgeStore): Pick<SQLiteStore, 'run'> => (store as unknown as RunProbe).sqlite;

test('two stores writing the same file without reading each other lose no row', async () => {
  const file = path();
  const first = await open(file);
  const second = await open(file);
  await first.upsertSource(source('from-first'));
  await second.upsertSource(source('from-second'));
  await first.upsertNode(fact('fact-first', 'from-first'));
  await second.upsertNode(fact('fact-second', 'from-second'));

  const third = await open(file);
  expect(third.listSources(100).map((record) => record.id).sort()).toEqual(['from-first', 'from-second']);
  expect(third.listNodes(100).map((record) => record.id).sort()).toEqual(['fact-first', 'fact-second']);
});

test('a store that was open before another store saved a row lists it once it checks for changes', async () => {
  const file = path();
  const reader = await open(file);
  const writer = await open(file);
  await writer.upsertSource(source('from-writer'));
  await reader.refreshIfChanged();
  expect(reader.listSources(100).map((record) => record.id)).toEqual(['from-writer']);
});

test('a status-only source update keeps the title, addresses, summary and description, also after a reopen', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('s', { title: 'Title', sourceUri: 'https://a.example/x', canonicalUri: 'https://a.example/x', summary: 'Sum', description: 'Desc' }));
  await store.upsertSource({ id: 's', connectorId: 'fixture', sourceType: 'manual', status: 'failed' });
  store = await reopen(store, file);
  const kept = store.getSource('s')!;
  expect([kept.status, kept.title, kept.sourceUri, kept.canonicalUri, kept.summary, kept.description])
    .toEqual(['failed', 'Title', 'https://a.example/x', 'https://a.example/x', 'Sum', 'Desc']);
  expect(store.getSourceByCanonicalUri('https://a.example/x')!.id).toBe('s');
});

test('deleting a source deletes the nodes only it produced and keeps a node another live source still backs', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('gone'));
  await store.upsertSource(source('other'));
  await store.upsertNode(fact('only-gone', 'gone'));
  await store.upsertNode(fact('shared', 'gone', { sourceIds: ['gone', 'other'] }));
  await store.upsertNode(fact('unrelated', 'other'));

  expect(await store.deleteSource('gone')).toBe(true);
  store = await reopen(store, file);
  expect(store.listNodes(100).map((node) => node.id).sort()).toEqual(['shared', 'unrelated']);
  expect(store.getSource('gone')).toBeNull();
  expect(store.getSource('other')).not.toBeNull();
});

test('a delete that fails part-way leaves every row as it was, in memory and in the file', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('s'));
  await store.upsertNode(fact('n', 's'));
  await store.upsertEdge({ fromKind: 'node', fromId: 'n', toKind: 'source', toId: 's', relation: 'supports_fact' });
  await store.upsertIssue({ id: 'i', severity: 'info', code: 'c', message: 'm', nodeId: 'n' });

  // The disk refuses the node's own row after the edge and issue rows went.
  const sqlite = sqliteOf(store);
  const run = sqlite.run.bind(sqlite);
  sqlite.run = (sql, params) => {
    if (sql.startsWith('DELETE FROM knowledge_nodes')) throw new Error('disk full');
    run(sql, params);
  };
  await expect(store.deleteNode('n')).rejects.toThrow('disk full');
  sqlite.run = run;

  expect(store.getNode('n')).not.toBeNull();
  expect(store.getIssue('i')).not.toBeNull();
  expect(store.listEdges()).toHaveLength(1);
  store = await reopen(store, file);
  expect(store.getNode('n')).not.toBeNull();
  expect(store.getIssue('i')).not.toBeNull();
  expect(store.listEdges()).toHaveLength(1);
});

test('replacing a namespace keeps an issue the operator reviewed and drops one nobody touched', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('s'));
  const metadata = { namespace: 'lint' };
  await store.upsertIssue({ id: 'untouched', severity: 'info', code: 'c', message: 'm', sourceId: 's', metadata });
  await store.upsertIssue({ id: 'reviewed', severity: 'info', code: 'c', message: 'm', sourceId: 's', metadata });
  await store.upsertIssue({ id: 'reviewed', severity: 'info', code: 'c', message: 'm', status: 'open', sourceId: 's', metadata: { ...metadata, review: { action: 'reopen' } } },
    createKnowledgeIssueOperatorMutation(store.getIssue('reviewed')!));
  await store.replaceIssues([], 'lint');
  store = await reopen(store, file);
  expect(store.getIssue('untouched')).toBeNull();
  expect(store.getIssue('reviewed')?.metadata.review).toBeDefined();
});
