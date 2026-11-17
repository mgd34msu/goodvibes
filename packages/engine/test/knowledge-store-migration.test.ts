// Proves: An upgrade or a second launch loses the owner's knowledge store.
// Red when: The move to the current format drops rows or the old file, or a second launch misses commits in the write-ahead log or rewrites what the running app holds.
/**
 * The owner's knowledge store is never lost to an upgrade or a second launch.
 * Opening a store written by an older version moves it to the current format
 * keeping every row, and keeps a copy of the old file. A store another app
 * holds open in write-ahead mode, with commits still in its WAL file, is read
 * at start-up, those commits included.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema-version.ts';
import { inspectPersistedPlanningProjects } from '../platform/src/platform/knowledge/project-planning/persisted-projects.ts';
import { listStoreSnapshots } from '../platform/src/platform/state/store-snapshots.ts';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-knowledge-migration-'));
  roots.push(root);
  return join(root, 'knowledge.sqlite');
}
async function open(path: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore({ dbPath: path });
  stores.push(store);
  await store.init();
  return store;
}
async function close(store: KnowledgeStore): Promise<void> {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
}
const source = (id: string, metadata: Record<string, unknown> = {}) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const, title: id, metadata });
const fact = (id: string, sourceId: string) => ({ id, kind: 'fact' as const, slug: id, title: id, confidence: 50, sourceId, metadata: {} });
const rowCounts = (db: Database) => ({
  sources: (db.query('SELECT count(*) AS n FROM knowledge_sources').get() as { n: number }).n,
  nodes: (db.query('SELECT count(*) AS n FROM knowledge_nodes').get() as { n: number }).n,
});

test('a store from the previous version is moved to the current format with every row, and the old file is kept', async () => {
  const path = storePath();
  const writer = await open(path);
  for (const id of ['a', 'b', 'c']) await writer.upsertSource(source(id));
  await writer.upsertNode(fact('fact-a', 'a'));
  await writer.upsertNode(fact('fact-c', 'c'));
  await close(writer);

  // Make it the previous version's file: its version stamp, and a clock that version wrote as text.
  const older = new Database(path);
  older.run("UPDATE knowledge_sources SET updated_at = '2026-01-02T03:04:05.000Z' WHERE id = 'b'");
  older.run(`PRAGMA user_version = ${KNOWLEDGE_SCHEMA_VERSION - 1}`);
  const before = rowCounts(older);
  older.close();

  const upgraded = await open(path);
  expect(upgraded.listSources(100).map((record) => record.id).sort()).toEqual(['a', 'b', 'c']);
  expect(upgraded.listNodes(100).map((record) => record.id).sort()).toEqual(['fact-a', 'fact-c']);
  // The clock the old version wrote as text is stored in the current format: milliseconds, one type per column.
  expect(upgraded.getSource('b')?.updatedAt).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  const current = new Database(path, { readonly: true });
  try {
    expect(current.query("SELECT typeof(updated_at) AS kind, updated_at AS at FROM knowledge_sources WHERE id = 'b'").get())
      .toEqual({ kind: 'integer', at: Date.parse('2026-01-02T03:04:05.000Z') });
  } finally { current.close(); }

  // The old file is kept beside it, at its old version and with every row.
  const snapshots = listStoreSnapshots(path);
  expect(snapshots).toHaveLength(1);
  const kept = new Database(snapshots[0]!.path, { readonly: true });
  try {
    expect((kept.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(KNOWLEDGE_SCHEMA_VERSION - 1);
    expect(rowCounts(kept)).toEqual(before);
  } finally { kept.close(); }
});

test('a store another app holds open in write-ahead mode is read at start-up, commits still in its WAL included', async () => {
  const path = storePath();
  // The running app: its connection keeps the WAL file, and these commits are only there.
  const running = await open(path);
  const planning = (project: string) => ({ ...source(`plan-${project}`, { projectId: project, knowledgeSpaceId: `project:${project}` }), connectorId: 'goodvibes-project-planning' });
  await running.upsertSource(planning('alpha'));
  await running.upsertSource(planning('beta'));
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

  // A second launch: project preparation reads the file, then the app opens its own store on it.
  const projects = await inspectPersistedPlanningProjects(path, () => {});
  expect(projects.projectIds).toEqual(['alpha', 'beta']);
  const second = await open(path);
  expect(second.listSources(100).map((record) => record.id).sort()).toEqual(['plan-alpha', 'plan-beta']);

  // Reading did not rewrite what the running app holds.
  await running.upsertSource(source('after-the-second-launch'));
  await second.refreshIfChanged();
  expect(second.getSource('after-the-second-launch')).not.toBeNull();
});
