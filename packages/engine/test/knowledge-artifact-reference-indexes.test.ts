/** UNRUN: actual SQLite typed references and indexed closed query plans. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';
import { artifactReferenceIndexes, createArtifactReferenceIndexes, persistedArtifactIsReferenced, persistedArtifactsReferenced, persistedArtifactReferenceSql, validateArtifactReferenceIndexes } from '../sdk/src/platform/knowledge/store-artifact-references.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-reference-index-')); roots.push(root); const path = join(root, 'knowledge.sqlite'), store = new SQLiteStore(path, { coordinated: true });
  await store.init(db => { db.run('CREATE TABLE knowledge_sources(id TEXT PRIMARY KEY, artifact_id TEXT)'); db.run('CREATE TABLE knowledge_extractions(id TEXT PRIMARY KEY, artifact_id TEXT)'); db.run('CREATE TABLE knowledge_edges(id TEXT PRIMARY KEY, from_kind TEXT NOT NULL,from_id TEXT NOT NULL,to_kind TEXT NOT NULL,to_id TEXT NOT NULL,relation TEXT NOT NULL)'); db.run('CREATE UNIQUE INDEX idx_knowledge_edges_unique ON knowledge_edges(from_kind,from_id,to_kind,to_id,relation)'); createArtifactReferenceIndexes(db); });
  return { root, path, store };
}
test('sources, extraction-only, outgoing artifact edges and incoming artifact edges each preserve a real typed reference', async () => {
  const f = await fixture(); try {
    const db = f.store.getDb(); db.run('INSERT INTO knowledge_sources VALUES(?,?)', ['source', 'source-artifact']); db.run('INSERT INTO knowledge_extractions VALUES(?,?)', ['extraction', 'extracted-artifact']);
    db.run('INSERT INTO knowledge_edges VALUES(?,?,?,?,?,?)', ['from-edge', 'artifact', 'outgoing-artifact', 'source', 'source', 'derived']); db.run('INSERT INTO knowledge_edges VALUES(?,?,?,?,?,?)', ['to-edge', 'source', 'source', 'artifact', 'incoming-artifact', 'derived']);
    for (const id of ['source-artifact', 'extracted-artifact', 'outgoing-artifact', 'incoming-artifact']) expect(persistedArtifactIsReferenced(db, id)).toBe(true);
    expect(persistedArtifactsReferenced(db, ['source-artifact', 'extracted-artifact', 'outgoing-artifact', 'incoming-artifact', 'unreferenced'])).toEqual(['source-artifact', 'extracted-artifact', 'outgoing-artifact', 'incoming-artifact']);
    expect(persistedArtifactIsReferenced(db, 'unreferenced')).toBe(false); expect(persistedArtifactIsReferenced(db, "id' OR 1=1 --")).toBe(false);
  } finally { f.store.close(); }
});
test('actual EXPLAIN uses partial source/extraction/artifact-target indexes and existing from-prefix index without full relation scans', async () => {
  const f = await fixture(); try {
    const db = f.store.getDb(), plans = db.exec(`EXPLAIN QUERY PLAN ${persistedArtifactReferenceSql}`, ['artifact', 'artifact', 'artifact', 'artifact']); const details = plans.flatMap(result => result.values.map(row => String(row[3])));
    for (const index of artifactReferenceIndexes) expect(details.some(detail => detail.includes(index.name))).toBe(true);
    expect(details.some(detail => detail.includes('idx_knowledge_edges_unique'))).toBe(true);
    for (const table of ['knowledge_sources', 'knowledge_extractions', 'knowledge_edges']) expect(details.some(detail => new RegExp(`\\bSCAN ${table}\\b`).test(detail))).toBe(false);
  } finally { f.store.close(); }
});
test('actual writer-locked reference inspection with changed:false leaves persisted SQLite bytes unchanged', async () => {
  const f = await fixture(); try {
    const before = readFileSync(f.path); const result = await f.store.transactPersisted(() => ({ changed: false, value: undefined }), () => { throw Error('Readonly lookup must not refresh or publish the DB'); }, (_value, db) => { expect(persistedArtifactIsReferenced(db, 'unreferenced')).toBe(false); });
    expect(result.kind).toBe('completed'); expect(readFileSync(f.path)).toEqual(before);
  } finally { f.store.close(); }
});
test('same-name indexes with different predicates cannot hide a full-scan/counterfeit plan', async () => {
  const f = await fixture(); try {
    const db = f.store.getDb(), index = artifactReferenceIndexes[0]!; db.run(`DROP INDEX ${index.name}`); db.run(`CREATE INDEX ${index.name} ON knowledge_sources(id)`);
    expect(() => validateArtifactReferenceIndexes(db)).toThrow('unsupported'); expect(() => createArtifactReferenceIndexes(db)).toThrow('unsupported');
  } finally { f.store.close(); }
});
