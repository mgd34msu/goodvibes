import { createRequire } from 'node:module';
import type { Database } from 'bun:sqlite';

/**
 * bun:sqlite is a Bun-only builtin, and a static import of it makes the whole
 * package root unloadable under Node, whose ESM loader rejects the `bun:`
 * scheme at link time. Engine code that runs under Node imports this root for
 * batteries and patterns, so the constructor is resolved only when a log is
 * opened, which stays a Bun-only path.
 */
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database {
  return (databaseCtor ??= (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database);
}

/*
 * The decision log's storage layout: decision rows, append-only notes, and opening
 * a log file with the schema this build writes.
 */

/** The immutable call records; post-call notes live in their own table. */
export const TABLE = 'decisions';

/**
 * Bumped whenever the table shape changes. A file at a version listed in
 * MIGRATIONS is brought forward in place; any other version is refused rather
 * than misread.
 */
const SCHEMA_VERSION = 4;
export const NOTES_TABLE = 'decision_notes';

const NOTES_SCHEMA = `
CREATE TABLE ${NOTES_TABLE} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES ${TABLE}(id),
  kind TEXT NOT NULL CHECK (kind IN ('readings', 'action', 'truth')),
  payload TEXT NOT NULL,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ${NOTES_TABLE}_decision_seq ON ${NOTES_TABLE} (decision_id, seq);
`;

/**
 * What a column holds. Every column is text: the row's key, a value the log
 * writes (always, or only once a note attaches), or a field SQLite derives
 * from the stored entry so queries can filter and index on it.
 */
type ColumnRole =
  | { readonly kind: 'key' }
  | { readonly kind: 'written'; readonly always: boolean }
  | { readonly kind: 'derived'; readonly entryField: readonly string[] };

const KEY: ColumnRole = { kind: 'key' };
const written = (always: boolean): ColumnRole => ({ kind: 'written', always });
const derived = (...entryField: string[]): ColumnRole => ({ kind: 'derived', entryField });

/** How each role is declared in CREATE TABLE. */
function declaration(role: ColumnRole): string {
  if (role.kind === 'key') return 'TEXT PRIMARY KEY';
  if (role.kind === 'written') return role.always ? 'TEXT NOT NULL' : 'TEXT';
  return `TEXT GENERATED ALWAYS AS (json_extract(entry, '$.${role.entryField.join('.')}')) VIRTUAL`;
}

/** Each row holds the whole entry as JSON; the fields queries filter on are derived from it, and notes attach in columns named for their kind. */
export const COLUMNS = {
  id: KEY,
  entry: written(true),
  at: derived('at'),
  status: derived('status'),
  battery: derived('context', 'battery'),
  site: derived('context', 'site'),
  readings: written(false),
  action: written(false),
  truth: written(false),
} as const satisfies Readonly<Record<string, ColumnRole>>;

/**
 * Additive steps from an older version to the next: version 2 had no truth
 * column, and every existing row simply has no truth recorded yet.
 */
const MIGRATIONS: Readonly<Record<number, string>> = {
  2: `ALTER TABLE ${TABLE} ADD COLUMN truth ${declaration(COLUMNS.truth)};`,
  // Older files retain only the last note of each kind. Preserve those values;
  // their original cross-kind order and any overwritten history are unknowable.
  3: NOTES_SCHEMA + ['readings', 'action', 'truth'].map(kind =>
    `INSERT INTO ${NOTES_TABLE} (decision_id, kind, payload, at)
     SELECT id, '${kind}', ${kind}, NULL FROM ${TABLE} WHERE status = 'answered' AND ${kind} IS NOT NULL;`).join('\n'),
};

const SCHEMA = `
CREATE TABLE ${TABLE} (
${Object.entries(COLUMNS).map(([column, role]) => `  ${column} ${declaration(role)}`).join(',\n')}
);
CREATE INDEX ${TABLE}_battery_at ON ${TABLE} (battery, at);
CREATE INDEX ${TABLE}_site_at ON ${TABLE} (site, at);
CREATE INDEX ${TABLE}_at ON ${TABLE} (at);
${NOTES_SCHEMA}
`;

/** A value bound into a statement. */
type SqlValue = string | number | null;
/** Statement parameters by name. */
export type Params = Readonly<Record<string, SqlValue>>;

/** Every row one statement yields. */
export const rowsOf = <T>(db: Database, sql: string, params: Params = {}): T[] => db.query(sql).all(params) as T[];

/** Opens the log file. A file with no tables yet is new and gets the schema; any other file must carry this schema version. */
export function openLog(path: string): Database {
  const Ctor = bunDatabase();
  const db = new Ctor(path, { create: true, strict: true });
  // The daemon and TUI share the project log. Brief concurrent writes must
  // wait for one another instead of discarding an otherwise valid judgment.
  try {
    db.exec('PRAGMA busy_timeout = 1000;');
    try { db.exec('PRAGMA journal_mode = WAL;'); }
    catch (error) {
      // Journal-mode changes can bypass SQLite's busy handler during a
      // simultaneous first open. Rollback journaling remains safe; the
      // immediate schema transaction below still waits for the writer.
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
    }
    db.transaction(() => {
      // Inspect only after acquiring the writer lock: another process may
      // have initialized or migrated this database while we were waiting.
      if (rowsOf(db, 'SELECT 1 FROM sqlite_master').length === 0) {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
        return;
      }
      let [{ user_version: version }] = rowsOf<{ user_version: number }>(db, 'PRAGMA user_version') as [{ user_version: number }];
      while (version !== SCHEMA_VERSION && MIGRATIONS[version] !== undefined) {
        db.exec(MIGRATIONS[version]!);
        db.exec(`PRAGMA user_version = ${++version};`);
      }
      if (version !== SCHEMA_VERSION) {
        throw new RangeError(`decision log ${path} has schema version ${version}; this build writes version ${SCHEMA_VERSION}`);
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
