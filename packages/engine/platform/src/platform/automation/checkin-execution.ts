/**
 * automation/checkin-execution.ts
 *
 * The execution path for a `kind: 'checkin'` automation job. When the shared
 * scheduler fires a check-in job, executeAutomationJob delegates here instead of
 * spawning a generic agent: the attached check-in evaluator runs its own
 * briefing→judgment→conditional-delivery loop (see checkin/service.ts) and
 * returns a terminal outcome, which this module records as a normal, terminal
 * AutomationRun using the same context idioms the main execution path uses
 * (set run, advance job counters, persist, emit started/completed).
 *
 * The check-in run is SYNCHRONOUS and terminal, there is no fire-and-forget
 * agent to reconcile later, so the run it produces is already `completed` or
 * `failed`, and its `result` records what the check-in decided.
 */
import { randomUUID } from 'node:crypto';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationRunTrigger } from './types.js';
import type { AutomationManagerExecutionContext } from './manager-runtime-execution.js';
import type { AutomationRunSettlement } from './manager-runtime-reconcile.js';
import { logger } from '../utils/logger.js';
import type { Fence } from '../utils/owner-fence.js';

/** What a single check-in evaluation decided, the outcome the evaluator returns. */
export interface AutomationCheckinOutcome {
  /** delivered: contacted the user. quiet: judged nothing warranted contact. skipped: disabled/quiet-hours. error: evaluation failed. */
  readonly outcome: 'delivered' | 'quiet' | 'skipped' | 'error';
  /** A one-line human summary for the run receipt. */
  readonly summary: string;
  /** The channel delivery id when a message was delivered. */
  readonly deliveryId?: string | undefined;
  /** Failure detail, or a durability warning alongside an already confirmed delivery. */
  readonly error?: string | undefined;
  /**
   * True on an `error` whose send was already handed to the channel when it
   * failed: the note may have reached the owner, so the run is not retried.
   */
  readonly deliveryMayHaveBegun?: boolean | undefined;
}

/** A check-in whose send may have begun: another attempt could send the note twice. */
const CHECKIN_SEND_MAY_HAVE_BEGUN = {
  failureClass: 'terminal',
  basis: 'explicit',
  detail: 'the check-in note may already have been sent',
} as const;

/**
 * The check-in evaluator the CheckinService attaches to the AutomationManager. `signal` is the run's fence signal:
 * it aborts when the run is cancelled, its job removed, the manager stopped or the automation role moved, and the
 * evaluator stops before its judgment and its delivery when it does.
 */
export type AutomationCheckinEvaluator = (job: AutomationJob, signal?: AbortSignal) => Promise<AutomationCheckinOutcome>;

/**
 * Run a check-in job to a terminal AutomationRun via the attached evaluator.
 * Records the run through the same context methods executeAutomationJob uses so
 * the automation run history, persistence, and events are identical to any
 * other job, the run is simply terminal on return rather than pending an agent.
 */
export async function executeCheckinJob(
  fence: Fence,
  context: AutomationManagerExecutionContext,
  evaluator: AutomationCheckinEvaluator,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt: number,
): Promise<AutomationRun> {
  const now = Date.now();
  const baseRun: AutomationRun = {
    id: `autorun-${job.id}-${now}-${randomUUID().slice(0, 6)}`,
    labels: trigger === 'manual' ? ['manual', 'checkin'] : ['scheduled', 'checkin'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    jobId: job.id,
    status: 'running',
    triggeredBy: { ...job.source, lastSeenAt: now, updatedAt: now },
    target: job.execution.target,
    execution: job.execution,
    scheduleKind: job.schedule.kind,
    queuedAt: now,
    startedAt: now,
    forceRun: trigger === 'manual',
    dueRun,
    attempt,
    deliveryIds: [],
  };
  context.onRunMinted?.(baseRun.id);

  const current = context.jobs.get(job.id) ?? job;
  const runningJob: AutomationJob = {
    ...current,
    lastRunAt: now,
    lastRunId: baseRun.id,
    runCount: current.runCount + 1,
    updatedAt: now,
  };
  context.runs.set(baseRun.id, baseRun);
  context.onRunRecorded?.();
  if (context.jobs.has(job.id)) context.jobs.set(runningJob.id, runningJob);
  context.emitRunStarted(runningJob, baseRun);

  let evaluation: AutomationCheckinOutcome;
  try {
    evaluation = await evaluator(job, fence.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await settleCheckinRun(fence, context, baseRun, { status: 'failed', endedAt: Date.now(), error: message, failure: { error } });
  }
  const end = Date.now();
  const result = { checkin: evaluation.outcome, summary: evaluation.summary };
  const failureText = evaluation.error ?? evaluation.summary;
  return await settleCheckinRun(fence, context, baseRun, evaluation.outcome === 'error'
    ? { status: 'failed', endedAt: end, error: failureText, failure: evaluation.deliveryMayHaveBegun ? { known: CHECKIN_SEND_MAY_HAVE_BEGUN } : { error: failureText } }
    : { status: 'completed', endedAt: end, result }, evaluation);
}

/**
 * A check-in run ends the way every run does (settleRun): a success resets
 * the job's failure count, a failure goes through the failure notice and the
 * job's retry policy, a run cancelled meanwhile keeps its cancellation. The
 * check-in's own delivery id and outcome stay on the record.
 */
async function settleCheckinRun(
  fence: Fence,
  context: AutomationManagerExecutionContext,
  baseRun: AutomationRun,
  settlement: AutomationRunSettlement,
  evaluation?: AutomationCheckinOutcome,
): Promise<AutomationRun> {
  const stored = context.runs.get(baseRun.id);
  if (stored && stored.status !== 'running') {
    logger.warn('AutomationManager: check-in finished after its run was already settled; keeping its recorded status', {
      jobId: baseRun.jobId, runId: baseRun.id, status: stored.status,
    });
    return stored;
  }
  if (evaluation) {
    // The evaluator already delivered (or chose not to): its outcome rides on the run.
    context.runs.set(baseRun.id, {
      ...baseRun,
      deliveryIds: evaluation.deliveryId ? [evaluation.deliveryId] : [],
      result: { checkin: evaluation.outcome, summary: evaluation.summary },
      ...(evaluation.error ? { error: evaluation.error } : {}),
    });
  }
  const ending = context.settleRun(context.runs.get(baseRun.id) ?? baseRun, settlement, 'automation.checkin');
  const terminal = ending.run;
  context.pruneRunHistory(baseRun.jobId);
  // A manager that stopped (or a role that moved) while the check-in ran saves nothing more for it; its
  // answer and failure notice still go out, since the check-in already ran.
  if (!fence.current) {
    logger.info('AutomationManager: a check-in ended after its owner ended; its outcome was not saved', { jobId: baseRun.jobId, runId: baseRun.id, status: terminal.status });
    ending.followUp();
    return context.runs.get(baseRun.id) ?? terminal;
  }
  // Save, then deliver: the run's end is on disk before its answer or failure notice goes out.
  try { await Promise.all([context.saveJobs(), context.saveRuns()]); }
  catch (error) {
    // The outcome is recorded in memory and announced; only saving it failed.
    logger.warn('AutomationManager: check-in outcome recorded but could not be saved', {
      jobId: baseRun.jobId, runId: baseRun.id, status: terminal.status, error: error instanceof Error ? error.message : String(error),
    });
  }
  ending.followUp();
  return context.runs.get(baseRun.id) ?? terminal;
}
