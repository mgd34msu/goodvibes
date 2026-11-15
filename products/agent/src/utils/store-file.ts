/**
 * Atomic JSON publication and transaction serialization for agent stores.
 * writeStoreFile prevents torn files; runStoreFileUpdate serializes async
 * transactions within this process and holds the same cross-process lock as
 * runStoreFileUpdateSync for the whole transaction, so a CLI process and a
 * running agent updating one store take turns.
 */
import { atomicWriteFileSync, type AtomicWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
import { dirname, resolve } from 'node:path';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Atomic single-file writes
// ---------------------------------------------------------------------------

/**
 * Write `contents` to `path` through the platform's atomic-write primitive
 * (private temp file, fsync, then rename), creating the parent directory if
 * needed. A failed write leaves `path` holding its previous contents; the platform
 * primitive removes its own temp file on failure.
 */
export function writeStoreFile(path: string, contents: string, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  atomicWriteFileSync(path, contents, { ...options, mkdirp: true });
}

/** {@link writeStoreFile} for the pretty-printed-JSON-plus-newline shape most stores use. */
export function writeStoreJson(path: string, data: unknown, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  writeStoreFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

// ---------------------------------------------------------------------------
// Serializing read-modify-write cycles that span an await
// ---------------------------------------------------------------------------

/**
 * One promise chain per store path, holding the tail of that path's queue.
 *
 * Keyed by resolved path, not by the object that happens to own the store, so
 * two registry instances built over one file serialize against each other.
 * Entries are dropped once a path's queue drains, so a long-lived process that
 * touches many stores does not accumulate them.
 */
const updateQueues = new Map<string, Promise<unknown>>();

/** The lock sidecar for a store path; created on first use and never removed. */
function openStoreLock(path: string): Database {
  const lockPath = `${resolve(path)}.writer.sqlite`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  closeSync(openSync(lockPath, 'a', 0o600));
  // SQLite owns the OS file lock, which is released even if a writer crashes.
  // Keep this sidecar in place: unlinking it would split concurrent lock owners.
  return new Database(lockPath);
}

const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 25;

function isLockBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked/i.test(error instanceof Error ? error.message : '');
}

/**
 * Take the cross-process lock without blocking the event loop: a busy lock is
 * retried on a timer, up to the same ten seconds the synchronous variant waits.
 */
async function acquireStoreLock(path: string): Promise<Database> {
  const lock = openStoreLock(path);
  lock.exec('PRAGMA busy_timeout = 0');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { lock.exec('BEGIN IMMEDIATE'); return lock; }
    catch (error) {
      if (!isLockBusy(error) || Date.now() >= deadline) { lock.close(); throw error; }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Serialize a synchronous read-modify-write transaction across CLI and agent processes. */
export function runStoreFileUpdateSync<T>(path: string, update: () => T): T {
  const lock = openStoreLock(path);
  try {
    lock.exec('PRAGMA busy_timeout = 10000');
    lock.exec('BEGIN IMMEDIATE');
    const result = update();
    lock.exec('COMMIT');
    return result;
  } finally { lock.close(); }
}

/**
 * Run `update` once every previously queued update for `path` has settled and
 * no other process holds the store's lock.
 *
 * Chains onto the queue regardless of whether earlier updates resolved or
 * rejected, so a failed update never wedges the ones behind it, and returns
 * `update`'s own result or rejection to its caller.
 */
export function runStoreFileUpdate<T>(path: string, update: () => Promise<T> | T): Promise<T> {
  const key = resolve(path);
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const locked = async (): Promise<T> => {
    const lock = await acquireStoreLock(key);
    try {
      const result = await update();
      lock.exec('COMMIT');
      return result;
    } finally { lock.close(); }
  };
  const run = previous.then(locked, locked);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  updateQueues.set(key, tail);
  void tail.then(() => {
    // Only the tail may clear the entry; a later enqueue has already replaced it.
    if (updateQueues.get(key) === tail) updateQueues.delete(key);
  });
  return run;
}
