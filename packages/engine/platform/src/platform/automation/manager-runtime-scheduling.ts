import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationRunTrigger } from './types.js';
import { computeNextRun, jobEnablement } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { scheduleCapacityWaitKey, type AutomationCapacityWait } from './scheduler-capacity.js';

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AutomationHeartbeatWake {
  readonly jobId: string;
  readonly jobName: string;
  readonly trigger: AutomationRunTrigger;
  readonly dueRun: boolean;
  readonly attempt: number;
  readonly queuedAt: number;
  readonly reason: string;
}

interface AutomationSchedulingContext {
  readonly configManager: ConfigManager;
  readonly jobs: Map<string, AutomationJob>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  readonly heartbeatWakes: Map<string, AutomationHeartbeatWake>;
  /** Occurrences held back at the concurrency limit, for the capacity report. */
  readonly capacityWaits?: Map<string, AutomationCapacityWait> | undefined;
  readonly running: () => boolean;
  readonly saveJobs: () => Promise<void>;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly executeJob: (job: AutomationJob, trigger: AutomationRunTrigger, dueRun: boolean, attempt?: number) => Promise<AutomationRun>;
  /**
   * Record that a scheduled occurrence was missed, the planned run time is now
   * further in the past than the catch-up window, so the run never fired (the
   * daemon was down, or the host was asleep). Optional so callers that only
   * (re)schedule live jobs need not wire it. When present it is invoked with the
   * planned-but-missed run time before the next occurrence is recomputed.
   */
  readonly recordMissedRun?: ((job: AutomationJob, plannedRunAt: number) => void) | undefined;
  /**
   * Whether a run of this job is still in flight. A timer that fires while one
   * is skips that occurrence rather than starting an overlapping run of the
   * same work. Absent, every due occurrence starts.
   */
  readonly hasRunningRun?: ((jobId: string) => boolean) | undefined;
}

function completeOneShotJob(context: Pick<AutomationSchedulingContext, 'jobs' | 'timers' | 'saveJobs'>, current: AutomationJob, reason: string): void {
  const completedOneShot: AutomationJob = {
    ...current,
    ...jobEnablement(false),
    pausedReason: 'one-shot-complete',
    nextRunAt: undefined,
    updatedAt: Date.now(),
  };
  context.jobs.set(current.id, completedOneShot);
  cancelAutomationTimer(context.timers, current.id);
  saveJobsAsync(context, reason, current.id);
}

function saveJobsAsync(context: Pick<AutomationSchedulingContext, 'saveJobs'>, reason: string, jobId?: string): void {
  void context.saveJobs().catch((error: unknown) => {
    logger.warn('AutomationManager: job persistence failed', {
      reason,
      jobId,
      error: summarizeError(error),
    });
  });
}

export function scheduleAutomationJob(context: AutomationSchedulingContext, job: AutomationJob): void {
  cancelAutomationTimer(context.timers, job.id);
  if (!context.running() || !job.enabled) return;

  const now = Date.now();
  const catchUpWindowMs = Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000;
  const nextRunAtCandidate = job.nextRunAt ?? computeNextRun(job.schedule, now);
  // A planned occurrence older than the catch-up window never fired. Record it
  // as a missed run (a first-class outcome that flows the same delivery path as
  // a failure) instead of silently recomputing the next occurrence.
  const missedPlannedRunAt = nextRunAtCandidate !== undefined && nextRunAtCandidate < (now - catchUpWindowMs)
    ? nextRunAtCandidate
    : undefined;
  const successorRunAt = missedPlannedRunAt !== undefined ? computeNextRun(job.schedule, now) : undefined;
  // A one-shot that has already run (a manual run, say) did not miss anything.
  const alreadyRan = missedPlannedRunAt !== undefined && successorRunAt === undefined
    && job.lastRunAt !== undefined && job.lastRunAt >= missedPlannedRunAt;
  if (missedPlannedRunAt !== undefined && !alreadyRan) {
    context.recordMissedRun?.(job, missedPlannedRunAt);
  }
  const nextRunAt = missedPlannedRunAt !== undefined ? successorRunAt : nextRunAtCandidate;
  if (nextRunAt === undefined) {
    // A missed one-shot has no later occurrence: it is finished, not enabled
    // with nothing left to run.
    if (missedPlannedRunAt !== undefined || job.schedule.kind === 'at') completeOneShotJob(context, job, 'missed-one-shot-complete');
    return;
  }

  const refreshed: AutomationJob = {
    ...job,
    nextRunAt,
  };
  context.jobs.set(job.id, refreshed);
  saveJobsAsync(context, 'schedule', job.id);

  const delayMs = Math.max(0, nextRunAt - Date.now());
  if (delayMs > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => scheduleAutomationJob(context, refreshed), MAX_TIMEOUT_MS);
    timer.unref?.();
    context.timers.set(job.id, timer);
    return;
  }

  const timer = setTimeout(() => {
    const waitKey = scheduleCapacityWaitKey(job.id);
    const waiting = context.capacityWaits?.get(waitKey);
    context.capacityWaits?.delete(waitKey);
    const latest = context.jobs.get(job.id);
    if (!latest?.enabled) return;
    if (latest.execution.wakeMode === 'next-heartbeat') {
      queueHeartbeatWake(context.heartbeatWakes, latest, 'scheduled', true, 1, 'scheduled-due');
      return;
    }
    if (context.activeRunCount() >= context.maxConcurrentRuns()) {
      const deferredTo = Date.now() + 15_000;
      const deferred: AutomationJob = {
        ...latest,
        nextRunAt: deferredTo,
        updatedAt: Date.now(),
      };
      context.jobs.set(latest.id, deferred);
      context.capacityWaits?.set(waitKey, { kind: 'schedule', jobId: latest.id, since: waiting?.since ?? Date.now(), nextRunAt: deferredTo });
      saveJobsAsync(context, 'defer-capacity', latest.id);
      scheduleAutomationJob(context, deferred);
      return;
    }
    // The next occurrence is armed once this one has been handled, whether it
    // started, was skipped, or failed to start.
    const advance = () => {
      const current = context.jobs.get(job.id);
      if (!current?.enabled) return;
      // A failure cooldown moved the next run and armed its timer already.
      if (current.nextRunAt !== undefined && current.nextRunAt !== latest.nextRunAt && current.nextRunAt > Date.now()) return;
      const next = computeNextRun(current.schedule, Date.now());
      if (next !== undefined) {
        const updated: AutomationJob = {
          ...current,
          nextRunAt: next,
          updatedAt: Date.now(),
        };
        context.jobs.set(current.id, updated);
        saveJobsAsync(context, 'advance-next-run', current.id);
        scheduleAutomationJob(context, updated);
        return;
      }
      completeOneShotJob(context, current, 'complete-one-shot');
    };
    if (context.hasRunningRun?.(job.id)) {
      logger.info('AutomationManager: scheduled occurrence skipped, a run of this job is still in flight', { jobId: job.id });
      advance();
      return;
    }
    // A start failure is recorded, announced and followed up by the execution
    // itself; the scheduler only needs to log it and move on.
    void context.executeJob(latest, 'scheduled', true)
      .catch((error) => {
        logger.error('AutomationManager: scheduled execution failed', {
          jobId: latest.id,
          error: summarizeError(error),
        });
      })
      .finally(advance);
  }, delayMs);
  timer.unref?.();
  context.timers.set(job.id, timer);
}

export function cancelAutomationTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
): void {
  const timer = timers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(jobId);
  }
}

export function queueDueHeartbeatAutomationJobs(
  jobs: Iterable<AutomationJob>,
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  reason: string,
): void {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || job.execution.wakeMode !== 'next-heartbeat') continue;
    if (job.nextRunAt === undefined || job.nextRunAt > now) continue;
    queueHeartbeatWake(heartbeatWakes, job, 'scheduled', true, 1, reason);
  }
}

export function queueHeartbeatWake(
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt: number,
  reason: string,
): void {
  if (heartbeatWakes.has(job.id)) return;
  heartbeatWakes.set(job.id, {
    jobId: job.id,
    jobName: job.name,
    trigger,
    dueRun,
    attempt,
    queuedAt: Date.now(),
    reason,
  });
}

export function advanceScheduledHeartbeatAutomationJob(
  context: Pick<AutomationSchedulingContext, 'jobs' | 'saveJobs'>,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
  reschedule: (job: AutomationJob) => void,
): void {
  const current = context.jobs.get(jobId);
  if (!current?.enabled) return;
  const next = computeNextRun(current.schedule, Date.now());
  if (next !== undefined) {
    const updated: AutomationJob = {
      ...current,
      nextRunAt: next,
      updatedAt: Date.now(),
    };
    context.jobs.set(current.id, updated);
    saveJobsAsync(context, 'heartbeat-advance', current.id);
    reschedule(updated);
    return;
  }
  completeOneShotJob({ jobs: context.jobs, timers, saveJobs: context.saveJobs }, current, 'heartbeat-complete-one-shot');
}
