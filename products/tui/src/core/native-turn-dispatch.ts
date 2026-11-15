/**
 * The steps of dispatching one native turn. Whether the turn is spoken travels
 * on the turn's own origin, so nothing here has to be undone when a dispatch is
 * superseded or fails before its turn starts.
 */
export interface NativeTurnDispatchSteps {
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
  try {
    await steps.prepare();
    if (!steps.current()) return;
    steps.begin();
    await steps.start();
  } catch (error) {
    if (!steps.current()) return;
    await steps.failed(error);
  }
}
