import { logger } from '../utils/logger.js';
import type { AutomationDeliveryManager } from './delivery-manager.js';
import type { AutomationDeliveryAttempt, AutomationDeliveryTarget } from './delivery.js';
import { calculateRetryDelay } from './failures.js';
import { retryCapacityWaitKey, type AutomationCapacityWait } from './scheduler-capacity.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import { summarizeError } from '../utils/error-display.js';
import { readFailureTransience, type FailureTransience } from '../integrations/delivery.js';
import type { UnattendedAnswer, UnattendedRuns } from './unattended-runs.js';
import type { ScheduleRunOutcome } from '@goodvibes/engine/contracts';

export interface AutomationFailureFollowUpContext {
  readonly jobs: Map<string, AutomationJob>;
  readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Whether new work is admitted (daemon/work-admission.ts); a retry due while it is not waits as at the concurrency limit. */
  readonly admitted?: (() => boolean) | undefined;
  /** Retries held back at the concurrency limit, for the capacity report. */
  readonly capacityWaits?: Map<string, AutomationCapacityWait> | undefined;
  readonly deliveryManager: AutomationDeliveryManager | null;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly executeJob: (job: AutomationJob, trigger: 'scheduled', dueRun: boolean, attempt?: number) => Promise<AutomationRun>;
  readonly saveJobs: () => Promise<void>;
  readonly scheduleJob: (job: AutomationJob) => void;
  readonly deliverFailureNotice: (job: AutomationJob, run: AutomationRun) => void;
  readonly emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => void;
}

interface AutomationRunDeliveryContext {
  readonly runs: Map<string, AutomationRun>;
  readonly deliveryInFlight: Set<string>;
  readonly deliveryManager: AutomationDeliveryManager | null;
  /** The owner inbox a run's answer goes to when the job names no target or every target failed. */
  readonly unattendedRuns?: UnattendedRuns | undefined;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly saveRuns: () => Promise<void>;
  /** Records on the job how a completed run's answer reached the person (AutomationJob.lastOutcome). */
  readonly noteJobOutcome?: ((jobId: string, outcome: Exclude<ScheduleRunOutcome, 'failed'>) => void) | undefined;
  /** Removes a finished one-shot job once its run's delivery is recorded. */
  readonly removeOneShotJob?: ((jobId: string) => void) | undefined;
  /** Hears each delivery started, as a promise that settles (never rejects) when it is recorded or given up on. */
  readonly track?: ((delivery: Promise<void>) => void) | undefined;
}

function saveJobsAsync(context: Pick<AutomationFailureFollowUpContext, 'saveJobs'>, reason: string, jobId: string): void {
  void context.saveJobs().catch((error: unknown) => {
    logger.warn('AutomationManager: job persistence failed', {
      reason,
      jobId,
      error: summarizeError(error),
    });
  });
}

/**
 * What a failed run's transience comes from: the failure itself (the thrown
 * error, or the failure text an agent or remote runner reported), or a fact
 * the caller already holds, such as a run whose agent state was lost to a
 * restart.
 */
export type AutomationRunFailure =
  | { readonly error: unknown }
  | { readonly known: FailureTransience };

/**
 * Reads whether a failed run could succeed on another attempt, before any
 * retry or cooldown follow-up (structured facts first, then Jev's reading of
 * the failure wording; see readFailureTransience). Undefined when no reading
 * could be made: the failure is logged and the run is not retried, since
 * nothing established that another attempt could succeed.
 */
export async function readAutomationRunTransience(
  failure: AutomationRunFailure,
  site: string,
  ids: { readonly jobId: string; readonly runId: string },
): Promise<FailureTransience | undefined> {
  if ('known' in failure) return failure.known;
  try {
    return await readFailureTransience(failure.error, site);
  } catch (error: unknown) {
    logger.warn('AutomationManager: run failure could not be read; the run is not retried', {
      ...ids,
      failure: summarizeError(failure.error),
      error: summarizeError(error),
    });
    return undefined;
  }
}

/**
 * Follows up a failed or cancelled run: delivers the failure notice, then
 * applies the job's failure policy. A cooldown moves the next scheduled run
 * out by the cooldown whatever the failure was. A retry runs the same work
 * again, so it happens only when `retryAllowed` says another attempt could
 * succeed (a transient failure by readAutomationRunTransience, or a
 * cancellation, which has no failure to read).
 */
export function scheduleAutomationFailureFollowUp(
  context: AutomationFailureFollowUpContext,
  job: AutomationJob,
  run: AutomationRun,
  retryAllowed: boolean,
  deliverNotice = true,
): void {
  if (deliverNotice) context.deliverFailureNotice(job, run);
  if (!job.enabled) return;

  if (job.failure.action === 'cooldown') {
    const cooled: AutomationJob = {
      ...job,
      nextRunAt: Date.now() + Math.max(1_000, job.failure.cooldownMs),
      updatedAt: Date.now(),
    };
    context.jobs.set(job.id, cooled);
    context.scheduleJob(cooled);
    saveJobsAsync(context, 'failure-cooldown', job.id);
    return;
  }

  // The failure policy's retry policy rules; an explicit per-job
  // execution.maxAttempts (older jobs) overrides its attempt count.
  const retryPolicy = job.failure.retryPolicy;
  const maxAttempts = Math.max(1, job.execution.maxAttempts ?? retryPolicy.maxAttempts);
  if (job.failure.action !== 'retry' || run.attempt >= maxAttempts || !retryAllowed) {
    return;
  }
  const retryKey = `${job.id}:${run.id}`;
  const existing = context.retryTimers.get(retryKey);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    context.retryTimers.delete(retryKey);
    const waitKey = retryCapacityWaitKey(retryKey);
    const waiting = context.capacityWaits?.get(waitKey);
    context.capacityWaits?.delete(waitKey);
    const latestJob = context.jobs.get(job.id);
    // A one-shot job is disabled once its only occurrence has fired, which
    // must not cancel the retry of that occurrence; an operator or the
    // failure threshold pausing it does.
    if (!latestJob || (!latestJob.enabled && latestJob.pausedReason !== 'one-shot-complete')) return;
    if (context.activeRunCount() >= context.maxConcurrentRuns() || context.admitted?.() === false) {
      scheduleAutomationFailureFollowUp(context, latestJob, run, retryAllowed, false);
      if (context.retryTimers.has(retryKey)) {
        context.capacityWaits?.set(waitKey, { kind: 'retry', jobId: latestJob.id, since: waiting?.since ?? Date.now(), retryKey });
      }
      return;
    }
    void context.executeJob(latestJob, 'scheduled', false, run.attempt + 1).catch((error) => {
      logger.warn('AutomationManager: retry execution failed', {
        jobId: latestJob.id,
        runId: run.id,
        attempt: run.attempt + 1,
        error: summarizeError(error),
      });
    });
  }, Math.max(1_000, calculateRetryDelay(retryPolicy.delayMs, run.attempt, retryPolicy.strategy, retryPolicy.maxDelayMs, retryPolicy.jitterMs)));
  timer.unref?.();
  context.retryTimers.set(retryKey, timer);
}

/**
 * Settles a run that failed outside a request (reconcile found its agent
 * failed or lost): delivers the failure notice now, then reads whether the
 * failure is transient before emitting the run-failed event and applying the
 * job's retry or cooldown policy to the job as it stands after the reading.
 */
export function settleAutomationRunFailure(
  context: AutomationFailureFollowUpContext,
  job: AutomationJob,
  run: AutomationRun,
  message: string,
  failure: AutomationRunFailure,
): void {
  context.deliverFailureNotice(job, run);
  void (async () => {
    const transience = await readAutomationRunTransience(failure, 'automation.run.reconcile', { jobId: job.id, runId: run.id });
    const retryable = transience?.failureClass === 'retryable';
    const latest = context.jobs.get(job.id);
    context.emitRunFailed(latest ?? job, run, message, retryable);
    if (latest) scheduleAutomationFailureFollowUp(context, latest, run, retryable, false);
  })().catch((error: unknown) => {
    logger.warn('AutomationManager: failed-run follow-up failed', { jobId: job.id, runId: run.id, error: summarizeError(error) });
  });
}

/**
 * Resolve where a failure (or missed-run) notice for `job` should go.
 *
 * Priority:
 *  1. The per-job failure override, its `notifyRouteId` / `deadLetterRouteId`
 *     surface routes, when either is set. An explicit failure channel wins.
 *  2. Otherwise the job's OWN normal delivery targets (`delivery.targets`, or
 *     `delivery.replyToRouteId`), with `delivery.fallbackTargets` as the
 *     fallback, the same targets its ordinary run deliveries use. A job whose
 *     delivery is turned off (`mode === 'none'`) contributes no default here;
 *     only its explicit failure override can reach anyone.
 *
 * Returns `{ primary, fallback }`. When both are empty the job has no reachable
 * target at all and the caller records the honest gap.
 */
export function resolveAutomationFailureNoticeTargets(job: AutomationJob): {
  readonly primary: readonly AutomationDeliveryTarget[];
  readonly fallback: readonly AutomationDeliveryTarget[];
} {
  const overrideTargets = [job.failure.notifyRouteId, job.failure.deadLetterRouteId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((routeId): AutomationDeliveryTarget => ({ kind: 'surface', routeId }));
  if (overrideTargets.length > 0) {
    return { primary: overrideTargets, fallback: [] };
  }
  if (job.delivery.mode === 'none') {
    return { primary: [], fallback: [] };
  }
  const primary: readonly AutomationDeliveryTarget[] = job.delivery.targets.length > 0
    ? [...job.delivery.targets]
    : typeof job.delivery.replyToRouteId === 'string' && job.delivery.replyToRouteId.length > 0
      ? [{ kind: 'surface', routeId: job.delivery.replyToRouteId }]
      : [];
  return { primary, fallback: [...job.delivery.fallbackTargets] };
}

/**
 * True when the failure notice for `job` goes to the job's own delivery
 * targets (no explicit failure route), so the notice is the only terminal
 * message a failed or cancelled run needs: sending the ordinary run message
 * as well would put two messages about one failure in front of the same people.
 */
export function failureNoticeCoversRunDelivery(job: AutomationJob): boolean {
  return !job.failure.notifyRouteId && !job.failure.deadLetterRouteId;
}

/** A failed or missed run's notice, as the owner inbox keeps it when the job names no target. */
export function automationFailureAnswer(job: AutomationJob, run: AutomationRun): UnattendedAnswer {
  return {
    source: 'schedule',
    runId: run.id,
    ownerId: job.id,
    title: run.status === 'missed' ? `Scheduled run missed: ${job.name}` : `Scheduled run failed: ${job.name}`,
    body: buildFailureNoticeMessage(job, run),
    ...(run.agentId ? { agentId: run.agentId } : {}),
  };
}

/** A run's answer, as a channel or the owner inbox receives it. */
function automationRunAnswer(job: AutomationJob, run: AutomationRun): UnattendedAnswer {
  const result = typeof run.result === 'string' ? run.result : run.result !== undefined && run.result !== null ? JSON.stringify(run.result, null, 2) : '';
  return {
    source: 'schedule',
    runId: run.id,
    ownerId: job.id,
    title: `Scheduled run: ${job.name}`,
    body: run.error ? `${result}\n\nError: ${run.error}`.trim() : result,
    ...(run.agentId ? { agentId: run.agentId } : {}),
  };
}

function buildFailureNoticeMessage(job: AutomationJob, run: AutomationRun): string {
  const heading = run.status === 'missed'
    ? `Automation missed run: ${job.name}`
    : `Automation failure: ${job.name}`;
  return [
    heading,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    run.error ? `Error: ${run.error}` : null,
    run.cancelledReason ? `Cancelled: ${run.cancelledReason}` : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
}

/**
 * Deliver a failure (or missed-run) notice for a job's run.
 *
 * The notice flows to the job's own delivery targets by default so a failed or
 * slept-through overnight job still reaches its human, not only to a separately
 * configured failure route. `onDeliveryGap` is invoked (once, at the caller's
 * discretion) when the job has no reachable target at all, so the gap is logged
 * honestly instead of failing silently. The returned promise settles when the
 * notice was sent or given up on, and never rejects.
 */
export function maybeDeliverAutomationFailureNotice(
  deliveryManager: AutomationDeliveryManager | null,
  job: AutomationJob,
  run: AutomationRun,
  onDeliveryGap?: (job: AutomationJob, run: AutomationRun) => void,
): Promise<void> {
  const { primary, fallback } = resolveAutomationFailureNoticeTargets(job);
  if (primary.length === 0 && fallback.length === 0) {
    onDeliveryGap?.(job, run);
    return Promise.resolve();
  }
  if (!deliveryManager) return Promise.resolve();
  const message = buildFailureNoticeMessage(job, run);
  // Resolves when the notice was sent or given up on; never rejects, so the run it reports on never fails for it.
  return (async () => {
    const attempts = primary.length > 0
      ? await deliveryManager.deliverText(job, run, message, primary, { kind: 'failure-notice' })
      : [];
    const delivered = attempts.some((attempt) => attempt.status === 'sent');
    if (!delivered && fallback.length > 0) {
      await deliveryManager.deliverText(job, run, message, fallback, { kind: 'failure-notice' });
    }
  })().catch((error) => {
    logger.warn('AutomationManager: failure notice delivery failed', {
      jobId: job.id,
      runId: run.id,
      error: summarizeError(error),
    });
  });
}

/**
 * Deliver a settled run's answer to its job's targets (or the owner inbox).
 * Returns whether a delivery was started. A run that owes its delivery
 * (`delivery: owed`, written with its end) is settled by the write that
 * records the delivery, and only then is a finished one-shot job removed, so
 * a restart in between still has the job's targets to deliver to.
 */
export function maybeDeliverAutomationRun(
  context: AutomationRunDeliveryContext,
  job: AutomationJob,
  run: AutomationRun,
): boolean {
  if (context.deliveryInFlight.has(run.id)) return true;
  if (run.deliveryIds.length > 0) return false;
  const settleOwed = async (attempts: readonly AutomationDeliveryAttempt[]): Promise<void> => {
    const latest = context.runs.get(run.id);
    if (!latest || (attempts.length === 0 && !latest.delivery)) return;
    const updated: AutomationRun = {
      ...latest,
      ...(attempts.length > 0 ? { deliveryIds: attempts.map((attempt) => attempt.id), deliveryAttempts: attempts } : {}),
      delivery: undefined,
      updatedAt: Date.now(),
    };
    context.runs.set(updated.id, updated);
    context.syncRunToRuntime(updated, 'automation.delivery');
    await context.saveRuns();
    if (job.deleteAfterRun && run.status === 'completed') context.removeOneShotJob?.(job.id);
  };
  // A job that names no target: its answer goes to the owner inbox, never only to the run history.
  if (job.delivery.mode === 'none' || !context.deliveryManager) {
    if (!context.unattendedRuns || run.status === 'cancelled') return false;
    context.deliveryInFlight.add(run.id);
    const posting = context.unattendedRuns.postToInbox(automationRunAnswer(job, run))
      .then(async () => {
        if (run.status === 'completed') context.noteJobOutcome?.(job.id, 'inbox');
        await settleOwed([]);
      })
      .catch((error: unknown) => {
        logger.warn('AutomationManager: the run answer could not be put in the owner inbox; it stays owed', { runId: run.id, jobId: job.id, error: summarizeError(error) });
      })
      .finally(() => { context.deliveryInFlight.delete(run.id); });
    context.track?.(posting);
    return true;
  }
  context.deliveryInFlight.add(run.id);
  const delivering = context.deliveryManager.deliverJobRun(job, run)
    .then(async (deliveryAttempts) => {
      // Every named target failed (or none could be resolved): the answer goes to the owner inbox instead.
      const undelivered = deliveryAttempts.every((attempt) => attempt.status === 'failed' || attempt.status === 'dead_lettered');
      if (run.status === 'completed') context.noteJobOutcome?.(job.id, undelivered ? 'not-delivered' : 'delivered');
      if (context.unattendedRuns && undelivered) {
        const reason = deliveryAttempts.length === 0
          ? 'No delivery target of this job could be reached.'
          : `Not delivered: ${deliveryAttempts.map((attempt) => attempt.error ?? attempt.status).join('; ')}.`;
        await context.unattendedRuns.postToInbox(automationRunAnswer(job, run), reason);
      }
      // The attempts (or the inbox) are the delivery's record; the run owes nothing more.
      await settleOwed(deliveryAttempts);
    })
    .catch((error) => {
      logger.warn('AutomationManager: delivery failed', {
        runId: run.id,
        jobId: job.id,
        error: summarizeError(error),
      });
    })
    .finally(() => {
      context.deliveryInFlight.delete(run.id);
    });
  context.track?.(delivering);
  return true;
}
