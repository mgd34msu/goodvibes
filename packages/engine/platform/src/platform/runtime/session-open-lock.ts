/**
 * Whether a saved session is open in a running process right now.
 *
 * The fact is a lock the kernel releases (utils/process-lock.ts), and it is the
 * same lock the owner inbox reads to say whether the session that left the
 * owner a question is running (control-plane/owner-asker-liveness.ts): an open
 * session is the asker that takes the owner's answer on its next request, so
 * the two are one lock file per session id, beside the home's owner inbox
 * store. A process holds it from the moment a session becomes its live one
 * until it leaves that session or exits; the kernel releases it when the
 * process ends however it ends, so a crash relaunched at once finds it free.
 * No process id, age or refresh is compared, and nothing is written while it
 * is held.
 *
 * Cost: "open in another process" is one `stat` and, when the file exists, one
 * lock attempt that never waits (a SQLite write reservation and rollback, no
 * write). Holding is one lock taken when a session opens here and given up
 * (the file removed under the lock) when it closes or the live session moves.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { askerLivenessPath, holdAskerRunning, settleAskerLock } from '../control-plane/owner-asker-liveness.js';
import { ownerInboxStorePath } from '../control-plane/question-store.js';
import { ProcessLockBusyError, withProcessLockSync } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import type { SessionSurface } from './session-surface.js';

/** The lock file a process holds while `sessionId` is open in it. */
export function sessionOpenLockPath(surface: Pick<SessionSurface, 'homeDirectory'>, sessionId: string): string {
  const store = ownerInboxStorePath({ resolveUserPath: (...segments) => join(surface.homeDirectory, '.goodvibes', ...segments) });
  return askerLivenessPath(store, 'session', sessionId);
}

/**
 * True while a process other than this one has `sessionId` open. A session
 * this process holds is not "elsewhere". Never creates the file, never waits.
 */
export function isSessionOpenElsewhere(surface: Pick<SessionSurface, 'homeDirectory'>, sessionId: string): boolean {
  if (!sessionId.trim()) return false;
  const path = sessionOpenLockPath(surface, sessionId);
  if (!existsSync(path)) return false;
  try {
    withProcessLockSync(path, () => undefined, { waitMs: 0 });
    return false;
  } catch (error) {
    if (error instanceof ProcessLockBusyError) return error.heldBy === 'another-process';
    logger.debug('[session] a session lock could not be read; the session reads as not open elsewhere', { path, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Lock path to its release, for every session this module holds open in this process. */
const openHere = new Map<string, () => void>();

/** Mark `sessionId` open in this process until {@link closeSessionHere}. Holding it twice is one hold. */
export function openSessionHere(surface: Pick<SessionSurface, 'homeDirectory'>, sessionId: string): void {
  if (!sessionId.trim()) return;
  const path = sessionOpenLockPath(surface, sessionId);
  if (openHere.has(path)) return;
  try {
    openHere.set(path, holdAskerRunning(path));
  } catch (error) {
    logger.debug('[session] could not mark a session open', { path, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Give up this process's hold on `sessionId`; the file goes with it unless something else here still holds it. */
export function closeSessionHere(surface: Pick<SessionSurface, 'homeDirectory'>, sessionId: string): void {
  if (!sessionId.trim()) return;
  const path = sessionOpenLockPath(surface, sessionId);
  const release = openHere.get(path);
  if (!release) return;
  openHere.delete(path);
  release();
}

/** The live session of this process changed from `from` to `to`: `to` is held before `from` is let go. */
export function moveSessionHere(surface: Pick<SessionSurface, 'homeDirectory'>, from: string, to: string): void {
  if (from === to) return;
  openSessionHere(surface, to);
  closeSessionHere(surface, from);
}

/** Session lock files no process held when the sweep looked, removed under the lock. */
export interface SessionLockSweepResult {
  readonly scanned: number;
  readonly removed: number;
}

/**
 * Remove the lock files of sessions nobody has open (what a crashed process
 * leaves; a clean close removes its own). Each file is taken without waiting
 * and removed only while this process holds it, so a session that is open
 * anywhere, this process included, is never touched. An unheld file says
 * nothing a missing one does not, so removing it changes no answer.
 */
export function sweepClosedSessionLocks(surface: Pick<SessionSurface, 'homeDirectory'>): SessionLockSweepResult {
  const dir = dirname(sessionOpenLockPath(surface, 'probe'));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('session-') && name.endsWith('.writer.sqlite'));
  } catch {
    return { scanned: 0, removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (!settleAskerLock(path, () => true) && !existsSync(path)) removed++;
  }
  return { scanned: names.length, removed };
}
