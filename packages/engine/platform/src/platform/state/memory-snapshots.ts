/**
 * The memory store's point-in-time copies, for the owner: list them and read
 * one to put its records back (MemoryRegistry.restoreSnapshot).
 *
 * The copies are the store snapshots kept beside `memory.sqlite`
 * (store-snapshots.ts): the daily copy, the copy before a schema migration,
 * the tripwire copy and the copy every restore takes of the records it
 * replaces. A restore does not swap files: it reads the chosen copy and writes
 * its rows into the live store in one SQLite write transaction, so every
 * process holding the store open (the terminal app, the Agent, the daemon)
 * stays on the same file and sees the restored records on its next read.
 */
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import { listStoreSnapshots, type StoreSnapshotInfo } from './store-snapshots.js';
import { MEMORY_SCHEMA_VERSION } from './memory-store-helpers.js';

/** The tables a copy carries, in the order rows go back (records before the links that name them). */
export const MEMORY_SNAPSHOT_TABLES = ['memory_records', 'memory_links', 'memory_proposals', 'memory_meta'] as const;
export type MemorySnapshotTable = typeof MEMORY_SNAPSHOT_TABLES[number];

export interface MemorySnapshotInfo {
  /** The copy's file name; what `/memory restore` and `memory.snapshots.restore` take. */
  readonly name: string;
  /** Why it was taken: daily, pre-migration, pre-restore, tripwire. */
  readonly reason: string;
  /** When it was taken (ms since epoch). */
  readonly createdAt: number;
  /** Bytes on disk, the copy and its WAL together. */
  readonly sizeBytes: number;
  /** Memory records in the copy; null when the copy could not be read. */
  readonly recordCount: number | null;
}

/** One table of a copy: its column names and every row. */
export interface MemorySnapshotTableRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** A copy read into memory, ready to be written back by MemoryStore.replaceFromSnapshot. */
export interface MemorySnapshotImage {
  readonly name: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly tables: ReadonlyMap<MemorySnapshotTable, MemorySnapshotTableRows>;
}

/** What a restore did, as the owner and an attached app read it. */
export interface MemoryRestoreResult {
  /** The copy whose records are now the store's. */
  readonly restored: string;
  readonly restoredReason: string;
  readonly restoredCreatedAt: number;
  /** Records in the store before and after. */
  readonly recordsBefore: number;
  readonly recordsAfter: number;
  readonly linksAfter: number;
  /** The copy taken of the replaced records just before; restoring it undoes this restore. */
  readonly undoSnapshot: string;
  /**
   * The semantic index: 'updating' while it re-embeds the records whose text
   * differs from what it holds and drops the ones that are gone; 'off' when
   * this store keeps no vector index.
   */
  readonly vectorIndex: 'updating' | 'off';
}

export type MemorySnapshotErrorCode =
  | 'MEMORY_SNAPSHOT_UNAVAILABLE'
  | 'MEMORY_SNAPSHOT_NOT_FOUND'
  | 'MEMORY_SNAPSHOT_AMBIGUOUS'
  | 'MEMORY_SNAPSHOT_UNREADABLE';

const STATUS_BY_CODE: Readonly<Record<MemorySnapshotErrorCode, number>> = {
  MEMORY_SNAPSHOT_UNAVAILABLE: 409,
  MEMORY_SNAPSHOT_NOT_FOUND: 404,
  MEMORY_SNAPSHOT_AMBIGUOUS: 409,
  MEMORY_SNAPSHOT_UNREADABLE: 422,
};

/** A refusal that names the state, the reason and the next step; nothing was changed. */
export class MemorySnapshotError extends Error {
  readonly status: number;
  constructor(readonly code: MemorySnapshotErrorCode, message: string) {
    super(message);
    this.name = 'MemorySnapshotError';
    this.status = STATUS_BY_CODE[code];
  }
}

// bun:sqlite is a Bun-only builtin; resolved on first use so Node can load this module.
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database {
  if (databaseCtor) return databaseCtor;
  try { databaseCtor = (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database; }
  catch { throw new MemorySnapshotError('MEMORY_SNAPSHOT_UNAVAILABLE', 'Memory copies can be read only under Bun (bun:sqlite); nothing was changed.'); }
  return databaseCtor;
}

/** Read-only, so reading a copy never checkpoints or changes it. */
function withCopy<T>(path: string, read: (db: Database) => T): T {
  const db = new (bunDatabase())(path, { readonly: true });
  try {
    db.run('PRAGMA busy_timeout = 5000');
    return read(db);
  } finally { db.close(); }
}

function countRecords(path: string): number | null {
  try {
    return withCopy(path, (db) => {
      const row = db.query('SELECT count(*) AS n FROM memory_records').get() as { n?: unknown } | null;
      return typeof row?.n === 'number' ? row.n : null;
    });
  } catch { return null; }
}

function toInfo(entry: StoreSnapshotInfo): MemorySnapshotInfo {
  return {
    name: basename(entry.path),
    reason: entry.reason,
    createdAt: entry.createdAt,
    sizeBytes: entry.sizeBytes,
    recordCount: countRecords(entry.path),
  };
}

function requireFileStore(dbPath: string | null): string {
  if (!dbPath) {
    throw new MemorySnapshotError('MEMORY_SNAPSHOT_UNAVAILABLE', 'This memory store lives in memory only, so it keeps no copies; nothing was changed.');
  }
  return dbPath;
}

/** Every copy of the store at `dbPath`, newest first, with its record count (one read-only open each). */
export function listMemorySnapshots(dbPath: string | null): MemorySnapshotInfo[] {
  if (!dbPath) return [];
  return listStoreSnapshots(dbPath).map(toInfo);
}

/**
 * The copy `selector` names: its exact file name, `latest` (the newest copy of
 * any kind) or the start of one name (a date such as `2026-11-16`) that only
 * one copy has.
 */
export function resolveMemorySnapshot(dbPath: string | null, selector: string): StoreSnapshotInfo {
  const path = requireFileStore(dbPath);
  const wanted = selector.trim();
  const copies = listStoreSnapshots(path);
  if (copies.length === 0) {
    throw new MemorySnapshotError('MEMORY_SNAPSHOT_NOT_FOUND', 'There are no memory copies yet: the first daily copy is taken within an hour of start. Nothing was changed.');
  }
  if (wanted === '' || wanted === 'latest') return copies[0]!;
  const exact = copies.find((copy) => basename(copy.path) === wanted);
  if (exact) return exact;
  const matches = copies.filter((copy) => basename(copy.path).startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new MemorySnapshotError('MEMORY_SNAPSHOT_AMBIGUOUS',
      `${matches.length} memory copies start with "${wanted}" (${matches.map((copy) => basename(copy.path)).join(', ')}); name one in full. Nothing was changed.`);
  }
  throw new MemorySnapshotError('MEMORY_SNAPSHOT_NOT_FOUND', `No memory copy is named "${wanted}"; list them with /memory snapshots. Nothing was changed.`);
}

/** Read every row of the copy, after checking it is a memory store this build can read. */
export function readMemorySnapshotImage(copy: StoreSnapshotInfo): MemorySnapshotImage {
  const name = basename(copy.path);
  const unreadable = (why: string): MemorySnapshotError =>
    new MemorySnapshotError('MEMORY_SNAPSHOT_UNREADABLE', `The memory copy ${name} cannot be restored: ${why}. Nothing was changed; choose another copy.`);
  let tables: Map<MemorySnapshotTable, MemorySnapshotTableRows>;
  try {
    tables = withCopy(copy.path, (db) => {
      const version = (db.query('PRAGMA user_version').get() as { user_version?: unknown } | null)?.user_version;
      if (typeof version !== 'number' || version > MEMORY_SCHEMA_VERSION) {
        throw unreadable(`it was written by a newer version (schema ${String(version)}, this build reads up to ${MEMORY_SCHEMA_VERSION})`);
      }
      const present = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
      if (!present.has('memory_records')) throw unreadable('it holds no memory records table');
      const read = new Map<MemorySnapshotTable, MemorySnapshotTableRows>();
      for (const table of MEMORY_SNAPSHOT_TABLES) {
        if (!present.has(table)) continue;
        const statement = db.prepare(`SELECT * FROM ${table}`);
        try {
          const rows = statement.values() as unknown[][];
          read.set(table, { columns: [...statement.columnNames], rows });
        } finally { statement.finalize(); }
      }
      return read;
    });
  } catch (error) {
    if (error instanceof MemorySnapshotError) throw error;
    throw unreadable(error instanceof Error ? error.message : String(error));
  }
  return { name, reason: copy.reason, createdAt: copy.createdAt, tables };
}
