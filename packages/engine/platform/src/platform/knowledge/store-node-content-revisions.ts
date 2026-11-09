/** Durable content versions for activation subjects. Administrative activation
 * bookkeeping must not invalidate itself or another subject's interpretation. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import { KnowledgeRowRevisionError } from './store-row-revisions.js';

export const KNOWLEDGE_NODE_CONTENT_REVISION_COLUMN = 'gv_content_revision';
const meaningChanged = [
  'kind', 'slug', 'title', 'summary', 'aliases', 'confidence', 'source_id',
].map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')
  + " OR json_remove(OLD.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation') IS NOT json_remove(NEW.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation')";
const contentStampChanged = `(${meaningChanged}) OR OLD.gv_content_revision IS NOT NEW.gv_content_revision`;
export const knowledgeNodeContentRevisionTriggers = Object.freeze([
  Object.freeze(['knowledge_nodes_content_revision_insert', `CREATE TRIGGER knowledge_nodes_content_revision_insert AFTER INSERT ON knowledge_nodes BEGIN
    UPDATE knowledge_nodes SET gv_content_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END`] as const),
  Object.freeze(['knowledge_nodes_content_revision_update', `CREATE TRIGGER knowledge_nodes_content_revision_update AFTER UPDATE ON knowledge_nodes
  WHEN NEW.gv_content_revision = '' OR ${contentStampChanged} BEGIN
    UPDATE knowledge_nodes SET gv_content_revision = CASE WHEN ${contentStampChanged}
      THEN lower(hex(randomblob(16))) ELSE OLD.gv_revision END WHERE rowid = NEW.rowid;
  END`] as const),
]);

/** No existing row is rewritten. An old row's first administrative update
 * freezes its original writer version; a real content change receives a new
 * version. Thus migration preserves every existing gv_revision and record ID. */
export function createKnowledgeNodeContentRevisions(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  const columns = db.exec('PRAGMA table_info(knowledge_nodes)')[0]?.values;
  if (!columns?.length) throw new KnowledgeRowRevisionError();
  if (!columns.some(row => row[1] === KNOWLEDGE_NODE_CONTENT_REVISION_COLUMN)) {
    db.run("ALTER TABLE knowledge_nodes ADD COLUMN gv_content_revision TEXT NOT NULL DEFAULT ''");
  }
  const installed = db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_nodes_content_revision_insert','knowledge_nodes_content_revision_update')")[0]?.values ?? [];
  for (const [name, sql] of knowledgeNodeContentRevisionTriggers) {
    const existing = installed.find(row => row[0] === name);
    if (existing && existing[1] !== sql) throw new KnowledgeRowRevisionError();
    if (!existing) db.run(sql);
  }
  validateKnowledgeNodeContentRevisions(db);
}

export function validateKnowledgeNodeContentRevisions(db: Pick<SqlDatabase, 'exec'>): void {
  const column = db.exec('PRAGMA table_info(knowledge_nodes)')[0]?.values.find(row => row[1] === KNOWLEDGE_NODE_CONTENT_REVISION_COLUMN);
  if (!column || column[2] !== 'TEXT' || column[3] !== 1 || column[4] !== "''" || column[5] !== 0) throw new KnowledgeRowRevisionError();
  const installed = db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_nodes_content_revision_insert','knowledge_nodes_content_revision_update')")[0]?.values ?? [];
  if (installed.length !== knowledgeNodeContentRevisionTriggers.length
    || knowledgeNodeContentRevisionTriggers.some(([name, sql]) => installed.find(row => row[0] === name)?.[1] !== sql)) throw new KnowledgeRowRevisionError();
}

/** Kept native/private: consumers project structural labels, never SQL facts. */
export function knowledgeNodeContentGenerationFromRows(rows: ReturnType<SqlDatabase['exec']>): string | null {
  const row = rows[0], values = row?.values[0];
  if (!row || !values) return null;
  const content = values[row.columns.indexOf(KNOWLEDGE_NODE_CONTENT_REVISION_COLUMN)];
  const revision = content === '' ? values[row.columns.indexOf('gv_revision')] : content;
  if (typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) throw new KnowledgeRowRevisionError();
  return `kc-${revision}`;
}
