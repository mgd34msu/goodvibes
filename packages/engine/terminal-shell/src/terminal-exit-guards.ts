/**
 * terminal-exit-guards.ts, the startup and exit ordering both full-screen
 * front-ends must follow so a crash never leaves the user's shell on the
 * alternate screen with mouse and keyboard modes still on.
 *
 * The three rules, kept in one place so the two front-ends cannot drift:
 *   1. a `process` 'exit' listener restores the terminal (the final safety net
 *      for any exit path, including a throw during boot);
 *   2. crash and signal handlers are registered BEFORE raw mode and terminal
 *      entry, so a throw during setup is already covered;
 *   3. the terminal is handed back BEFORE a crash line is printed, otherwise the
 *      alternate screen that exit discards erases it. Front-ends pass
 *      `handBack` to their crash handler for this.
 */
import type { TerminalLifecycle } from './terminal-lifecycle.js';

export interface TerminalExitGuardOptions {
  /**
   * The front-end's own hand-back, when it has more to do than the lifecycle's
   * restore (for example closing a paint window first). Defaults to
   * `lifecycle.restoreTerminal`.
   */
  readonly restore?: () => void;
  /**
   * Extra work the 'exit' listener does after the restore (for example
   * releasing a session lock). A throw here never reaches the exit path.
   */
  readonly onExit?: () => void;
  /** Registers the 'exit' listener. Defaults to `process.on('exit', ...)`. */
  readonly onProcessExit?: (listener: () => void) => void;
}

export interface TerminalStartupSteps {
  /** Register the crash and termination handlers (they must call `handBack` before printing). */
  readonly registerFaults: () => void;
  readonly enableRawMode: () => void;
  /** Resume stdin and set its encoding. Optional. */
  readonly prepareInput?: () => void;
  /** Enter the terminal (alt screen, mouse, keyboard modes). */
  readonly enter: () => void;
}

export interface TerminalExitGuards {
  /** Restore the terminal. Idempotent and never throws. */
  readonly handBack: () => void;
  /**
   * Run the startup steps in the one safe order: faults, raw mode, input, enter.
   * A throwing step restores the terminal and rethrows, so the startup error is
   * reported on the user's own screen.
   */
  readonly startTerminalSession: (steps: TerminalStartupSteps) => void;
}

export function installTerminalExitGuards(
  lifecycle: Pick<TerminalLifecycle, 'restoreTerminal'>,
  options: TerminalExitGuardOptions = {},
): TerminalExitGuards {
  const restore = options.restore ?? lifecycle.restoreTerminal;
  const handBack = (): void => {
    // stdout may already be torn down; the restore is best effort here.
    try { restore(); } catch { /* nothing left to hand back to */ }
  };
  const onProcessExit = options.onProcessExit ?? ((listener: () => void): void => { process.on('exit', listener); });
  onProcessExit(() => {
    handBack();
    try { options.onExit?.(); } catch { /* exit must proceed */ }
  });

  const startTerminalSession = (steps: TerminalStartupSteps): void => {
    try {
      steps.registerFaults();
      steps.enableRawMode();
      steps.prepareInput?.();
      steps.enter();
    } catch (error) {
      handBack();
      throw error;
    }
  };

  return { handBack, startTerminalSession };
}
