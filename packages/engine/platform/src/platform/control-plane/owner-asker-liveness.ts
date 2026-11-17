/**
 * Whether the session or agent that left the owner a question is running right
 * now, in any process on this machine.
 *
 * The fact is a kernel-released lock (utils/process-lock.ts): while an asker
 * waits on a question, the process running it holds one lock file named after
 * the asker, beside the owner inbox store. Any process reads "running" by
 * trying that lock once without waiting: held means running. A process that
 * exits, however it exits, has its lock released by the kernel, so nothing a
 * crash leaves can read as running, and no process id or age is compared.
 *
 * The file exists only while that asker has an open question (or is running
 * and waiting on an answer). A clean release removes it. After a crash, the
 * first process that closes one of the asker's questions (answers or
 * withdraws it, records the answer taken or not deliverable, settles a
 * deleted or ended session), or reads the asker while none of its questions
 * is open any more, takes the lock without waiting and, only when it gets it
 * and the asker has no open question, removes the file while still holding
 * the lock. A process taking the lock at that moment either holds it (so the
 * file is left) or has not opened it yet (and creates a fresh one). The
 * directory itself is left in place: removing it could race a process that
 * has created it and is about to create its file.
 *
 * Cost: holding is one lock taken when an asker starts waiting on a question
 * and given up when it stops; reading or settling is one `stat`, and when the
 * file exists one lock attempt (a SQLite write reservation and rollback, no
 * write) plus, when the asker may be idle, one indexed read of its questions.
 */
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ProcessLockBusyError,
  acquireProcessLock,
  withProcessLockSync,
  type HeldProcessLock,
} from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';

export type OwnerAskerKind = 'session' | 'agent';

/** The lock file that says asker `id` of `kind` is running, beside the store at `storePath`. */
export function askerLivenessPath(storePath: string, kind: OwnerAskerKind, id: string): string {
  // Hashed: an id is never used as a file name, whatever characters it holds.
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 32);
  return join(dirname(storePath), 'owner-askers', `${kind}-${digest}.writer.sqlite`);
}

/** True while some process (this one included) holds the asker's lock. Never creates the file. */
export function isAskerRunning(path: string): boolean {
  return settleAskerLock(path);
}

/**
 * True while some process holds the asker's lock. Otherwise, when `idle()`
 * says the asker has no open question, the file is removed while this process
 * holds the lock, so nothing is left behind by an asker that crashed. Never
 * creates the file and never waits.
 */
export function settleAskerLock(path: string, idle?: () => boolean): boolean {
  if (!existsSync(path)) return false;
  try {
    withProcessLockSync(path, () => { if (idle?.()) removeFile(path); }, { waitMs: 0 });
    return false;
  } catch (error) {
    if (error instanceof ProcessLockBusyError) return true;
    logger.debug('[owner-inbox] an asker lock could not be read; the asker reads as not running', { path, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

interface Holding {
  count: number;
  lock: HeldProcessLock | null;
}

const holdings = new Map<string, Holding>();

/** A reader's one-shot attempt can overlap the holder's start; the holder waits this long for it. */
const HOLD_WAIT_MS = 1_000;

function removeFile(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

function giveUp(path: string, lock: HeldProcessLock): void {
  // Removed while still held, so no reader can find an unheld file of a run that ended cleanly.
  removeFile(path);
  lock.release();
}

/**
 * Take the asker's lock, waiting briefly for a reader's one-shot attempt. A
 * process that removed the file while this one was opening it leaves this one
 * holding a file nobody can find; then it is taken again on a fresh file.
 */
async function takeAskerLock(path: string): Promise<HeldProcessLock> {
  for (let attempt = 0; ; attempt += 1) {
    const lock = await acquireProcessLock(path, { waitMs: HOLD_WAIT_MS });
    if (existsSync(path) || attempt >= 2) return lock;
    lock.release();
  }
}

/**
 * Mark the asker at `path` running in this process until the returned function
 * is called. Holders in one process share the lock; the last one to stop gives
 * it up and removes the file.
 */
export function holdAskerRunning(path: string): () => void {
  let holding = holdings.get(path);
  if (!holding) {
    const created: Holding = { count: 0, lock: null };
    holding = created;
    holdings.set(path, created);
    void takeAskerLock(path).then((lock) => {
      if (created.count > 0 && holdings.get(path) === created) created.lock = lock;
      else giveUp(path, lock);
    }).catch((error: unknown) => {
      // Another process runs the same asker (the same session open twice); it is the one that reads as running.
      logger.debug('[owner-inbox] could not mark an asker running', { path, error: error instanceof Error ? error.message : String(error) });
    });
  }
  holding.count += 1;
  const held = holding;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    held.count -= 1;
    if (held.count > 0) return;
    if (holdings.get(path) === held) holdings.delete(path);
    if (held.lock) {
      giveUp(path, held.lock);
      held.lock = null;
    }
  };
}
