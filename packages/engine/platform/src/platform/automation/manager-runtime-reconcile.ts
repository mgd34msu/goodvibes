import { AgentManager } from '../tools/agent/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun, AutomationRunTelemetry } from './runs.js';
import { buildRunTelemetryFromAgent, canSettleStoredRun, getTerminalAgentState } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import {
  automationRunDeliveryWanted,
  failureNoticeCoversRunDelivery,
  settleAutomationRunFailure,
  type AutomationFailureFollowUpContext,
  type AutomationRunFailure,
} from './manager-runtime-delivery.js';

/** What ending a run needs from the manager, whoever ends it. */
export interface AutomationRunSettleContext {
  readonly sessionBroker: SharedSessionBroker;
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
  readonly syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  /** Announces the end of a run: AUTOMATION_RUN_COMPLETED, the one terminal event, for every outcome. */
  readonly emitRunCompleted: (
    job: AutomationJob,
    run: AutomationRun,
    outcome: 'success' | 'partial' | 'failed' | 'cancelled',
    failure?: { readonly error: string; readonly retryable: boolean },
  ) => void;
  /** Delivers failure notices, emits run-failed and applies the job's retry or cooldown policy. */
  readonly followUp: AutomationFailureFollowUpContext;
  readonly emitJobAutoDisabled: (job: AutomationJob, reason: string) => void;
  /** The manager's delivery wiring, to tell whether a settled run has an answer to deliver (automationRunDeliveryWanted). */
  readonly delivery: Parameters<typeof automationRunDeliveryWanted>[0];
  /** Starts the run's delivery; true when one was started (the run then owes it until it lands). */
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => boolean;
  /** Hears that a run left the running count, so work waiting for a run slot can start. */
  readonly runEnded: () => void;
  readonly applyFailureToJob: (job: AutomationJob, timestamp: number, countRun?: boolean) => AutomationJob;
  readonly removeJobRecord: (jobId: string, reason: string) => void;
}

interface AutomationReconcileContext extends AutomationRunSettleContext {
  readonly configManager: ConfigManager;
  readonly agentStatusProvider: Pick<AgentManager, 'getStatus'>;
  readonly cancelTask?: ((agentId: string) => void) | undefined;
  /**
   * Runs read back from disk at start. Agent ids belong to the process that
   * spawned them, so such a run whose agent this process does not know can
   * never be reported on and is settled at once.
   */
  readonly restoredRunIds: Set<string>;
  readonly saveJobs: () => Promise<void>;
  readonly saveRuns: () => Promise<void>;
  readonly pruneRunHistory: () => void;
  /** Hears the save-then-follow-up of the runs one pass settled, as a promise that never rejects. */
  readonly track: (work: Promise<void>) => void;
}

/** How a run ended, with what each ending carries. */
export type AutomationRunSettlement =
  | { readonly status: 'completed'; readonly endedAt: number; readonly result: unknown; readonly telemetry?: AutomationRunTelemetry | undefined }
  | { readonly status: 'failed'; readonly endedAt: number; readonly error: string; readonly failure: AutomationRunFailure; readonly telemetry?: AutomationRunTelemetry | undefined }
  | { readonly status: 'cancelled'; readonly endedAt: number; readonly reason: string; readonly telemetry?: AutomationRunTelemetry | undefined };

function reportAsyncFailure(label: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  logger.warn(`AutomationManager: ${label} failed`, {
    ...metadata,
    error: summarizeError(error),
  });
}

/**
 * A run cut off before it reported an end (the daemon restarted under it, or
 * its agent vanished unreported) may already have acted: sent mail, posted,
 * written files. Running it again on its own could repeat that, so it is not
 * retried; the failure notice says so and the owner can run it again by hand.
 * Known from structure; nothing to read.
 */
const RUN_CUT_OFF = {
  failureClass: 'terminal',
  basis: 'explicit',
  detail: 'the run was cut off before it reported its end and may already have acted',
} as const;

/** What a run cut off by a restart says, in its record and its failure notice. */
const CUT_OFF_BY_RESTART = 'Interrupted by a restart before it finished. It may already have done part of its work, so it was not retried; run it again by hand if it still needs to run.';
/** What a check-in cut off by a restart says: its note may already have been sent. */
const CHECKIN_CUT_OFF_BY_RESTART = 'Check-in interrupted by a restart before it finished. Its note may already have been sent, so it was not retried; run checkin.run if a check-in is still wanted.';
/** What a run whose agent stopped without reporting says. */
const AGENT_LOST = 'Its agent stopped without reporting how the run ended. It may already have done part of its work, so it was not retried; run it again by hand if it still needs to run.';

/** A run past its deadline was stopped by the manager; the job's policy decides whether to try again. */
const RUN_TIMED_OUT = {
  failureClass: 'retryable',
  basis: 'explicit',
  detail: 'the run passed its timeout and was stopped',
} as const;

/**
 * The failure follow-up for a run that ended as failed. The follow-up
 * classifies the failure before it announces it; at that moment the run's
 * end is announced once with the reading (AUTOMATION_RUN_COMPLETED, outcome
 * `failed`), then the run-failed detail event.
 */
function failedRunFollowUp(context: AutomationRunSettleContext): AutomationFailureFollowUpContext {
  return {
    ...context.followUp,
    emitRunFailed: (job, run, error, retryable) => {
      context.emitRunCompleted(job, run, 'failed', { error, retryable });
      context.followUp.emitRunFailed(job, run, error, retryable);
    },
  };
}

function formatTimeout(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * A settled run, and what it still has to do once its end is saved: start its
 * delivery and its failure follow-up (notice, retry or cooldown). The caller
 * saves first and then calls `followUp`, so an answer or notice never goes out
 * for a run whose end is not on disk.
 */
export interface AutomationRunEnding {
  readonly run: AutomationRun;
  readonly followUp: () => void;
}

const NOTHING_TO_FOLLOW_UP = (): void => {};

/**
 * The one way a running run ends, whoever noticed: the reconcile pass, an
 * operator cancelling the run, a remote runner reporting back, the run's
 * timeout or its job being removed. A completed run resets the job's failure
 * count and is delivered. A cancelled run is recorded and delivered as
 * cancelled; it is not a failure, so it is neither counted nor retried. Only
 * a failed run goes through the failure notice and the job's failure policy.
 * Persistence is the caller's: it saves once for everything it settled, then
 * calls each returned `followUp`.
 */
export function settleAutomationRun(
  context: AutomationRunSettleContext,
  run: AutomationRun,
  settlement: AutomationRunSettlement,
  source: string,
): AutomationRunEnding {
  const stored = context.runs.get(run.id) ?? run;
  if (stored.status !== 'running' || !canSettleStoredRun(stored, settlement.status)) return { run: stored, followUp: NOTHING_TO_FOLLOW_UP };
  const { endedAt } = settlement;
  const updatedRun: AutomationRun = {
    ...stored,
    status: settlement.status,
    endedAt,
    durationMs: Math.max(0, endedAt - (stored.startedAt ?? stored.queuedAt)),
    updatedAt: endedAt,
    ...(settlement.telemetry ? { telemetry: settlement.telemetry } : {}),
    ...(settlement.status === 'completed'
      ? { result: settlement.result }
      : settlement.status === 'failed'
        ? { error: settlement.error }
        : { cancelledReason: settlement.reason }),
  };
  context.runs.set(updatedRun.id, updatedRun);
  context.syncRunToRuntime(updatedRun, source);
  context.runEnded();

  const job = context.jobs.get(updatedRun.jobId);
  if (!job) return { run: updatedRun, followUp: NOTHING_TO_FOLLOW_UP };
  const wasEnabled = job.enabled;
  const updatedJob: AutomationJob = settlement.status === 'completed'
    ? { ...job, successCount: job.successCount + 1, failureCount: 0, updatedAt: endedAt }
    : settlement.status === 'failed'
      ? { ...context.applyFailureToJob(job, endedAt, false), lastOutcome: 'failed' as const }
      : { ...job, updatedAt: endedAt };
  context.jobs.set(job.id, updatedJob);
  void context.syncExecutionRoute(updatedJob, updatedRun).catch((error: unknown) => {
    reportAsyncFailure('execution route sync', error, { jobId: updatedJob.id, runId: updatedRun.id });
  });
  if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
    const sessionBody = settlement.status === 'completed'
      ? String(updatedRun.result ?? '')
      : settlement.status === 'failed' ? settlement.error : settlement.reason;
    if (sessionBody.trim().length > 0) {
      void context.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? updatedRun.id, sessionBody, {
        status: settlement.status,
        automationJobId: updatedJob.id,
        automationRunId: updatedRun.id,
        ...(updatedRun.routeId ? { routeId: updatedRun.routeId } : {}),
      }).catch((error: unknown) => {
        reportAsyncFailure('session agent completion', error, { sessionId: updatedRun.sessionId, jobId: updatedJob.id, runId: updatedRun.id });
      });
    }
  }
  context.syncJobToRuntime(updatedJob, source);
  if (settlement.status === 'completed') context.emitRunCompleted(updatedJob, updatedRun, 'success');
  else if (settlement.status === 'cancelled') context.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
  // A failed run is announced by its failure notice when that goes to the
  // job's own targets; sending the run message too would say it twice.
  // Save, then deliver: the run's end carries `delivery: owed` in the caller's
  // save, the delivery starts only after that save, and the write that records
  // the delivery clears it, so a daemon that stops in between delivers it after
  // its restart (deliverOwedRuns).
  const owed = (settlement.status !== 'failed' || !failureNoticeCoversRunDelivery(updatedJob))
    && automationRunDeliveryWanted(context.delivery, updatedJob, updatedRun);
  if (owed) context.runs.set(updatedRun.id, { ...updatedRun, delivery: { state: 'owed', effect: automationRunEffect(updatedRun.id) } });
  // A one-shot job is done only when a run of it succeeded. A failed or
  // cancelled one stays (disabled once its occurrence fired) so the owner or
  // an agent can retry the run or start it by hand; that run's success removes
  // it, once its answer was delivered (the delivery needs the job's targets,
  // also after a restart), see maybeDeliverAutomationRun.
  if (updatedJob.deleteAfterRun && settlement.status === 'completed' && !owed) {
    context.removeJobRecord(updatedJob.id, 'one-shot-complete');
  }
  if (settlement.status === 'failed' && !updatedJob.enabled && wasEnabled) {
    context.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
  }
  const followUp = (): void => {
    if (owed) {
      const owing = context.runs.get(updatedRun.id);
      if (owing?.delivery?.state === 'owed') context.maybeDeliverRun(updatedJob, owing);
    }
    if (settlement.status === 'failed') {
      settleAutomationRunFailure(failedRunFollowUp(context), updatedJob, updatedRun, settlement.error, settlement.failure);
    }
  };
  return { run: context.runs.get(updatedRun.id) ?? updatedRun, followUp };
}

/**
 * Saves what the caller settled, then starts every follow-up, whether or not
 * the save landed (a failed save is logged; the answer is still owed to its
 * person). Never rejects.
 */
export async function saveThenFollowUp(
  save: () => Promise<unknown>,
  followUps: readonly (() => void)[],
  label: string,
): Promise<void> {
  try {
    await save();
  } catch (error) {
    reportAsyncFailure(label, error);
  }
  for (const followUp of followUps) followUp();
}

/** The identity of a run's delivery, the same for every attempt (the delivery manager's `announces`). */
export function automationRunEffect(runId: string): string {
  return `automation:${runId}:result`;
}

/** The deadline a run runs under: its own timeout, else the configured default; 0 is none. */
function runTimeoutMs(context: AutomationReconcileContext, run: AutomationRun): number {
  const own = run.execution?.timeoutMs;
  const value = own !== undefined ? own : Number(context.configManager.get('automation.defaultTimeoutMs') ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function reconcileAutomationActiveRuns(context: AutomationReconcileContext): void {
  const followUps: Array<() => void> = [];
  const settle = (run: AutomationRun, settlement: AutomationRunSettlement, source: string): void => {
    followUps.push(settleAutomationRun(context, run, settlement, source).followUp);
  };
  const now = Date.now();
  for (const run of [...context.runs.values()]) {
    if (run.status !== 'running') continue;
    const restored = context.restoredRunIds.delete(run.id);
    const timeoutMs = runTimeoutMs(context, run);
    if (timeoutMs > 0 && now - (run.startedAt ?? run.queuedAt) > timeoutMs) {
      if (run.agentId && context.cancelTask) {
        try { context.cancelTask(run.agentId); }
        catch (error) { reportAsyncFailure('timed-out agent cancellation', error, { jobId: run.jobId, runId: run.id, agentId: run.agentId }); }
      }
      const error = `Timed out after ${formatTimeout(timeoutMs)}`;
      settle(run, { status: 'failed', endedAt: now, error, failure: { known: RUN_TIMED_OUT } }, 'automation.timeout');
      continue;
    }
    if (!run.agentId) {
      // A check-in is evaluated inside the process that started it, so one read
      // back from disk can never finish. Any other run without an agent is
      // settled by a remote peer's report or, failing that, by its deadline.
      if (restored && run.labels.includes('checkin')) {
        settle(run, { status: 'failed', endedAt: now, error: CHECKIN_CUT_OFF_BY_RESTART, failure: { known: RUN_CUT_OFF } }, 'automation.reconcile');
      }
      continue;
    }
    const agent = context.agentStatusProvider.getStatus(run.agentId);
    if (!agent) {
      // A run read back from disk can never be reported on, because agent ids
      // do not outlive their process: it is settled now. A run this process
      // started whose agent left the registry unreported gets the catch-up
      // window before it is settled the same way.
      const lostAfterMs = Math.max(300_000, Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000);
      if (!restored && now - (run.startedAt ?? run.queuedAt) < lostAfterMs) continue;
      settle(run, { status: 'failed', endedAt: now, error: restored ? CUT_OFF_BY_RESTART : AGENT_LOST, failure: { known: RUN_CUT_OFF } }, 'automation.reconcile');
      continue;
    }
    const terminalStatus = getTerminalAgentState(agent);
    if (!terminalStatus) continue;
    const endedAt = agent.completedAt ?? now;
    const telemetry = buildRunTelemetryFromAgent(agent, run);
    settle(run, terminalStatus === 'completed'
      ? { status: 'completed', endedAt, result: agent.fullOutput ?? agent.progress ?? null, telemetry }
      : terminalStatus === 'failed'
        ? { status: 'failed', endedAt, error: agent.error ?? 'Agent failed', failure: { error: agent.error ?? '' }, telemetry }
        : { status: 'cancelled', endedAt, reason: agent.error ?? 'Agent cancelled', telemetry }, 'automation.reconcile');
  }
  if (followUps.length === 0) return;
  context.pruneRunHistory();
  // One save for every run this pass settled, then their deliveries and failure follow-ups.
  context.track(saveThenFollowUp(() => Promise.all([
    context.saveJobs().catch((error: unknown) => { reportAsyncFailure('job persistence', error); }),
    context.saveRuns(),
  ]), followUps, 'run persistence'));
}
