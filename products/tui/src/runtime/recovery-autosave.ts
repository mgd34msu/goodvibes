import { buildPersistedSessionContextFromFacts, crashSnapshotTurn, type CrashSnapshotTurnMoment } from '@goodvibes/engine/platform/platform/runtime/operations';
/**
 * recovery-autosave.ts, the minute timer behind crash recovery, extracted out
 * of main.ts to keep it under the architecture line-count gate.
 *
 * At start the live session's lock is taken (runtime/session-open-lock.ts): a
 * second terminal reads it to tell "this session is open in another terminal
 * right now" from "this is an orphaned crash snapshot", and the kernel lets it
 * go if this process dies. Nothing refreshes it.
 *
 * Each tick:
 *   1. Writes the crash-recovery snapshot (writeRecoveryFile) for a change made
 *      outside a turn (/undo, /title, a branch switch), only when the
 *      conversation's revision moved since it was last written (core/turn-event-wiring.ts
 *      writes it at turn moments and the store save at turn end deletes it), so
 *      an idle session writes nothing.
 *   2. Follows a change of the live session id the switching path did not
 *      already follow: the conversation counts as saved under the new id, which
 *      every switching path (a fork, `/session save <name>`, a recovery restore)
 *      has just done, and the lock moves if it has not moved yet.
 */
import { writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { openSessionHere } from '@goodvibes/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.ts';
import {
  conversationChangedSinceDurable,
  markConversationDurable,
  moveLiveSessionArtifacts,
} from '../core/session-resume-core.ts';

export interface StartRecoveryAutosaveOptions {
  readonly conversation: ConversationManager;
  readonly runtime: { readonly sessionId: string };
  /**
   * The app's declare-once session-storage handle. Both the snapshot and the
   * session lock resolve off it, so the startup recovery offer, which
   * reads through the same handle, looks in the directory this writer used.
   */
  readonly surface: SessionSurface;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContextFromFacts>[2];
  /** Overridable for tests. Defaults to 60s. */
  readonly intervalMs?: number;
}

/**
 * Write this terminal's crash snapshot when the conversation changed since it
 * was last written (a store save or a snapshot); otherwise do nothing. Shared
 * by the turn moments, the minute timer and the exit path, which all ask the
 * same integer question first. True when a snapshot was written.
 */
export function writeCrashSnapshotIfChanged(input: {
  readonly conversation: ConversationManager;
  readonly sessionId: string;
  readonly surface: SessionSurface;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContextFromFacts>[2];
  /** When it is written; recorded in the snapshot so a restore knows a turn was still running. Default: the minute timer. */
  readonly moment?: CrashSnapshotTurnMoment | undefined;
}): boolean {
  const { conversation, sessionId, surface } = input;
  if (!conversationChangedSinceDurable(conversation, sessionId)) return false;
  const snapshot = conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> };
  const persisted = buildPersistedSessionContextFromFacts(
    snapshot.messages,
    conversation.getTitleSource(),
    input.buildSessionContinuityHints(),
  );
  const turn = crashSnapshotTurn(input.moment ?? 'TIMER', conversation);
  const written = writeRecoveryFile({ ...snapshot, ...persisted, turn }, sessionId, conversation.title ?? '', { surface });
  // A failed write is not recorded, so the next moment, tick or exit tries
  // again; an empty conversation has nothing to keep.
  if (written) markConversationDurable(conversation, sessionId, 'snapshot');
  else if (snapshot.messages.length === 0) markConversationDurable(conversation, sessionId, 'store');
  return written;
}

export function startRecoveryAutosave(options: StartRecoveryAutosaveOptions): ReturnType<typeof setInterval> {
  const { conversation, runtime, surface, buildSessionContinuityHints, intervalMs = 60_000 } = options;
  openSessionHere(surface, runtime.sessionId);
  let liveSessionId = runtime.sessionId;
  // The boot conversation needs no snapshot: it is either empty or what the
  // resume that produced it just read from the store (which recorded it).
  if (conversationChangedSinceDurable(conversation, liveSessionId)) markConversationDurable(conversation, liveSessionId, 'store');
  return setInterval(() => {
    // A timer callback that throws becomes an uncaught exception and ends the
    // TUI; a failed tick only costs this tick's work, and the next tick retries.
    const sessionId = runtime.sessionId;
    if (sessionId !== liveSessionId) {
      try {
        moveLiveSessionArtifacts(surface, liveSessionId, sessionId);
      } catch (error) {
        logger.warn('[Recovery] Moving the session files to the new session id failed', { error: summarizeError(error) });
      }
      liveSessionId = sessionId;
      if (conversationChangedSinceDurable(conversation, sessionId)) markConversationDurable(conversation, sessionId, 'store');
    }
    try {
      writeCrashSnapshotIfChanged({ conversation, sessionId, surface, buildSessionContinuityHints });
    } catch (error) {
      logger.warn('[Recovery] Autosave snapshot failed', { error: summarizeError(error) });
    }
  }, intervalMs);
}
