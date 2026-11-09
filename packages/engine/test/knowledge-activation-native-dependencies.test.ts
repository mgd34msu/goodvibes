/** Authored native regression SOURCE; execution deferred until coding finishes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createSchema } from '../platform/src/platform/knowledge/store-schema.js';
import { loadSqlJsEngine, type SqlDatabase, type SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { knowledgeNodeContentGenerationFromRows, knowledgeNodeContentRevisionTriggers } from '../platform/src/platform/knowledge/store-node-content-revisions.js';
import { knowledgeRowGenerationFromRows, knowledgeRawRowForAdmission } from '../platform/src/platform/knowledge/store-row-revisions.js';
import { sameNativeKnowledgeTableSql } from '../platform/src/platform/knowledge/store-table-definition.js';
import { knowledgeRecordTableSql } from '../platform/src/platform/knowledge/store-schema-validation-data.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], databases: SqlDatabase[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'activation-native-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath: path }); stores.push(store); await store.init();
  await store.upsertSource({ id: 'manual', connectorId: 'fixture', sourceType: 'manual', title: 'Manual', status: 'indexed', metadata: { private: 'PRIVATE_SOURCE_BODY' } });
  await store.upsertExtraction({ id: 'manual-text', sourceId: 'manual', extractorId: 'fixture', format: 'text', excerpt: 'The device has four inputs.', metadata: { private: 'PRIVATE_EXTRACTION_BODY' } });
  return { store, path };
}
const node = (id: string, subjectId?: string) => ({ id, kind: 'fact' as const, slug: id, title: 'Device inputs',
  summary: 'The device has four inputs.', sourceId: 'manual', metadata: { semanticKind: 'fact', value: 'four inputs', evidence: 'The device has four inputs.', ...(subjectId ? { subjectId } : {}) } });

test('fresh native activation and unchanged restart reuse perform no activation SHA and duplicate no source body', async () => {
  const { store, path } = await fixture(), fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  const hashes = spyOn(crypto, 'createHash');
  try {
    const original = await store.upsertNode(node('fact'));
    expect(original.metadata.nodeActivation).toMatchObject({ dependencyVersion: 1 });
    expect(original.metadata.nodeActivation).not.toHaveProperty('evidenceHash');
    expect(await store.upsertNode({ ...original })).toEqual(original); expect(fake.requests).toHaveLength(1);
    await store.close();
    const restarted = new KnowledgeStore({ dbPath: path }); stores.push(restarted); await restarted.init();
    const saved = restarted.getNode(original.id)!;
    const bytes = readFileSync(path);
    expect(await restarted.upsertNode({ ...saved })).toEqual(saved);
    expect(fake.requests).toHaveLength(1); expect(readFileSync(path)).toEqual(bytes);
    expect(hashes).not.toHaveBeenCalled();
    const wire = JSON.stringify(fake.requests);
    for (const privateName of ['gv_revision', 'gv_content_revision', 'nodeGeneration', 'sourceGeneration', 'extractionGeneration']) expect(wire).not.toContain(privateName);
    const SQL = await loadSqlJsEngine(), db = new SQL.Database(readFileSync(path)); databases.push(db);
    const cache = JSON.stringify(db.exec('SELECT * FROM knowledge_node_activation_dependencies'));
    expect(cache).not.toContain('PRIVATE_SOURCE_BODY'); expect(cache).not.toContain('PRIVATE_EXTRACTION_BODY');
    expect(cache).not.toContain('The device has four inputs.');
  } finally { hashes.mockRestore(); installJudgmentPort(previous); }
});

test('self and cyclic batch subjects use final native content versions without repeated paid readings', async () => {
  const { store } = await fixture(), fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    const self = await store.upsertNode(node('self', 'self'));
    expect(await store.upsertNode({ ...self })).toEqual(self); expect(fake.requests).toHaveLength(1);
    const prepared = await store.prepareNodeWrites([node('left', 'right'), node('right', 'left')]);
    const left = await store.upsertPreparedNode(prepared, 0), right = await store.upsertPreparedNode(prepared, 1);
    expect(fake.requests).toHaveLength(3);
    expect(await store.upsertNode({ ...left })).toEqual(left);
    expect(await store.upsertNode({ ...right })).toEqual(right); expect(fake.requests).toHaveLength(3);
    // A proposed sibling change must invalidate reuse before any batch writes,
    // even though its current persisted generation still matches the old cache.
    const changed = await store.prepareNodeWrites([{ ...left }, { ...right, summary: 'The device has four physical inputs.' }]);
    await store.upsertPreparedNode(changed, 0); await store.upsertPreparedNode(changed, 1);
    expect(fake.requests).toHaveLength(5);
    await store.upsertNode({ ...store.getNode('left')! }); await store.upsertNode({ ...store.getNode('right')! });
    expect(fake.requests).toHaveLength(5);
  } finally { installJudgmentPort(previous); }
});

test('a mixed sequential pass ending in an unchanged slot persists the final dependency vectors before returning', async () => {
  const { store, path } = await fixture(), fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    const existing = await store.upsertNode(node('existing'));
    const prepared = await store.prepareNodeWrites([node('new'), { ...existing }]);
    await store.upsertPreparedNode(prepared, 0); await store.upsertPreparedNode(prepared, 1);
    expect(fake.requests).toHaveLength(2);
    await store.close();
    const restarted = new KnowledgeStore({ dbPath: path }); stores.push(restarted); await restarted.init();
    await restarted.upsertNode({ ...restarted.getNode('new')! }); await restarted.upsertNode({ ...restarted.getNode('existing')! });
    expect(fake.requests).toHaveLength(2);
  } finally { installJudgmentPort(previous); }
});

test.each(['future-receipt', 'malformed-receipt', 'future-cache', 'malformed-cache-reference', 'malformed-cache-generation'] as const)('%s is preserved before any provider call, including changed candidate content', async kind => {
  const { store, path } = await fixture(), seed = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(seed.port);
  try {
    const original = await store.upsertNode(node('fact')); await store.close();
    const SQL = await loadSqlJsEngine(), edited = new SQL.Database(readFileSync(path));
    try {
      if (kind === 'future-cache' || kind === 'malformed-cache-reference' || kind === 'malformed-cache-generation') {
        const rows = edited.exec('SELECT dependencies_json FROM knowledge_node_activation_dependencies WHERE node_id=?', [original.id]);
        const saved = JSON.parse(String(rows[0]!.values[0]![0])) as Record<string, unknown>;
        if (kind === 'malformed-cache-reference') edited.run('UPDATE knowledge_node_activation_dependencies SET receipt_reference=? WHERE node_id=?', ['not-a-native-reference', original.id]);
        else edited.run('UPDATE knowledge_node_activation_dependencies SET dependencies_json=? WHERE node_id=?', [JSON.stringify(kind === 'future-cache'
          ? { ...saved, version: 2, futureField: 'preserve' } : { ...saved, nodeGeneration: 'kc-not-a-native-version' }), original.id]);
      } else {
        const receipt = original.metadata.nodeActivation as Record<string, unknown>;
        edited.run('UPDATE knowledge_nodes SET metadata=? WHERE id=?', [JSON.stringify({ ...original.metadata,
          nodeActivation: { ...receipt, dependencyVersion: kind === 'future-receipt' ? 2 : '1' } }), original.id]);
      }
      writeFileSync(path, edited.export());
    } finally { edited.close(); }
    const restarted = new KnowledgeStore({ dbPath: path }); stores.push(restarted); await restarted.init();
    const bytes = readFileSync(path), saved = restarted.getNode(original.id)!, fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    await expect(restarted.upsertNode({ ...saved, summary: 'Changed supported candidate content.' })).rejects.toThrow('malformed');
    await expect(restarted.prepareNodeWrites([node('ordinary'), { ...saved }])).rejects.toThrow('malformed');
    expect(fake.requests).toHaveLength(0); expect(readFileSync(path)).toEqual(bytes);
    expect(restarted.getNode(original.id)).toEqual(saved);
  } finally { installJudgmentPort(previous); }
});

test('a native SQL edit during model I/O cannot tag an old interpretation with new dependency versions', async () => {
  const { store } = await fixture(), sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const fake = fakePort(async () => {
    sqlite.run('UPDATE knowledge_extractions SET excerpt=? WHERE id=?', ['Changed actual extraction while the cached view remains old.', 'manual-text']);
    await sqlite.save();
    return noulAnswer(0.99);
  }), previous = installJudgmentPort(fake.port);
  try {
    await expect(store.upsertNode(node('stale-result'))).rejects.toThrow('stale');
    expect(store.getNode('stale-result')).toBeNull();
    expect(sqlite.exec('SELECT node_id FROM knowledge_node_activation_dependencies')[0]?.values ?? []).toEqual([]);
    expect(store.getExtraction('manual-text')?.excerpt).toBe('The device has four inputs.');
  } finally { installJudgmentPort(previous); }
});

test('a stale cached extraction cannot acquire the latest native source version before preparation', async () => {
  const { store } = await fixture(), sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('UPDATE knowledge_extractions SET excerpt=? WHERE id=?', ['Changed actual extraction before preparation.', 'manual-text']); await sqlite.save();
  const fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    await expect(store.upsertNode(node('stale-input'))).rejects.toThrow('stale');
    expect(fake.requests).toHaveLength(0); expect(store.getNode('stale-input')).toBeNull();
  } finally { installJudgmentPort(previous); }
});

test('content revisions preserve administrative restamps but retire on actual content, deletion and reinsert', async () => {
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(); databases.push(db); createSchema(db);
  db.run("INSERT INTO knowledge_nodes(id,kind,slug,title,status,confidence,metadata,created_at,updated_at) VALUES('node','topic','node','Topic','active',0,'{\"value\":\"original\"}',0,0)");
  const rows = () => db.exec("SELECT * FROM knowledge_nodes WHERE id='node'");
  const original = knowledgeNodeContentGenerationFromRows(rows()), rowRevision = knowledgeRowGenerationFromRows(rows());
  db.run("UPDATE knowledge_nodes SET metadata=?,updated_at=1 WHERE id='node'", ['{"value":"original","nodeActivation":{"dependencyReference":"new"},"reviewProvenance":{"decidedAt":"later"},"nodeObservation":{"origin":"catalog"}}']);
  expect(knowledgeNodeContentGenerationFromRows(rows())).toBe(original);
  expect(knowledgeRowGenerationFromRows(rows())).not.toBe(rowRevision);
  const raw = Object.fromEntries(rows()[0]!.columns.map((column, index) => [column, rows()[0]!.values[0]![index]]));
  expect(knowledgeRawRowForAdmission(raw, 'node')).not.toHaveProperty('gv_content_revision');
  expect(knowledgeRawRowForAdmission(raw, 'node')).not.toHaveProperty('gv_revision');
  db.run("UPDATE knowledge_nodes SET metadata='{\"value\":\"changed\"}' WHERE id='node'");
  expect(knowledgeNodeContentGenerationFromRows(rows())).not.toBe(original);
  db.run("UPDATE knowledge_nodes SET gv_content_revision=? WHERE id='node'", [original!.slice(3)]);
  expect(knowledgeNodeContentGenerationFromRows(rows())).not.toBe(original);
  db.run("DELETE FROM knowledge_nodes WHERE id='node'");
  db.run("INSERT INTO knowledge_nodes(id,kind,slug,title,status,confidence,metadata,created_at,updated_at) VALUES('node','topic','node','Topic','active',0,'{\"value\":\"original\"}',0,0)");
  expect(knowledgeNodeContentGenerationFromRows(rows())).not.toBe(original);
});

test('v12 migration changes no existing native row revisions and initializes content versions without a rewrite', async () => {
  const { store, path } = await fixture(), before = store.getSourceGeneration('manual'); await store.close();
  const SQL = await loadSqlJsEngine(), old = new SQL.Database(readFileSync(path));
  let oldNodeGeneration: string | null = null;
  try {
    old.run('DROP TRIGGER knowledge_node_activation_dependencies_delete'); old.run('DROP TABLE knowledge_node_activation_dependencies');
    for (const [name] of knowledgeNodeContentRevisionTriggers) old.run(`DROP TRIGGER ${name}`);
    old.run('ALTER TABLE knowledge_nodes DROP COLUMN gv_content_revision'); old.run('PRAGMA user_version=12');
    old.run("INSERT INTO knowledge_nodes(id,kind,slug,title,status,confidence,metadata,created_at,updated_at) VALUES('previous-node','topic','previous-node','Previous','draft',0,'{}',0,0)");
    oldNodeGeneration = knowledgeRowGenerationFromRows(old.exec("SELECT * FROM knowledge_nodes WHERE id='previous-node'"));
    writeFileSync(path, old.export());
  } finally { old.close(); }
  const migrated = new KnowledgeStore({ dbPath: path }); stores.push(migrated); await migrated.init();
  expect(migrated.getSourceGeneration('manual')).toBe(before);
  const db = new SQL.Database(readFileSync(path)); databases.push(db);
  const ddl = db.exec("SELECT sql FROM sqlite_master WHERE name='knowledge_nodes'")[0]!.values[0]![0];
  expect(sameNativeKnowledgeTableSql(ddl, knowledgeRecordTableSql.knowledge_nodes)).toBe(true);
  const existing = db.exec("SELECT * FROM knowledge_nodes WHERE id='previous-node'");
  expect(knowledgeRowGenerationFromRows(existing)).toBe(oldNodeGeneration);
  expect(knowledgeNodeContentGenerationFromRows(existing)).toBe(`kc-${oldNodeGeneration!.slice(3)}`);
});

test('native schema whitespace normalization preserves every literal and rejects unknown clauses', () => {
  const expected = "CREATE TABLE IF NOT EXISTS t (id TEXT, value TEXT DEFAULT 'a  b')";
  expect(sameNativeKnowledgeTableSql("CREATE TABLE t(id TEXT ,value TEXT DEFAULT 'a  b' )", expected)).toBe(true);
  expect(sameNativeKnowledgeTableSql("CREATE TABLE t(id TEXT,value TEXT DEFAULT 'a b')", expected)).toBe(false);
  expect(sameNativeKnowledgeTableSql("CREATE TABLE t(id TEXT,value TEXT DEFAULT 'a  b',extra TEXT)", expected)).toBe(false);
  expect(sameNativeKnowledgeTableSql("CREATE TABLE t(id TEXT/* comment */,value TEXT DEFAULT 'a  b')", expected)).toBe(false);
});
