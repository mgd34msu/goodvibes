import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationRunTrigger } from './types.js';
import { computeNextRun, nextJobEnablement } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { scheduleCapacityWaitKey, type AutomationCapacityWait } from './scheduler-capacity.js';
import { WORK_ADMISSION_RECHECK_MS } from '../daemon/work-admission.js';

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
  /**
   * Occurrences held back at the concurrency limit. Each is started again by
   * the manager when a run slot frees (its `resume`), not by a timer.
   */
  readonly capacityWaits: Map<string, AutomationCapacityWait>;
  readonly running: () => boolean;
  readonly saveJobs: () => Promise<void>;
  /**
   * Takes a run slot in the same step as it checks one is free: the release, or
   * null at the concurrency limit. Held across the group claim and handed to
   * executeJob, so no other start can take the slot in between.
   */
  readonly tryReserveRun: () => (() => void) | null;
  readonly executeJob: (job: AutomationJob, trigger: AutomationRunTrigger, dueRun: boolean, attempt: number, reserved: () => void) => Promise<AutomationRun>;
  /** Puts a job the scheduler changed on its own (a finished one-shot) into the runtime store. */
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  /** Announces a job the scheduler changed on its own, as an owner's edit is announced. */
  readonly emitJobUpdated: (job: AutomationJob, changedFields: string[]) => void;
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
  /**
   * In a group (cluster/group-work.ts): whether this machine arms the job's
   * timer, which is where the automation role is held. Absent, every job runs here.
   */
  readonly runsHere?: ((job: AutomationJob) => boolean) | undefined;
  /**
   * In a group: write the occurrence about to start onto the group's record
   * before it starts, so the next holder does not run it again. Resolves to
   * the job to run, or null when it must not run here.
   */
  readonly claimOccurrence?: ((job: AutomationJob) => Promise<AutomationJob | null>) | undefined;
  /**
   * Whether new work is admitted (daemon/work-admission.ts). While it is not (a
   * self-update's restart) a due occurrence does not start and stays due: its
   * stored next run time is not moved, so it runs once after the restart.
   */
  readonly admitted?: (() => boolean) | undefined;
}

/**
 * A one-shot job whose only occurrence has fired (or was missed) is switched
 * off with `one-shot-complete`, saved, and announced like any other change.
 */
function completeOneShotJob(
  context: Pick<AutomationSchedulingContext, 'jobs' | 'timers' | 'saveJobs' | 'syncJobToRuntime' | 'emitJobUpdated'>,
  current: AutomationJob,
  reason: string,
): void {
  const now = Date.now();
  const completedOneShot: AutomationJob = {
    ...current,
    ...nextJobEnablement(current, false, current.schedule, now, 'one-shot-complete'),
    updatedAt: now,
  };
  context.jobs.set(current.id, completedOneShot);
  cancelAutomationTimer(context.timers, current.id);
  saveJobsAsync(context, reason, current.id);
  const stored = context.jobs.get(current.id) ?? completedOneShot;
  context.syncJobToRuntime(stored, 'automation.one-shot-complete');
  context.emitJobUpdated(stored, ['enabled']);
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
  // In a group, only the machine holding the automation role arms a timer.
  if (context.runsHere && !context.runsHere(job)) return;
  // An occurrence waiting for a run slot is started when one frees; it needs no timer.
  const slotWait = context.capacityWaits.get(scheduleCapacityWaitKey(job.id));
  if (slotWait?.kind === 'schedule' && slotWait.nextRunAt === job.nextRunAt) return;

  const now = Date.now();
  const catchUpWindowMs = Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000;
  let nextRunAtCandidate = job.nextRunAt ?? computeNextRun(job.schedule, now);
  // An occurrence a machine of the group already started (it may have stopped
  // before writing the next run time) is not run again: the next one is due.
  if (job.lastOccurrenceAt !== undefined && nextRunAtCandidate !== undefined && nextRunAtCandidate <= job.lastOccurrenceAt) {
    nextRunAtCandidate = computeNextRun(job.schedule, job.lastOccurrenceAt);
  }
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

  /**
   * Starts the due occurrence. `reserved` is a run slot already taken for it
   * (the manager hands one over when a slot frees for a waiting occurrence);
   * every path that does not start a run gives it back.
   */
  const fire = (reserved?: () => void): void => {
    // The daemon takes no new work (a self-update's restart): the occurrence stays due and is asked about again.
    if (context.admitted?.() === false) {
      reserved?.();
      const recheck = setTimeout(() => fire(), WORK_ADMISSION_RECHECK_MS);
      recheck.unref?.();
      context.timers.set(job.id, recheck);
      return;
    }
    const waitKey = scheduleCapacityWaitKey(job.id);
    const waiting = context.capacityWaits.get(waitKey);
    context.capacityWaits.delete(waitKey);
    const latest = context.jobs.get(job.id);
    // Disabled meanwhile, or the role moved while the timer waited (the new holder runs this occurrence).
    if (!latest?.enabled || (context.runsHere && !context.runsHere(latest))) {
      reserved?.();
      return;
    }
    if (latest.execution.wakeMode === 'next-heartbeat') {
      reserved?.();
      queueHeartbeatWake(context.heartbeatWakes, latest, 'scheduled', true, 1, 'scheduled-due');
      return;
    }
    const release = reserved ?? context.tryReserveRun();
    if (!release) {
      // Every run slot is in use: the occurrence waits for one and the manager
      // starts it when a run ends. Its stored next run time stays the due time,
      // so nothing is written and a restart finds it due.
      context.capacityWaits.set(waitKey, {
        kind: 'schedule', jobId: latest.id, since: waiting?.since ?? Date.now(), nextRunAt: latest.nextRunAt ?? nextRunAt, resume: fire,
      });
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
      release();
      logger.info('AutomationManager: scheduled occurrence skipped, a run of this job is still in flight', { jobId: job.id });
      advance();
      return;
    }
    // A start failure is recorded, announced and followed up by the execution
    // itself; the scheduler only needs to log it and move on.
    // An occurrence not claimed here (the role moved, or the group's record
    // could not be written) is neither run nor passed over: the holder runs
    // it, or the next reconcile pass tries again. The slot taken above is held
    // across the claim and handed to the run, so no other start takes it meanwhile.
    let claimedHere = true;
    const claimed = context.claimOccurrence ? context.claimOccurrence(latest) : Promise.resolve(latest);
    void claimed
      .then((claimedJob) => {
        if (claimedJob) return context.executeJob(claimedJob, 'scheduled', true, 1, release);
        claimedHere = false;
        release();
        return undefined;
      })
      .catch((error) => {
        release();
        logger.error('AutomationManager: scheduled execution failed', {
          jobId: latest.id,
          error: summarizeError(error),
        });
      })
      .finally(() => { if (claimedHere) advance(); });
  };
  const timer = setTimeout(() => fire(), delayMs);
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
  context: Pick<AutomationSchedulingContext, 'jobs' | 'saveJobs' | 'syncJobToRuntime' | 'emitJobUpdated'>,
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
  completeOneShotJob({ ...context, timers }, current, 'heartbeat-complete-one-shot');
}
