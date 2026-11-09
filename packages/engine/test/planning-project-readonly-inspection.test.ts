/** UNRUN: inspect actual persisted project selectors before any store constructor. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPersistedPlanningProjects, PlanningProjectInspectionError } from '../platform/src/platform/knowledge/project-planning/persisted-projects.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { SQLiteStore, loadSqlJsEngine } from '../platform/src/platform/state/sqlite-store.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.ts';
import { createEmptyWorkLedgerState } from '../platform/src/platform/workflow/work-ledger/service.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'planning-project-readonly-')); roots.push(root); return { root, path: join(root, 'knowledge.sqlite') }; }
async function saved() {
  const f = fixture(), store = new KnowledgeStore({ dbPath: f.path });
  await store.upsertSource({ id: 'actual-old-source', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', title: 'Saved project source', status: 'indexed',
    metadata: { projectId: 'existing-project', knowledgeSpaceId: 'project:existing-project', planningArtifactKind: 'state', planningArtifactId: 'current' } }); await store.close();
  const raw = new SQLiteStore(f.path, { coordinated: true }); await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  raw.run('INSERT INTO work_ledgers(project_id,format_version,revision,state_json) VALUES(?,?,?,?)', ['ledger-only-project', 2, 0, JSON.stringify(createEmptyWorkLedgerState('ledger-only-project'))]); await raw.save(); raw.close(); return f;
}
test('missing storage remains absent with no created parent or metadata registration', async () => {
  const f = fixture(), path = join(f.root, 'uncreated', 'nested', 'knowledge.sqlite');
  const view = await inspectPersistedPlanningProjects(path, () => {}); expect(view.exists).toBe(false); expect(view.projectIds).toEqual([]); expect(existsSync(join(f.root, 'uncreated'))).toBe(false); view.assertCurrent();
});
test('actual planning-only and ledger-only selectors are preserved while file bytes and directory members stay unchanged', async () => {
  const f = await saved(), before = readFileSync(f.path), members = readdirSync(f.root).sort();
  const view = await inspectPersistedPlanningProjects(f.path, () => {}); expect(view.projectIds).toEqual(['existing-project', 'ledger-only-project']); expect(readFileSync(f.path)).toEqual(before); expect(readdirSync(f.root).sort()).toEqual(members); view.assertCurrent();
});
test('future database version is refused without migration, quarantine or reset', async () => {
  const f = await saved(), raw = new SQLiteStore(f.path, { coordinated: true }); await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION }); raw.run('PRAGMA user_version = 99'); await raw.save(); raw.close(); const before = readFileSync(f.path), members = readdirSync(f.root).sort();
  await expect(inspectPersistedPlanningProjects(f.path, () => {})).rejects.toBeInstanceOf(PlanningProjectInspectionError); expect(readFileSync(f.path)).toEqual(before); expect(readdirSync(f.root).sort()).toEqual(members);
});
test('same-byte original replacement retires inspection without rereading or hashing private bodies', async () => {
  const f = await saved(), view = await inspectPersistedPlanningProjects(f.path, () => {}), bytes = readFileSync(f.path); renameSync(f.path, `${f.path}.original`); writeFileSync(f.path, bytes);
  expect(() => view.assertCurrent()).toThrow(); expect(readFileSync(`${f.path}.original`)).toEqual(bytes);
});
test('an explicitly configured file alias retains both original link and physical target', async () => {
  const f = await saved(), alias = join(f.root, 'configured.sqlite'); symlinkSync(f.path, alias); const view = await inspectPersistedPlanningProjects(alias, () => {}); expect(view.projectIds).toContain('existing-project');
  renameSync(alias, `${alias}.original`); symlinkSync(f.path, alias); expect(() => view.assertCurrent()).toThrow();
});
test('retiring the original native owner during async engine acquisition prevents publication of identifiers', async () => {
  const f = await saved(); let current = true;
  const pending = inspectPersistedPlanningProjects(f.path, () => { if (!current) throw Error('Original workspace retired'); }); current = false;
  await expect(pending).rejects.toThrow('Original workspace retired');
});

test('a substituted shared driver is refused before it can receive private database image bytes', async () => {
  const f = await saved(), engine = await loadSqlJsEngine(), original = Object.getOwnPropertyDescriptor(engine, 'Database'); if (!original) throw Error('Missing actual driver descriptor'); let supplied = 0;
  expect(Reflect.defineProperty(engine, 'Database', { ...original, value: class ForeignDriver { constructor() { supplied++; throw Error('Private image reached a foreign driver'); } } })).toBe(true);
  try { await expect(inspectPersistedPlanningProjects(f.path, () => {})).rejects.toThrow(); expect(supplied).toBe(0); }
  finally { Object.defineProperty(engine, 'Database', original); }
});
test('initial native source restriction rejects replacement before any migration or schema callback', async () => {
  const f = await saved(), view = await inspectPersistedPlanningProjects(f.path, () => {}), before = readFileSync(f.path); let schema = 0;
  const store = new SQLiteStore(f.path, { coordinated: true, beforeInitialRead: view.assertInitialImage });
  const pending = store.init(() => { schema++; }, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION }); renameSync(f.path, `${f.path}.original`); writeFileSync(f.path, before);
  try { await expect(pending).rejects.toThrow(); expect(schema).toBe(0); expect(readFileSync(f.path)).toEqual(before); }
  finally { store.close(); }
});
test('actual native initialization can create its own missing intermediate directories without inventing an original database', async () => {
  const f = fixture(), path = join(f.root, 'new', 'nested', 'knowledge.sqlite'), view = await inspectPersistedPlanningProjects(path, () => {});
  const store = new SQLiteStore(path, { coordinated: true, beforeInitialRead: view.assertInitialImage });
  try { await store.init(() => {}, { schemaVersion: 1 }); view.assertInitialImage(); expect(existsSync(path)).toBe(false); expect(() => view.assertCurrent()).toThrow(); }
  finally { store.close(); }
});
test('async/nonvoid source restrictions are rejected and drained before schema effects', async () => {
  const f = await saved(); let schema = 0; const store = new SQLiteStore(f.path, { coordinated: true, beforeInitialRead: async () => { throw Error('synthetic async restriction'); } });
  try { await expect(store.init(() => { schema++; }, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION })).rejects.toThrow('initial read owner must complete synchronously'); expect(schema).toBe(0); }
  finally { store.close(); }
});
