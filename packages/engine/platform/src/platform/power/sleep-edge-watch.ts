/**
 * power/sleep-edge-watch.ts, one long-lived sleep-edge watcher child with a
 * bounded respawn.
 *
 * A watcher (`dbus-monitor`, `log stream`) that exits on its own (system bus
 * restart, the tool killed) would otherwise leave the checkpoint-before-sleep
 * and wake catch-up hooks silently dead. It is respawned a few times, each exit
 * logged; a watcher that cannot start at all is not retried.
 */
import type { ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { onStdoutLines, trackSleepWatcher } from './child-hygiene.js';

/** Respawns allowed per subscription; a watcher that keeps dying is reported and left off. */
export const SLEEP_WATCH_MAX_RESTARTS = 3;

export function watchSleepEdge(input: {
  readonly label: string;
  readonly spawnWatcher: () => ChildProcess;
  /** Builds the line handler for ONE child, so per-child parse state never leaks into a respawn. */
  readonly createLineHandler: () => (line: string) => void;
  readonly maxRestarts?: number | undefined;
}): () => void {
  const maxRestarts = input.maxRestarts ?? SLEEP_WATCH_MAX_RESTARTS;
  let stopped = false;
  let restarts = 0;
  let stopCurrent: () => void = () => undefined;

  const start = (): void => {
    const child = input.spawnWatcher();
    let failedToSpawn = false;
    // Registered before any output is read so the watcher can never outlive us (see child-hygiene.ts).
    stopCurrent = trackSleepWatcher(child, (error) => {
      failedToSpawn = true;
      logger.warn(`[power] ${input.label} unavailable; sleep-edge signal disabled`, { error: error.message });
    });
    onStdoutLines(child, input.createLineHandler());
    child.once('exit', (code, signal) => {
      if (stopped || failedToSpawn) return;
      if (restarts >= maxRestarts) {
        logger.warn(`[power] ${input.label} keeps exiting; sleep-edge signal disabled`, { restarts, code, signal });
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
