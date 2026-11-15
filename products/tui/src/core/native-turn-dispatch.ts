/**
 * The steps of dispatching one native turn, with the spoken-output arm handled
 * in one place.
 *
 * Speech is armed before anything is awaited so the turn it belongs to is
 * spoken. If the dispatch ends without a turn being submitted, because a newer
 * dispatch superseded it or it threw first, nothing will consume that arm; left
 * in place it swallows the next Esc/Ctrl+C and speaks a later identical prompt.
 * It is withdrawn by identity, so an arm a newer dispatch made stays.
 */
export interface NativeTurnDispatchSteps {
  /** Arm speech for this turn, or null when speech is off or unavailable. */
  readonly armSpeech: () => { readonly disarm: () => boolean } | null;
  /** Anything awaited before the turn starts (memory refresh). */
  readonly prepare: () => Promise<void>;
  /** False once a newer dispatch has taken over. */
  readonly current: () => boolean;
  /** Runs once the dispatch is still current and about to start the turn. */
  readonly begin: () => void;
  readonly start: () => Promise<void>;
  /** Reports a failure to the owner; only called while this dispatch is current. */
  readonly failed: (error: unknown) => void | Promise<void>;
}

export async function runNativeTurnDispatch(steps: NativeTurnDispatchSteps): Promise<void> {
  const spokenArm = steps.armSpeech();
  try {
    await steps.prepare();
    if (!steps.current()) {
      spokenArm?.disarm();
      return;
    }
    steps.begin();
    await steps.start();
  } catch (error) {
    spokenArm?.disarm();
    if (!steps.current()) return;
    await steps.failed(error);
  }
}
