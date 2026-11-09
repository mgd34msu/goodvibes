import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema-version.js';
import { prepareNativeKnowledgeSchemaReadPlan } from '../platform/src/platform/state/knowledge-schema-read-plan.js';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { readSQLitePersistedImage, SQLiteStorePersistence } from '../platform/src/platform/state/sqlite-store-persistence.js';

const roots: string[] = [], close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() { const root = mkdtempSync(join(tmpdir(), 'native-schema-baseline-')); roots.push(root); return join(root, 'knowledge.sqlite'); }

test('only fresh native reads of accepted exact bytes and original physical file retain baseline identity', () => {
  const file = path(), owner = new SQLiteStorePersistence(file), bytes = Buffer.from('Original persisted image');
  owner.acceptBaseline(null); owner.write(bytes);
  const original = readSQLitePersistedImage(owner);
  expect(original.baseline).toBeDefined();
  expect(readSQLitePersistedImage(owner).baseline).toBe(original.baseline);
  const forged = spyOn(owner, 'read').mockReturnValue(Buffer.from('Foreign bytes'));
  try { expect(readSQLitePersistedImage(owner).data).toEqual(bytes); expect(readSQLitePersistedImage(owner).baseline).toBe(original.baseline); }
  finally { forged.mockRestore(); }
  const old = `${file}.original`; renameSync(file, old); writeFileSync(file, bytes, { mode: 0o600 });
  const spoof = spyOn(owner, 'observationIdentity').mockReturnValue(original.identity);
  try { expect(readSQLitePersistedImage(owner).baseline).toBeUndefined(); }
  finally { spoof.mockRestore(); }
  expect(readSQLitePersistedImage(owner).baseline).toBeUndefined(); // Reads never adopt the replacement.
  expect(readFileSync(old)).toEqual(bytes);
});

test('an identical-byte accepted write invalidates the old token and same-inode content edits cannot restore it', () => {
  const file = path(), owner = new SQLiteStorePersistence(file), bytes = Buffer.from('Original persisted image');
  owner.acceptBaseline(null); owner.write(bytes); const first = readSQLitePersistedImage(owner);
  owner.write(bytes); const second = readSQLitePersistedImage(owner);
  expect(second.baseline).toBeDefined(); expect(second.baseline).not.toBe(first.baseline);
  const stamp = statSync(file); writeFileSync(file, 'Changed private contents'); utimesSync(file, stamp.atime, stamp.mtime);
  expect(readSQLitePersistedImage(owner).baseline).toBeUndefined();
  writeFileSync(file, bytes); utimesSync(file, stamp.atime, stamp.mtime);
  expect(readSQLitePersistedImage(owner).baseline).toBeUndefined();
});

test('a genuine native plan does not cache a substituted generic validator or its callback images', async () => {
  const sqlite = new SQLiteStore(path(), { coordinated: true }); close.push(() => sqlite.close()); let validations = 0;
  await sqlite.init(db => { db.run('CREATE TABLE IF NOT EXISTS custom_data(id TEXT)'); }, {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION, nativeSchemaReadPlan: prepareNativeKnowledgeSchemaReadPlan(),
    validateCurrentSchema() { validations++; },
  });
  await sqlite.save(); const before = validations;
  for (let index = 0; index < 3; index++) sqlite.readPersisted(db => { db.run('INSERT INTO custom_data VALUES (?)', [String(index)]); });
  expect(validations).toBe(before + 3);
  expect(sqlite.readPersisted(db => db.exec('SELECT * FROM custom_data'))).toEqual([]);
  expect(validations).toBe(before + 4);
});

test('a successful own write of an invalid native schema is never a full-validation acknowledgment', async () => {
  const file = path(), store = new KnowledgeStore({ dbPath: file }); close.push(() => store.close());
  await store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  expect(sqlite.readPersisted(db => db.exec('SELECT id FROM knowledge_sources')[0]?.values[0]?.[0])).toBe('source');
  sqlite.run('DROP TABLE native_work_execution_settlements'); await sqlite.save();
  const invalid = readFileSync(file);
  expect(() => sqlite.readPersisted(() => true)).toThrow();
  expect(readFileSync(file)).toEqual(invalid);
});
