/**
 * One lock shared by every process on this machine, released by the kernel
 * when its holder exits, however it exits.
 *
 * The lock is a SQLite write reservation (`BEGIN IMMEDIATE`) on an empty file.
 * SQLite takes it with an OS byte-range lock, so a crashed or killed holder
 * leaves nothing behind: there is no pid to check, no age to judge and nothing
 * to take over. The file stays empty and is never removed; removing it would
 * let two holders lock two different files.
 *
 * Within one process, holders of one path queue in order and only the head of
 * the queue touches the file. A synchronous caller cannot wait for an
 * asynchronous holder in its own process (it would block the event loop the
 * holder needs to finish), so it is refused at once instead.
 *
 * A store on its own SQLite file needs no separate lock: its transactions are
 * the lock.
 */
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { assertProjectFolderReachable } from '../workspace/project-folder-guard.js';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';

// bun:sqlite is a Bun-only builtin; a static import would make every importer
// of the utils entry point unloadable under Node. Resolve it on first use.
let databaseCtor: typeof import('bun:sqlite').Database | null = null;
function sqliteDatabase(): typeof import('bun:sqlite').Database {
  return (databaseCtor ??= createRequire(import.meta.url)('bun:sqlite').Database);
}

/** How long a caller waits for another holder unless it says otherwise. */
export const DEFAULT_PROCESS_LOCK_WAIT_MS = 10_000;
const FIRST_RETRY_MS = 5;
const MAX_RETRY_MS = 100;

export interface ProcessLockOptions {
  /** How long to wait for another holder before refusing; 0 tries once. Default 10 s. */
  readonly waitMs?: number | undefined;
  /** Stops the wait. It does not interrupt the locked work once that has started. */
  readonly signal?: AbortSignal | undefined;
}

export interface HeldProcessLock {
  /** Give the lock up. Safe to call more than once. */
  release(): void;
}

/** The lock is held by someone else and stayed held for the whole wait. */
export class ProcessLockBusyError extends Error {
  readonly code = 'PROCESS_LOCK_BUSY';
  readonly retryable = true;
  constructor(
    readonly lockPath: string,
    readonly heldBy: 'this-process' | 'another-process',
    readonly waitedMs: number,
  ) {
    super(heldBy === 'this-process'
      ? `The lock ${lockPath} is held by other work in this process and cannot be waited for here. Nothing was changed; retry once that work finishes.`
      : `The lock ${lockPath} is held by another process and stayed held for ${waitedMs} ms. Nothing was changed; retry once that process finishes.`);
    this.name = 'ProcessLockBusyError';
  }
}

/** The lock file cannot be locked at all: a filesystem without file locks, or a file that is not a lock file. */
export class ProcessLockUnavailableError extends Error {
  readonly code = 'PROCESS_LOCK_UNAVAILABLE';
  readonly retryable = false;
  constructor(readonly lockPath: string, cause: unknown) {
    const detail = (cause as { code?: unknown } | null)?.code;
    super(`The lock ${lockPath} could not be taken (${typeof detail === 'string' ? detail : 'unknown error'}). `
      + `Its directory must be on a local disk that supports file locks, and the file must be empty or a lock file written by this program; `
      + `move the state directory to a local disk, or remove the file while no other GoodVibes process is running.`, { cause });
    this.name = 'ProcessLockUnavailableError';
  }
}

/** In-process queue for one lock path. `held` is true while a caller in this process owns the path; waiters exist only then. */
interface PathState {
  held: boolean;
  readonly waiters: Array<() => void>;
}

/** An open connection to one lock file, kept between holds, with the identity of the file it opened. */
interface LockFile {
  readonly db: Database;
  readonly dev: number;
  readonly ino: number;
  busyTimeoutMs: number;
}

const pathStates = new Map<string, PathState>();
/** Most recently used last. Opening a connection costs more than the lock itself, so idle ones are kept, up to a bound. */
const openFiles = new Map<string, LockFile>();
const MAX_IDLE_FILES = 32;

function stateFor(key: string): PathState {
  let state = pathStates.get(key);
  if (!state) {
    state = { held: false, waiters: [] };
    pathStates.set(key, state);
  }
  return state;
}

/** Pass the in-process slot to the next waiter, or free it. */
function handOff(key: string, state: PathState): void {
  const next = state.waiters.shift();
  if (next) { next(); return; }
  state.held = false;
  if (pathStates.get(key) === state) pathStates.delete(key);
}

function identity(key: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(key);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function forget(key: string, file: LockFile): void {
  if (openFiles.get(key) === file) openFiles.delete(key);
  // SQLite keeps the descriptor open while another connection of this process
  // holds a lock on the same file, so this close never drops someone's lock.
  file.db.close();
}

/**
 * The connection for `key`, opened on first use and reused while the file at
 * `key` is still the file it opened. A file that was removed or replaced (its
 * directory deleted, say) is opened afresh, so the lock is never taken on a
 * file other processes can no longer see. Only called by the in-process owner
 * of `key`.
 */
function lockFileFor(key: string): LockFile {
  const current = identity(key);
  const cached = openFiles.get(key);
  if (cached) {
    if (current && current.dev === cached.dev && current.ino === cached.ino) {
      openFiles.delete(key);
      openFiles.set(key, cached);
      return cached;
    }
    forget(key, cached);
  }
  if (!current) {
    assertProjectFolderReachable(key);
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
    // Created here only so it is private. The file is new, so no connection of
    // this process has it open and this close cannot drop a lock it holds.
    try { closeSync(openSync(key, 'wx', 0o600)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let db: Database;
  try {
    db = new (sqliteDatabase())(key);
    // Nothing is ever written, so there is no journal to look for: this
    // connection-only setting skips that check and halves the cost of a hold.
    db.exec('PRAGMA journal_mode = MEMORY');
  } catch (error) { throw new ProcessLockUnavailableError(key, error); }
  const opened = identity(key);
  if (!opened) { db.close(); throw new ProcessLockUnavailableError(key, Object.assign(new Error('lock file removed while opening'), { code: 'ENOENT' })); }
  const file: LockFile = { db, dev: opened.dev, ino: opened.ino, busyTimeoutMs: 0 };
  openFiles.set(key, file);
  trimIdleFiles();
  return file;
}

/** Close the least recently used idle connections beyond the bound. A connection whose path is held is never closed. */
function trimIdleFiles(): void {
  if (openFiles.size <= MAX_IDLE_FILES) return;
  for (const [key, file] of openFiles) {
    if (openFiles.size <= MAX_IDLE_FILES) return;
    if (pathStates.get(key)?.held) continue;
    forget(key, file);
  }
}

function setBusyTimeout(file: LockFile, ms: number): void {
  if (file.busyTimeoutMs === ms) return;
  file.db.exec(`PRAGMA busy_timeout = ${ms}`);
  file.busyTimeoutMs = ms;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

/** One attempt at the reservation. False when another holder has it. */
function tryReserve(key: string, file: LockFile): boolean {
  try {
    file.db.exec('BEGIN IMMEDIATE');
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    forget(key, file);
    throw new ProcessLockUnavailableError(key, error);
  }
}

function endReservation(key: string, file: LockFile): void {
  // Nothing was written, so the rollback only gives the reservation up. If it
  // fails, closing the connection gives it up instead.
  try { file.db.exec('ROLLBACK'); } catch { forget(key, file); }
}

function heldLock(key: string, state: PathState, file: LockFile): HeldProcessLock {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try { endReservation(key, file); } finally {
        handOff(key, state);
        trimIdleFiles();
      }
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  // `abort()` without an argument still sets an AbortError reason.
  return signal.reason;
}

/** Wait for this process's earlier holders of `key`. Resolves owning the in-process slot. */
function waitForTurn(key: string, state: PathState, deadline: number, started: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const wake = (): void => {
      if (settled) { handOff(key, state); return; }
      // An aborted waiter never takes the slot: it leaves with its reason and
      // the slot goes straight to the next waiter.
      if (signal?.aborted) {
        finish();
        reject(abortReason(signal));
        handOff(key, state);
        return;
      }
      finish();
      resolvePromise();
    };
    const leave = (error: unknown): void => {
      if (settled) return;
      finish();
      const index = state.waiters.indexOf(wake);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(error);
    };
    const onAbort = (): void => leave(abortReason(signal!));
    const timer = setTimeout(() => leave(new ProcessLockBusyError(key, 'this-process', Date.now() - started)), Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    state.waiters.push(wake);
  });
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortReason(signal!)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Take the file reservation, retrying while another process holds it. SQLite's
 * own wait would block the thread, so the wait is a timer that starts at 5 ms
 * and doubles to 100 ms; it runs only while another process holds the lock.
 */
async function reserveFile(key: string, deadline: number, started: number, signal: AbortSignal | undefined): Promise<LockFile> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    const file = lockFileFor(key);
    setBusyTimeout(file, 0);
    if (tryReserve(key, file)) return file;
    const left = deadline - Date.now();
    if (left <= 0) throw new ProcessLockBusyError(key, 'another-process', Date.now() - started);
    await pause(Math.min(delay, left), signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

/**
 * Take the lock at `path`, waiting up to `waitMs` for other holders. The caller
 * must release it. `waitMs: 0` takes the lock only if it is free right now: a
 * holder in this process or another one refuses it at once, with no timer turn.
 */
export async function acquireProcessLock(path: string, options: ProcessLockOptions = {}): Promise<HeldProcessLock> {
  const key = resolve(path);
  const started = Date.now();
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_PROCESS_LOCK_WAIT_MS);
  const deadline = started + waitMs;
  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);
  const state = stateFor(key);
  if (state.held && waitMs === 0) throw new ProcessLockBusyError(key, 'this-process', 0);
  if (state.held) await waitForTurn(key, state, deadline, started, signal);
  else state.held = true;
  try {
    return heldLock(key, state, await reserveFile(key, deadline, started, signal));
  } catch (error) {
    handOff(key, state);
    throw error;
  }
}

/**
 * Run `fn` while holding the lock at `path`, and release it when `fn` settles,
 * whether it returned or threw. `path` is the lock file itself; pick a name no
 * other format uses, such as `<store>.writer.sqlite`.
 */
export async function withProcessLock<T>(path: string, fn: () => T | Promise<T>, options: ProcessLockOptions = {}): Promise<T> {
  const lock = await acquireProcessLock(path, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * {@link withProcessLock} for a synchronous `fn`. The wait for another process
 * blocks this thread, so keep `waitMs` short off the start-up path. Refused at
 * once while other work in this process holds the same lock.
 */
export function withProcessLockSync<T>(path: string, fn: () => T, options: Pick<ProcessLockOptions, 'waitMs'> = {}): T {
  const key = resolve(path);
  const state = stateFor(key);
  if (state.held) throw new ProcessLockBusyError(key, 'this-process', 0);
  state.held = true;
  let file: LockFile;
  try {
    file = lockFileFor(key);
    setBusyTimeout(file, Math.max(0, Math.floor(options.waitMs ?? DEFAULT_PROCESS_LOCK_WAIT_MS)));
    const started = Date.now();
    if (!tryReserve(key, file)) throw new ProcessLockBusyError(key, 'another-process', Date.now() - started);
  } catch (error) {
    handOff(key, state);
    throw error;
  }
  const lock = heldLock(key, state, file);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Take the lock at `path` now, or return null when someone else holds it.
 * For a holder that keeps the lock for a long time: a poller, a leader, a
 * single writer. The kernel releases it if this process dies.
 */
export function holdProcessLock(path: string): HeldProcessLock | null {
  const key = resolve(path);
  const state = stateFor(key);
  if (state.held) return null;
  state.held = true;
  try {
    const file = lockFileFor(key);
    setBusyTimeout(file, 0);
    if (tryReserve(key, file)) return heldLock(key, state, file);
  } catch (error) {
    handOff(key, state);
    throw error;
  }
  handOff(key, state);
  return null;
}
