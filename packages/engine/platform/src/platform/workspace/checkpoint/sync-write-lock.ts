import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** The pid recorded in a writer lock, or null when the file is unreadable or not in the lock format. */
function readHolderPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

/**
 * Remove a writer lock whose recorded holder process is gone (ESRCH). Only a
 * proven-dead pid is taken over, never an age or an unreadable file, so a live
 * writer is never displaced. The inode is compared before and after the pid
 * check so a lock a new holder published in between is left alone.
 */
function reclaimDeadHolderLock(lockPath: string): boolean {
  let before;
  try { before = statSync(lockPath); } catch { return true; }
  const pid = readHolderPid(lockPath);
  if (pid === null) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  try {
    const after = statSync(lockPath);
    if (after.dev !== before.dev || after.ino !== before.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return true;
  }
}

/** Atomically publish a populated writer lock and refuse contention before reading. A lock left by a dead process is reclaimed. */
export function withFileWriteLockSync<T>(path: string, write: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${lockPath}.owner-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), acquiredAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  const identity = statSync(temporary);
  try {
    try {
      linkSync(temporary, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!reclaimDeadHolderLock(lockPath)) {
        throw Object.assign(new Error(`File writer lock ${lockPath} is owned by a running process; retry once it finishes.`), { code: 'FILE_WRITER_BUSY' });
      }
      try {
        linkSync(temporary, lockPath);
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code !== 'EEXIST') throw retry;
        throw Object.assign(new Error(`File writer lock ${lockPath} was taken by another process while reclaiming a dead holder's lock; retry.`), { code: 'FILE_WRITER_BUSY' });
      }
    }
  } finally { unlinkSync(temporary); }
  try { return write(); } finally {
    try {
      const current = statSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
    } catch {
      // The lock was already reclaimed; the write's own result stands.
    }
  }
}
