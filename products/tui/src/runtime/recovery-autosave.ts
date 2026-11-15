import { buildPersistedSessionContextFromFacts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
/**
 * recovery-autosave.ts, the liveness-marker refresh and the out-of-turn crash
 * snapshot, extracted out of main.ts to keep it under the architecture
 * line-count gate.
 *
 * Two writes:
 *   1. The liveness marker (see session-liveness-marker.ts), written at once
 *      and refreshed on the interval (default 60s), that lets a second instance
 *      tell "this session is open in another terminal right now" from "this is
 *      an orphaned crash snapshot".
 *   2. The crash-recovery snapshot (writeRecoveryFile) for a change made outside
 *      a turn (/undo, /title, a branch switch). Turns write it themselves, when
 *      a prompt is accepted and after each tool batch (core/turn-event-wiring.ts);
 *      the interval writes it only when the conversation's revision moved since
 *      the last write here, so an idle session writes nothing.
 */
import { writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
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
  /** Overridable for tests. Defaults to 60s. */
  readonly intervalMs?: number;
}

export function startRecoveryAutosave(options: StartRecoveryAutosaveOptions): ReturnType<typeof setInterval> {
  const { conversation, runtime, surface, buildSessionContinuityHints, intervalMs = 60_000 } = options;
  writeLivenessMarker(surface, runtime.sessionId);
  // The revision written last; the boot conversation needs no snapshot.
  let writtenRevision = conversation.revisionSource.revision();
  let writtenSessionId = runtime.sessionId;
  const writeSnapshot = (): void => {
    const snapshot = conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> };
    const persisted = buildPersistedSessionContextFromFacts(
      snapshot.messages,
      conversation.getTitleSource(),
      buildSessionContinuityHints(),
    );
    writeRecoveryFile({ ...snapshot, ...persisted }, runtime.sessionId, conversation.title ?? '', { surface });
  };
  return setInterval(() => {
    // A timer callback that throws becomes an uncaught exception and ends the
    // TUI; a failed tick only costs this snapshot, and the next tick retries.
    const revision = conversation.revisionSource.revision();
    if (revision !== writtenRevision || runtime.sessionId !== writtenSessionId) {
      try {
        writeSnapshot();
        writtenRevision = revision;
        writtenSessionId = runtime.sessionId;
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
