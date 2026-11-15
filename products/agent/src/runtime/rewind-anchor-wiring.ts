/**
 * rewind-anchor-wiring.ts, the Agent's end of message-anchored rewind, and the
 * housekeeping that keeps its on-disk half bounded.
 *
 * A rewind is anchored to a `{ sessionId, turnId }`. Files-scope resolves that
 * turnId against the workspace checkpoint the turn engine stamped with the same
 * id; conversation-scope needs to know how many conversation messages existed at
 * that boundary, which no checkpoint carries. So every completed turn records
 * the pair, and mirrors it to a sidecar beside the session's JSONL, without the
 * sidecar a rewind could only reach turns from the current run, and a resumed
 * session's earlier turns would resolve to nothing.
 *
 * The registry, the sidecar and the sweep are all the platform's
 * (platform/rewind, platform/runtime durability-housekeeping). What is here is
 * this product's wiring of them: which handle they run against, and when.
 *
 * Every path is best-effort. A missed anchor must never break the turn that
 * produced it, and a sweep must never break boot.
 */
import { persistTurnAnchors, recordTurnAnchor, restoreTurnAnchors, summarizeTurnLabel } from '@goodvibes-jev/engine/platform/platform/rewind';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { startDurabilityHousekeeping } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';

/** The conversation facts an anchor is built from, read at the moment of capture. */
export interface RewindAnchorConversationView {
  getLastUserMessage(): string | null | undefined;
  getMessageCount(): number;
  /** When present, said once per session, as a warning, if a rewind point could not be saved. */
  addNotice?(message: string, meta: { readonly level: 'warning' }): void;
}

/** Sessions already told that a rewind point could not be saved, so one failure streak says it once. */
const sessionsToldOfAnchorFailure = new Set<string>();

/**
 * Record a completed turn's anchor and mirror it to the session's sidecar.
 *
 * Called from the TURN_COMPLETED handler, with the session id read live so a
 * resume between turns anchors against the session actually in use.
 */
export function recordCompletedTurnAnchor(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly conversation: RewindAnchorConversationView;
  readonly surface: SessionSurface;
}): void {
  try {
    recordTurnAnchor(input.sessionId, {
      turnId: input.turnId,
      label: summarizeTurnLabel(input.conversation.getLastUserMessage()),
      messageCount: input.conversation.getMessageCount(),
      at: Date.now(),
    });
    // persistTurnAnchors logs its own cause; false means the sidecar was not written.
    if (!persistTurnAnchors(input.sessionId, input.surface)) {
      tellOnceThatAnchorWasNotSaved(input, 'the session sidecar could not be written', '/rewind will not offer this turn after the session is resumed');
    }
  } catch (error) {
    logger.warn('rewind turn-anchor recording failed', { sessionId: input.sessionId, error: summarizeError(error) });
    tellOnceThatAnchorWasNotSaved(input, summarizeError(error), '/rewind will not offer this turn');
  }
}

function tellOnceThatAnchorWasNotSaved(
  input: { readonly sessionId: string; readonly conversation: RewindAnchorConversationView },
  cause: string,
  consequence: string,
): void {
  if (sessionsToldOfAnchorFailure.has(input.sessionId)) return;
  sessionsToldOfAnchorFailure.add(input.sessionId);
  try {
    input.conversation.addNotice?.(
      `A rewind point for this turn could not be saved (${cause}). `
      + `${consequence}; later turns are still recorded.`,
      { level: 'warning' },
    );
  } catch {
    // The notice is a courtesy; the warning already carries the cause.
  }
}

/**
 * The reload half, bound to one surface: `/session resume` calls it with the
 * session it just loaded and reports how many rewind points came back.
 */
export function bindRestoreTurnAnchorsToSurface(surface: SessionSurface): (sessionId: string) => number {
  return (sessionId: string): number => restoreTurnAnchors(sessionId, surface);
}

/**
 * Start the sweep that reclaims what no live session can use again: anchor
 * sidecars whose session is gone or whose content restores nothing, and the
 * staging files an interrupted write leaves behind. One pass now, then on a
 * cadence; the session in use is never a target, and whatever is removed is
 * disclosed. Returns the disposer.
 */
export function startAnchorDurabilityHousekeeping(input: {
  readonly surface: SessionSurface;
  readonly currentSessionId: () => string;
}): () => void {
  return startDurabilityHousekeeping({
    surface: input.surface,
    currentSessionId: input.currentSessionId,
  });
}
