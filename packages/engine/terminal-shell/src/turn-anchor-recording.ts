/**
 * turn-anchor-recording.ts, the terminal products' end of message-anchored
 * rewind: record a completed turn's anchor and mirror it to the session's
 * sidecar, and tell the person, once per failure streak, when a rewind point
 * could not be saved.
 *
 * A rewind is anchored to a `{ sessionId, turnId }`. Files-scope resolves that
 * turnId against the workspace checkpoint the turn engine stamped with the same
 * id; conversation-scope needs to know how many conversation messages existed at
 * that boundary, which no checkpoint carries. So every completed turn records
 * the pair, and mirrors it to a sidecar beside the session's JSONL: without the
 * sidecar a rewind could only reach turns from the current run, and a resumed
 * session's earlier turns would resolve to nothing.
 *
 * Every path is best-effort. A missed anchor must never break the turn that
 * produced it.
 */
import {
  captureTurnAnchor,
  persistTurnAnchors,
  recordTurnAnchor,
  type TurnAnchorSource,
} from '@goodvibes/engine/platform/platform/rewind';
import type { SessionSurface } from '@goodvibes/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** Sessions whose current failure streak has already been told; a saved anchor ends the streak. */
const sessionsToldOfAnchorFailure = new Set<string>();

/**
 * Record a completed turn's anchor and mirror it to the session's sidecar.
 *
 * Called on TURN_COMPLETED with the session id read live, so a resume between
 * turns anchors against the session actually in use. `warn` is said once per
 * failure streak: the first failed anchor after a saved one (or after start).
 */
export function recordCompletedTurnAnchor(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly conversation: TurnAnchorSource;
  readonly surface: SessionSurface;
  /** When the turn completed; the current time when absent. */
  readonly at?: number | undefined;
  readonly warn: (message: string) => void;
}): void {
  try {
    recordTurnAnchor(input.sessionId, captureTurnAnchor(input.turnId, input.conversation, input.at ?? Date.now()));
    // persistTurnAnchors logs its own cause; false means the sidecar was not written.
    if (!persistTurnAnchors(input.sessionId, input.surface)) {
      tellOnceThatAnchorWasNotSaved(input, 'the session sidecar could not be written', '/checkpoint rewind will not offer this turn after the session is resumed');
      return;
    }
    sessionsToldOfAnchorFailure.delete(input.sessionId);
  } catch (error) {
    logger.warn('rewind turn-anchor recording failed', { sessionId: input.sessionId, error: summarizeError(error) });
    tellOnceThatAnchorWasNotSaved(input, summarizeError(error), '/checkpoint rewind will not offer this turn');
  }
}

function tellOnceThatAnchorWasNotSaved(
  input: { readonly sessionId: string; readonly warn: (message: string) => void },
  cause: string,
  consequence: string,
): void {
  if (sessionsToldOfAnchorFailure.has(input.sessionId)) return;
  sessionsToldOfAnchorFailure.add(input.sessionId);
  try {
    input.warn(
      `A rewind point for this turn could not be saved (${cause}). `
      + `${consequence}; later turns are still recorded when saving works again.`,
    );
  } catch {
    // The notice is a courtesy; the log line already carries the cause.
  }
}
