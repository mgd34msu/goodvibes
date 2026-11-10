import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createSchema, KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.js';
import { SQLiteStore, type SqlDatabase } from '../platform/src/platform/state/sqlite-store.js';
import { storeSnapshotDir } from '../platform/src/platform/state/store-snapshots.js';

const roots: string[] = [], knowledge: KnowledgeStore[] = [], databases: SQLiteStore[] = [];
afterEach(async () => {
  for (const store of knowledge.splice(0)) await store.close();
  for (const store of databases.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function filename() { const root = mkdtempSync(join(tmpdir(), 'knowledge-fresh-schema-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
function backing(store: KnowledgeStore): SQLiteStore {
  const sqlite: unknown = Reflect.get(store, 'sqlite');
  if (!(sqlite instanceof SQLiteStore)) throw new Error('Original SQLite owner unavailable');
  return sqlite;
}
function schemaAndContent(sqlite: SQLiteStore) {
  const tables = sqlite.exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")[0]?.values ?? [];
  return {
    schema: sqlite.exec('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'),
    version: sqlite.exec('PRAGMA user_version'),
    recursiveTriggers: sqlite.exec('PRAGMA recursive_triggers'),
    rows: tables.map(([name]) => {
      if (typeof name !== 'string') throw new Error('Invalid original table name');
      return [name, sqlite.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`)];
    }),
  };
}
function observeKnowledgeOpen(file: string, historical = false) {
  const calls = { schema: 0, migratedSchema: 0, migrations: [] as number[] };
  const initialize = SQLiteStore.prototype.init;
  const observer = spyOn(SQLiteStore.prototype, 'init').mockImplementation(function (this: SQLiteStore, schema, options = {}) {
    const migrations = options.migrations?.map(migration => ({ ...migration, migrate(db: SqlDatabase) {
      if (migration.migrate === schema) calls.migratedSchema++;
      calls.migrations.push(migration.toVersion); migration.migrate(db);
    } }));
    return initialize.call(this, db => { calls.schema++; schema(db); }, { ...options,
      ...(historical ? { initializeFreshSchema: false } : {}), ...(migrations ? { migrations } : {}) });
  });
  let store: KnowledgeStore;
  try { store = new KnowledgeStore({ dbPath: file }); }
  finally { observer.mockRestore(); }
  knowledge.push(store);
  return { store, calls };
}

test('one complete fresh initializer exactly matches all historical schema definitions and initial table contents', async () => {
  const fresh = observeKnowledgeOpen(filename()), historical = observeKnowledgeOpen(filename(), true);
  await Promise.all([fresh.store.init(), historical.store.init()]);
  expect(fresh.calls).toEqual({ schema: 1, migratedSchema: 0, migrations: [] });
  expect(historical.calls.migrations).toEqual(Array.from({ length: KNOWLEDGE_SCHEMA_VERSION }, (_, index) => index + 1));
  expect(historical.calls.schema + historical.calls.migratedSchema).toBe(2);
  expect(schemaAndContent(backing(fresh.store))).toEqual(schemaAndContent(backing(historical.store)));
  expect(backing(fresh.store).exec('PRAGMA user_version')[0]?.values).toEqual([[KNOWLEDGE_SCHEMA_VERSION]]);
  expect(existsSync(fresh.store.storagePath)).toBe(false);
  expect(existsSync(historical.store.storagePath)).toBe(false);
  await fresh.store.upsertSource({ id: 'first-save', connectorId: 'fresh-fixture', sourceType: 'document', title: 'Original first save', status: 'indexed' });
  expect(existsSync(fresh.store.storagePath)).toBe(true);
  const reopened = observeKnowledgeOpen(fresh.store.storagePath); await reopened.store.init();
  expect(reopened.store.getSource('first-save')?.title).toBe('Original first save');
  expect(reopened.calls.migrations).toEqual([]);
});

test('an existing version-zero database with real source content retains every historical migration and its original snapshot', async () => {
  const file = filename(), old = new SQLiteStore(file); databases.push(old);
  await old.init(createSchema, { schemaVersion: 0 });
  old.run('INSERT INTO knowledge_sources(id,connector_id,source_type,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ['original-v0', 'historical-fixture', 'document', 'Original version-zero content', 'indexed', 1, 1]);
  await old.save(); old.close();
  const bytes = readFileSync(file), opened = observeKnowledgeOpen(file); await opened.store.init();
  expect(opened.calls.migrations).toEqual(Array.from({ length: KNOWLEDGE_SCHEMA_VERSION }, (_, index) => index + 1));
  expect(opened.store.getSource('original-v0')?.title).toBe('Original version-zero content');
  expect(backing(opened.store).exec('PRAGMA user_version')[0]?.values).toEqual([[KNOWLEDGE_SCHEMA_VERSION]]);
  const directory = storeSnapshotDir(file), snapshots = readdirSync(directory).filter(name => name.includes('pre-migration-v0-to-v17'));
  expect(snapshots).toHaveLength(1);
  expect(readFileSync(join(directory, snapshots[0] ?? 'missing'))).toEqual(bytes);
});

test('SQLiteStore callers without fresh opt-in retain their migration seed effects', async () => {
  const sqlite = new SQLiteStore(filename(), { coordinated: true }); databases.push(sqlite);
  let schemaCalls = 0;
  const schema = (db: SqlDatabase) => { schemaCalls++; db.run('CREATE TABLE IF NOT EXISTS fixture(seed TEXT)'); };
  await sqlite.init(schema, { schemaVersion: 2, migrations: [
    { toVersion: 1, migrate(db) { schema(db); db.run("INSERT INTO fixture VALUES ('first')"); } },
    { toVersion: 2, migrate(db) { db.run("INSERT INTO fixture VALUES ('second')"); } },
  ] });
  expect(schemaCalls).toBe(2);
  expect(sqlite.exec('SELECT seed FROM fixture ORDER BY rowid')[0]?.values).toEqual([['first'], ['second']]);
});

test('fresh initialization retains original read ownership and native first-save declaration', async () => {
  const file = filename(); let readChecks = 0, writes = 0, schemaCalls = 0, validationCalls = 0;
  const sqlite = new SQLiteStore(file, { coordinated: true, beforeInitialRead() { readChecks++; }, beforePersist() { writes++; } }); databases.push(sqlite);
  await sqlite.init(db => { schemaCalls++; db.run('CREATE TABLE fixture(value TEXT)'); }, {
    initializeFreshSchema: true, schemaVersion: 2, validateCurrentSchema(db) {
      validationCalls++; expect(db.exec("SELECT name FROM sqlite_schema WHERE name='fixture'")[0]?.values).toEqual([['fixture']]);
    },
  });
  expect(readChecks).toBeGreaterThanOrEqual(3); expect(schemaCalls).toBe(1); expect(validationCalls).toBe(1);
  expect(writes).toBe(0); expect(existsSync(file)).toBe(false);
  await sqlite.save(); expect(writes).toBe(1); expect(existsSync(file)).toBe(true);
});

test('a retired original image owner refuses fresh initialization before schema work', async () => {
  const file = filename(); let checks = 0, schemaCalls = 0;
  const sqlite = new SQLiteStore(file, { coordinated: true, beforeInitialRead() { if (++checks === 3) throw new Error('Original image owner retired'); } }); databases.push(sqlite);
  await expect(sqlite.init(() => { schemaCalls++; }, { initializeFreshSchema: true, schemaVersion: 1 })).rejects.toThrow('Original image owner retired');
  expect(schemaCalls).toBe(0); expect(existsSync(file)).toBe(false);
});

for (const failure of ['schema', 'validator'] as const) {
test(`a throwing fresh ${failure} closes its partial image without writing a database`, async () => {
  const file = filename(), sqlite = new SQLiteStore(file, { coordinated: true }); databases.push(sqlite);
  await expect(sqlite.init(db => { db.run('CREATE TABLE fixture(value TEXT)'); if (failure === 'schema') throw new Error('Fresh callback refused'); }, {
    initializeFreshSchema: true, schemaVersion: 1, validateCurrentSchema() { if (failure === 'validator') throw new Error('Fresh callback refused'); },
  })).rejects.toThrow('Fresh callback refused');
  expect(existsSync(file)).toBe(false);
  expect(() => sqlite.exec('SELECT * FROM fixture')).toThrow('not initialized');
});
}

for (const version of [-1, 1.5, NaN, Infinity, 2_147_483_648]) {
test(`fresh opt-in rejects an invalid native target version ${version} before schema creation`, async () => {
  const file = filename(), sqlite = new SQLiteStore(file, { coordinated: true }); databases.push(sqlite);
  let called = false;
  await expect(sqlite.init(() => { called = true; }, { initializeFreshSchema: true, schemaVersion: version })).rejects.toThrow('native user_version range');
  expect(called).toBe(false); expect(existsSync(file)).toBe(false);
});
}

test('an existing malformed file is never reclassified as a fresh image', async () => {
  const file = filename(), bytes = Buffer.from('existing malformed image'); writeFileSync(file, bytes);
  const sqlite = new SQLiteStore(file, { coordinated: true }); databases.push(sqlite);
  let called = false;
  await expect(sqlite.init(() => { called = true; }, { initializeFreshSchema: true, schemaVersion: 1 })).rejects.toThrow();
  expect(called).toBe(false); expect(readFileSync(file)).toEqual(bytes);
});
