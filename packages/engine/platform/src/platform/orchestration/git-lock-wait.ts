/**
 * A git lock another process holds while a commit wants it: waited for by its events, never by a clock.
 *
 * Git refuses a command whose lock file (`index.lock`, a ref's `.lock`) exists: `Unable to create '<path>.lock': File
 * exists.` The lock is held for the length of the other process's git command, which removes it when it ends. So the
 * commit waits for the lock file to go away (a change in its folder), and then runs again. A lock whose holder is gone
 * (no process has the file open and no git command runs in the repository) is stale: it is never going away by itself.
 * That is said, in words, and the stale lock is removed; the commit then runs (and says it met one). A lock found stale
 * again at once, or one that could not be removed, fails the commit with that sentence. Where this system cannot see
 * processes (no `/proc`), the commit waits for the lock file to go away.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { logger } from '../utils/logger.js';

/** Git's own words when another git process holds the index or a ref: `Unable to create '<path>.lock': File exists`. */
export const GIT_LOCK_HELD = /Unable to create '([^'\n]*\.lock)': File exists/;

/** The lock file a git error names as held, when it names one. */
export function heldGitLock(message: string): string | undefined {
  return GIT_LOCK_HELD.exec(message)?.[1];
}

/** The repository folder a lock belongs to: the folder that holds its `.git`. */
function repositoryOf(lockPath: string): string {
  const at = lockPath.indexOf('/.git/');
  return at >= 0 ? lockPath.slice(0, at) : dirname(lockPath);
}

/**
 * The processes that hold the lock: one with the lock file open, or a git command running in its repository (a git
 * command closes its lock file a moment before it renames it into place). Undefined where processes cannot be seen.
 */
export function gitLockHolders(lockPath: string): readonly number[] | undefined {
  if (!existsSync('/proc/self/fd')) return undefined;
  const repository = repositoryOf(lockPath);
  const holders: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'git') {
        const cwd = readlinkSync(`/proc/${entry}/cwd`);
        if (cwd === repository || cwd.startsWith(`${repository}/`)) { holders.push(Number(entry)); continue; }
      }
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        let target: string;
        try { target = readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
        if (target === lockPath) { holders.push(Number(entry)); break; }
      }
    } catch { /* the process ended meanwhile, or it is not this account's to read */ }
  }
  return holders;
}

/** How a wait for a held lock ended. */
export type GitLockWait =
  | { readonly kind: 'released' }
  | { readonly kind: 'stale'; readonly said: string; readonly removed: boolean }
  | { readonly kind: 'stopped' };

/**
 * Waits until the lock file is gone (its holder finished), it is found stale (removed, and said), or `signal` stops
 * the wait. Every change in the lock's folder is looked at; the lock's own writes (its holder at work) are not.
 */
export function waitForGitLock(lockPath: string, signal: AbortSignal): Promise<GitLockWait> {
  return new Promise<GitLockWait>((resolve) => {
    let watcher: FSWatcher | undefined;
    let ended = false;
    const end = (result: GitLockWait): void => {
      if (ended) return;
      ended = true;
      watcher?.close();
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    function onAbort(): void { end({ kind: 'stopped' }); }
    const look = (holdersToo: boolean): void => {
      if (ended) return;
      if (signal.aborted) { end({ kind: 'stopped' }); return; }
      if (!existsSync(lockPath)) { end({ kind: 'released' }); return; }
      if (!holdersToo) return;
      const holders = gitLockHolders(lockPath);
      if (holders === undefined || holders.length > 0) return;
      try { rmSync(lockPath, { force: true }); }
      catch (error) {
        end({ kind: 'stale', removed: false, said: `the repository's lock ${lockPath} was left by a git process that is gone, and it could not be removed (${error instanceof Error ? error.message : String(error)}); remove it, then commit again` });
        return;
      }
      logger.warn('a stale git lock was removed: no process held it and no git command ran in the repository', { lockPath });
      end({ kind: 'stale', removed: true, said: `the repository's lock ${lockPath} was left by a git process that is gone; it was removed` });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    logger.info('a commit waits for a git lock another process holds, until it goes away', { lockPath });
    try {
      // Watched before the first look, so a lock removed between the two is not missed.
      // The lock's own writes (its holder at work) say it is held: only whether it is gone is looked at for them.
      watcher = watch(dirname(lockPath), (event, name) => look(event === 'rename' || name !== basename(lockPath)));
      watcher.on('error', () => look(true));
    } catch { /* a folder that cannot be watched: the first look below still settles a released or stale lock; else the work's stop ends the wait */ }
    look(true);
  });
}
