import { withCrossProcessLockSync, CrossProcessLockBusyError } from './cross-process-lock.js';

/**
 * Run a synchronous `write` of `path` while holding the lock `<path>.lock`, the
 * same lock the asynchronous writers of that store take. Never waits: a busy
 * lock throws `FILE_WRITER_BUSY` at once. A holder that died released the lock
 * with its process.
 */
export function withFileWriteLockSync<T>(path: string, write: () => T): T {
  try {
    return withCrossProcessLockSync(`${path}.lock`, write);
  } catch (error) {
    if (!(error instanceof CrossProcessLockBusyError)) throw error;
    throw Object.assign(new Error(error.message, { cause: error }), { code: 'FILE_WRITER_BUSY' });
  }
}
