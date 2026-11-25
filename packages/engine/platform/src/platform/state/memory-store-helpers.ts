import type { MemoryBundle, MemoryClass, MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewState, MemoryScope, MemorySearchFilter } from './memory-store.js';

export const MEMORY_SCHEMA_VERSION = 2;

// The stamp changes at the actual SQL write, including updates that leave the
// timestamp unchanged. Stamp-only writes do not recursively fire the trigger.
const memoryRevisionTriggers = [
  `CREATE TRIGGER IF NOT EXISTS memory_record_revision_insert AFTER INSERT ON memory_records BEGIN
    UPDATE memory_records SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_record_revision_update AFTER UPDATE OF
    id, scope, cls, summary, detail, tags, provenance, review_state, confidence,
    reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
    ON memory_records BEGIN
    UPDATE memory_records SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END`,
] as const;

export function createSchema(db: { run(sql: string): void; exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> }): void {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL DEFAULT 'project',
      cls        TEXT NOT NULL,
      summary    TEXT NOT NULL,
      detail     TEXT,
      tags       TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_links (
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, relation),
      FOREIGN KEY(from_id) REFERENCES memory_records(id) ON DELETE CASCADE,
      FOREIGN KEY(to_id) REFERENCES memory_records(id) ON DELETE CASCADE
    )
  `);

  ensureColumn(db, 'memory_records', 'scope TEXT NOT NULL DEFAULT \'project\'', 'scope');
  ensureColumn(db, 'memory_records', 'review_state TEXT NOT NULL DEFAULT \'fresh\'', 'review_state');
  ensureColumn(db, 'memory_records', 'confidence INTEGER NOT NULL DEFAULT 60', 'confidence');
  ensureColumn(db, 'memory_records', 'reviewed_at INTEGER', 'reviewed_at');
  ensureColumn(db, 'memory_records', 'reviewed_by TEXT', 'reviewed_by');
  ensureColumn(db, 'memory_records', 'stale_reason TEXT', 'stale_reason');
  ensureColumn(db, 'memory_records', 'valid_from INTEGER', 'valid_from');
  ensureColumn(db, 'memory_records', 'valid_until INTEGER', 'valid_until');
  ensureColumn(db, 'memory_records', "gv_revision TEXT NOT NULL DEFAULT ''", 'gv_revision');
  // Usage counters live on the record: removed with it, updated in place, and
  // outside the revision trigger's column list, so a count never looks like an edit.
  ensureColumn(db, 'memory_records', 'injected_count INTEGER NOT NULL DEFAULT 0', 'injected_count');
  ensureColumn(db, 'memory_records', 'assessed_count INTEGER NOT NULL DEFAULT 0', 'assessed_count');
  ensureColumn(db, 'memory_records', 'referenced_count INTEGER NOT NULL DEFAULT 0', 'referenced_count');
  ensureColumn(db, 'memory_records', 'last_injected_at INTEGER', 'last_injected_at');
  ensureColumn(db, 'memory_records', 'last_referenced_at INTEGER', 'last_referenced_at');
  // The project a "this project" record was saved for (memory-project.ts); NULL is the person's own, given
  // everywhere. Outside the revision trigger's column list (its SQL is checked as written), so a write that sets it
  // stamps the revision itself. A 3.5.0 reader names its columns and does not read it.
  ensureColumn(db, 'memory_records', 'project TEXT', 'project');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_records(project)');

  // Small store-owned facts (the consolidation cursor) and the standing
  // consolidation proposals, one row each, keyed by kind and record ids.
  db.run(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_proposals (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      ids        TEXT NOT NULL,
      route      TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  const revisions = db.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('memory_record_revision_insert', 'memory_record_revision_update')")[0]?.values ?? [];
  if (revisions.length === 0) {
    // Backfill once during migration. Reopening a current store keeps its stamps.
    db.run('UPDATE memory_records SET gv_revision = lower(hex(randomblob(16)))');
    for (const sql of memoryRevisionTriggers) db.run(sql);
  }
  validateMemoryRowRevisions(db);

  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_cls ON memory_records(cls)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_records(created_at)`);
}

/** Check the native writer metadata before using a persisted cache revision. */
export function validateMemoryRowRevisions(db: { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }> }): void {
  const columns = db.exec('PRAGMA table_info(memory_records)')[0]?.values ?? [];
  const revision = columns.find(row => row[1] === 'gv_revision');
  const triggers = db.exec("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('memory_record_revision_insert', 'memory_record_revision_update')")[0]?.values ?? [];
  if (!revision || revision[2] !== 'TEXT' || revision[3] !== 1 || revision[4] !== "''"
    || triggers.length !== memoryRevisionTriggers.length
    || memoryRevisionTriggers.some(sql => !triggers.some(row => row[0] === sql.replace('IF NOT EXISTS ', '')))) {
    throw new Error('Memory native row revision schema is unavailable or invalid');
  }
}

export function ensureColumn(
  db: { run(sql: string): void; exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> },
  table: string,
  columnSql: string,
  columnName: string,
): void {
  const rows = db.exec(`PRAGMA table_info(${table})`);
  const existing = new Set<string>();
  if (rows[0]!) {
    const nameIndex = rows[0]?.columns.indexOf('name') ?? -1;
    for (const value of (rows[0]?.values ?? [])) {
      if (nameIndex >= 0) {
        existing.add(String(value[nameIndex]));
      }
    }
  }
  if (!existing.has(columnName)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  }
}

export function rowToRecord(columns: string[], values: unknown[]): MemoryRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]!])) as Record<string, unknown>;
  const id = requireMemoryString(row.id, 'id');
  const cls = requireMemoryString(row.cls, 'cls') as MemoryRecord['cls'];
  const summary = requireMemoryString(row.summary, 'summary');
  const createdAt = requireMemoryTimestamp(row.created_at, 'created_at');
  const updatedAt = requireMemoryTimestamp(row.updated_at, 'updated_at');
  return {
    id,
    scope: normalizePersistedScope(row.scope),
    ...(typeof row.project === 'string' && row.project ? { project: row.project } : {}),
    cls,
    summary,
    ...(typeof row.detail === 'string' && row.detail.trim() ? { detail: row.detail.trim() } : {}),
    tags: parseMemoryJsonField<string[]>(row.tags, 'tags'),
    provenance: parseMemoryJsonField<Array<MemoryRecord['provenance'][number]>>(row.provenance, 'provenance'),
    reviewState: normalizePersistedReviewState(row.review_state),
    confidence: requirePersistedConfidence(row.confidence),
    ...(row.reviewed_at !== null && row.reviewed_at !== undefined ? { reviewedAt: requireMemoryTimestamp(row.reviewed_at, 'reviewed_at') } : {}),
    ...(typeof row.reviewed_by === 'string' && row.reviewed_by.trim() ? { reviewedBy: row.reviewed_by.trim() } : {}),
    ...(typeof row.stale_reason === 'string' && row.stale_reason.trim() ? { staleReason: row.stale_reason.trim() } : {}),
    createdAt,
    updatedAt,
    ...(row.valid_from !== null && row.valid_from !== undefined ? { validFrom: requireMemoryTimestamp(row.valid_from, 'valid_from') } : {}),
    ...(row.valid_until !== null && row.valid_until !== undefined ? { validUntil: requireMemoryTimestamp(row.valid_until, 'valid_until') } : {}),
  };
}

function throwInvalidMemoryRow(fieldName: string, reason: string): never {
  throw new Error(`Memory record field '${fieldName}' is invalid: ${reason}`);
}

function requireMemoryString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throwInvalidMemoryRow(fieldName, 'expected a non-empty string');
  }
  return value;
}

function requireMemoryTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwInvalidMemoryRow(fieldName, 'expected a finite timestamp number');
  }
  return value;
}

function normalizePersistedScope(value: unknown): MemoryScope {
  if (value === 'session' || value === 'project' || value === 'team') return value;
  throwInvalidMemoryRow('scope', 'expected session, project, or team');
}

function normalizePersistedReviewState(value: unknown): MemoryReviewState {
  if (value === 'fresh' || value === 'reviewed' || value === 'stale' || value === 'contradicted') return value;
  throwInvalidMemoryRow('review_state', 'expected fresh, reviewed, stale, or contradicted');
}

function requirePersistedConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throwInvalidMemoryRow('confidence', 'expected a finite number from 0 to 100');
  }
  return Math.round(value);
}

export function normalizeReviewState(value: unknown): MemoryReviewState {
  return value === 'reviewed' || value === 'stale' || value === 'contradicted' ? value : 'fresh';
}

export function normalizeScope(value: unknown): MemoryScope {
  return value === 'session' || value === 'team' ? value : 'project';
}

export function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 60;
}

const MEMORY_CLASSES: ReadonlySet<string> = new Set<MemoryClass>(['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership']);
const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>(['session', 'project', 'team']);
const PROVENANCE_KINDS: ReadonlySet<string> = new Set(['session', 'turn', 'task', 'event', 'file']);

/** Most records and links one imported bundle may carry. */
export const MAX_MEMORY_BUNDLE_RECORDS = 10_000;
export const MAX_MEMORY_BUNDLE_LINKS = 50_000;
const MAX_SUMMARY_CHARS = 20_000;
const MAX_DETAIL_CHARS = 1_000_000;
const MAX_TAGS = 200;
const MAX_TAG_CHARS = 500;
const MAX_PROVENANCE_LINKS = 500;
const MAX_REF_CHARS = 2_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The same shape rules the read path enforces (rowToRecord), applied before a
 * write: a value the store would refuse to read back is refused when it is
 * written, naming the field, so one bad row never makes every later read fail.
 * Only the fields present are checked; `summary` and `cls` are required by the
 * callers that create a record.
 */
export function assertValidMemoryFields(fields: {
  readonly scope?: unknown;
  readonly cls?: unknown;
  readonly summary?: unknown;
  readonly detail?: unknown;
  readonly tags?: unknown;
  readonly provenance?: unknown;
}, label = 'memory record'): void {
  const bad = (field: string, expected: string): never => {
    // The caller's value is the fault, so a route relaying this answers 400, not a server error.
    throw Object.assign(new Error(`Invalid ${label}: '${field}' must be ${expected}. Nothing was stored.`), { status: 400 });
  };
  if (fields.scope !== undefined && !MEMORY_SCOPES.has(String(fields.scope))) bad('scope', 'one of session, project, team');
  if (fields.cls !== undefined && !MEMORY_CLASSES.has(String(fields.cls))) bad('cls', `one of ${[...MEMORY_CLASSES].join(', ')}`);
  if (fields.summary !== undefined) {
    if (typeof fields.summary !== 'string' || !fields.summary.trim()) bad('summary', 'a non-empty string');
    else if (fields.summary.length > MAX_SUMMARY_CHARS) bad('summary', `at most ${MAX_SUMMARY_CHARS} characters`);
  }
  if (fields.detail !== undefined && fields.detail !== null) {
    if (typeof fields.detail !== 'string') bad('detail', 'a string');
    else if (fields.detail.length > MAX_DETAIL_CHARS) bad('detail', `at most ${MAX_DETAIL_CHARS} characters`);
  }
  if (fields.tags !== undefined) {
    if (!Array.isArray(fields.tags) || fields.tags.length > MAX_TAGS
      || !fields.tags.every((tag) => typeof tag === 'string' && tag.length <= MAX_TAG_CHARS)) {
      bad('tags', `an array of at most ${MAX_TAGS} strings of at most ${MAX_TAG_CHARS} characters`);
    }
  }
  if (fields.provenance !== undefined) {
    const provenance = fields.provenance;
    if (!Array.isArray(provenance) || provenance.length > MAX_PROVENANCE_LINKS
      || !provenance.every((link) => isPlainObject(link) && PROVENANCE_KINDS.has(String(link.kind))
        && typeof link.ref === 'string' && link.ref.length <= MAX_REF_CHARS
        && (link.label === undefined || typeof link.label === 'string'))) {
      bad('provenance', `an array of at most ${MAX_PROVENANCE_LINKS} {kind, ref} links (kind: ${[...PROVENANCE_KINDS].join(', ')})`);
    }
  }
}

function assertFiniteNumber(value: unknown, field: string, label: string, optional: boolean): void {
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Object.assign(new Error(`Invalid ${label}: '${field}' must be a finite number. Nothing was imported.`), { status: 400 });
  }
}

/**
 * Check a whole bundle before any row is written: shape, field sizes and the
 * record and link counts. Throws naming the first bad record or link, so a
 * truncated, edited or foreign file imports nothing instead of part of itself.
 */
export function assertValidMemoryBundle(bundle: unknown): asserts bundle is MemoryBundle {
  if (!isPlainObject(bundle) || !Array.isArray(bundle.records) || !Array.isArray(bundle.links)) {
    throw Object.assign(new Error("Invalid memory bundle: expected an object with 'records' and 'links' arrays. Nothing was imported."), { status: 400 });
  }
  if (bundle.records.length > MAX_MEMORY_BUNDLE_RECORDS) {
    throw Object.assign(new Error(`Invalid memory bundle: ${bundle.records.length} records exceeds the limit of ${MAX_MEMORY_BUNDLE_RECORDS}. Nothing was imported.`), { status: 400 });
  }
  if (bundle.links.length > MAX_MEMORY_BUNDLE_LINKS) {
    throw Object.assign(new Error(`Invalid memory bundle: ${bundle.links.length} links exceeds the limit of ${MAX_MEMORY_BUNDLE_LINKS}. Nothing was imported.`), { status: 400 });
  }
  bundle.records.forEach((record: unknown, index) => {
    const label = `memory bundle record #${index + 1}`;
    if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id.trim()) {
      throw Object.assign(new Error(`Invalid ${label}: 'id' must be a non-empty string. Nothing was imported.`), { status: 400 });
    }
    // An imported scope that is not one of ours is normalised to project, as before.
    assertValidMemoryFields({
      cls: record.cls ?? '',
      summary: record.summary ?? '',
      detail: record.detail,
      tags: record.tags ?? [],
      provenance: record.provenance ?? [],
    }, `${label} (${record.id})`);
    assertFiniteNumber(record.createdAt, 'createdAt', label, false);
    assertFiniteNumber(record.updatedAt, 'updatedAt', label, false);
    assertFiniteNumber(record.confidence, 'confidence', label, true);
    assertFiniteNumber(record.reviewedAt, 'reviewedAt', label, true);
    assertFiniteNumber(record.validFrom, 'validFrom', label, true);
    assertFiniteNumber(record.validUntil, 'validUntil', label, true);
  });
  bundle.links.forEach((link: unknown, index) => {
    const label = `memory bundle link #${index + 1}`;
    if (!isPlainObject(link) || typeof link.fromId !== 'string' || typeof link.toId !== 'string'
      || typeof link.relation !== 'string' || !link.relation.trim() || link.relation.length > MAX_TAG_CHARS) {
      throw Object.assign(new Error(`Invalid ${label}: 'fromId', 'toId' and 'relation' must be strings. Nothing was imported.`), { status: 400 });
    }
    assertFiniteNumber(link.createdAt, 'createdAt', label, false);
  });
}

export function isReviewFlagged(record: MemoryRecord): boolean {
  return record.reviewState === 'stale' || record.reviewState === 'contradicted';
}

/**
 * Retrieval order when there is no query to rank against: records not flagged
 * for review first, then higher confidence, then most recently updated. A
 * structural order over stored fields; relevance to a query is the
 * `engine.state.memory-search` rerank's job (memory-store.ts).
 */
export function compareByTrust(a: MemoryRecord, b: MemoryRecord): number {
  return Number(isReviewFlagged(a)) - Number(isReviewFlagged(b))
    || b.confidence - a.confidence
    || b.updatedAt - a.updatedAt
    || b.createdAt - a.createdAt;
}

export function recordMatchesPostSqlFilter(record: MemoryRecord, filter: MemorySearchFilter): boolean {
  if (filter.scope && record.scope !== filter.scope) return false;
  // Another project's record never answers this project's search.
  if (filter.project !== undefined && record.project !== undefined && record.project !== filter.project) return false;
  if (filter.cls && record.cls !== filter.cls) return false;
  // Same rules as the literal path's SQL: `since` is creation time, and every tag must be present.
  if (filter.since && record.createdAt < filter.since) return false;
  if (filter.tags?.length && !filter.tags.every((tag) => record.tags.includes(tag))) return false;
  if (filter.provenanceKinds?.length) {
    if (!record.provenance.some((entry) => filter.provenanceKinds?.includes(entry.kind))) return false;
  }
  if (filter.reviewState) {
    const states = Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState];
    if (!states.includes(record.reviewState)) return false;
  }
  if (filter.staleOnly && !isReviewFlagged(record)) return false;
  // The vector table's confidence and review state are copies taken when the row
  // was embedded: the live row decides, as the literal path's SQL does.
  if (filter.minConfidence !== undefined && record.confidence < filter.minConfidence) return false;
  if (!filter.staleOnly && record.reviewState === 'contradicted') {
    const states = filter.reviewState ? (Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState]) : [];
    if (!states.includes('contradicted')) return false;
  }
  return true;
}

export function parseMemoryJsonField<T>(raw: unknown, fieldName: string): T {
  if (typeof raw !== 'string') {
    throwInvalidMemoryRow(fieldName, 'expected JSON text');
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throwInvalidMemoryRow(fieldName, `invalid JSON: ${message}`);
  }
}

export function memoryLink(fromId: string, toId: string, relation: string, createdAt: number): MemoryLink {
  return { fromId, toId, relation, createdAt };
}

export function memoryDoctorReport(vector: MemoryDoctorReport['vector'], embeddings: MemoryDoctorReport['embeddings'], checkedAt: number): MemoryDoctorReport {
  return { vector, embeddings, checkedAt };
}
