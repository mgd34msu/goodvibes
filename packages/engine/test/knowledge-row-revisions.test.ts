import { knowledgeNodeContentRevisionTriggers } from '../sdk/src/platform/knowledge/store-node-content-revisions.js';
import { knowledgeContentHash } from '../sdk/src/platform/knowledge/content-hash.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema, KNOWLEDGE_SCHEMA_VERSION } from '../sdk/src/platform/knowledge/store-schema.js';
import { createKnowledgeRowRevisions, knowledgeRowGenerationFromRows, knowledgeRawRowForAdmission,
  knowledgeRevisionTables, knowledgeRowRevisionTriggers, validateKnowledgeRowRevisions } from '../sdk/src/platform/knowledge/store-row-revisions.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';

const databases: SqlDatabase[] = [], roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function database() {
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(); databases.push(db);
  createSchema(db); return db;
}
const inserts = {
  knowledge_sources: "INSERT INTO knowledge_sources(id,connector_id,source_type,status,metadata,created_at,updated_at) VALUES('record','fixture','manual','indexed','{}',0,0)",
  knowledge_nodes: "INSERT INTO knowledge_nodes(id,kind,slug,title,status,confidence,metadata,created_at,updated_at) VALUES('record','topic','record','Topic','draft',0,'{}',0,0)",
  knowledge_extractions: "INSERT INTO knowledge_extractions(id,source_id,extractor_id,format,metadata,created_at,updated_at) VALUES('record','source','fixture','text','{}',0,0)",
  knowledge_edges: "INSERT INTO knowledge_edges(id,from_kind,from_id,to_kind,to_id,relation,weight,metadata,created_at,updated_at) VALUES('record','source','source','node','node','references',1,'{}',0,0)",
};
function generation(db: SqlDatabase, table: typeof knowledgeRevisionTables[number]) {
  return knowledgeRowGenerationFromRows(db.exec(`SELECT * FROM ${table} WHERE id='record'`));
}

test.each(knowledgeRevisionTables)('%s revisions belong to actual writes and survive reopen without content hashing', async table => {
  const db = await database();
  expect(generation(db, table)).toBeNull(); db.run(inserts[table]);
  const original = generation(db, table);
  expect(original).toMatch(/^kr-[0-9a-f]{32}$/);
  expect(generation(db, table)).toBe(original);
  const SQL = await loadSqlJsEngine(), reopened = new SQL.Database(db.export()); databases.push(reopened);
  createSchema(reopened);
  expect(generation(reopened, table)).toBe(original);
  db.run(`UPDATE ${table} SET metadata=' { }' WHERE id='record'`);
  const edited = generation(db, table); expect(edited).not.toBe(original);
  db.run(`UPDATE ${table} SET metadata='{}' WHERE id='record'`);
  expect(generation(db, table)).not.toBe(original);
  db.run(`UPDATE ${table} SET gv_revision=? WHERE id='record'`, [original!.slice(3)]);
  expect(generation(db, table)).not.toBe(original);
  db.run(`DELETE FROM ${table} WHERE id='record'`); db.run(inserts[table]);
  expect(generation(db, table)).not.toBe(original);
  expect(() => validateKnowledgeRowRevisions(db)).not.toThrow();
});

test('row stamp updates do not add endpoint history but real edge changes do', async () => {
  const db = await database(); db.run(inserts.knowledge_edges);
  const count = () => db.exec('SELECT count(*) FROM knowledge_edge_changes')[0]?.values[0]?.[0];
  expect(count()).toBe(1);
  db.run("UPDATE knowledge_edges SET metadata='{ }' WHERE id='record'");
  expect(count()).toBe(3);
  const original = generation(db, 'knowledge_edges');
  db.run("UPDATE knowledge_edges SET gv_revision='attempted restore' WHERE id='record'");
  expect(count()).toBe(3);
  expect(generation(db, 'knowledge_edges')).not.toBe(original);
});

test('transaction rollback restores the complete previous row and its native revision', async () => {
  const db = await database(); db.run(inserts.knowledge_sources);
  const original = generation(db, 'knowledge_sources');
  db.run('BEGIN'); db.run("UPDATE knowledge_sources SET title='Temporary' WHERE id='record'");
  expect(generation(db, 'knowledge_sources')).not.toBe(original);
  db.run('ROLLBACK'); expect(generation(db, 'knowledge_sources')).toBe(original);
});

test.each(['missing-trigger', 'foreign-trigger', 'recursive-triggers', 'view'] as const)('native revision admission refuses %s', async kind => {
  const db = await database();
  if (kind === 'recursive-triggers') db.run('PRAGMA recursive_triggers=ON');
  else if (kind === 'view') {
    db.run('ALTER TABLE knowledge_sources RENAME TO source_rows');
    db.run('CREATE VIEW knowledge_sources AS SELECT * FROM source_rows');
  } else {
    db.run('DROP TRIGGER knowledge_sources_revision_update');
    if (kind === 'foreign-trigger') db.run('CREATE TRIGGER knowledge_sources_revision_update AFTER UPDATE ON knowledge_sources BEGIN SELECT 1; END');
  }
  expect(() => validateKnowledgeRowRevisions(db)).toThrow();
});

test('the native admission projection omits only the host column, including no metadata exceptions', () => {
  const raw = { gv_revision: 'native revision', gv_content_revision: 'native content revision', metadata: '{"gv_revision":"private user value"}', unknown: 'unrecognized input' };
  expect(knowledgeRawRowForAdmission(raw, 'node')).toEqual({ metadata: raw.metadata, unknown: raw.unknown });
  expect(knowledgeRawRowForAdmission(raw, 'source')?.gv_content_revision).toBe('native content revision');
  expect(raw.gv_revision).toBe('native revision');
});

function makeVersionTen(db: SqlDatabase) {
  db.run('DROP TRIGGER knowledge_node_activation_dependencies_delete');
  db.run('DROP TABLE knowledge_node_activation_dependencies');
  for (const [name] of knowledgeNodeContentRevisionTriggers) db.run(`DROP TRIGGER ${name}`);
  db.run('ALTER TABLE knowledge_nodes DROP COLUMN gv_content_revision');
  for (const [name] of knowledgeRowRevisionTriggers) db.run(`DROP TRIGGER ${name}`);
  for (const table of knowledgeRevisionTables) db.run(`ALTER TABLE ${table} DROP COLUMN gv_revision`);
  db.run('DROP TRIGGER knowledge_edge_change_update');
  db.run(`CREATE TRIGGER knowledge_edge_change_update AFTER UPDATE ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END`);
  db.run('PRAGMA user_version=10');
}

test('an actual version ten image migrates once and keeps its original source values on restart', async () => {
  const db = await database(); db.run(inserts.knowledge_sources);
  makeVersionTen(db);
  const root = mkdtempSync(join(tmpdir(), 'knowledge-native-revision-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'); writeFileSync(dbPath, db.export());
  const store = new KnowledgeStore({ dbPath });
  let first: string | null = null;
  try {
    await store.init(); first = store.getSourceGeneration('record');
    expect(first).toMatch(/^kr-[0-9a-f]{32}$/);
    expect(store.getSource('record')).toMatchObject({ id: 'record', connectorId: 'fixture', metadata: {} });
  } finally { await store.close(); }
  const next = new KnowledgeStore({ dbPath });
  try { await next.init(); expect(next.getSourceGeneration('record')).toBe(first); }
  finally { await next.close(); }
  const SQL = await loadSqlJsEngine(), migrated = new SQL.Database(readFileSync(dbPath)); databases.push(migrated);
  expect(migrated.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(KNOWLEDGE_SCHEMA_VERSION);
  createKnowledgeRowRevisions(migrated); expect(generation(migrated, 'knowledge_sources')).toBe(first);
});


test('native row migration preserves paid activation receipts without another model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-paid-revision-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath });
  const fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    await store.init();
    await store.upsertSource({ id: 'manual', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', title: 'Manual' });
    await store.upsertExtraction({ sourceId: 'manual', extractorId: 'fixture', format: 'text', excerpt: 'The device has four inputs.' });
    const original = await store.upsertNode({ id: 'fact', kind: 'fact', slug: 'fact', title: 'Device inputs',
      summary: 'The device has four inputs.', sourceId: 'manual',
      metadata: { semanticKind: 'fact', factKind: 'specification', value: 'four inputs', evidence: 'The device has four inputs.' } });
    expect(original.status).toBe('active'); expect(fake.requests).toHaveLength(1);
    const { dependencyReference: _reference, dependencyVersion: _dependencyVersion, ...oldReading } = original.metadata.nodeActivation as Record<string, unknown>;
    const historical = { ...original, metadata: { ...original.metadata, nodeActivation: { ...oldReading,
      evidenceHash: knowledgeContentHash(JSON.stringify({ evidence: [{ id: 'manual', source: store.getSource('manual'),
        extraction: store.getExtractionBySourceId('manual') }], subjects: [] })) } } };
    await store.close();
    const SQL = await loadSqlJsEngine(), old = new SQL.Database(readFileSync(dbPath));
    try { old.run('UPDATE knowledge_nodes SET metadata=? WHERE id=?', [JSON.stringify(historical.metadata), original.id]); old.run('UPDATE knowledge_node_revisions SET metadata=? WHERE node_id=?', [JSON.stringify(historical.metadata), original.id]); makeVersionTen(old); writeFileSync(dbPath, old.export()); } finally { old.close(); }
    const restarted = new KnowledgeStore({ dbPath });
    try {
      await restarted.init();
      expect(restarted.getNode('fact')).toEqual(historical);
      const adopted = await restarted.upsertNode({ ...historical });
      expect((adopted.metadata.nodeActivation as Record<string, unknown>).evidenceHash).toBeUndefined();
      expect((adopted.metadata.nodeActivation as Record<string, unknown>).dependencyVersion).toBe(1);
      expect(fake.requests).toHaveLength(1);
      const migrated = readFileSync(dbPath);
      expect(await restarted.upsertNode({ ...adopted })).toEqual(adopted);
      expect(fake.requests).toHaveLength(1);
      expect(readFileSync(dbPath)).toEqual(migrated);
    } finally { await restarted.close(); }
  } finally { installJudgmentPort(previous); await store.close(); }
});
