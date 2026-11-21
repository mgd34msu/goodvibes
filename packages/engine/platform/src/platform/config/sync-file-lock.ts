/**
 * sync-file-lock.ts, a short cross-process lock around a synchronous
 * read-modify-write of one shared file.
 *
 * The shared settings, subscription and announcement files are written by the
 * daemon, the TUI and the agent. An atomic rename keeps a file from tearing, but
 * two processes that each read the old object and rename their own copy over it
 * still lose one update. Holding this lock across the read and the write closes
 * that.
 *
 * The lock is the kernel-released process lock (`<file>.writer.sqlite` beside
 * the file): a holder that dies releases it with its process, so there is no
 * holder record, no stale rule and no reclaim. The critical sections are a file
 * read and a file write, so the wait is brief. Never hold it across a network
 * call.
 *
 * When the lock cannot be taken, `withSyncFileLock` decides by its `onBusy`
 * policy. `write-unlocked` (the default) still runs the operation, unlocked,
 * with a warning: the caller's change is the user's intent, and dropping it
 * would be worse than the lost-update window this lock narrows. `refuse` throws
 * ProcessLockBusyError when another process holds the lock past the wait, and
 * writes unlocked with a warning only when the directory cannot hold a lock
 * file at all. A write that can simply happen next time (a notice, a receipt)
 * uses `trySyncFileLock` instead, which skips the operation. Every form shares
 * one record of the locks this process holds, so a nested call on the same
 * file joins the outer hold instead of being refused by it.
 */
import { resolve } from 'node:path';
import { ProcessLockUnavailableError, withProcessLockSync } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** How long a writer waits for another process's read-and-write to the same file. */
const WAIT_MS = 1_000;

/** Lock paths this process holds right now, so a nested call joins instead of being refused by its own hold. */
const heldHere = new Set<string>();

/** The lock file for `target`. */
export function syncFileLockPath(target: string): string {
  return `${resolve(target)}.writer.sqlite`;
}

/** The outcome of {@link trySyncFileLock}: the operation's value, or that the lock could not be taken. */
export type SyncFileLockAttempt<T> = { readonly ran: true; readonly value: T } | { readonly ran: false; readonly error: unknown };

/**
 * Run `operation` with the lock for `target` held, or skip it when the lock
 * cannot be taken within the wait. Errors thrown by the operation propagate.
 */
export function trySyncFileLock<T>(target: string, operation: () => T): SyncFileLockAttempt<T> {
  const lock = syncFileLockPath(target);
  if (heldHere.has(lock)) return { ran: true, value: operation() };
  let entered = false;
  try {
    const value = withProcessLockSync(lock, () => {
      entered = true;
      heldHere.add(lock);
      try { return operation(); } finally { heldHere.delete(lock); }
    }, { waitMs: WAIT_MS });
    return { ran: true, value };
  } catch (error) {
    if (entered) throw error;
    return { ran: false, error };
  }
}

/**
 * Run `operation` with the lock for `target` held, releasing it however the
 * operation ends. When the lock cannot be taken, `onBusy` decides: see the
 * file header.
 */
export function withSyncFileLock<T>(target: string, operation: () => T, options: { readonly onBusy?: 'refuse' | 'write-unlocked' } = {}): T {
  const attempt = trySyncFileLock(target, operation);
  if (attempt.ran) return attempt.value;
  if (options.onBusy === 'refuse' && !(attempt.error instanceof ProcessLockUnavailableError)) throw attempt.error;
  logger.warn('Shared file lock could not be taken; saving without it', { lock: syncFileLockPath(target), error: summarizeError(attempt.error) });
  return operation();
}
