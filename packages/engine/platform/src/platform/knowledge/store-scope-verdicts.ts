import type { SqlDatabase } from '../state/sqlite-store.js';

/**
 * Whether a default-space record belongs in the ordinary knowledge view, as read
 * once from its content. `version` is the content version the reading was taken
 * from; a record whose content moved on has no current reading until it is read
 * again. `included: null` is a reading that could not settle: the record is shown.
 */
export interface KnowledgeScopeVerdict {
  readonly key: string;
  readonly version: string;
  readonly included: boolean | null;
  readonly decidedAt: number;
}

const TABLE = 'knowledge_scope_verdicts';

/**
 * Additive table beside the record tables; nothing else reads it, so an older
 * build that opens the file ignores it. Returns true when it was created.
 */
export function ensureKnowledgeScopeVerdictTable(db: Pick<SqlDatabase, 'run' | 'exec'>): boolean {
  if (db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${TABLE}'`)[0]?.values.length) return false;
  db.run(`CREATE TABLE ${TABLE} (
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    content_version TEXT NOT NULL,
    included INTEGER,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (record_kind, record_id)
  )`);
  return true;
}

export function splitScopeVerdictKey(key: string): readonly [string, string] {
  const index = key.indexOf(':');
  return index < 0 ? ['', key] : [key.slice(0, index), key.slice(index + 1)];
}

/** One stored reading, decoded from its row (the store reads them through SQL, store-table-specs.ts). */
export function mapScopeVerdictRow(columns: string[], values: unknown[]): KnowledgeScopeVerdict {
  const at = (name: string): unknown => values[columns.indexOf(name)];
  const included = at('included');
  return {
    key: `${String(at('record_kind'))}:${String(at('record_id'))}`,
    version: String(at('content_version')),
    included: included === null || included === undefined ? null : Number(included) === 1,
    decidedAt: Number(at('decided_at')) || 0,
  };
}

export function writeKnowledgeScopeVerdict(db: Pick<SqlDatabase, 'run'>, verdict: KnowledgeScopeVerdict): void {
  const [kind, id] = splitScopeVerdictKey(verdict.key);
  db.run(`INSERT OR REPLACE INTO ${TABLE} (record_kind, record_id, content_version, included, decided_at) VALUES (?, ?, ?, ?, ?)`,
    [kind, id, verdict.version, verdict.included === null ? null : verdict.included ? 1 : 0, verdict.decidedAt]);
}

/** Readings of records that no longer exist; removed at open. Returns the number removed. */
export function pruneOrphanScopeVerdicts(db: Pick<SqlDatabase, 'run' | 'exec'>): number {
  const orphan = `(record_kind = 'source' AND record_id NOT IN (SELECT id FROM knowledge_sources))
    OR (record_kind = 'node' AND record_id NOT IN (SELECT id FROM knowledge_nodes))
    OR (record_kind = 'issue' AND record_id NOT IN (SELECT id FROM knowledge_issues))`;
  const count = Number(db.exec(`SELECT COUNT(*) FROM ${TABLE} WHERE ${orphan}`)[0]?.values[0]?.[0] ?? 0);
  if (count === 0) return 0;
  db.run(`DELETE FROM ${TABLE} WHERE ${orphan}`);
  return count;
}
