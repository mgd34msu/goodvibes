/** Actual typed artifact relations, read only from a fresh owned SQLite image.
 * These selectors do not interpret arbitrary JSON metadata as a reference.
 */
import type { SqlDatabase } from '../state/sqlite-store.js';
import { KNOWLEDGE_SCHEMA_VERSION } from './store-schema-version.js';
export const artifactReferenceIndexes = Object.freeze([
  Object.freeze({ name: 'idx_knowledge_sources_artifact_reference', sql: 'CREATE INDEX idx_knowledge_sources_artifact_reference ON knowledge_sources(artifact_id) WHERE artifact_id IS NOT NULL' }),
  Object.freeze({ name: 'idx_knowledge_extractions_artifact_reference', sql: 'CREATE INDEX idx_knowledge_extractions_artifact_reference ON knowledge_extractions(artifact_id) WHERE artifact_id IS NOT NULL' }),
  Object.freeze({ name: 'idx_knowledge_edges_artifact_target_reference', sql: "CREATE INDEX idx_knowledge_edges_artifact_target_reference ON knowledge_edges(to_id) WHERE to_kind = 'artifact'" }),
]);
export const persistedArtifactReferenceSql = `SELECT
  EXISTS(SELECT 1 FROM knowledge_sources WHERE artifact_id = ?)
  OR EXISTS(SELECT 1 FROM knowledge_extractions WHERE artifact_id = ?)
  OR EXISTS(SELECT 1 FROM knowledge_edges WHERE from_kind = 'artifact' AND from_id = ?)
  OR EXISTS(SELECT 1 FROM knowledge_edges WHERE to_kind = 'artifact' AND to_id = ?) AS referenced`;
export function persistedArtifactIsReferenced(db: Pick<SqlDatabase, 'exec'>, id: string): boolean {
  if (!id || typeof id !== 'string') throw new Error('Artifact reference selector is unavailable.');
  const value = db.exec(persistedArtifactReferenceSql, [id, id, id, id])[0]?.values[0]?.[0];
  if (value !== 0 && value !== 1) throw new Error('Artifact reference observation is unavailable.'); return value === 1;
}
export function createArtifactReferenceIndexes(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const index of artifactReferenceIndexes) {
    const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name=?', [index.name])[0]?.values[0];
    if (!row) db.run(index.sql); else if (row[0] !== 'index' || row[1] !== index.sql) throw new Error('Knowledge artifact reference index is unsupported.');
  }
  validateArtifactReferenceIndexes(db);
}
export function validateArtifactReferenceIndexes(db: Pick<SqlDatabase, 'exec'>): void {
  for (const index of artifactReferenceIndexes) {
    const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name=?', [index.name])[0]?.values[0];
    if (!row || row[0] !== 'index' || row[1] !== index.sql) throw new Error('Knowledge artifact reference index is unsupported.');
  }
}

/** Closed compatibility reader for inactive known knowledge files. It never
 * repairs a schema or treats an unfamiliar database as an empty reference set.
 * Older supported layouts may lack today's performance indexes; their typed
 * source/extraction/edge relations retain the same meaning.
 */
export function inspectPersistedArtifactReferences(db: Pick<SqlDatabase, 'exec'>, ids: readonly string[]): readonly string[] {
  const version = db.exec('PRAGMA user_version')[0]?.values[0]?.[0];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > KNOWLEDGE_SCHEMA_VERSION) throw new Error('Knowledge artifact reference layout is unsupported.');
  const relations = [
    ['knowledge_sources', ['id', 'artifact_id']],
    ['knowledge_extractions', ['id', 'artifact_id']],
    ['knowledge_edges', ['from_kind', 'from_id', 'to_kind', 'to_id']],
  ] as const;
  for (const [table, columns] of relations) {
    const rows = db.exec('SELECT type FROM sqlite_master WHERE name=?', [table])[0]?.values ?? [];
    if (rows.length !== 1 || rows[0]?.[0] !== 'table') throw new Error('Knowledge artifact reference layout is unsupported.');
    const actual = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
    if (!columns.every(name => actual.some(row => row[1] === name && String(row[2]).toUpperCase() === 'TEXT'))) throw new Error('Knowledge artifact reference layout is unsupported.');
  }
  if (version === KNOWLEDGE_SCHEMA_VERSION) validateArtifactReferenceIndexes(db);
  return persistedArtifactsReferenced(db, ids);
}

/** One bounded indexed relation read per original database image, not one image
 * parse per artifact. IDs are parameters; no caller SQL or raw row escapes. */
export function persistedArtifactsReferenced(db: Pick<SqlDatabase, 'exec'>, ids: readonly string[]): readonly string[] {
  if (ids.length === 0 || ids.length > 64 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Artifact reference batch is unavailable.');
  const slots = ids.map(() => '?').join(',');
  const sql = `SELECT artifact_id FROM knowledge_sources WHERE artifact_id IN (${slots})
    UNION SELECT artifact_id FROM knowledge_extractions WHERE artifact_id IN (${slots})
    UNION SELECT from_id FROM knowledge_edges WHERE from_kind = 'artifact' AND from_id IN (${slots})
    UNION SELECT to_id FROM knowledge_edges WHERE to_kind = 'artifact' AND to_id IN (${slots})`;
  const found = new Set<string>();
  for (const row of db.exec(sql, [...ids, ...ids, ...ids, ...ids])[0]?.values ?? []) {
    const id = row[0]; if (typeof id !== 'string' || !ids.includes(id)) throw new Error('Artifact reference result is unavailable.'); found.add(id);
  }
  return Object.freeze(ids.filter(id => found.has(id)));
}
