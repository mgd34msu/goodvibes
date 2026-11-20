/**
 * power/sleep-edge-watch.ts, one long-lived sleep-edge watcher child with a
 * bounded respawn.
 *
 * A watcher (`dbus-monitor`, `log stream`) that exits on its own (system bus
 * restart, the tool killed) would otherwise leave the checkpoint-before-sleep
 * and wake catch-up hooks silently dead. It is respawned, each exit logged; a
 * child that runs long enough to print a line has proved itself healthy, so
 * the restart budget counts only exits in a row with no output between them.
 * When the budget runs out, or a watcher cannot start at all, the subscriber
 * is told the watcher is off and why, so the power state can say so.
 */
import type { ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { onStdoutLines, trackSleepWatcher } from './child-hygiene.js';

/** Respawns in a row (no output between them) before the watcher is left off. */
export const SLEEP_WATCH_MAX_RESTARTS = 3;

export function watchSleepEdge(input: {
  readonly label: string;
  readonly spawnWatcher: () => ChildProcess;
  /** Builds the line handler for ONE child, so per-child parse state never leaks into a respawn. */
  readonly createLineHandler: () => (line: string) => void;
  /** Told once when the watcher stops for good, with the reason. */
  readonly onWatcherOff?: ((reason: string) => void) | undefined;
  readonly maxRestarts?: number | undefined;
}): () => void {
  const maxRestarts = input.maxRestarts ?? SLEEP_WATCH_MAX_RESTARTS;
  let stopped = false;
  let restarts = 0;
  let stopCurrent: () => void = () => undefined;
  const off = (reason: string): void => {
    try {
      input.onWatcherOff?.(reason);
    } catch (error) {
      logger.warn('[power] sleep-edge watcher-off report failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const start = (): void => {
    const child = input.spawnWatcher();
    let failedToSpawn = false;
    // Registered before any output is read so the watcher can never outlive us (see child-hygiene.ts).
    stopCurrent = trackSleepWatcher(child, (error) => {
      failedToSpawn = true;
      logger.warn(`[power] ${input.label} unavailable; sleep-edge signal disabled`, { error: error.message });
      if (!stopped) off('GoodVibes cannot tell when this computer goes to sleep, so work in progress is not saved before it sleeps and missed work is not caught up when it wakes. Restart GoodVibes to try again.');
    });
    const handleLine = input.createLineHandler();
    let sawOutput = false;
    onStdoutLines(child, (line) => {
      if (!sawOutput) {
        sawOutput = true;
        restarts = 0;
      }
      handleLine(line);
    });
    child.once('exit', (code, signal) => {
      if (stopped || failedToSpawn) return;
      if (restarts >= maxRestarts) {
        logger.warn(`[power] ${input.label} keeps exiting; sleep-edge signal disabled`, { restarts, code, signal });
        off('GoodVibes stopped noticing when this computer goes to sleep, so work in progress is not saved before it sleeps and missed work is not caught up when it wakes. Restart GoodVibes to turn this back on.');
        return;
      }
      restarts += 1;
      logger.warn(`[power] ${input.label} exited; restarting the sleep-edge watcher`, { attempt: restarts, code, signal });
      start();
    });
  };
  start();
  return () => {
    stopped = true;
    stopCurrent();
  };
}
