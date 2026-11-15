import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessLockBusyError, withProcessLock } from '../platform/src/platform/utils/process-lock.ts';

/**
 * Mutual exclusion for BUILDS only (build.ts, package staging), so two builders
 * never write the same output tree at once. Tests do not take it: they run from
 * source (the `bun` export condition) and read nothing a build rewrites.
 *
 * The lock is the kernel-released process lock: a builder that is killed
 * leaves nothing held, so there is no owner record and nothing to take over.
 * It is not reentrant; a caller that already holds it runs its inner step
 * unlocked.
 */
const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_PATH = resolve(ENGINE_ROOT, '.tmp/build.writer.sqlite');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function withWorkspaceLock<T>(label: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS, lockPath = DEFAULT_LOCK_PATH): Promise<T> {
  let started = false;
  try {
    return await withProcessLock(lockPath, () => { started = true; return fn(); }, { waitMs: timeoutMs });
  } catch (error) {
    if (!started && error instanceof ProcessLockBusyError) {
      throw new Error(`The build lock ${lockPath} stayed held by ${error.heldBy === 'this-process' ? 'other work in this process' : 'another build'} for ${Math.round(error.waitedMs / 1000)} s, so "${label}" did not start. Nothing was written; run it again once that build finishes.`, { cause: error });
    }
    throw error;
  }
}
