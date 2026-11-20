/**
 * Store snapshots: point-in-time copies of the SQLite files the platform
 * writes, kept beside each store under `snapshots/<db-file-name>/`.
 *
 * Three jobs:
 * - `snapshotStoreFile`, one consistent copy taken by SQLite itself
 *   (`VACUUM INTO`, so a store in WAL mode is copied with every committed
 *   change and needs no sidecar), checked for the SQLite header; used before
 *   schema migrations. `snapshotStoreFileAsync` copies the file and its WAL
 *   off the event loop under a held read transaction, for the daily
 *   scheduler and the tripwire exit;
 * - `restoreStoreSnapshot`, ONE command back to a snapshot: parks the
 *   current file at `<db>.pre-restore` (replacing what an earlier restore
 *   parked there), then replaces it with the snapshot (latest when none is
 *   named);
 * - `StoreSnapshotScheduler`, a daily snapshot of every registered store
 *   with bounded retention through the existing retention engine
 *   (RetentionPolicy + SnapshotPruner deleting real files). A snapshot and
 *   its `-wal`/`-shm` sidecars (written by a file copy) are removed together.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { RetentionPolicy } from '../runtime/retention/policy.js';
import { SnapshotPruner } from '../runtime/retention/pruner.js';
import type { RetentionClass } from '../runtime/retention/types.js';

// Composition surface: a consumer composing the scheduler with its own
// retention bounds needs the engine pieces this module builds on, so they
// travel with this entry point instead of forcing a behavioral re-implementation.
export { RetentionPolicy } from '../runtime/retention/policy.js';
export { SnapshotPruner } from '../runtime/retention/pruner.js';
export type { RetentionClass } from '../runtime/retention/types.js';

export const STORE_SNAPSHOT_DIR = 'snapshots';
const SNAPSHOT_SUFFIX = '.snapshot';
const SIDECARS = ['-wal', '-shm'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRealDbPath(dbPath: string): boolean {
  return dbPath.length > 0 && dbPath !== ':memory:';
}

/** Directory a store's snapshots live in: `<db dir>/snapshots/<db file name>/`. */
export function storeSnapshotDir(dbPath: string): string {
  return join(dirname(dbPath), STORE_SNAPSHOT_DIR, basename(dbPath));
}

const SQLITE_HEADER = 'SQLite format 3\0';

function hasSqliteHeader(path: string): boolean {
  if (statSync(path).size < SQLITE_HEADER.length) return false;
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    return header.toString('latin1') === SQLITE_HEADER;
  } finally { closeSync(fd); }
}

/** A file copy is kept only when it is as large as its source and still opens with the SQLite header. */
function assertCopyComplete(source: string, copy: string): void {
  const expected = statSync(source).size;
  const copied = statSync(copy);
  if (copied.size !== expected) throw new Error(`store snapshot copy is incomplete: ${copy} has ${copied.size} of ${expected} bytes`);
  if (expected < SQLITE_HEADER.length) return;
  if (!hasSqliteHeader(copy)) throw new Error(`store snapshot copy is not a SQLite database: ${copy}`);
}

// bun:sqlite is a Bun-only builtin; resolved on first use so Node can load this module.
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database | null {
  if (databaseCtor) return databaseCtor;
  try { databaseCtor = (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database; }
  catch { return null; }
  return databaseCtor;
}

/**
 * One consistent copy through SQLite: committed WAL content included, no
 * sidecars. False when it cannot be taken this way (no bun:sqlite, or a
 * schema this connection cannot rebuild, such as a virtual table whose
 * module is not loaded); the caller then copies the files.
 */
function vacuumInto(dbPath: string, snapshotPath: string): boolean {
  const Ctor = bunDatabase();
  if (!Ctor) return false;
  let db: Database | undefined;
  try {
    // The copy keeps the source's mode (stores are private to their owner);
    // VACUUM INTO accepts an existing empty file.
    closeSync(openSync(snapshotPath, 'wx', statSync(dbPath).mode & 0o777));
    // Read-only: never creates the store, and never checkpoints it on close.
    db = new Ctor(dbPath, { readonly: true });
    db.run('PRAGMA busy_timeout = 5000');
    db.run('VACUUM INTO ?', [snapshotPath]);
    return true;
  } catch (error) {
    try { unlinkSync(snapshotPath); } catch { /* nothing was written */ }
    logger.debug('store snapshot falls back to a file copy', { store: basename(dbPath), error: summarizeError(error) });
    return false;
  } finally { db?.close(); }
}

/** The `-wal`/`-shm` files a file-copied snapshot carries, as they exist now. */
function snapshotSidecars(snapshotPath: string): string[] {
  return SIDECARS.map(sidecar => `${snapshotPath}${sidecar}`).filter(path => existsSync(path));
}

/**
 * Folds a database's WAL into the file itself (one checkpoint, then the
 * connection closes and SQLite removes the emptied sidecars), so the file
 * alone holds every committed change and can be renamed into place as one
 * unit. False when SQLite is not available here.
 */
function foldIntoFile(dbPath: string): boolean {
  const Ctor = bunDatabase();
  if (!Ctor) return false;
  let db: Database | undefined;
  try {
    db = new Ctor(dbPath);
    db.run('PRAGMA busy_timeout = 5000');
    const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: unknown } | null;
    // A checkpoint another connection blocked did not fold everything.
    if (result && result.busy !== 0 && result.busy !== undefined) return false;
  } catch (error) {
    // A damaged store (the usual reason to restore) may not open: it is then kept with its sidecars as they are.
    logger.debug('store journal could not be folded into its file', { store: basename(dbPath), error: summarizeError(error) });
    return false;
  } finally { db?.close(); }
  removeSidecars(dbPath);
  return true;
}

function removeSidecars(snapshotPath: string): void {
  for (const sidecar of SIDECARS) {
    try { unlinkSync(`${snapshotPath}${sidecar}`); } catch { /* absent */ }
  }
}

function timestampSlug(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/**
 * A free path for a new snapshot of `dbPath` taken at `at` for `reason`, its
 * directory made: the name `listStoreSnapshots` and `restoreStoreSnapshot` read.
 * Timestamp slugs are millisecond-granular: two snapshots requested within the
 * same millisecond (fast successive sweeps on tmpfs) must not silently
 * overwrite each other, so the name is made unique instead of clobbering.
 */
export function newStoreSnapshotPath(dbPath: string, reason: string, at: number = Date.now()): string {
  const dir = storeSnapshotDir(dbPath);
  mkdirSync(dir, { recursive: true });
  let snapshotPath = join(dir, `${timestampSlug(at)}.${reason}${SNAPSHOT_SUFFIX}`);
  for (let counter = 1; existsSync(snapshotPath); counter += 1) {
    snapshotPath = join(dir, `${timestampSlug(at)}-${counter}.${reason}${SNAPSHOT_SUFFIX}`);
  }
  return snapshotPath;
}

/**
 * Snapshot the store into the snapshot dir: one consistent SQLite copy, or,
 * when SQLite cannot take one, a copy of the file and its WAL. Returns the
 * snapshot path, or null when there is nothing to snapshot (in-memory store,
 * missing file, or empty file).
 */
export function snapshotStoreFile(
  dbPath: string,
  reason: string,
  options: { now?: () => number } = {},
): string | null {
  if (!isRealDbPath(dbPath) || !existsSync(dbPath)) return null;
  if (statSync(dbPath).size === 0) return null;
  const at = (options.now ?? Date.now)();
  const snapshotPath = newStoreSnapshotPath(dbPath, reason, at);
  if (!hasSqliteHeader(dbPath)) throw new Error(`store snapshot source is not a SQLite database: ${dbPath}`);
  if (!vacuumInto(dbPath, snapshotPath)) publishCopiedSnapshot(dbPath, snapshotPath);
  // Stamp the snapshot's mtime with its LOGICAL creation time: listStoreSnapshots
  // reads createdAt from the filesystem mtime while the scheduler dedups on the
  // injectable clock, so under an injected time the wall-clock mtime would make
  // the day-boundary comparison misfire. A no-op in production (now IS the wall
  // clock); under injection the two clocks agree. Stamping failure is non-fatal,
  // the copy is already safe, only dedup precision degrades.
  try {
    const atSeconds = at / 1000;
    utimesSync(snapshotPath, atSeconds, atSeconds);
  } catch (error) {
    logger.warn('store snapshot mtime stamp failed', { snapshotPath, error: summarizeError(error) });
  }
  logger.info('store snapshot written', { store: basename(dbPath), reason, snapshotPath });
  return snapshotPath;
}

/**
 * A copied snapshot appears under its name only when it is complete: the file
 * and its WAL are copied under staged names, then the WAL is renamed to its
 * sidecar name and the file to the snapshot's name last. A crash before the
 * last rename leaves no snapshot (an orphan WAL, which the next listing
 * removes), never a snapshot without its WAL.
 */
function publishStagedSnapshot(staged: string, snapshotPath: string): void {
  if (existsSync(`${staged}-wal`)) renameSync(`${staged}-wal`, `${snapshotPath}-wal`);
  renameSync(staged, snapshotPath);
}

function discardStagedSnapshot(staged: string): void {
  try { unlinkSync(staged); } catch { /* nothing was kept */ }
  removeSidecars(staged);
}

function publishCopiedSnapshot(dbPath: string, snapshotPath: string): void {
  const staged = `${snapshotPath}.partial`;
  try {
    copyFileSync(dbPath, staged);
    assertCopyComplete(dbPath, staged);
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${staged}-wal`);
    publishStagedSnapshot(staged, snapshotPath);
  } catch (error) {
    discardStagedSnapshot(staged);
    throw error;
  }
}

export interface StoreSnapshotInfo {
  readonly path: string;
  readonly createdAt: number;
  /** The snapshot file and its sidecars together. */
  readonly sizeBytes: number;
  readonly reason: string;
  /** `-wal`/`-shm` files that belong to this snapshot; removed with it. */
  readonly sidecars: readonly string[];
}

/** All snapshots for a store, newest first. Sidecars whose snapshot is gone are removed. */
export function listStoreSnapshots(dbPath: string): StoreSnapshotInfo[] {
  if (!isRealDbPath(dbPath)) return [];
  const dir = storeSnapshotDir(dbPath);
  if (!existsSync(dir)) return [];
  const entries: StoreSnapshotInfo[] = [];
  const names = readdirSync(dir);
  const snapshots = new Set(names.filter(name => name.endsWith(SNAPSHOT_SUFFIX)));
  for (const name of names) {
    const sidecar = SIDECARS.find(suffix => name.endsWith(`${SNAPSHOT_SUFFIX}${suffix}`));
    if (sidecar && !snapshots.has(name.slice(0, -sidecar.length))) {
      try { unlinkSync(join(dir, name)); } catch { /* removed by another sweep */ }
    }
  }
  for (const name of snapshots) {
    const path = join(dir, name);
    const stat = statSync(path);
    const reasonMatch = name.match(/\.([^.]+)\.snapshot$/);
    const sidecars = snapshotSidecars(path);
    entries.push({
      path,
      createdAt: stat.mtimeMs,
      sizeBytes: stat.size + sidecars.reduce((total, sidecar) => total + statSync(sidecar).size, 0),
      reason: reasonMatch?.[1] ?? 'unknown',
      sidecars,
    });
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export interface RestoreStoreSnapshotResult {
  readonly restoredFrom: string;
  /** Where the replaced live file was parked (null when none existed). */
  readonly keptCurrentAt: string | null;
}

/**
 * ONE command back to a snapshot. The store must be closed by the caller.
 * With no snapshot named, the latest one is used; the replaced live file is
 * parked at `<path>.pre-restore`, so a wrong restore can be undone. One
 * parked copy is kept per store: a later restore replaces it.
 */
export function restoreStoreSnapshot(dbPath: string, snapshotPath?: string): RestoreStoreSnapshotResult {
  if (!isRealDbPath(dbPath)) {
    throw new Error(`cannot restore an in-memory store (${dbPath || 'empty path'})`);
  }
  const source = snapshotPath ?? listStoreSnapshots(dbPath)[0]?.path;
  if (!source) {
    throw new Error(`no snapshots exist for ${dbPath} under ${storeSnapshotDir(dbPath)}, nothing to restore`);
  }
  if (!existsSync(source)) {
    throw new Error(`snapshot not found: ${source}`);
  }
  // Each side of the swap is one self-contained file: the live store's WAL is
  // folded into it first, and the snapshot is staged with its WAL folded in.
  // Then the only multi-file step left is removing the (now empty) live
  // sidecars before one rename: a crash at any point leaves the live store
  // whole or the restored one whole, never a file beside a journal that is
  // not its own.
  let keptCurrentAt: string | null = null;
  if (existsSync(dbPath)) {
    const folded = foldIntoFile(dbPath);
    keptCurrentAt = `${dbPath}.pre-restore`;
    // The parked copy replaces the previous one only once it is complete.
    const parking = `${keptCurrentAt}.partial`;
    discardStagedSnapshot(parking);
    copyFileSync(dbPath, parking);
    if (!folded) for (const sidecar of SIDECARS) {
      if (existsSync(`${dbPath}${sidecar}`)) copyFileSync(`${dbPath}${sidecar}`, `${parking}${sidecar}`);
    }
    removeSidecars(keptCurrentAt);
    for (const sidecar of SIDECARS) if (existsSync(`${parking}${sidecar}`)) renameSync(`${parking}${sidecar}`, `${keptCurrentAt}${sidecar}`);
    renameSync(parking, keptCurrentAt);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  // Written beside the target and renamed, so a crash leaves the old file or the whole snapshot, never half of one.
  const pending = `${dbPath}.restore-${process.pid}.tmp`;
  try {
    copyFileSync(source, pending);
    assertCopyComplete(source, pending);
    for (const sidecar of SIDECARS) {
      if (existsSync(`${source}${sidecar}`)) copyFileSync(`${source}${sidecar}`, `${pending}${sidecar}`);
    }
    if (!foldIntoFile(pending)) throw new Error(`the snapshot ${source} could not be opened to fold its journal into it, so it was not restored`);
    if (!hasSqliteHeader(pending)) throw new Error(`the restored copy is not a SQLite database: ${pending}`);
    // The live sidecars belong to the file being replaced: left in place they would be replayed onto the snapshot.
    for (const sidecar of SIDECARS) {
      if (existsSync(`${dbPath}${sidecar}`)) unlinkSync(`${dbPath}${sidecar}`);
    }
    renameSync(pending, dbPath);
  } catch (error) {
    discardStagedSnapshot(pending);
    throw error;
  }
  logger.info('store restored from snapshot', { store: basename(dbPath), restoredFrom: source, keptCurrentAt });
  return { restoredFrom: source, keptCurrentAt };
}

export interface SnapshotStoreTarget {
  readonly name: string;
  readonly dbPath: string;
}

export interface StoreSnapshotSchedulerOptions {
  readonly stores: readonly SnapshotStoreTarget[];
  /**
   * Whether new work is admitted (daemon/work-admission.ts). While it is not (a
   * self-update's restart) no snapshot starts, so none is cut off; a day-old
   * store is still due (read from the snapshot files) at the next check.
   */
  readonly workAdmitted?: (() => boolean) | undefined;
  /** Daily-snapshot retention class limits; bounded by default. */
  readonly retention?: RetentionPolicy | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** How often the scheduler wakes to check due-ness (hourly by default). */
  readonly checkIntervalMs?: number | undefined;
}

const DAILY_RETENTION_CLASS: RetentionClass = 'standard';
const PRE_MIGRATION_RETENTION_CLASS: RetentionClass = 'forensic';

/** Bounded defaults for store snapshots: 14 daily copies / 30 forensic days. */
export function defaultStoreSnapshotRetention(): RetentionPolicy {
  return new RetentionPolicy(
    {
      standard: { maxAgeMs: 14 * DAY_MS, maxCount: 14, maxSizeBytes: 512 * 1024 * 1024 },
      forensic: { maxAgeMs: 30 * DAY_MS, maxCount: 30, maxSizeBytes: 1024 * 1024 * 1024 },
    },
    undefined,
    new SnapshotPruner(),
  );
}

/**
 * A read transaction on the store, held until the returned release runs, or
 * null when SQLite is unavailable or refuses (the copy is then unpinned).
 * While it is held no checkpoint moves past its snapshot and the WAL cannot
 * restart, so a copy of the file plus a copy of the WAL replays to one
 * committed state. Read-only, so closing it never checkpoints the store.
 */
function holdReadSnapshot(dbPath: string): (() => void) | null {
  const Ctor = bunDatabase();
  if (!Ctor) return null;
  let db: Database | undefined;
  try {
    db = new Ctor(dbPath, { readonly: true });
    db.run('PRAGMA busy_timeout = 5000');
    // Outside WAL mode a held read would block the store's writers for the whole copy.
    const mode = db.query('PRAGMA journal_mode').get() as { journal_mode?: unknown } | null;
    if (mode?.journal_mode !== 'wal') { db.close(); return null; }
    db.run('BEGIN');
    db.query('SELECT count(*) FROM sqlite_master').get();
    const held = db;
    return () => {
      try { held.run('ROLLBACK'); } catch { /* the transaction ends with the connection */ }
      held.close();
    };
  } catch (error) {
    db?.close();
    logger.debug('store snapshot copies without a read transaction', { store: basename(dbPath), error: summarizeError(error) });
    return null;
  }
}

/**
 * {@link snapshotStoreFile} off the event loop: the same path/uniquify/mtime
 * logic with threadpool copies (fs/promises) of the file and its WAL, taken
 * under a held read transaction so the pair is one consistent state. Used by
 * the daily scheduler, and by callers whose deadline must remain enforceable
 * while the disk stalls (the memory-governor tripwire exit).
 */
export async function snapshotStoreFileAsync(
  dbPath: string,
  reason: string,
  options: { now?: () => number } = {},
): Promise<string | null> {
  if (!isRealDbPath(dbPath) || !existsSync(dbPath)) return null;
  if (statSync(dbPath).size === 0) return null;
  const at = (options.now ?? Date.now)();
  const snapshotPath = newStoreSnapshotPath(dbPath, reason, at);
  if (!hasSqliteHeader(dbPath)) throw new Error(`store snapshot source is not a SQLite database: ${dbPath}`);
  // Threadpool copies keep the event loop free on a stalled disk; the WAL
  // goes with the file so committed changes are not lost. The shared-memory
  // index is rebuilt on open and is not copied.
  const release = holdReadSnapshot(dbPath);
  try {
    const walPath = `${dbPath}-wal`;
    const pinnedWal = release !== null && existsSync(walPath);
    const staged = `${snapshotPath}.partial`;
    try {
      await copyFile(dbPath, staged);
      // Under a held snapshot a checkpoint may still write frames the WAL copy
      // also carries into the file, so its size can move; the header still has to hold.
      if (pinnedWal) { if (!hasSqliteHeader(staged)) throw new Error(`store snapshot copy is not a SQLite database: ${snapshotPath}`); }
      else assertCopyComplete(dbPath, staged);
      if (existsSync(walPath)) await copyFile(walPath, `${staged}-wal`);
      publishStagedSnapshot(staged, snapshotPath);
    } catch (error) {
      discardStagedSnapshot(staged);
      throw error;
    }
  } finally { release?.(); }
  try {
    const atSeconds = at / 1000;
    utimesSync(snapshotPath, atSeconds, atSeconds);
  } catch (error) {
    logger.warn('store snapshot mtime stamp failed', { snapshotPath, error: summarizeError(error) });
  }
  logger.info('store snapshot written', { store: basename(dbPath), reason, snapshotPath });
  return snapshotPath;
}

/**
 * Daily snapshots of every registered store, with bounded retention driven
 * through the retention engine after every sweep. Time and timers are
 * injectable; the loop never keeps the process alive.
 */
export class StoreSnapshotScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly retention: RetentionPolicy;

  constructor(private readonly options: StoreSnapshotSchedulerOptions) {
    this.retention = options.retention ?? defaultStoreSnapshotRetention();
  }

  private get checkIntervalMs(): number {
    return this.options.checkIntervalMs ?? 60 * 60 * 1000;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    // One chain of timers: a second start() or a manual tick() must not leave an earlier timer running beside it.
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      void this.tick();
    }, this.checkIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One sweep: snapshot stores whose newest daily copy is a day old, then prune. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.options.workAdmitted?.() === false) { this.scheduleNext(); return; }
    try {
      const now = (this.options.now ?? Date.now)();
      for (const store of this.options.stores) {
        try {
          const newestDaily = listStoreSnapshots(store.dbPath).find((snapshot) => snapshot.reason === 'daily');
          if (!newestDaily || now - newestDaily.createdAt >= DAY_MS) {
            await snapshotStoreFileAsync(store.dbPath, 'daily', { now: () => now });
          }
        } catch (error) {
          logger.warn('daily store snapshot failed', { store: store.name, error: summarizeError(error) });
        }
      }
      await this.pruneRegisteredSnapshots();
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Snapshot every registered store NOW using ASYNC (threadpool) file copies.
   * This is the tripwire-exit path: synchronous copyFileSync on a stalled disk
   * blocks the event loop itself, so no outer timeout could ever fire, async
   * copyFile keeps the loop free and lets the governor's shutdown ceiling
   * genuinely bound the work. Best-effort per store; no pruning.
   */
  async snapshotAllAsync(reason: string): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    for (const store of this.options.stores) {
      try {
        await snapshotStoreFileAsync(store.dbPath, reason, { now: () => now });
      } catch (error) {
        logger.warn('async store snapshot failed', { store: store.name, error: summarizeError(error) });
      }
    }
  }

  /** Register every snapshot on disk with the retention engine, then prune. */
  async pruneRegisteredSnapshots(): Promise<void> {
    for (const store of this.options.stores) {
      for (const snapshot of listStoreSnapshots(store.dbPath)) {
        this.retention.register({
          id: snapshot.path,
          createdAt: snapshot.createdAt,
          sizeBytes: snapshot.sizeBytes,
          retentionClass: snapshot.reason === 'daily' ? DAILY_RETENTION_CLASS : PRE_MIGRATION_RETENTION_CLASS,
          path: snapshot.path,
        });
      }
    }
    try {
      const result = await this.retention.prune();
      if (result.deletedIds.length > 0) {
        // Ids are snapshot paths; a pruned snapshot takes its sidecars with it.
        for (const id of result.deletedIds) { removeSidecars(id); this.retention.unregister(id); }
        logger.info('store snapshot retention pruned', { deleted: result.deletedIds.length, reclaimedBytes: result.reclaimedBytes });
      }
    } catch (error) {
      logger.warn('store snapshot retention prune failed', { error: summarizeError(error) });
    }
  }
}
