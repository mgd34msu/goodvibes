/**
 * The steps of dispatching one native turn. Whether the turn is spoken travels
 * on the turn's own origin, so nothing here has to be undone when a dispatch is
 * superseded or fails before its turn starts.
 */
export interface NativeTurnDispatchSteps {
  /** Anything awaited before the turn starts (memory refresh). */
  readonly prepare: () => Promise<void>;
  /** Runs once the preparation is done and the turn is about to start. */
  readonly begin: () => void;
  readonly start: () => Promise<void>;
  /** Reports a failure to the owner; the caller decides what a newer prompt supersedes. */
  readonly failed: (error: unknown) => void | Promise<void>;
}

export async function runNativeTurnDispatch(steps: NativeTurnDispatchSteps): Promise<void> {
  try {
    await steps.prepare();
    steps.begin();
    await steps.start();
  } catch (error) {
    await steps.failed(error);
  }
}
