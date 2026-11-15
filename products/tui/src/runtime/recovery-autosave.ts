import { buildPersistedSessionContextFromFacts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
/**
 * recovery-autosave.ts, periodic recovery-file autosave + liveness-marker
 * refresh, extracted out of main.ts to keep it under the architecture
 * line-count gate.
 *
 * Two writes:
 *   1. The crash-recovery snapshot (writeRecoveryFile). Given the turn events,
 *      it is written when a prompt is accepted and after each tool batch (the
 *      rule both terminal apps share); without them, on the interval.
 *   2. The liveness marker refresh (see session-liveness-marker.ts), on the
 *      interval (default 60s), that lets a second instance tell "this session
 *      is open in another terminal right now" from "this is an orphaned crash
 *      snapshot".
 * The marker is also written once immediately (not just on the first tick of
 * the interval) so a second instance checking soon after this one launches
 * sees it promptly rather than waiting up to a minute.
 */
import { writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { writeCrashSnapshotAtTurnMoments, writeLivenessMarker, type CrashSnapshotMoment } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.ts';

export interface StartRecoveryAutosaveOptions {
  readonly conversation: ConversationManager;
  readonly runtime: { readonly sessionId: string };
  /**
   * The app's declare-once session-storage handle. Both the snapshot and the
   * liveness marker resolve off it, so the startup recovery offer, which
   * reads through the same handle, looks in the directory this writer used.
   */
  readonly surface: SessionSurface;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContextFromFacts>[2];
  /**
   * The turn events. Given, the snapshot is written when a prompt is accepted
   * and after each tool batch (the shared rule both terminal apps use) and the
   * interval only refreshes the liveness marker; absent, the snapshot is also
   * written on the interval.
   */
  readonly turns?: { on(event: CrashSnapshotMoment, handler: () => void): () => void } | undefined;
  /** Overridable for tests. Defaults to 60s. */
  readonly intervalMs?: number;
}

export function startRecoveryAutosave(options: StartRecoveryAutosaveOptions): ReturnType<typeof setInterval> {
  const { conversation, runtime, surface, buildSessionContinuityHints, intervalMs = 60_000, turns } = options;
  writeLivenessMarker(surface, runtime.sessionId);
  const writeSnapshot = (): void => {
    const snapshot = conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> };
    const persisted = buildPersistedSessionContextFromFacts(
      snapshot.messages,
      conversation.getTitleSource(),
      buildSessionContinuityHints(),
    );
    writeRecoveryFile({ ...snapshot, ...persisted }, runtime.sessionId, conversation.title ?? '', { surface });
  };
  // Lives as long as the process: the turn feed is the process's own.
  if (turns) writeCrashSnapshotAtTurnMoments({ subscribe: (moment, handler) => turns.on(moment, handler), write: writeSnapshot });
  return setInterval(() => {
    // A timer callback that throws becomes an uncaught exception and ends the
    // TUI; a failed tick only costs this snapshot, and the next tick retries.
    if (!turns) {
      try {
        writeSnapshot();
      } catch (error) {
        logger.warn('[Recovery] Autosave snapshot failed', { error: summarizeError(error) });
      }
    }
    try {
      writeLivenessMarker(surface, runtime.sessionId);
    } catch (error) {
      logger.warn('[Recovery] Liveness marker refresh failed', { error: summarizeError(error) });
    }
  }, intervalMs);
}
