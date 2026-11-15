import { AgentManager } from '../tools/agent/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun, AutomationRunTelemetry } from './runs.js';
import { buildRunTelemetryFromAgent, canSettleStoredRun, getTerminalAgentState } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import {
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
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => void;
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
 * A run whose agent vanished before reporting a terminal state was lost to a
 * restart, not failed by its work, so another attempt could succeed. Known
 * from structure; nothing to read.
 */
const AGENT_STATE_LOST = {
  failureClass: 'retryable',
  basis: 'explicit',
  detail: 'the agent state was lost before the run completed',
} as const;

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
 * The one way a running run ends, whoever noticed: the reconcile pass, an
 * operator cancelling the run, a remote runner reporting back, the run's
 * timeout or its job being removed. A completed run resets the job's failure
 * count and is delivered. A cancelled run is recorded and delivered as
 * cancelled; it is not a failure, so it is neither counted nor retried. Only
 * a failed run goes through the failure notice and the job's failure policy.
 * Persistence is the caller's: it saves once for everything it settled.
 */
export function settleAutomationRun(
  context: AutomationRunSettleContext,
  run: AutomationRun,
  settlement: AutomationRunSettlement,
  source: string,
): AutomationRun {
  const stored = context.runs.get(run.id) ?? run;
  if (stored.status !== 'running' || !canSettleStoredRun(stored, settlement.status)) return stored;
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

  const job = context.jobs.get(updatedRun.jobId);
  if (!job) return updatedRun;
  const wasEnabled = job.enabled;
  const updatedJob: AutomationJob = settlement.status === 'completed'
    ? { ...job, successCount: job.successCount + 1, failureCount: 0, updatedAt: endedAt }
    : settlement.status === 'failed'
      ? context.applyFailureToJob(job, endedAt, false)
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
  if (settlement.status !== 'failed' || !failureNoticeCoversRunDelivery(updatedJob)) context.maybeDeliverRun(updatedJob, updatedRun);
  // A one-shot job is done when its run succeeded, or when it was already
  // disabled (created disabled, or its only occurrence fired): the failure
  // follow-up never retries a disabled job, so nothing would run it again.
  if (updatedJob.deleteAfterRun && (settlement.status === 'completed' || !wasEnabled)) {
    context.removeJobRecord(updatedJob.id, 'one-shot-complete');
  }
  if (settlement.status === 'failed') {
    settleAutomationRunFailure(failedRunFollowUp(context), updatedJob, updatedRun, settlement.error, settlement.failure);
    if (!updatedJob.enabled && wasEnabled) {
      context.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }
  }
  return updatedRun;
}

/** The deadline a run runs under: its own timeout, else the configured default; 0 is none. */
function runTimeoutMs(context: AutomationReconcileContext, run: AutomationRun): number {
  const own = run.execution?.timeoutMs;
  const value = own !== undefined ? own : Number(context.configManager.get('automation.defaultTimeoutMs') ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function reconcileAutomationActiveRuns(context: AutomationReconcileContext): void {
  let settled = false;
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
      settleAutomationRun(context, run, { status: 'failed', endedAt: now, error, failure: { known: RUN_TIMED_OUT } }, 'automation.timeout');
      settled = true;
      continue;
    }
    if (!run.agentId) continue;
    const agent = context.agentStatusProvider.getStatus(run.agentId);
    if (!agent) {
      // A run read back from disk can never be reported on, because agent ids
      // do not outlive their process: it is settled now. A run this process
      // started whose agent left the registry unreported gets the catch-up
      // window before it is settled the same way.
      const lostAfterMs = Math.max(300_000, Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000);
      if (!restored && now - (run.startedAt ?? run.queuedAt) < lostAfterMs) continue;
      settleAutomationRun(context, run, { status: 'failed', endedAt: now, error: 'Agent state lost before completion', failure: { known: AGENT_STATE_LOST } }, 'automation.reconcile');
      settled = true;
      continue;
    }
    const terminalStatus = getTerminalAgentState(agent);
    if (!terminalStatus) continue;
    const endedAt = agent.completedAt ?? now;
    const telemetry = buildRunTelemetryFromAgent(agent, run);
    settleAutomationRun(context, run, terminalStatus === 'completed'
      ? { status: 'completed', endedAt, result: agent.fullOutput ?? agent.streamingContent ?? agent.progress ?? null, telemetry }
      : terminalStatus === 'failed'
        ? { status: 'failed', endedAt, error: agent.error ?? 'Agent failed', failure: { error: agent.error ?? '' }, telemetry }
        : { status: 'cancelled', endedAt, reason: agent.error ?? 'Agent cancelled', telemetry }, 'automation.reconcile');
    settled = true;
  }
  if (!settled) return;
  void context.saveJobs().catch((error: unknown) => {
    reportAsyncFailure('job persistence', error);
  });
  context.pruneRunHistory();
  void context.saveRuns().catch((error: unknown) => {
    reportAsyncFailure('run persistence', error);
  });
}
