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
 * When the lock cannot be taken (another process holds it past the wait, or the
 * directory cannot hold the lock file) the operation still runs, unlocked, with
 * a warning: the caller's change is the user's intent, and dropping it would be
 * worse than the lost-update window this lock narrows.
 */
import { resolve } from 'node:path';
import { withProcessLockSync } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** How long a writer waits for another process's read-and-write before saving without the lock. */
const WAIT_MS = 500;

/** Lock paths this process holds right now, so a nested call joins instead of being refused by its own hold. */
const heldHere = new Set<string>();

/** The lock file for `target`. */
export function syncFileLockPath(target: string): string {
  return `${resolve(target)}.writer.sqlite`;
}

/** Run `operation` with the lock for `target` held, releasing it however the operation ends. */
export function withSyncFileLock<T>(target: string, operation: () => T): T {
  const lock = syncFileLockPath(target);
  if (heldHere.has(lock)) return operation();
  let entered = false;
  try {
    return withProcessLockSync(lock, () => {
      entered = true;
      heldHere.add(lock);
      try { return operation(); } finally { heldHere.delete(lock); }
    }, { waitMs: WAIT_MS });
  } catch (error) {
    if (entered) throw error;
    logger.warn('Shared file lock could not be taken; saving without it', { lock, error: summarizeError(error) });
    return operation();
  }
}
