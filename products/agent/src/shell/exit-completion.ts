/** Await every exit owner before process exit or executable handover. */
export async function settleInteractiveExit(
  shutdown: Promise<void>,
  spokenOutput: Promise<void>,
  sessionRelease: Promise<void> = Promise.resolve(),
): Promise<readonly unknown[]> {
  // Neither rejection can short-circuit the other owner's release. Audio owns
  // its existing bounded drain; runtime disposal is awaited up to its deadline.
  const results = await Promise.allSettled([shutdown, spokenOutput, sessionRelease]);
  return results.flatMap(result => {
    if (result.status !== 'rejected') return [];
    // Runtime shutdown aggregates independently failed owners. Preserve those
    // original errors as separate diagnostics instead of logging only its title.
    return result.reason instanceof AggregateError ? [...result.reason.errors] : [result.reason];
  });
}

/** The longest exit waits on runtime shutdown. Longer than the TUI's: the session is saved only after the daemon, browser and service owners have been released. */
export const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

/**
 * Runs every unsubscribe; one that throws is reported and cannot skip the
 * others or the session-saving shutdown that follows.
 */
export function runUnsubscribes(unsubs: readonly (() => void)[], onError: (error: unknown) => void): void {
  for (const unsub of unsubs) {
    try { unsub(); } catch (error) { onError(error); }
  }
}

/** Rejects when `shutdown` has not settled within `timeoutMs`, so a hung owner cannot hold the process open forever. */
export function withShutdownDeadline(shutdown: Promise<void>, timeoutMs: number = SHUTDOWN_HARD_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runtime shutdown did not finish within ${timeoutMs}ms; exiting without waiting`)), timeoutMs);
  });
  return Promise.race([shutdown, deadline]).finally(() => clearTimeout(timer));
}
