import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { createSqlJsDatabase, SqlJsDatabaseAllocationError } from './sqljs-database.js';
import { open } from 'node:fs/promises';
import { fstatSync, lstatSync, readdirSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MutationPublication } from '../utils/file-mutation.js';
import { logger } from '../utils/logger.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { captureQuarantineSource, quarantineCorruptFile, reapOwnedQuarantines, type QuarantineSource, type QuarantineOutcome } from '../utils/atomic-json-store.js';
import { capturePrivateSqliteDirectory, readPrivateSqliteImage } from './private-sqlite-path.js';
import { loadSqlJsEngine, type SqlDatabase } from './sqlite-store.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';

/** How long a second process waits for the store's writer before it refuses to open. */
const WRITER_LOCK_WAIT_MS = 2_000;

/** Writer locks this process holds, shared by every instance over one file so only the first takes it. */
const writerLocks = new Map<string, { holders: number; release: Promise<() => void> }>();

/** Synchronous transaction view; callers must not retain it past the callback. */
export interface HandlerSqliteTransaction {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T | null;
}

interface PreparedSqliteImage { assertCurrent(): void; cleanup(): void }
export interface HandlerSqliteStoreOptions {
  workingDirectory: string;
  /** e.g. 'channel-routes.sqlite', 'drafts.sqlite', 'inbox-cursors.sqlite' */
  fileName: string;
  /** CREATE TABLE / INDEX statements run once on init (idempotent: IF NOT EXISTS). */
  schema: string[];
  /** Native format declaration/restriction before each actual image publication. */
  beforeWrite?: (() => void) | undefined;
  /** How long to wait for another process to let go of this store before refusing to open it. Default 2000. */
  writerLockWaitMs?: number | undefined;
}

/**
 * The 16 bytes every SQLite file begins with ("SQLite format 3" + NUL). A file
 * that does not start with these is not a database, whatever its extension,
 * which is exactly what a crash mid-create, a zero-fill, or a partially
 * restored backup leaves behind.
 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * How long a physically owned database quarantine is kept before it is
 * reclaimed. These files exist so an operator can try to salvage a damaged
 * store by hand; 14 days is long enough for someone to notice a broken daemon
 * and come looking, and short enough that a store that goes bad repeatedly
 * cannot fill the disk with copies of itself. Reaped on the next init.
 */
const CORRUPT_QUARANTINE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** At most this many quarantined copies of one store are kept, newest first. */
const MAX_CORRUPT_QUARANTINES = 3;

/**
 * Daemon sqlite helper following the project MemoryStore lifecycle
 * (sql.js WASM: init → run/exec → save → close). One file per concern under
 * {workingDirectory}/.goodvibes/tui/operator/{fileName}.
 */
export class HandlerSqliteStore {
  /**
   * Makes every temp filename this process writes distinct. Static rather than
   * per-instance because two INSTANCES pointed at one file (two surfaces
   * sharing a store path) would otherwise collide with each other exactly as
   * two saves of one instance did. See save().
   */
  private static saveSequence = 0;
  // Serialize snapshots in invocation order, even across instances sharing a
  // path. This is process-local ordering, not a multi-process database lock.
  private static readonly saveTails = new Map<string, Promise<void>>();

  private readonly options: HandlerSqliteStoreOptions;
  private readonly resolvedPath: string;
  private db: SqlDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private persistenceBlocked = false;
  private databaseFactory: ((data: Uint8Array) => SqlDatabase) | null = null;
  private mutationRevision = 0;
  private stagedTransactions = 0;
  private closed = false;
  /**
   * The database image as of close(), kept only when a save was still waiting
   * behind a staged transaction (it captures its bytes when it runs, so the
   * database it would have exported is gone by then).
   */
  private finalImage: Uint8Array | null = null;
  /** Identity of the database file as this instance last read or published it. */
  private knownFileIdentity: string | undefined;
  private foreignWriter = false;
  private holdsWriterLock = false;
  private recovery: string | undefined;
  private assertStorageCurrent: () => void = () => { throw new Error('HandlerSqliteStore is not initialized'); };

  constructor(options: HandlerSqliteStoreOptions) {
    if (!options.fileName || options.fileName === '.' || options.fileName === '..' || /[\\/\0]/.test(options.fileName)) throw new Error('HandlerSqliteStore requires a local filename');
    this.options = Object.freeze({ ...options, schema: [...options.schema] }); Object.freeze(this.options.schema);
    this.resolvedPath = join(
      options.workingDirectory,
      '.goodvibes',
      'tui',
      'operator',
      options.fileName,
    );
  }

  get dbPath(): string {
    return this.resolvedPath;
  }

  /**
   * True once another process was seen to replace this database file. Each save rewrites
   * the whole image from this process's memory, so rows the other process wrote since this
   * one loaded are overwritten; callers that can tell the operator should.
   */
  foreignWriterDetected(): boolean {
    return this.foreignWriter;
  }

  /** Set when init found the database unreadable and started a fresh one: what happened and where the old file went. */
  recoveryNotice(): string | undefined {
    return this.recovery;
  }

  /**
   * Each save rewrites the whole database from this process's memory, so two processes
   * holding the same store would erase each other's rows. The second one refuses to open
   * instead; a lock that cannot be created at all (read-only disk) does not stop a
   * single process from working.
   */
  private async acquireWriterLock(): Promise<void> {
    if (this.holdsWriterLock) return;
    let entry = writerLocks.get(this.resolvedPath);
    if (!entry) {
      entry = { holders: 0, release: acquireCrossProcessLock(join(dirname(dirname(this.resolvedPath)), `${this.options.fileName}.writer-lock`), { totalTimeoutMs: this.options.writerLockWaitMs ?? WRITER_LOCK_WAIT_MS }) };
      writerLocks.set(this.resolvedPath, entry);
    }
    entry.holders++;
    this.holdsWriterLock = true;
    try {
      await entry.release;
    } catch (error) {
      this.releaseWriterLock();
      if (error instanceof Error && /timed out/.test(error.message)) {
        throw new Error(`The ${this.options.fileName} store is open in another process using ${this.options.workingDirectory}. `
          + 'Two processes would overwrite each other\'s saved rows, so this one did not open it. Stop the other GoodVibes process for this directory, then retry.');
      }
      logger.warn('daemon store writer lock unavailable; opening without it', {
        store: this.options.fileName, reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private releaseWriterLock(): void {
    if (!this.holdsWriterLock) return;
    this.holdsWriterLock = false;
    const entry = writerLocks.get(this.resolvedPath);
    if (!entry || --entry.holders > 0) return;
    writerLocks.delete(this.resolvedPath);
    void entry.release.then((release) => release(), () => {});
  }

  /** Called immediately before a rename that publishes this instance's image. */
  private noteForeignWriter(): void {
    let current: string | undefined;
    try { current = fileObservationIdentity(this.resolvedPath); } catch { return; }
    // A file that exists while this instance has neither read nor published one was written by someone else.
    if (current !== this.knownFileIdentity && !this.foreignWriter) {
      this.foreignWriter = true;
      logger.warn('daemon store was changed by another process; saving now overwrites that process\'s rows', {
        store: this.options.fileName, path: this.resolvedPath,
      });
    }
  }

  private rememberPublishedIdentity(): void {
    try { this.knownFileIdentity = fileObservationIdentity(this.resolvedPath); } catch { this.knownFileIdentity = undefined; }
  }

  /** Remove staging files left by a process that no longer exists (a crash between stage and rename). */
  private reapDeadStagingFiles(): void {
    const directory = dirname(this.resolvedPath);
    const prefix = `${this.options.fileName}.`;
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      const match = name.startsWith(prefix) ? /^(\d+)\.\d+\.\d+\.tmp$/.exec(name.slice(prefix.length)) : null;
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { process.kill(pid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      try {
        const path = join(directory, name);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat?.isFile()) unlinkSync(path);
      } catch (error) { logger.warn('daemon store could not remove a stale staging file', { file: name, error: String(error) }); }
    }
  }

  private requireDb(): SqlDatabase {
    if (!this.db) {
      throw new Error(this.closed
        ? `HandlerSqliteStore is closed: ${this.resolvedPath}. Open a new store to read or write it.`
        : `HandlerSqliteStore not initialized: ${this.resolvedPath}`);
    }
    return this.db;
  }

  /**
   * Move a database file that cannot be opened aside instead of deleting it, so
   * an operator still has something to salvage, and return the quarantine path.
   * Returns null when the move itself failed, in which case the caller starts
   * fresh in memory with persistence blocked. Any surviving source or archive
   * remains available for recovery instead of being overwritten on save.
   */
  private quarantineUnreadable(source: QuarantineSource | null, reason: string): QuarantineOutcome | null {
    if (!source) return null;
    try {
      return quarantineCorruptFile(this.resolvedPath, {
        source, label: 'daemon SQLite', reason,
        recovery: 'The daemon starts an empty store. Inspect the preserved database before attempting manual recovery.',
        assertCurrent: () => this.assertActiveStorage(),
        maxFiles: MAX_CORRUPT_QUARANTINES, maximumAgeMs: CORRUPT_QUARANTINE_TTL_MS,
      });
    } catch {
      // A failed or uncertain quarantine never permits overwriting a survivor.
      return null;
    }
  }

  /** Only exact native archive/receipt pairs belong to this retention policy.
   * Matching historical filenames and other configured stores remain intact. */
  private reapCorruptQuarantines(nowMs: number): number {
    return reapOwnedQuarantines(this.resolvedPath, {
      maxFiles: MAX_CORRUPT_QUARANTINES, maximumAgeMs: CORRUPT_QUARANTINE_TTL_MS,
      now: nowMs, assertCurrent: () => this.assertActiveStorage(),
    }).reaped;
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('HandlerSqliteStore is closed');
    if (this.db) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } catch (error) {
      if (!this.db) this.releaseWriterLock();
      throw error;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    if (this.closed) throw new Error('HandlerSqliteStore is closed');
    const storage = capturePrivateSqliteDirectory(this.options.workingDirectory, { create: true, assertCurrent() {} });
    this.assertStorageCurrent = storage.assertCurrent;
    await this.acquireWriterLock(); this.assertActiveStorage();
    const SQL = await loadSqlJsEngine(); this.assertActiveStorage();
    this.databaseFactory = (data) => createSqlJsDatabase(SQL.Database, data);
    this.persistenceBlocked = false;

    // Validate the file by its CONTENT, not by existsSync. `save()` writes
    // through a pid-and-timestamp temp file and an atomic rename, so it cannot
    // itself leave a half-written database, but a zero-filled file recovered
    // by a filesystem, a truncated restore, or a copy interrupted by something
    // outside this process all produce a path that exists and holds no usable
    // database. Handing those bytes to `new SQL.Database(...)` throws out of
    // init and takes the whole daemon store down with no way back.
    let existing: Buffer | undefined;
    let quarantined: QuarantineOutcome | null = null;
    let quarantineReason = '';
    // Reject aliases/hardlinks and tighten the actual selected descriptor
    // before reading a private database. Unsafe ownership is never quarantined
    // or replaced by an apparently fresh store.
    const original = readPrivateSqliteImage(this.resolvedPath, () => this.assertActiveStorage());
    this.knownFileIdentity = original?.physical;
    this.reapDeadStagingFiles();
    const source = original ? captureQuarantineSource(this.resolvedPath) : null;
    try {
      // Bind the recovery descriptor to the exact private image already read,
      // before any SQL validation. Never adopt a catch-time replacement.
      if (original) {
        if (!source || fileObservationIdentity(this.resolvedPath) !== original.physical) throw new Error('SQLite source changed before validation');
        source.assertCurrent();
      }
      if (original !== undefined) {
        const raw = original.bytes;
        if (raw.length === 0) {
          quarantineReason = 'zero-byte file (interrupted write)';
          quarantined = this.quarantineUnreadable(source, quarantineReason);
        } else if (raw.length < SQLITE_HEADER.length || !raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
          quarantineReason = 'missing the SQLite file header (not a database)';
          quarantined = this.quarantineUnreadable(source, quarantineReason);
        } else {
          existing = raw;
        }
      }

      let candidate: SqlDatabase | null = null;
      if (existing) {
        // The constructor is NOT where a damaged image surfaces: sql.js accepts
        // the bytes and only reports "database disk image is malformed" when the
        // first statement touches a bad page. Validate the image independently
        // of the caller's schema: a schema typo must never quarantine good data.
        try {
          candidate = createSqlJsDatabase(SQL.Database, existing);
          const check = candidate.exec('PRAGMA quick_check');
          if (check.length !== 1 || check[0]?.values.length !== 1 || check[0].values[0]?.[0] !== 'ok') {
            throw new Error('SQLite quick_check rejected the database image');
          }
        } catch (error) {
          if (error instanceof SqlJsDatabaseAllocationError) throw error;
          // Header present but the body does not hold up: a truncated or damaged
          // database. Same treatment, set aside, disclose, start clean.
          quarantineReason = `database would not open: ${error instanceof Error ? error.message : String(error)}`;
          candidate?.close();
          candidate = null;
          quarantined = this.quarantineUnreadable(source, quarantineReason);
        }
      }

      if (!quarantineReason) {
        try { source?.assertCurrent(); } catch (error) { candidate?.close(); throw error; }
      }
      let reclaimed: number;
      try { reclaimed = (quarantined?.reaped ?? 0) + this.reapCorruptQuarantines(Date.now()); }
      catch (error) { candidate?.close(); throw error; }

      // A failed move is not permission to overwrite the operator's only copy.
      this.persistenceBlocked = Boolean(quarantineReason && !quarantined);
      candidate ??= createSqlJsDatabase(SQL.Database);
      try {
        for (const statement of this.options.schema) candidate.run(statement);
        this.db = candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }

      // Disclosure: starting a store from scratch is data loss from the user's
      // point of view, so it is never allowed to happen quietly.
      if (quarantineReason) {
        this.recovery = `The ${this.options.fileName} store could not be opened (${quarantineReason}); a fresh one was started. `
          + (quarantined?.quarantinePath ? `The old file was kept at ${quarantined.quarantinePath}.` : 'The old file was left in place and saving is blocked.');
        logger.warn('daemon store could not be opened; starting a fresh one', {
          store: this.options.fileName,
          path: this.resolvedPath,
          reason: quarantineReason,
          quarantinedTo: quarantined?.quarantinePath ?? '(recovery was not confirmed; existing files preserved)',
        });
      }

      if (reclaimed > 0) {
        logger.info('daemon store reclaimed quarantined copies', {
          store: this.options.fileName,
          reclaimedFiles: reclaimed,
          ttlDays: Math.round(CORRUPT_QUARANTINE_TTL_MS / (24 * 60 * 60 * 1000)),
          keptNewest: MAX_CORRUPT_QUARANTINES,
        });
      }
    } finally { source?.close(); }
  }

  /** Execute a write (INSERT/UPDATE/DELETE/CREATE). */
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    this.mutationRevision += 1;
    this.requireDb().run(sql, params);
  }

  /** SELECT → array of row objects (columns mapped to values). */
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T[] {
    return queryRows<T>(this.requireDb(), sql, params);
  }

  /** First row or null. */
  get<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T | null {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0]! : null;
  }

  private assertActiveStorage(): void {
    if (this.closed) throw new Error('HandlerSqliteStore is closed'); this.assertStorageCurrent();
  }

  /** Retain the actual staged descriptor through every asynchronous write.
   * Creation collisions grant neither publication nor cleanup of another file. */
  private async stageImage(path: string, bytes: Uint8Array, assertCurrent: () => void = () => this.assertActiveStorage()): Promise<PreparedSqliteImage> {
    const assertStorageCurrent = this.assertStorageCurrent;
    assertCurrent();
    const handle = await open(path, 'wx', 0o600);
    let original: BigIntStats | undefined;
    let handleClosed = false;
    const owns = (stat: BigIntStats | undefined): boolean => !!original && !!stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && stat.dev === original.dev && stat.ino === original.ino && stat.uid === original.uid && stat.gid === original.gid && stat.birthtimeNs === original.birthtimeNs;
    const cleanup = () => {
      // Physical cleanup remains allowed after close, but never follows a
      // replaced directory or removes a foreign file occupying the old name.
      assertStorageCurrent(); const selected = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (owns(selected)) unlinkSync(path);
    };
    try {
      original = fstatSync(handle.fd, { bigint: true });
      assertCurrent();
      if (!owns(lstatSync(path, { bigint: true, throwIfNoEntry: false }))) throw new Error('SQLite staging source changed');
      await handle.chmod(0o600); assertCurrent();
      await handle.writeFile(bytes); assertCurrent();
      // Without this a power loss after the rename can leave an empty or partial file that the next init quarantines.
      await handle.sync(); assertCurrent();
      const prepared = fstatSync(handle.fd, { bigint: true });
      if (!owns(prepared) || (prepared.mode & 0o777n) !== 0o600n) throw new Error('SQLite staging permissions are unavailable');
      const assertPreparedCurrent = () => {
        assertCurrent(); const selected = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (!owns(selected) || !selected || selected.mode !== prepared.mode || selected.size !== prepared.size
          || selected.mtimeNs !== prepared.mtimeNs || selected.ctimeNs !== prepared.ctimeNs) throw new Error('SQLite staging source changed');
      };
      assertPreparedCurrent(); await handle.close(); handleClosed = true; assertPreparedCurrent();
      return { assertCurrent: assertPreparedCurrent, cleanup };
    } catch (error) {
      try { if (!handleClosed) await handle.close(); } finally { cleanup(); }
      throw error;
    }
  }

  /**
   * Serialize and atomically persist to dbPath (tmp + rename).
   *
   * The temp filename carries a per-process counter, not just pid + clock. Two
   * saves of the same store in the SAME millisecond produced the same temp path
   * before it did: both wrote it, the first rename moved it away, and the
   * second failed with ENOENT on a file it had just written. That is not a
   * hypothetical race, the inbox poller flushes once per provider and polls
   * every provider concurrently, so it hit on an ordinary two-provider startup,
   * and the failure surfaced as a provider reporting a filesystem error for its
   * feed. Every store on this base shares the hazard, so the counter lives here.
   */
  async save(): Promise<void> {
    const db = this.requireDb();
    if (this.persistenceBlocked) {
      throw new Error(`HandlerSqliteStore cannot save: quarantine failed for ${this.resolvedPath}`);
    }
    // Capture before yielding, so close() or subsequent writes cannot change
    // this save's contents. A later invocation must be the later rename.
    // A save admitted behind a staged transaction must capture AFTER it; an
    // earlier snapshot would overwrite the newly committed checkpoint.
    const data = this.stagedTransactions > 0 ? undefined : db.export();
    // SQL resource teardown cannot revoke these already captured bytes. Retain
    // the original physical storage owner through every later publication step.
    const assertStorageCurrent = this.assertStorageCurrent;
    HandlerSqliteStore.saveSequence += 1;
    const tmpPath = `${this.resolvedPath}.${process.pid}.${Date.now()}.${HandlerSqliteStore.saveSequence}.tmp`;
    const previous = HandlerSqliteStore.saveTails.get(this.resolvedPath) ?? Promise.resolve();
    const saving = previous.then(async () => {
      let prepared: PreparedSqliteImage | undefined;
      try {
        const current = () => { assertStorageCurrent(); if (this.options.beforeWrite) synchronousFence(this.options.beforeWrite); assertStorageCurrent(); };
        current();
        prepared = await this.stageImage(tmpPath, data ?? (this.db ? this.db.export() : this.finalImage ?? this.requireDb().export()), current);
        current(); prepared.assertCurrent(); this.noteForeignWriter(); renameSync(tmpPath, this.resolvedPath);
        this.rememberPublishedIdentity();
      } finally { prepared?.cleanup(); }
    });
    const tail = saving.catch(() => {});
    HandlerSqliteStore.saveTails.set(this.resolvedPath, tail);
    void tail.then(() => {
      if (HandlerSqliteStore.saveTails.get(this.resolvedPath) === tail) {
        HandlerSqliteStore.saveTails.delete(this.resolvedPath);
      }
    });
    await saving;
  }

  /**
   * Stage a repeatable synchronous mutation on a private database image. Only
   * after a successful disk write and synchronous fence does rename+publication
   * occur, without an await between them. Failure leaves the live DB unchanged.
   * Concurrent ordinary mutations cause a rebase; queued ordinary saves capture
   * after this operation, preserving mixed-provider and retention updates.
   */
  persistTransaction<T>(mutate: (transaction: HandlerSqliteTransaction) => T, assertCurrent: () => void,
    withPublication?: MutationPublication): Promise<T> {
    this.requireDb();
    this.stagedTransactions += 1;
    const previous = HandlerSqliteStore.saveTails.get(this.resolvedPath) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (this.persistenceBlocked) throw new Error('HandlerSqliteStore cannot persist transaction: quarantine failed');
      for (;;) {
        synchronousFence(assertCurrent);
        const live = this.requireDb();
        const revision = this.mutationRevision;
        const candidate = this.databaseFactory!(live.export());
        HandlerSqliteStore.saveSequence += 1;
        const tmpPath = `${this.resolvedPath}.${process.pid}.${Date.now()}.${HandlerSqliteStore.saveSequence}.tmp`;
        let published = false;
        let prepared: PreparedSqliteImage | undefined;
        try {
          const transaction: HandlerSqliteTransaction = {
            run: (sql, params) => candidate.run(sql, params),
            all: <R>(sql: string, params?: (string | number)[]) => queryRows<R>(candidate, sql, params),
            get: <R>(sql: string, params?: (string | number)[]) => queryRows<R>(candidate, sql, params)[0] ?? null,
          };
          candidate.run('BEGIN');
          let result: T;
          try {
            result = mutate(transaction);
            if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
              drainOwned(result);
              throw new Error('HandlerSqliteStore transaction must be synchronous');
            }
            candidate.run('COMMIT');
          } catch (error) { candidate.run('ROLLBACK'); throw error; }
          const current = () => { this.assertActiveStorage(); if (this.options.beforeWrite) synchronousFence(this.options.beforeWrite); this.assertActiveStorage(); };
          current();
          prepared = await this.stageImage(tmpPath, candidate.export(), current);
          const staged = prepared; staged.assertCurrent();
          // The trusted fence cannot yield. A synchronous rename closes the
          // otherwise unavoidable gap between checking and replacing the file.
          let finished = false, attempted = false, active = true;
          const publish = (publicationCurrent: () => void) => {
            if (!active || attempted) throw new Error('HandlerSqliteStore publication is not current');
            attempted = true;
            synchronousFence(publicationCurrent); synchronousFence(assertCurrent); current(); staged.assertCurrent();
            if (this.db !== live) throw new Error('HandlerSqliteStore transaction lost its database');
            if (this.mutationRevision !== revision) { finished = true; return; }
            this.noteForeignWriter();
            renameSync(tmpPath, this.resolvedPath);
            this.rememberPublishedIdentity();
            this.db = candidate;
            this.mutationRevision += 1;
            published = true;
            try { live.close(); } catch { /* Publication already succeeded. */ }
            finished = true;
          };
          try {
            if (withPublication) await withPublication(publish);
            else publish(() => {});
            if (!finished) throw new Error('HandlerSqliteStore publication did not finish');
          } finally { active = false; }
          if (!published) continue;
          return result;
        } finally {
          if (!published) candidate.close();
          prepared?.cleanup();
        }
      }
    });
    const completed = operation.finally(() => { this.stagedTransactions -= 1; });
    const tail = completed.then(() => {}, () => {});
    HandlerSqliteStore.saveTails.set(this.resolvedPath, tail);
    void tail.then(() => {
      if (HandlerSqliteStore.saveTails.get(this.resolvedPath) === tail) HandlerSqliteStore.saveTails.delete(this.resolvedPath);
    });
    return completed;
  }

  close(): void {
    this.closed = true;
    this.releaseWriterLock();
    if (this.db) {
      // A save admitted behind a staged transaction exports when it runs; keep
      // the last image so closing does not turn that save into a failure that
      // drops the writes made before it.
      if (this.stagedTransactions > 0) this.finalImage = this.db.export();
      this.db.close();
      this.db = null;
    }
  }

  /** BEGIN/COMMIT around fn; ROLLBACK on throw (synchronous sql.js). */
  transaction(fn: () => void): void {
    const db = this.requireDb();
    this.mutationRevision += 1;
    db.run('BEGIN');
    try {
      fn();
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
}

function queryRows<T>(db: SqlDatabase, sql: string, params?: (string | number)[]): T[] {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  const { columns, values } = result[0]!;
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T);
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
