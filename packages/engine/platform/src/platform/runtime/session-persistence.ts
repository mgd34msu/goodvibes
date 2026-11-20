/**
 * Durable session persistence: saving a conversation to its session store file
 * and remembering which session was last active.
 *
 * The crash-snapshot half of this module now lives in session-recovery.ts, and
 * the "which directory does this call mean" layer both halves share lives in
 * session-persistence-scope.ts. This file stays the single import site every
 * consumer already uses: the full previously-public API is re-exported below,
 * name for name, so no caller changes as a result of the split.
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import type { SessionMeta } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  type CrashSnapshotTurn,
  type CrashSnapshotTurnMoment,
  resolveLastSessionPointerPath,
  resolveSessionManager,
  resolveSessionsDirPath,
  resolveSessionStorePath,
  type SessionPersistenceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

// The scope layer's public names, re-exported unchanged. Everything else in
// session-persistence-scope.ts is internal plumbing shared with
// session-recovery.ts and deliberately stays out of the public barrel
// (runtime/operations.ts re-exports THIS file, not that one).
export {
  getLastSessionPointerPath,
  getRecoveryDir,
  getRecoveryFilePath,
  getUserSessionsDir,
  type CrashSnapshotTurn,
  type CrashSnapshotTurnMoment,
  type SessionPersistenceOptions,
  type SessionPersistencePaths,
  type SessionPersistenceSurfaceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

/**
 * The turn moments a terminal writes the conversation to its crash snapshot:
 * the prompt was accepted, and a batch of tool calls finished. The session
 * save at turn end is the durable copy after that, so a crash mid-turn loses
 * at most the tool batches of the last few seconds, never the turn.
 */
export type CrashSnapshotMoment = 'TURN_SUBMITTED' | 'TOOL_EXECUTING' | 'TOOLS_DONE';

/**
 * Tool batches written to the crash snapshot at most once in this window; a
 * batch inside it is written when the window ends. Each write serialises the
 * whole conversation on the UI thread, so a turn of many quick batches paid it
 * once per batch.
 */
export const CRASH_SNAPSHOT_TOOLS_INTERVAL_MS = 5_000;

/**
 * Write the crash snapshot at each {@link CrashSnapshotMoment}, through the
 * product's own atomic recovery write (`write`). Shared by both terminal apps
 * so the two keep one rule. An accepted prompt is written at once; tool
 * batches are coalesced (at most one write per
 * {@link CRASH_SNAPSHOT_TOOLS_INTERVAL_MS}, the last batch written when the
 * window ends), and a pending batch write is dropped when the turn completes,
 * because the turn-end save is the copy then. A failed write is logged and the
 * next moment writes again. Returns the unsubscribe.
 */
export function writeCrashSnapshotAtTurnMoments(input: {
  readonly subscribe: (moment: 'TURN_SUBMITTED' | 'TOOLS_DONE' | 'TURN_COMPLETED', handler: () => void) => () => void;
  /**
   * A tool call of the turn starts running (its call is in the conversation by
   * then). Given, the batch is written before its results too, so a process
   * killed while a command runs restores that call as interrupted, its effect
   * unknown, instead of losing that the model made it.
   */
  readonly subscribeToolStart?: ((handler: () => void) => () => void) | undefined;
  /** Writes the snapshot; `moment` goes into it (see {@link crashSnapshotTurn}). */
  readonly write: (moment: CrashSnapshotMoment) => void;
}): () => void {
  const writeNow = (moment: CrashSnapshotMoment): void => {
    try {
      input.write(moment);
    } catch (error) {
      logger.warn('[Recovery] Crash snapshot write failed; the next turn moment writes it again', { error: summarizeError(error) });
    }
  };
  let lastToolsWrite = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const dropPending = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };
  const writeTools = (moment: 'TOOL_EXECUTING' | 'TOOLS_DONE'): void => {
    dropPending();
    lastToolsWrite = Date.now();
    writeNow(moment);
  };
  // Both tool moments share one window, so a turn still pays at most one write per window.
  const toolsMoment = (moment: 'TOOL_EXECUTING' | 'TOOLS_DONE') => (): void => {
    const wait = lastToolsWrite + CRASH_SNAPSHOT_TOOLS_INTERVAL_MS - Date.now();
    if (wait <= 0) { writeTools(moment); return; }
    if (pending !== undefined) return;
    pending = setTimeout(() => writeTools(moment), wait);
    (pending as { unref?: () => void }).unref?.();
  };
  const unsubs = [
    input.subscribe('TURN_SUBMITTED', () => { dropPending(); writeNow('TURN_SUBMITTED'); }),
    ...(input.subscribeToolStart ? [input.subscribeToolStart(toolsMoment('TOOL_EXECUTING'))] : []),
    input.subscribe('TOOLS_DONE', toolsMoment('TOOLS_DONE')),
    input.subscribe('TURN_COMPLETED', dropPending),
  ];
  return () => {
    dropPending();
    for (const unsubscribe of unsubs) unsubscribe();
  };
}

/**
 * What a crash snapshot taken at `moment` records about its turn: a turn
 * moment is inside a running turn; a reply still arriving (the conversation's
 * streaming message) is a running turn at any moment, and its text is marked
 * cut off, so a restore never presents it as a finished reply. One method call.
 */
export function crashSnapshotTurn(moment: CrashSnapshotTurnMoment, conversation: { hasPartialReply(): boolean }): CrashSnapshotTurn {
  const partialReply = conversation.hasPartialReply();
  return { moment, inFlight: partialReply || moment === 'TURN_SUBMITTED' || moment === 'TOOL_EXECUTING' || moment === 'TOOLS_DONE', partialReply };
}

// The crash-recovery API, re-exported so `session-persistence.js` remains the
// one import path for it (see session-recovery.ts for the semantics).
export {
  autoRestoreRecovery,
  checkRecoveryFile,
  checkRecoveryForSession,
  deleteRecoveryFile,
  findSessionCrashSnapshot,
  holdOfferedRecoverySnapshot,
  loadRecoveryConversation,
  releaseOfferedRecoverySnapshot,
  removeRecoveryPoint,
  writeRecoveryFile,
  type RecoveryFileInfo,
  type SessionCrashSnapshot,
  type RecoveryReceiptSink,
  type RecoveryRemoveResult,
  type RecoveryRestoreResult,
} from './session-recovery.js';

export function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

export function saveSession(
  sessionId: string,
  data: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
  /**
   * Who caused this save, recorded on the session's meta line. Defaults to
   * `'auto'` (save-on-exit and turn-end saves); `'user'` is a save the user
   * asked for. Neither is ever removed by a retention sweep.
   */
  saveSource: 'user' | 'auto' = 'auto',
): void {
  const manager = resolveSessionManager(options);
  const meta: SessionMeta = {
    title,
    model,
    provider,
    timestamp: data.timestamp ?? Date.now(),
    titleSource: data.titleSource,
    returnContext: data.returnContext,
    saveSource,
    ...(data.mirroredFrom ? { mirroredFrom: data.mirroredFrom } : {}),
  };
  manager.save(sessionId, data.messages as Array<Record<string, unknown>>, meta, undefined, data.contracts,
    data.branches === undefined ? undefined : { branches: data.branches, currentBranch: data.currentBranch ?? 'main' });
}

export function persistConversation(
  sessionId: string,
  data: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
  saveSource: 'user' | 'auto' = 'auto',
): void {
  saveSession(sessionId, data, model, provider, title, options, saveSource);
  // The session itself is saved; a pointer that was not written is said, not
  // reported as a failed save (the next save writes it again).
  try { writeLastSessionPointer(sessionId, options); }
  catch (error) { logger.warn('The last-session pointer was not written; the session itself was saved', { sessionId, error: summarizeError(error) }); }
}

/**
 * Record which session was last active.
 *
 * Written to a pid-suffixed temp file and renamed into place: `rename()` within
 * one directory is atomic on every POSIX filesystem, so a crash mid-write can
 * only ever leave the temp file behind, never a half-written pointer where a
 * good one used to be. (The read side already treats a torn pointer as absent,
 * which is the safe direction; this makes a torn pointer impossible to produce
 * in the first place.) The pid suffix keeps two processes writing the same
 * pointer from sharing a temp name.
 *
 * Throws when the pointer was not written (the error names the pointer's
 * path), so a caller can say so: `--continue` would otherwise open an older
 * session with nothing having said why.
 */
export function writeLastSessionPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  let tempPath: string | undefined;
  let pointerPath: string | undefined;
  try {
    pointerPath = resolveLastSessionPointerPath(options);
    mkdirSync(dirname(pointerPath), { recursive: true });
    tempPath = `${pointerPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(
      tempPath,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
    renameSync(tempPath, pointerPath);
    tempPath = undefined;
  } catch (error) {
    throw new Error(`the last-session pointer${pointerPath ? ` ${pointerPath}` : ''} was not written (${summarizeError(error)})`, { cause: error });
  } finally {
    // A failed write must not leave its own litter behind. ENOENT here means
    // the rename actually landed or the file was never created, either way
    // there is nothing left to clean up.
    if (tempPath !== undefined) {
      try {
        unlinkSync(tempPath);
      } catch { /* best effort */ }
    }
  }
}

/**
 * The session id last recorded by writeLastSessionPointer, or null.
 *
 * Validated BY CONTENT, not by existence: the file is parsed and the id is
 * required to be a non-empty string, so a torn pointer reads as absent.
 *
 * It deliberately does NOT check that the referenced session still exists. This
 * function answers "which id was recorded", which is a question about the
 * pointer file alone, resolving the referent needs the sessions directory and
 * the SessionManager's filename rule, and callers that only want the id (a
 * resume prompt deciding whether to offer anything, a diagnostic) would be made
 * to pay for a stat they do not need. The referent check belongs with the
 * caller that dereferences it, which is loadLastConversation below, and that
 * is where the dangling pointer is retired, so the split costs no housekeeping.
 */
export function readLastSessionPointer(options?: SessionPersistenceOptions): string | null {
  try {
    const pointerPath = resolveLastSessionPointerPath(options);
    if (!existsSync(pointerPath)) return null;
    const data = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { sessionId?: unknown };
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
  } catch (error) {
    logger.warn('readLastSessionPointer failed', { error: summarizeError(error) });
  }
  return null;
}

/**
 * The store file the pointer refers to, or null when the options carry no
 * usable surface. A null here means "no referent check", never "referent missing".
 */
function resolveLastSessionStorePathIfKnown(
  sessionId: string,
  options?: SessionPersistenceOptions,
): string | null {
  try {
    return resolveSessionStorePath(resolveSessionsDirPath(options), sessionId);
  } catch {
    return null;
  }
}

/**
 * Delete a pointer whose session file is gone (retention reclaimed it, the user
 * deleted the session). A one-shot record whose referent no longer exists is
 * dead weight; leaving it means every future load re-resolves the same missing
 * file. Best-effort, and ENOENT is success. Only a pointer that still names the
 * missing session is retired: another terminal in the same project may have
 * pointed it at a live session since it was read.
 */
function retireDanglingPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  try {
    if (readLastSessionPointer(options) !== sessionId) return;
    const pointerPath = resolveLastSessionPointerPath(options);
    unlinkSync(pointerPath);
    logger.info('retired last-session pointer to a session that no longer exists', { sessionId });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('could not retire a dangling last-session pointer', { error: summarizeError(error) });
  }
}

export function loadLastConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const lastId = readLastSessionPointer(options);
    const manager = resolveSessionManager(options);
    if (!lastId) return null;

    // Validate the referent before dereferencing it: a pointer at a session
    // file that no longer exists is retired here rather than being re-resolved
    // on every future load. Only a genuinely ABSENT file retires the pointer,
    // a session that exists but fails to load (unreadable, mid-write) is a
    // transient problem, and deleting the pointer over it would throw away a
    // good pointer to a recoverable session.
    const storePath = resolveLastSessionStorePathIfKnown(lastId, options);
    if (storePath !== null && !existsSync(storePath)) {
      retireDanglingPointer(lastId, options);
      return null;
    }

    const { messages } = manager.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (error) {
    logger.warn('loadLastConversation failed', { error: summarizeError(error) });
  }
  return null;
}
