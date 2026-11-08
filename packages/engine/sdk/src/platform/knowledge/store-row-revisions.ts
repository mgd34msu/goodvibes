import type { SqlDatabase } from '../state/sqlite-store.js';
import { knowledgeEdgeChangeTriggers } from './store-schema-validation-data.js';

export const KNOWLEDGE_ROW_REVISION_COLUMN = 'gv_revision';
export const knowledgeRevisionTables = Object.freeze(['knowledge_sources', 'knowledge_nodes', 'knowledge_extractions', 'knowledge_edges'] as const);
export const knowledgeRowRevisionTriggers = Object.freeze(knowledgeRevisionTables.flatMap(table => ['insert', 'update'].map(event => Object.freeze([
  `${table}_revision_${event}`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_revision_${event} AFTER ${event.toUpperCase()} ON ${table} BEGIN
    UPDATE ${table} SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END`,
] as const))));

export class KnowledgeRowRevisionError extends Error {
  constructor() { super('Knowledge native row revision is unavailable or invalid'); this.name = 'KnowledgeRowRevisionError'; }
}

const installedSql = (sql: string): string => sql.replace('IF NOT EXISTS ', '');
const oldEdgeUpdate = `CREATE TRIGGER knowledge_edge_change_update AFTER UPDATE ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END`;

/** Native write metadata is issued by SQLite, never accepted from a producer DTO.
 * Existing rows get one revision during the versioned migration; reopening does
 * not rotate them. Internal stamp updates do not recursively stamp themselves.
 */
export function createKnowledgeRowRevisions(db: Pick<SqlDatabase, 'run' | 'exec'>): void {
  db.run('PRAGMA recursive_triggers = OFF');
  const edgeUpdate = db.exec("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='knowledge_edge_change_update'")[0]?.values[0]?.[0];
  if (edgeUpdate === oldEdgeUpdate) {
    db.run('DROP TRIGGER knowledge_edge_change_update');
    const replacement = knowledgeEdgeChangeTriggers.find(([name]) => name === 'knowledge_edge_change_update');
    if (!replacement) throw new KnowledgeRowRevisionError();
    db.run(replacement[1]);
  }
  for (const table of knowledgeRevisionTables) {
    const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values;
    if (!columns?.length) throw new KnowledgeRowRevisionError();
    const column = columns.find(value => value[1] === KNOWLEDGE_ROW_REVISION_COLUMN);
    if (column && (column[2] !== 'TEXT' || column[3] !== 1 || column[4] !== "''" || column[5] !== 0)) throw new KnowledgeRowRevisionError();
    if (!column) db.run(`ALTER TABLE ${table} ADD COLUMN gv_revision TEXT NOT NULL DEFAULT ''`);
    const triggers = knowledgeRowRevisionTriggers.filter(([name]) => name.startsWith(`${table}_revision_`));
    const installed = db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?", [table])[0]?.values ?? [];
    const existing = installed.filter(row => triggers.some(([name]) => row[0] === name));
    if (existing.length && (existing.length !== triggers.length || triggers.some(([name, sql]) => existing.find(row => row[0] === name)?.[1] !== installedSql(sql)))) {
      throw new KnowledgeRowRevisionError();
    }
    if (!existing.length) {
      // Ignore any purported revision supplied by an older/non-native row.
      db.run(`UPDATE ${table} SET gv_revision = lower(hex(randomblob(16)))`);
      for (const [, sql] of triggers) db.run(sql);
    }
  }
}

/** Bounded schema facts only; a read validates its selected revision separately. */
export function validateKnowledgeRowRevisions(db: Pick<SqlDatabase, 'exec'>): void {
  const tables = knowledgeRevisionTables.map(table => `'${table}'`).join(',');
  const triggers = knowledgeRowRevisionTriggers.map(([name]) => `'${name}'`).join(',');
  const results = db.exec([
    'PRAGMA recursive_triggers',
    ...knowledgeRevisionTables.map(table => `PRAGMA table_info(${table})`),
    `SELECT name,type FROM sqlite_master WHERE name IN (${tables})`,
    `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${triggers})`,
  ].join(';'));
  // Missing statement results cannot shift another table into its ordinal.
  if (results.length !== knowledgeRevisionTables.length + 3 || results[0]?.values[0]?.[0] !== 0) throw new KnowledgeRowRevisionError();
  const kinds = results[knowledgeRevisionTables.length + 1]?.values ?? [];
  for (const [index, table] of knowledgeRevisionTables.entries()) {
    const column = results[index + 1]?.values.find(row => row[1] === KNOWLEDGE_ROW_REVISION_COLUMN);
    if (kinds.find(row => row[0] === table)?.[1] !== 'table' || !column || column[2] !== 'TEXT'
      || column[3] !== 1 || column[4] !== "''" || column[5] !== 0) throw new KnowledgeRowRevisionError();
  }
  const installed = results[knowledgeRevisionTables.length + 2]?.values ?? [];
  for (const [name, sql] of knowledgeRowRevisionTriggers) {
    if (installed.find(row => row[0] === name)?.[1] !== installedSql(sql)) throw new KnowledgeRowRevisionError();
  }
}

/** Opaque writer revision; no record text or complete-row serialization. */
export function knowledgeRowGenerationFromRows(rows: ReturnType<SqlDatabase['exec']>): string | null {
  const row = rows[0], values = row?.values[0];
  if (!row || !values) return null;
  const index = row.columns.indexOf(KNOWLEDGE_ROW_REVISION_COLUMN);
  const revision = values[index];
  if (index < 0 || typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) throw new KnowledgeRowRevisionError();
  return `kr-${revision}`;
}

/** Native SQL bookkeeping is not evidence sent for semantic interpretation. */
export function knowledgeRawRowForAdmission(raw: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const result = { ...raw };
  delete result[KNOWLEDGE_ROW_REVISION_COLUMN];
  return result;
}
