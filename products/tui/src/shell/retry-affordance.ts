/**
 * retry-affordance.ts, the two actions the shell offers after something it
 * did: retry the turn that just failed, and open a fix session that was just
 * started for the owner (a CI fix session, a conflict-resolution session).
 *
 * Each is an action of the key table (`failure-retry`, `open-fix-session`:
 * Ctrl+G then r and Ctrl+G then j by default, beside F12 and F10), so a
 * sentence that starts with "r" or "j", or `j` pressed to move down a list,
 * always goes where it was typed, and both can be rebound. The retry is named
 * on the failed turn's own row in the transcript (terminal-shell
 * turn-failure-actions.ts), so the footer names only the fix session
 * (actionHint). An offer stays until it is used, replaced by a newer one, or
 * (for retry) a new prompt is sent.
 */
import { offerFailedTurnRetry } from '@goodvibes/engine/terminal-shell/turn-failure-actions';

/** The keys as bound, set by the shell each frame ("Ctrl+G R"). */
export let RETRY_CHORD_LABEL = 'Ctrl+G R';
export let FIX_SESSION_CHORD_LABEL = 'Ctrl+G J';

/** Keep the labels in step with the key table; an unbound key keeps the last label. */
export function setShellActionKeyLabels(labels: { readonly retry: string; readonly fixSession: string }): void {
  if (labels.retry !== '(unbound)') RETRY_CHORD_LABEL = labels.retry;
  if (labels.fixSession !== '(unbound)') FIX_SESSION_CHORD_LABEL = labels.fixSession;
}

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
 * What the two key-table actions do: each acts only while its offer stands
 * (nothing on offer, the key does nothing). The failed turn's row sends its
 * prompt to the model chosen there through this same retry.
 */
export function wireShellActionOffers(offers: ShellActionOffers, deps: ShellActionChordDeps): { readonly retry: () => void; readonly openFixSession: () => void } {
  const retry = (): void => {
    if (!offers.retry) return;
    offers.retry = null;
    deps.retry();
    deps.render();
  };
  offerFailedTurnRetry(retry);
  return {
    retry,
    openFixSession: () => {
      if (!offers.fixSessionId) return;
      const sessionId = offers.fixSessionId;
      offers.fixSessionId = null;
      deps.openSession(sessionId);
      deps.render();
    },
  };
}
