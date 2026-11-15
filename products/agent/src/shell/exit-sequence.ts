/**
 * The agent's orderly exit, as a function of injected owners so a test can
 * drive it with a throwing step. Every step is isolated: one that throws is
 * reported and can neither skip the session-saving shutdown nor keep the
 * terminal from being restored.
 */
import { runUnsubscribes, settleInteractiveExit, withShutdownDeadline } from './exit-completion.ts';

export interface ExitSequenceDeps<Snapshot> {
  /** Releases the herdr pane report; may throw or reject. */
  readonly closeHerdr: () => Promise<void>;
  /** Cancels a pairing prompt. */
  readonly disposePairing: () => void;
  /** Closes the paint window so no late frame follows the terminal restore. */
  readonly closePaintWindow: () => void;
  /** Starts the bounded spoken-output drain. */
  readonly stopSpokenOutput: () => Promise<void> | undefined;
  readonly unsubs: readonly (() => void)[];
  /** Aborts ambient reads and the skill-draft pass; the save never waits on them. */
  readonly stopAutonomy: () => void;
  /**
   * Leaves the hosted session so the daemon applies its detach policy; a
   * terminal that only exits stays attached forever. Bounded by its owner.
   */
  readonly detachHostedSession: () => Promise<'none' | 'detached' | 'failed'>;
  /** The full snapshot: messages plus session context. May throw. */
  readonly buildSnapshot: () => Snapshot;
  /** Messages alone, used when the full snapshot cannot be built. May throw. */
  readonly buildMessagesSnapshot: () => Snapshot;
  /** Releases every runtime owner and saves the session. */
  readonly shutdown: (snapshot: Snapshot) => Promise<void>;
  /** Removes this session's recovery snapshot once the save finished. */
  readonly removeRecoveryPoint: () => void;
  /** Stops timers and listeners this exit must not leave running. */
  readonly detach: () => void;
  /** Hands the terminal back. */
  readonly restoreTerminal: () => void;
  readonly warn: (message: string, error: unknown) => void;
  readonly warnPlain: (message: string) => void;
  readonly exit: (code: number) => void;
}

export function runExitSequence<Snapshot>(
  deps: ExitSequenceDeps<Snapshot>,
  handOver?: () => number,
  exitCode = 0,
): void {
  // A throwing release must still let the app exit and restore the terminal.
  let herdrRelease: Promise<void>;
  try {
    herdrRelease = deps.closeHerdr();
  } catch (error) {
    herdrRelease = Promise.reject(error);
  }
  let exitCompletion = settleInteractiveExit(Promise.resolve(), Promise.resolve(), herdrRelease);
  let shutdownIncomplete = false;
  try {
    try { deps.disposePairing(); } catch (error) { deps.warn('Pairing prompt could not be cancelled during exitApp', error); }
    // Gate render() before anything else so no late frame follows the terminal-restore write below.
    try { deps.closePaintWindow(); } catch (error) { deps.warn('Paint window could not be closed during exitApp', error); }
    // Already-playing speech may finish inside a short bounded window instead
    // of the player being killed mid-drain; queued speech is dropped.
    let spokenOutputDrain: Promise<void> = Promise.resolve();
    try {
      spokenOutputDrain = Promise.resolve(deps.stopSpokenOutput()).then(() => undefined);
    } catch (error) {
      spokenOutputDrain = Promise.reject(error);
    }
    // Started before the unsubscribes run, which may dispose the router that
    // knows the hosted session. A failed detach only warns: the daemon's own
    // housekeeping resolves a stale attachment, and the exit must not wait on it.
    const hostedDetach = Promise.resolve()
      .then(() => deps.detachHostedSession())
      .then((outcome) => { if (outcome === 'failed') deps.warnPlain('Leaving the hosted session did not complete; the daemon keeps this window attached until its own cleanup.'); })
      .catch((error: unknown) => { deps.warn('Hosted session could not be left during exitApp', error); });
    // One throwing unsubscribe must not skip autonomy.stop() or the session-saving shutdown below.
    runUnsubscribes(deps.unsubs, (error) => deps.warn('Unsubscribe failed during exitApp', error));
    // Autonomy work is aborted, not awaited: the session save is never ordered
    // behind a background pass, and a failed stop is only reported.
    try { deps.stopAutonomy(); } catch (error) { deps.warn('Autonomy could not be stopped during exitApp', error); }
    // A failure in the session-context half of the snapshot must not skip the
    // shutdown that releases every owner and saves the session: fall back to
    // the messages alone. When even those cannot be read nothing is saved (an
    // empty save would overwrite the durable session) and the recovery
    // snapshot is kept for the next launch.
    let snapshot: Snapshot | undefined;
    try {
      snapshot = deps.buildSnapshot();
    } catch (error) {
      deps.warn('Session context failed during exitApp; saving the messages without it', error);
      try {
        snapshot = deps.buildMessagesSnapshot();
      } catch (inner) {
        deps.warn('Session messages could not be read during exitApp; the recovery snapshot is kept', inner);
      }
    }
    const saved = snapshot;
    // Bounded so a hung owner cannot hold the process open. The session is
    // saved near the end of shutdown, so the recovery snapshot is removed only
    // once that shutdown has finished: if the deadline wins, it stays and the
    // next launch can restore from it.
    const runtimeShutdown = (saved !== undefined
      ? withShutdownDeadline(hostedDetach.then(() => deps.shutdown(saved)))
      : Promise.reject(new Error('The session snapshot could not be built; shutdown was not run.')))
      .then(() => {
        deps.removeRecoveryPoint();
      }, (error: unknown) => { shutdownIncomplete = true; throw error; });
    exitCompletion = settleInteractiveExit(runtimeShutdown, spokenOutputDrain, herdrRelease);
    deps.detach();
  } catch (error) {
    exitCompletion = exitCompletion.then((failures) => [...failures, error]);
  } finally {
    try { deps.restoreTerminal(); } catch (error) {
      exitCompletion = exitCompletion.then((failures) => [...failures, error]);
    }
  }
  // The terminal is restored immediately. Process exit and executable
  // handover wait for runtime ownership release and the bounded audio drain.
  void exitCompletion.then((failures) => {
    for (const error of failures) deps.warn('Owned cleanup failed during exitApp', error);
    // A handover replaces this process while it may still hold its session and
    // services; after an unfinished shutdown, exit and let the next launch recover.
    if (handOver && shutdownIncomplete) deps.warnPlain('Restart onto the updated program skipped: shutdown did not finish. Start it again to continue from the saved recovery point.');
    deps.exit(handOver && !shutdownIncomplete ? handOver() : exitCode);
  });
}
