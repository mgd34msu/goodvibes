/**
 * Whether a saved session is open in a running process right now.
 *
 * A session is identified by its saved file (`sessionIdentityFile`): the file
 * names the app (`tui`, `agent`), the project store it lives in and the
 * session id, so a TUI session and an Agent session saved under the same name,
 * or two projects' sessions with one name, are different sessions. The owner
 * inbox records the same file on every question a terminal session asks, and
 * matches answers and locks by it (owner-asker-liveness.ts `sessionAskerKey`).
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
import { askerLivenessPath, claimAskerRunning, holdAskerRunning, retakeAskerHold, sessionAskerKey, settleAskerLock } from '../control-plane/owner-asker-liveness.js';
import { resolveSessionStorePath } from './session-persistence-scope.js';
import { canonicalFilePath } from '../utils/canonical-path.js';
import { ownerInboxStorePath } from '../control-plane/question-store.js';
import { ProcessLockBusyError, withProcessLockSync } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import type { SessionSurface } from './session-surface.js';

/** The parts of a surface that locate a session's identity and its lock. */
export type SessionIdentitySurface = Pick<SessionSurface, 'homeDirectory' | 'sessionsDir'>;

/**
 * The one identity of session `sessionId` of this surface: the path of its
 * saved file (whether or not it exists yet), in canonical form: the sessions
 * folder's real path (resolved once per process and remembered) plus the file
 * name, so the project reached through a symlink or another spelling is the
 * same session. The owner inbox records it on the questions the session asks;
 * the session lock is keyed by it.
 */
export function sessionIdentityFile(surface: Pick<SessionSurface, 'sessionsDir'>, sessionId: string): string {
  return canonicalFilePath(resolveSessionStorePath(surface.sessionsDir, sessionId));
}

/** The lock file a process holds while `sessionId` is open in it. */
export function sessionOpenLockPath(surface: SessionIdentitySurface, sessionId: string): string {
  const store = ownerInboxStorePath({ resolveUserPath: (...segments) => join(surface.homeDirectory, '.goodvibes', ...segments) });
  return askerLivenessPath(store, 'session', sessionAskerKey({ session: sessionId, sessionFile: sessionIdentityFile(surface, sessionId) }));
}

/**
 * True while a process other than this one has `sessionId` open. A session
 * this process holds is not "elsewhere". Never creates the file, never waits.
 */
export function isSessionOpenElsewhere(surface: SessionIdentitySurface, sessionId: string): boolean {
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

/**
 * Mark `sessionId` open in this process until {@link closeSessionHere}. Holding
 * it twice is one hold. When the lock could not be taken because another
 * process held it (a forced resume), each later call tries again, so the
 * terminals call this at every turn as a backstop: once that process exits,
 * this one holds the session and a third one is refused.
 */
export function openSessionHere(surface: SessionIdentitySurface, sessionId: string): void {
  if (!sessionId.trim()) return;
  const path = sessionOpenLockPath(surface, sessionId);
  if (openHere.has(path)) {
    void retakeAskerHold(path);
    return;
  }
  try {
    openHere.set(path, holdAskerRunning(path));
  } catch (error) {
    logger.debug('[session] could not mark a session open', { path, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Give up this process's hold on `sessionId`; the file goes with it unless something else here still holds it. */
export function closeSessionHere(surface: SessionIdentitySurface, sessionId: string): void {
  if (!sessionId.trim()) return;
  const path = sessionOpenLockPath(surface, sessionId);
  const release = openHere.get(path);
  if (!release) return;
  openHere.delete(path);
  release();
}

/**
 * Hold `sessionId` open here only if no other process has it open: true once
 * this process holds the lock, false when another process does (also for a
 * session already open here whose lock another process still holds). Waits at
 * most a second (for another process's one-shot read); call
 * {@link isSessionOpenElsewhere} first to refuse without waiting.
 */
export async function claimSessionHere(surface: SessionIdentitySurface, sessionId: string): Promise<boolean> {
  if (!sessionId.trim()) return false;
  const path = sessionOpenLockPath(surface, sessionId);
  if (openHere.has(path)) return retakeAskerHold(path);
  const release = await claimAskerRunning(path);
  if (!release) return false;
  if (openHere.has(path)) release();
  else openHere.set(path, release);
  return true;
}

/** The live session of this process changed from `from` to `to`: `to` is held before `from` is let go. */
export function moveSessionHere(surface: SessionIdentitySurface, from: string, to: string): void {
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
export function sweepClosedSessionLocks(surface: SessionIdentitySurface): SessionLockSweepResult {
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
