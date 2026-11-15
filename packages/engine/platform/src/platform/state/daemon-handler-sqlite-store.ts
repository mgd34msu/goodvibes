import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { chmodSync, closeSync, existsSync, openSync, readSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { MutationPublication } from '../utils/file-mutation.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { capturePrivateSqliteDirectory } from './private-sqlite-path.js';
import { openSqliteFile, type SqliteFile } from './sqlite-file.js';

/** Synchronous transaction view; callers must not retain it past the callback. */
export interface HandlerSqliteTransaction {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T | null;
}

export interface HandlerSqliteStoreOptions {
  workingDirectory: string;
  /** e.g. 'channel-routes.sqlite', 'drafts.sqlite', 'inbox-cursors.sqlite' */
  fileName: string;
  /** CREATE TABLE / INDEX statements run once on init (idempotent: IF NOT EXISTS). */
  schema: string[];
  /** Synchronous fence run immediately before each transaction commits. */
  beforeWrite?: (() => void) | undefined;
}

/**
 * The 16 bytes every SQLite file begins with ("SQLite format 3" + NUL). A file
 * that does not start with these is not a database, whatever its extension,
 * which is exactly what a crash mid-create, a zero-fill, or a partially
 * restored backup leaves behind.
 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** How long a statement waits for another process's write before it fails. */
const BUSY_TIMEOUT_MS = 5_000;

type Param = string | number | Uint8Array | null;

/**
 * Daemon handler store: one real SQLite file per concern under
 * {workingDirectory}/.goodvibes/tui/operator/{fileName}, opened once with
 * bun:sqlite in WAL mode (B4 row store).
 *
 * A write is one statement or one transaction on the file, so its cost is the
 * rows it changes, not the size of the store; there is no in-memory image to
 * export and no whole-file save. Two processes on one working directory (the
 * daemon and a terminal, two terminals) share the file under SQLite's own
 * locking, with a busy wait for the other writer.
 *
 * Damage is handled once, at open: a file that is empty, lacks the SQLite
 * header, or fails `quick_check` is moved aside with its -wal/-shm (never
 * deleted), a fresh store is started, and recoveryNotice() says what happened
 * and where the old file went.
 */
export class HandlerSqliteStore {
  private readonly options: HandlerSqliteStoreOptions;
  private readonly resolvedPath: string;
  private file: SqliteFile | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private recovery: string | undefined;

  constructor(options: HandlerSqliteStoreOptions) {
    if (!options.fileName || options.fileName === '.' || options.fileName === '..' || /[\\/\0]/.test(options.fileName)) throw new Error('HandlerSqliteStore requires a local filename');
    this.options = Object.freeze({ ...options, schema: [...options.schema] }); Object.freeze(this.options.schema);
    this.resolvedPath = join(options.workingDirectory, '.goodvibes', 'tui', 'operator', options.fileName);
  }

  get dbPath(): string {
    return this.resolvedPath;
  }

  /** Set when init found the database unreadable and started a fresh one: what happened and where the old file went. */
  recoveryNotice(): string | undefined {
    return this.recovery;
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('HandlerSqliteStore is closed');
    if (this.file) return;
    this.initPromise ??= Promise.resolve().then(() => this.open()).finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private open(): void {
    if (this.closed) throw new Error('HandlerSqliteStore is closed');
    if (this.file) return;
    // The operator directory is private to this user (0700), created once here.
    capturePrivateSqliteDirectory(this.options.workingDirectory, { create: true, assertCurrent() {} });
    const unreadable = this.headerProblem();
    if (unreadable) this.setAside(unreadable);
    let file: SqliteFile;
    try {
      file = this.openFile();
      const check = file.db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
      if (check?.quick_check !== 'ok') {
        file.close();
        throw Object.assign(new Error(`quick_check reported ${check?.quick_check ?? 'nothing'}`), { code: 'SQLITE_CORRUPT' });
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'SQLITE_NOTADB' && code !== 'SQLITE_CORRUPT') throw error;
      this.setAside(`database would not open: ${summarizeError(error)}`);
      file = this.openFile();
    }
    try {
      file.tx(() => { for (const statement of this.options.schema) file.db.run(statement); });
    } catch (error) {
      file.close();
      throw error;
    }
    if (this.closed) { file.close(); return; }
    this.file = file;
  }

  private openFile(): SqliteFile {
    const file = openSqliteFile(this.resolvedPath, { name: `${this.options.fileName} store`, migrations: [], busyTimeoutMs: BUSY_TIMEOUT_MS });
    try { chmodSync(this.resolvedPath, 0o600); } catch (error) {
      logger.warn('daemon store permissions could not be narrowed', { store: this.options.fileName, error: summarizeError(error) });
    }
    return file;
  }

  /** Why the file on disk is not a database, or undefined when it is one (or absent). */
  private headerProblem(): string | undefined {
    if (!existsSync(this.resolvedPath)) return undefined;
    const fd = openSync(this.resolvedPath, 'r');
    try {
      const head = Buffer.alloc(SQLITE_HEADER.length);
      const read = readSync(fd, head, 0, head.length, 0);
      if (read === 0) return 'zero-byte file (interrupted write)';
      if (read < SQLITE_HEADER.length || !head.equals(SQLITE_HEADER)) return 'missing the SQLite file header (not a database)';
      return undefined;
    } finally { closeSync(fd); }
  }

  /** Move the unreadable file and its -wal/-shm to `<file>.unreadable-<n>`; nothing is deleted. */
  private setAside(reason: string): void {
    let n = 1;
    while (existsSync(`${this.resolvedPath}.unreadable-${n}`)) n++;
    const target = `${this.resolvedPath}.unreadable-${n}`;
    renameSync(this.resolvedPath, target);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(this.resolvedPath + suffix)) renameSync(this.resolvedPath + suffix, target + suffix);
    }
    this.recovery = `The ${this.options.fileName} store could not be opened (${reason}); a fresh one was started. The old file was kept at ${target}.`;
    logger.warn('daemon store could not be opened; starting a fresh one', { store: this.options.fileName, path: this.resolvedPath, reason, keptAt: target });
  }

  private requireFile(): SqliteFile {
    if (!this.file) {
      throw new Error(this.closed
        ? `HandlerSqliteStore is closed: ${this.resolvedPath}. Open a new store to read or write it.`
        : `HandlerSqliteStore not initialized: ${this.resolvedPath}`);
    }
    return this.file;
  }

  /** Execute a write (INSERT/UPDATE/DELETE/CREATE); durable when it returns. */
  run(sql: string, params?: Param[]): void {
    this.requireFile().db.query(sql).run(...(params ?? []));
  }

  /** SELECT → array of row objects (columns mapped to values). */
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T[] {
    return this.requireFile().db.query(sql).all(...(params ?? [])) as T[];
  }

  /** First row or null. */
  get<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T | null {
    return (this.requireFile().db.query(sql).get(...(params ?? [])) as T | null) ?? null;
  }

  /**
   * Run a synchronous mutation in one immediate transaction. `assertCurrent`
   * (and the store's beforeWrite) run immediately before the commit; when a
   * publication is given, the commit happens inside it, synchronously, so the
   * caller's publication and the rows land together. A throw rolls back.
   */
  async persistTransaction<T>(mutate: (transaction: HandlerSqliteTransaction) => T, assertCurrent: () => void,
    withPublication?: MutationPublication): Promise<T> {
    const file = this.requireFile();
    const transaction: HandlerSqliteTransaction = {
      run: (sql, params) => { file.db.query(sql).run(...(params ?? [])); },
      all: <R>(sql: string, params?: (string | number)[]) => file.db.query(sql).all(...(params ?? [])) as R[],
      get: <R>(sql: string, params?: (string | number)[]) => (file.db.query(sql).get(...(params ?? [])) as R | null) ?? null,
    };
    let attempted = false;
    let result!: T;
    const commit = (publicationCurrent: () => void): void => {
      if (attempted) throw new Error('HandlerSqliteStore publication is not current');
      attempted = true;
      synchronousFence(publicationCurrent);
      synchronousFence(assertCurrent);
      if (this.options.beforeWrite) synchronousFence(this.options.beforeWrite);
      if (this.file !== file) throw new Error('HandlerSqliteStore transaction lost its database');
      result = file.tx(() => {
        const value = mutate(transaction);
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
          drainOwned(value);
          throw new Error('HandlerSqliteStore transaction must be synchronous');
        }
        return value;
      });
    };
    if (withPublication) await withPublication(commit);
    else commit(() => {});
    if (!attempted) throw new Error('HandlerSqliteStore publication did not finish');
    return result;
  }

  close(): void {
    this.closed = true;
    this.file?.close();
    this.file = null;
  }

  /** BEGIN/COMMIT around fn; ROLLBACK on throw. */
  transaction(fn: () => void): void {
    this.requireFile().tx(fn);
  }
}

function synchronousFence(assertCurrent: () => void): void {
  let result: unknown;
  try { result = assertCurrent(); }
  catch (error) { drainOwned(error); throw error; }
  if (result !== undefined) {
    drainOwned(result);
    throw new Error('HandlerSqliteStore currentness fence must be synchronous and return void');
  }
}
