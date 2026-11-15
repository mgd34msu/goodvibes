/**
 * The scheduler capacity report: run slots in use, and the work waiting for
 * one. Wire format uses camelCase at the API boundary per platform convention.
 */

/**
 * Scheduler capacity report returned at the API boundary.
 * `queueDepth` counts the work that is due and waiting: heartbeat wakes not yet
 * processed, scheduled occurrences and retries held back at the concurrency
 * limit. `oldestQueuedAgeMs` is how long the oldest of them has waited.
 */
export interface SchedulerCapacityReport {
  readonly slotsTotal: number;
  readonly slotsInUse: number;
  readonly queueDepth: number;
  readonly oldestQueuedAgeMs: number | null;
}

/**
 * A scheduled occurrence or a retry that came due while every run slot was in
 * use and was put off. A scheduled wait is current while its job is enabled and
 * still set to the deferred time; a retry wait while its retry timer is armed.
 */
export type AutomationCapacityWait =
  | { readonly kind: 'schedule'; readonly jobId: string; readonly since: number; readonly nextRunAt: number }
  | { readonly kind: 'retry'; readonly jobId: string; readonly since: number; readonly retryKey: string };

export function scheduleCapacityWaitKey(jobId: string): string {
  return `schedule:${jobId}`;
}

export function retryCapacityWaitKey(retryKey: string): string {
  return `retry:${retryKey}`;
}

/**
 * Compute a scheduler capacity report.
 *
 * @param slotsTotal - Maximum concurrent run slots (from config)
 * @param slotsInUse - Runs running or starting now
 * @param waitingSince - When each piece of waiting work came due
 * @param nowMs - Current timestamp in ms
 */
export function computeSchedulerCapacity(
  slotsTotal: number,
  slotsInUse: number,
  waitingSince: Iterable<number>,
  nowMs = Date.now(),
): SchedulerCapacityReport {
  let queueDepth = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const since of waitingSince) {
    queueDepth += 1;
    if (since < oldest) oldest = since;
  }
  return {
    slotsTotal,
    slotsInUse,
    queueDepth,
    oldestQueuedAgeMs: queueDepth > 0 ? Math.max(0, nowMs - oldest) : null,
  };
}
