import { logger } from '../utils/logger.js';
import type { AutomationDeliveryManager } from './delivery-manager.js';
import type { AutomationDeliveryAttempt, AutomationDeliveryTarget } from './delivery.js';
import { calculateRetryDelay } from './failures.js';
import { retryCapacityWaitKey, type AutomationCapacityWait } from './scheduler-capacity.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import { summarizeError } from '../utils/error-display.js';
import { readFailureTransience, type FailureTransience } from '../integrations/delivery.js';
import type { UnattendedAnswer, UnattendedAnswerReceipt, UnattendedRuns } from './unattended-runs.js';
import type { ScheduleRunOutcome } from '@goodvibes/engine/contracts';

export interface AutomationFailureFollowUpContext {
  readonly jobs: Map<string, AutomationJob>;
  readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Whether new work is admitted (daemon/work-admission.ts); a retry due while it is not waits as at the concurrency limit. */
  readonly admitted?: (() => boolean) | undefined;
  /** Retries held back at the concurrency limit; the manager starts each when a run slot frees (its `resume`). */
  readonly capacityWaits: Map<string, AutomationCapacityWait>;
  readonly deliveryManager: AutomationDeliveryManager | null;
  /** Takes a run slot in the same step as it checks one is free: the release, or null at the concurrency limit. */
  readonly tryReserveRun: () => (() => void) | null;
  readonly executeJob: (job: AutomationJob, trigger: 'scheduled', dueRun: boolean, attempt: number, reserved: () => void) => Promise<AutomationRun>;
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
  // The notice describes the failed run, so it reads the job as it was passed in.
  if (deliverNotice) context.deliverFailureNotice(job, run);
  // The policy acts on the job as it stands now: a job removed or disabled while
  // the failure was being read is left removed or disabled, never written back.
  // A one-shot switched off because its only occurrence fired may still retry
  // that occurrence, as startRetry below allows.
  const current = context.jobs.get(job.id);
  if (!current) return;
  if (!current.enabled && current.pausedReason !== 'one-shot-complete') return;

  if (current.failure.action === 'cooldown') {
    if (!current.enabled) return;
    const cooled: AutomationJob = {
      ...current,
      nextRunAt: Date.now() + Math.max(1_000, current.failure.cooldownMs),
      updatedAt: Date.now(),
    };
    context.jobs.set(current.id, cooled);
    context.scheduleJob(cooled);
    saveJobsAsync(context, 'failure-cooldown', current.id);
    return;
  }

  // The failure policy's retry policy rules; an explicit per-job
  // execution.maxAttempts (older jobs) overrides its attempt count.
  const retryPolicy = current.failure.retryPolicy;
  const maxAttempts = Math.max(1, current.execution.maxAttempts ?? retryPolicy.maxAttempts);
  if (current.failure.action !== 'retry' || run.attempt >= maxAttempts || !retryAllowed) {
    return;
  }
  const retryKey = `${job.id}:${run.id}`;
  const existing = context.retryTimers.get(retryKey);
  if (existing) {
    clearTimeout(existing);
  }
  /**
   * Starts the retry. `reserved` is a run slot already taken for it (the
   * manager hands one over when a slot frees for a waiting retry); every path
   * that does not start the run gives it back.
   */
  const startRetry = (reserved?: () => void): void => {
    context.retryTimers.delete(retryKey);
    const waitKey = retryCapacityWaitKey(retryKey);
    const waiting = context.capacityWaits.get(waitKey);
    context.capacityWaits.delete(waitKey);
    const latestJob = context.jobs.get(job.id);
    // A one-shot job is disabled once its only occurrence has fired, which
    // must not cancel the retry of that occurrence; an operator or the
    // failure threshold pausing it does.
    if (!latestJob || (!latestJob.enabled && latestJob.pausedReason !== 'one-shot-complete')) {
      reserved?.();
      return;
    }
    // The daemon takes no new work (a self-update's restart): the retry is put off by its own delay again.
    if (context.admitted?.() === false) {
      reserved?.();
      scheduleAutomationFailureFollowUp(context, latestJob, run, retryAllowed, false);
      return;
    }
    const release = reserved ?? context.tryReserveRun();
    if (!release) {
      // Every run slot is in use: the retry waits for one, and the manager starts it when a run ends.
      context.capacityWaits.set(waitKey, { kind: 'retry', jobId: latestJob.id, since: waiting?.since ?? Date.now(), retryKey, resume: startRetry });
      return;
    }
    void context.executeJob(latestJob, 'scheduled', false, run.attempt + 1, release).catch((error) => {
      logger.warn('AutomationManager: retry execution failed', {
        jobId: latestJob.id,
        runId: run.id,
        attempt: run.attempt + 1,
        error: summarizeError(error),
      });
    });
  };
  const timer = setTimeout(() => startRetry(), Math.max(1_000, calculateRetryDelay(retryPolicy.delayMs, run.attempt, retryPolicy.strategy, retryPolicy.maxDelayMs, retryPolicy.jitterMs)));
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
 * The identity of a failed or missed run's notice (AutomationRun.notice), the
 * same for every attempt: the delivery manager's `announces` for a failure
 * notice, so a surface that drops repeats drops a second copy after a restart.
 */
export function automationNoticeEffect(runId: string): string {
  return `automation:${runId}:failure-notice`;
}

/**
 * Deliver a failure (or missed-run) notice for a job's run.
 *
 * The notice flows to the job's own delivery targets by default so a failed or
 * slept-through overnight job still reaches its human, not only to a separately
 * configured failure route. `onUndelivered` is called when the notice reached
 * no one: the job names no target (no reason: the notice simply belongs in the
 * owner inbox), or, with the reason, delivery is unavailable or no attempt
 * across the primary and fallback targets was sent. `record` is awaited once an
 * attempt was sent, to clear what the run owes. The returned promise settles
 * when the notice was sent and recorded or given up on, and never rejects.
 */
export function maybeDeliverAutomationFailureNotice(
  deliveryManager: AutomationDeliveryManager | null,
  job: AutomationJob,
  run: AutomationRun,
  onUndelivered: (job: AutomationJob, run: AutomationRun, reason: string | undefined) => void,
  record: () => Promise<void>,
): Promise<void> {
  const { primary, fallback } = resolveAutomationFailureNoticeTargets(job);
  if (primary.length === 0 && fallback.length === 0) {
    onUndelivered(job, run, undefined);
    return Promise.resolve();
  }
  if (!deliveryManager) {
    onUndelivered(job, run, 'No delivery target of this job could be reached.');
    return Promise.resolve();
  }
  const message = buildFailureNoticeMessage(job, run);
  // Resolves when the notice was sent or given up on; never rejects, so the run it reports on never fails for it.
  return (async () => {
    const attempts: AutomationDeliveryAttempt[] = primary.length > 0
      ? [...await deliveryManager.deliverText(job, run, message, primary, { kind: 'failure-notice' })]
      : [];
    if (!attempts.some((attempt) => attempt.status === 'sent') && fallback.length > 0) {
      attempts.push(...await deliveryManager.deliverText(job, run, message, fallback, { kind: 'failure-notice' }));
    }
    if (!attempts.some((attempt) => attempt.status === 'sent')) {
      onUndelivered(job, run, undeliveredReason(attempts));
      return;
    }
    await record();
  })().catch((error) => {
    logger.warn('AutomationManager: failure notice delivery failed', {
      jobId: job.id,
      runId: run.id,
      error: summarizeError(error),
    });
    onUndelivered(job, run, `Not delivered: ${summarizeError(error)}.`);
  });
}

/** Why no attempt reached anyone, as the owner inbox says it. */
function undeliveredReason(attempts: readonly AutomationDeliveryAttempt[]): string {
  return attempts.length === 0
    ? 'No delivery target of this job could be reached.'
    : `Not delivered: ${attempts.map((attempt) => attempt.error ?? attempt.status).join('; ')}.`;
}

/** Which targets a partly delivered answer missed and why, as the owner inbox says it. */
function partlyDeliveredReason(missed: readonly AutomationDeliveryAttempt[]): string {
  const each = missed.map((attempt) => `${deliveryTargetWords(attempt.target)} (${attempt.error ?? attempt.status})`);
  return `Delivered to some targets, not to ${each.join('; ')}.`;
}

/** A delivery target as a person recognises it: its label, else its address or route, else its kind. */
function deliveryTargetWords(target: AutomationDeliveryTarget): string {
  return target.label?.trim() || target.address?.trim() || target.routeId?.trim() || target.surfaceKind || target.kind;
}

/**
 * Whether a settled run has an answer to deliver: to its job's targets, or to
 * the owner inbox when the job names none. A cancelled run with no target and a
 * run whose delivery is recorded and owes nothing more have nothing to deliver;
 * a run whose attempts all failed and whose answer reached no inbox either
 * still owes it.
 */
export function automationRunDeliveryWanted(
  context: Pick<AutomationRunDeliveryContext, 'deliveryManager' | 'unattendedRuns'>,
  job: AutomationJob,
  run: AutomationRun,
): boolean {
  if (run.deliveryIds.length > 0 && run.delivery?.state !== 'owed') return false;
  if (job.delivery.mode === 'none' || !context.deliveryManager) return context.unattendedRuns !== undefined && run.status !== 'cancelled';
  return true;
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
  if (!automationRunDeliveryWanted(context, job, run)) return false;
  /** Records the attempts on the run; `settled` clears what it owes (a run left owed is delivered again at the next start). */
  const record = async (attempts: readonly AutomationDeliveryAttempt[], settled: boolean): Promise<void> => {
    const latest = context.runs.get(run.id);
    if (!latest || (attempts.length === 0 && (!settled || !latest.delivery))) return;
    const updated: AutomationRun = {
      ...latest,
      ...(attempts.length > 0 ? { deliveryIds: attempts.map((attempt) => attempt.id), deliveryAttempts: attempts } : {}),
      ...(settled ? { delivery: undefined } : {}),
      updatedAt: Date.now(),
    };
    context.runs.set(updated.id, updated);
    context.syncRunToRuntime(updated, 'automation.delivery');
    await context.saveRuns();
    if (settled && job.deleteAfterRun && run.status === 'completed') context.removeOneShotJob?.(job.id);
  };
  const keptOwed = (receipt: UnattendedAnswerReceipt): void => {
    logger.warn('AutomationManager: the run answer reached no one; it stays owed and is delivered again at the next start', {
      runId: run.id, jobId: job.id, reason: receipt.to === 'nowhere' ? receipt.reason : receipt.to,
    });
  };
  // A job that names no target: its answer goes to the owner inbox, never only to the run history.
  if (job.delivery.mode === 'none' || !context.deliveryManager) {
    const inbox = context.unattendedRuns;
    if (!inbox) return false;
    context.deliveryInFlight.add(run.id);
    const posting = inbox.postToInbox(automationRunAnswer(job, run))
      .then(async (receipt) => {
        const reached = receipt.to === 'inbox';
        if (run.status === 'completed') context.noteJobOutcome?.(job.id, reached ? 'inbox' : 'not-delivered');
        if (!reached) {
          keptOwed(receipt);
          return;
        }
        await record([], true);
      })
      .catch((error: unknown) => {
        logger.warn('AutomationManager: the run answer reached the owner inbox, but recording that failed; it stays owed', { runId: run.id, jobId: job.id, error: summarizeError(error) });
      })
      .finally(() => { context.deliveryInFlight.delete(run.id); });
    context.track?.(posting);
    return true;
  }
  context.deliveryInFlight.add(run.id);
  const delivering = context.deliveryManager.deliverJobRun(job, run)
    .then(async (deliveryAttempts) => {
      const missed = deliveryAttempts.filter((attempt) => attempt.status === 'failed' || attempt.status === 'dead_lettered');
      // Every named target failed (or none could be resolved): the answer goes to the owner inbox instead.
      const undelivered = missed.length === deliveryAttempts.length;
      // Some targets were reached and some were not: the owner inbox gets the answer with the targets it missed named.
      const partly = !undelivered && missed.length > 0;
      const fallback = context.unattendedRuns && (undelivered || partly)
        ? await context.unattendedRuns.postToInbox(
          automationRunAnswer(job, run),
          partly ? partlyDeliveredReason(missed) : undeliveredReason(deliveryAttempts),
        )
        : undefined;
      const reached = !undelivered || fallback?.to === 'inbox';
      if (run.status === 'completed') context.noteJobOutcome?.(job.id, undelivered ? 'not-delivered' : partly ? 'partly-delivered' : 'delivered');
      if (fallback && !reached) keptOwed(fallback);
      // The attempts (or the inbox) are the delivery's record; the run owes nothing more once its answer reached someone.
      // A partly delivered answer is settled once the inbox note naming the missed targets landed.
      const settled = partly ? fallback?.to === 'inbox' : reached;
      if (partly && fallback && fallback.to !== 'inbox') keptOwed(fallback);
      await record(deliveryAttempts, settled || !context.unattendedRuns);
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
