import { settleAutomationRun, type AutomationRunSettlement } from '../../platform/src/platform/automation/manager-runtime-reconcile.ts';
import { applyFailureToJob } from '../../platform/src/platform/automation/manager-runtime-execution.ts';
import type { AutomationJob } from '../../platform/src/platform/automation/jobs.ts';
import type { AutomationRun } from '../../platform/src/platform/automation/runs.ts';

/**
 * The manager's run settlement over a hand-built execution context: what the
 * fixture records (jobs, runs, sync and emit callbacks) is used, and the rest
 * (session messages, delivery, retry timers) does nothing.
 */
export function settleRunOver(context: {
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
  readonly syncRunToRuntime?: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime?: (job: AutomationJob, source: string) => void;
  readonly emitRunCompleted?: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => void;
  readonly emitRunFailed?: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => void;
}): (run: AutomationRun, settlement: AutomationRunSettlement, source: string) => AutomationRun {
  const none = (): void => {};
  return (run, settlement, source) => settleAutomationRun({
    sessionBroker: { completeAgent: async () => null } as never,
    jobs: context.jobs,
    runs: context.runs,
    syncExecutionRoute: async () => {},
    syncRunToRuntime: context.syncRunToRuntime ?? none,
    syncJobToRuntime: context.syncJobToRuntime ?? none,
    emitRunCompleted: context.emitRunCompleted ?? none,
    followUp: {
      jobs: context.jobs, retryTimers: new Map(), deliveryManager: null,
      activeRunCount: () => 0, maxConcurrentRuns: () => 1,
      executeJob: async () => { throw new Error('No retries in this fixture'); },
      saveJobs: async () => {}, scheduleJob: none, deliverFailureNotice: none,
      emitRunFailed: context.emitRunFailed ?? none,
    },
    emitJobAutoDisabled: none,
    maybeDeliverRun: none,
    applyFailureToJob,
    removeJobRecord: (jobId) => { context.jobs.delete(jobId); },
  }, run, settlement, source);
}
