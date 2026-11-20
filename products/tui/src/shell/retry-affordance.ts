/**
 * retry-affordance.ts, the two actions the shell offers after something it
 * did: retry the turn that just failed, and open a fix session that was just
 * started for the owner (a CI fix session, a conflict-resolution session).
 *
 * Each is reached by a chord that can never be typed text, Alt+R and Alt+J,
 * so a sentence that starts with "r" or "j", or `j` pressed to move down a
 * list, always goes where it was typed. The retry is named on the failed
 * turn's own row in the transcript (alt+r try again, beside alt+o and alt+i;
 * terminal-shell turn-failure-actions.ts), so the footer names only the fix
 * session (actionHint). An offer stays until it is used, replaced by a newer
 * one, or (for retry) a new prompt is sent.
 */
import { offerFailedTurnRetry } from '@goodvibes/engine/terminal-shell/turn-failure-actions';

/** Alt+<letter> in both encodings a terminal sends: ESC-prefixed, or CSI-u with the Alt modifier (kitty keyboard protocol). */
function isAltChord(data: string, letter: string): boolean {
  return data === `\x1b${letter}` || data === `\x1b[${letter.charCodeAt(0)};3u`;
}

export const RETRY_CHORD_LABEL = 'Alt+R';
export const FIX_SESSION_CHORD_LABEL = 'Alt+J';

export interface ShellActionOffers {
  /** A failed turn can be sent again; `exhausted` when automatic failover already tried every provider. */
  /** `continues`: the failed turn already ran tools, so the chord continues it from their results instead of sending it again. */
  retry: { readonly exhausted: boolean; readonly continues?: boolean | undefined } | null;
  /** The newest started fix session the owner has not opened yet. */
  fixSessionId: string | null;
}

export function createShellActionOffers(): ShellActionOffers {
  return { retry: null, fixSessionId: null };
}

/** The footer line while a fix session is on offer; null when none is. The retry is on the failed turn's row. */
export function actionHint(offers: ShellActionOffers): string | null {
  return offers.fixSessionId ? `${FIX_SESSION_CHORD_LABEL} open fix session` : null;
}

/** Offer the retry whenever a user-visible error surfaces and a retry is actually possible. */
export function wireRetryOfferOnError(
  onErrorSurfaced: (cb: (exhausted: boolean) => void) => void,
  offers: ShellActionOffers,
  hasRetryCtx: () => boolean,
  render: () => void,
  continues: () => boolean = () => false,
): void {
  onErrorSurfaced((exhausted) => {
    if (!hasRetryCtx()) return;
    offers.retry = { exhausted, continues: continues() };
    render();
  });
}

export interface ShellActionChordDeps {
  /** Send the failed turn again (rolls the transcript back to before it), or continue it when it already ran tools. */
  readonly retry: () => void;
  /** Open (resume) the session with this id. */
  readonly openSession: (sessionId: string) => void;
  readonly render: () => void;
}

/**
 * Run the action a chord names when that action is on offer. Returns true when
 * the chunk was the chord and was consumed; every other chunk, including a
 * chord with nothing on offer, is left for normal input.
 */
export function handleShellActionChord(data: string, offers: ShellActionOffers, deps: ShellActionChordDeps): boolean {
  // The failed turn's row sends its prompt to the model chosen with alt+o through this same retry.
  offerFailedTurnRetry(() => {
    if (!offers.retry) return;
    offers.retry = null;
    deps.retry();
    deps.render();
  });
  if (offers.retry && isAltChord(data, 'r')) {
    offers.retry = null;
    deps.retry();
    deps.render();
    return true;
  }
  if (offers.fixSessionId && isAltChord(data, 'j')) {
    const sessionId = offers.fixSessionId;
    offers.fixSessionId = null;
    deps.openSession(sessionId);
    deps.render();
    return true;
  }
  return false;
}
