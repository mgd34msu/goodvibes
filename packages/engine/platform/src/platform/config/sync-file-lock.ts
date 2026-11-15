/**
 * sync-file-lock.ts, a short cross-process lock around a synchronous
 * read-modify-write of one shared file.
 *
 * The shared settings and subscription files are written by the daemon, the TUI
 * and the agent. An atomic rename keeps a file from tearing, but two processes
 * that each read the old object and rename their own copy over it still lose
 * one update. Holding this lock across the read and the write closes that.
 *
 * The lock is a directory next to the file, recording its holder. A lock left by
 * a process that no longer exists is reclaimed; a live holder is waited for in
 * short slices. The critical sections are a file read and a file write, so the
 * wait is brief. Never hold it across a network call.
 *
 * When the lock cannot be taken (another live process holds it past the wait, a
 * lock with no holder record, a read-only directory) the operation still runs,
 * unlocked, with a warning: the caller's change is the user's intent, and
 * dropping it would be worse than the lost-update window this lock narrows.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describeOwnerLock, reclaimDeadOwnerLock, recordOwnerLockHolder, removeOwnerLockDirectory } from './durable-policy-epoch.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

const WAIT_ATTEMPTS = 20;
const WAIT_SLICE_MS = 25;

/** Lock paths this process holds right now, so a nested call joins instead of waiting on itself. */
const heldHere = new Set<string>();

let wait: (ms: number) => void = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** @internal Replace the blocking wait used while another live process holds the lock; returns a restore function. */
export function setSyncFileLockWaitForTest(replacement: (ms: number) => void): () => void {
  const previous = wait; wait = replacement;
  return () => { wait = previous; };
}

/** The directory that is the lock for `target`. */
export function syncFileLockPath(target: string): string {
  return `${resolve(target)}.lock`;
}

/** Take the lock; returns false (after a warning) when it could not be taken. */
function acquire(lock: string): boolean {
  try {
    mkdirSync(dirname(lock), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (reclaimDeadOwnerLock(lock)) continue;
        if (attempt >= WAIT_ATTEMPTS) {
          logger.warn('Shared file lock is still held; saving without it', { detail: describeOwnerLock(lock) });
          return false;
        }
        wait(WAIT_SLICE_MS);
      }
    }
    try { recordOwnerLockHolder(lock); } catch (error) { rmdirSync(lock); throw error; }
    return true;
  } catch (error) {
    logger.warn('Shared file lock could not be taken; saving without it', { lock, error: summarizeError(error) });
    return false;
  }
}

/** Run `operation` with the lock for `target` held, releasing it however the operation ends. */
export function withSyncFileLock<T>(target: string, operation: () => T): T {
  const lock = syncFileLockPath(target);
  if (heldHere.has(lock)) return operation();
  if (!acquire(lock)) return operation();
  heldHere.add(lock);
  try {
    return operation();
  } finally {
    heldHere.delete(lock);
    try { removeOwnerLockDirectory(lock); }
    catch (error) { logger.warn('Shared file lock could not be released', { lock, error: summarizeError(error) }); }
  }
}
