/**
 * Row store: one real SQLite file per store, opened once, with one writer
 * transaction per change.
 *
 * Use it for rows that are queried or shared by processes (knowledge, memory,
 * pairing tokens, workspace trust, the work ledger). The database is the truth:
 * no copy of its rows is kept beside it, and another process's commit is seen
 * through `revision()`, which reads SQLite's own change counters.
 *
 * Opening a file:
 * - WAL journal and `synchronous = NORMAL`: readers never wait for the writer,
 *   and a commit is one append to the WAL. A filesystem that cannot hold a WAL
 *   keeps the rollback journal; nothing else changes.
 * - `busy_timeout`: a second process's brief write is waited for, not failed.
 * - Schema: `PRAGMA user_version` is read once. When it is behind, one
 *   consistent copy of the file is taken (`VACUUM INTO`, under
 *   `snapshots/<file>/` beside it, the place the restore command reads), then
 *   every pending migration and the version stamp run in ONE immediate
 *   transaction. A failed migration rolls back whole, so the file is never left
 *   half-migrated and nothing needs restoring. The version is re-read inside
 *   that transaction, so two processes opening an old file at once migrate it
 *   once. A file newer than this build is refused, untouched.
 *
 * Cost per request: a row read is one prepared statement; a write is one
 * transaction; `revision()` is one statement over two in-memory counters.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { RevisionSource } from '../utils/revision.js';
import { StoreSchemaDowngradeError } from './store-versioning.js';
import { storeSnapshotDir } from './store-snapshots.js';
import { logger } from '../utils/logger.js';

// bun:sqlite is a Bun-only builtin; a static import makes a module that imports
// this one unloadable under Node. The constructor is resolved on first open.
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database {
  return (databaseCtor ??= (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database);
}

/** One schema step. `up` runs inside the open's single migration transaction. */
export interface SqliteMigration {
  /** The `user_version` this step produces. Steps run in ascending order. */
  readonly toVersion: number;
  readonly up: (db: Database) => void;
}

export interface SqliteFileOptions {
  /** Every schema step, ascending or not; the last must reach the version this build writes. */
  readonly migrations: readonly SqliteMigration[];
  /** How long a statement waits for another process's write. Default 5000 ms. */
  readonly busyTimeoutMs?: number | undefined;
  /** Store name for messages ("knowledge store"). Defaults to the file name. */
  readonly name?: string | undefined;
  /** `PRAGMA foreign_keys`. Default true. */
  readonly foreignKeys?: boolean | undefined;
}

export interface SqliteFile extends RevisionSource {
  readonly db: Database;
  readonly path: string;
  /** The schema version the file had before this open; equal to the current one when nothing migrated. */
  readonly openedAtVersion: number;
  /** The copy taken before a migration, or null when none ran. */
  readonly snapshotPath: string | null;
  /**
   * Run `fn` in one immediate transaction: the write lock is taken at BEGIN, so
   * a read-then-write inside cannot fail half-way on another process's write.
   * Nested calls become savepoints. A throw rolls everything back.
   */
  tx<T>(fn: () => T): T;
  close(): void;
}

/** A migration failed and was rolled back; the file is as it was before the open. */
export class SqliteMigrationError extends Error {
  readonly code = 'SQLITE_MIGRATION_FAILED';
  constructor(
    readonly storeName: string,
    readonly path: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    readonly snapshotPath: string | null,
    cause: unknown,
  ) {
    super(
      `${storeName} could not be brought from schema v${fromVersion} to v${toVersion}: `
      + `${cause instanceof Error ? cause.message : String(cause)}. Nothing was changed: the migration ran in one transaction and rolled back. `
      + (snapshotPath ? `A copy taken before the attempt is at ${snapshotPath}. ` : '')
      + `Run the build that wrote the file, or move ${path} aside to start an empty store.`,
      { cause },
    );
    this.name = 'SqliteMigrationError';
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function isFilePath(path: string): boolean {
  return path.length > 0 && path !== ':memory:' && !path.startsWith('file::memory:');
}

/** Open (creating when absent) the SQLite file at `path` and bring its schema to this build's version. */
export function openSqliteFile(path: string, options: SqliteFileOptions): SqliteFile {
  if (isFilePath(path)) mkdirSync(dirname(path), { recursive: true });
  const db = new (bunDatabase())(path, { create: true, strict: true });
  try {
    return adoptSqliteDatabase(db, path, options);
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The same contract over a handle the caller opened itself, for a store that
 * must load an extension (asynchronously) before its schema can be touched.
 * On a throw the handle is left open; the caller closes it.
 */
export function adoptSqliteDatabase(db: Database, path: string, options: SqliteFileOptions): SqliteFile {
  const name = options.name ?? (isFilePath(path) ? path.slice(path.lastIndexOf('/') + 1) : 'in-memory store');
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
  if (isFilePath(path)) {
    try {
      db.run('PRAGMA journal_mode = WAL');
    } catch (error) {
      // A first open racing another process's can get SQLITE_BUSY here without
      // the busy handler; that process is setting the same mode.
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
    }
    db.run('PRAGMA synchronous = NORMAL');
  }
  db.run(`PRAGMA foreign_keys = ${options.foreignKeys === false ? 'OFF' : 'ON'}`);
  const { fromVersion, snapshotPath } = migrate(db, path, name, options.migrations);

  const counters = db.prepare<{ v: number; c: number }, []>(
    'SELECT (SELECT data_version FROM pragma_data_version()) AS v, total_changes() AS c',
  );
  let seenDataVersion = -1;
  let seenChanges = -1;
  let revision = 0;
  let closed = false;
  const file: SqliteFile = {
    id: name,
    db,
    path,
    openedAtVersion: fromVersion,
    snapshotPath,
    revision(): number {
      if (closed) return revision;
      // data_version moves when another connection commits; total_changes when
      // this one writes. Either moving is one change of the store's revision.
      const row = counters.get();
      if (row && (row.v !== seenDataVersion || row.c !== seenChanges)) {
        if (seenDataVersion !== -1) revision += 1;
        seenDataVersion = row.v;
        seenChanges = row.c;
      }
      return revision;
    },
    tx<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },
    close(): void {
      if (closed) return;
      closed = true;
      counters.finalize();
      db.close();
    },
  };
  file.revision();
  return file;
}

function readUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

function migrate(
  db: Database,
  path: string,
  name: string,
  migrations: readonly SqliteMigration[],
): { fromVersion: number; snapshotPath: string | null } {
  const steps = [...migrations].sort((a, b) => a.toVersion - b.toVersion);
  const target = steps.length === 0 ? 0 : steps[steps.length - 1]!.toVersion;
  const found = readUserVersion(db);
  if (found === target) return { fromVersion: found, snapshotPath: null };
  if (found > target) throw new StoreSchemaDowngradeError(name, path, found, target);

  const hasContent = (db.query<{ n: number }, []>('SELECT count(*) AS n FROM sqlite_master').get()?.n ?? 0) > 0;
  const snapshotPath = hasContent && isFilePath(path) ? snapshotBeforeMigration(db, path, found, target) : null;

  let reached = found;
  let attempted = target;
  try {
    db.transaction(() => {
      // Another process may have migrated while this one waited for the lock.
      reached = readUserVersion(db);
      if (reached > target) throw new StoreSchemaDowngradeError(name, path, reached, target);
      for (const step of steps) {
        if (step.toVersion <= reached) continue;
        attempted = step.toVersion;
        step.up(db);
      }
      if (reached !== target) db.run(`PRAGMA user_version = ${Math.trunc(target)}`);
    }).immediate();
  } catch (error) {
    if (error instanceof StoreSchemaDowngradeError) throw error;
    throw new SqliteMigrationError(name, path, reached, attempted, snapshotPath, error);
  }
  if (reached !== target) logger.info('store schema migrated', { store: name, fromVersion: reached, toVersion: target, snapshotPath });
  return { fromVersion: found, snapshotPath };
}

/** One consistent copy, readable by the store snapshot list and restore command. */
function snapshotBeforeMigration(db: Database, path: string, from: number, to: number): string {
  const dir = storeSnapshotDir(path);
  mkdirSync(dir, { recursive: true });
  const slug = new Date().toISOString().replace(/[:.]/g, '-');
  let target = join(dir, `${slug}.pre-migration-v${from}-to-v${to}.snapshot`);
  for (let counter = 1; existsSync(target); counter += 1) {
    target = join(dir, `${slug}-${counter}.pre-migration-v${from}-to-v${to}.snapshot`);
  }
  db.run('VACUUM INTO ?', [target]);
  return target;
}
