/**
 * Shared types and scope resolution for session persistence.
 *
 * "Scope" is the question every persistence call answers before it touches a
 * file: WHICH directory does this call mean? The answer is always a
 * declare-once `SessionSurface`, and both the durable-store half
 * (session-persistence.ts) and the crash-snapshot half (session-recovery.ts)
 * route every path through the resolvers here, so the two sibling modules can
 * never disagree about where a file lives.
 *
 * This module is NOT re-exported wholesale. session-persistence.ts re-exports
 * exactly the names that were already public before the split; everything else
 * below is internal plumbing shared between the two siblings.
 */

import type { ContractView } from '../contract/types.js';
import { join } from 'path';

import { SessionManager, sanitizeSessionName } from '../sessions/manager.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { resolveScopedDirectory } from './surface-root.js';
import { recoveryFilePath } from './recovery-path.js';
import type { SessionSurface } from './session-surface.js';

/**
 * When a crash snapshot was taken: at a turn moment (`TURN_SUBMITTED`,
 * `TOOLS_DONE`), after a turn's save failed (`TURN_COMPLETED`), by the minute
 * timer for a change outside a turn (`TIMER`), or on the way out (`EXIT`).
 */
export type CrashSnapshotTurnMoment = 'TURN_SUBMITTED' | 'TOOL_EXECUTING' | 'TOOLS_DONE' | 'TURN_COMPLETED' | 'TIMER' | 'EXIT';

/** What a crash snapshot says about the turn it was taken in. */
export interface CrashSnapshotTurn {
  readonly moment: CrashSnapshotTurnMoment;
  /** A turn was still running when the snapshot was taken: restoring it records that turn as interrupted. */
  readonly inFlight: boolean;
  /** The last assistant message is a reply that was still arriving: its text is cut off. */
  readonly partialReply: boolean;
}

export type SessionSnapshot = {
  messages: Array<Record<string, unknown>>;
  /** Crash snapshots only: the turn the snapshot was taken in. */
  turn?: CrashSnapshotTurn | undefined;
  timestamp?: number | undefined;
  title?: string | undefined;
  titleSource?: ConversationTitleSource | undefined;
  returnContext?: SessionReturnContextSummary | undefined;
  /** The trees of the contracts started in the session, saved as its contract lines. */
  contracts?: readonly ContractView[] | undefined;
  /** Side branches made with /branch, and the one open, saved with the session. */
  branches?: Readonly<Record<string, readonly object[]>> | undefined;
  currentBranch?: string | undefined;
  /** A copy of a conversation another owner holds: that owner and its revision (SessionMeta.mirroredFrom). */
  mirroredFrom?: import('../utils/owner-stamp.js').OwnerStamp | undefined;
};

/**
 * Where a persistence call reads and writes: every path is read directly off a
 * declare-once `SessionSurface` (see session-surface.ts), so there is no
 * unscoped directory to fall back to and no way for a writer and a reader to
 * disagree about a path as long as they share the same surface.
 */
export type SessionPersistenceSurfaceOptions = {
  readonly surface: SessionSurface;
};

export type SessionPersistenceOptions = SessionPersistenceSurfaceOptions;

export type SessionPersistencePaths = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

/**
 * Read the `SessionSurface` off the options, throwing synchronously with a
 * clear message if it is absent or missing a required path. This is what makes
 * the arity-bug class (a mis-called function silently resolving an unscoped
 * path because an options argument came through undefined) impossible: there
 * is no fallback branch here to silently resolve to.
 */
export function requireSurface(options: SessionPersistenceOptions | undefined): SessionSurface {
  const surface = options?.surface;
  if (
    !surface
    || !surface.workingDirectory
    || !surface.sessionsDir
    || !surface.recoveryDir
    || !surface.lastSessionPointer
    // recoveryFile is a method, not a path: a hand-rolled partial object that
    // supplies every string but omits it would otherwise pass this check and
    // fail later with an opaque "surface.recoveryFile is not a function".
    || typeof surface.recoveryFile !== 'function'
  ) {
    throw new Error(
      'Session persistence requires a fully-resolved SessionSurface (build one with createSessionSurface).',
    );
  }
  return surface;
}

/** Resolve the last-session pointer path. */
export function resolveLastSessionPointerPath(options?: SessionPersistenceOptions): string {
  return requireSurface(options).lastSessionPointer;
}

/** Resolve the recovery directory. */
export function resolveRecoveryDirPath(options?: SessionPersistenceOptions): string {
  return requireSurface(options).recoveryDir;
}

/** Resolve a specific session's recovery file path. */
export function resolveRecoveryFilePath(options: SessionPersistenceOptions | undefined, sessionId: string): string {
  return requireSurface(options).recoveryFile(sessionId);
}

/**
 * Resolve the DURABLE session-store directory (the one holding
 * `<sessionId>.jsonl` files SessionManager writes). This
 * is the directory the recovery layer compares a snapshot against to decide
 * whether that snapshot's own session already saved something newer, see
 * `sessionStoreMtimeMs` in session-recovery.ts.
 */
export function resolveSessionsDirPath(options?: SessionPersistenceOptions): string {
  return requireSurface(options).sessionsDir;
}

/**
 * The durable store file for one session inside an already-resolved sessions
 * directory. The filename stem comes from the SAME rule SessionManager.save
 * writes with (`sanitizeSessionName`), so this path is the file that session's
 * clean saves actually land in, not a lookalike derived from a second rule.
 */
export function resolveSessionStorePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sanitizeSessionName(sessionId)}.jsonl`);
}

/**
 * The one SessionManager of each surface, built on first use. Building it
 * sweeps the sessions directory for temp files a crashed write left; that is a
 * start-of-surface chore, so it runs once per surface, not on every save.
 */
const surfaceSessionManagers = new WeakMap<SessionSurface, SessionManager>();

/** The surface's one SessionManager: the composition's session store and every persistence call share it. */
export function surfaceSessionManager(surface: SessionSurface): SessionManager {
  let manager = surfaceSessionManagers.get(surface);
  if (!manager) {
    manager = new SessionManager(surface.workingDirectory, { surface });
    surfaceSessionManagers.set(surface, manager);
  }
  return manager;
}

export function resolveSessionManager(options?: SessionPersistenceOptions): SessionManager {
  return surfaceSessionManager(requireSurface(options));
}

export function getUserSessionsDir(workingDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
}

export function getLastSessionPointerPath(workingDirectory: string, surfaceRoot?: string): string {
  return join(getUserSessionsDir(workingDirectory, surfaceRoot), 'last-session.json');
}

/** Filename prefix for per-session crash-recovery snapshots. */
export const RECOVERY_FILE_PREFIX = 'recovery-';
export const RECOVERY_FILE_SUFFIX = '.jsonl';

/**
 * Directory holding per-session crash-recovery snapshots
 * (`<scope>/recovery/recovery-<sessionId>.jsonl`). Each concurrent session
 * owns its own file, so two sessions crashing (or snapshotting) at once never
 * clobber a single shared recovery file.
 */
export function getRecoveryDir(homeDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery');
}

/**
 * The recovery snapshot path for a specific session:
 * Safe IDs keep their existing filenames; arbitrary IDs are private opaque
 * labels bound by the original saved header. Before any publication an opaque
 * suggestion is process-local: writeRecoveryFile coordinates the final path.
 * Resolve again when accessing an existing snapshot.
 */
export function getRecoveryFilePath(homeDirectory: string, sessionId: string, surfaceRoot?: string): string {
  return recoveryFilePath(getRecoveryDir(homeDirectory, surfaceRoot), sessionId);
}
