import { expect, test } from 'bun:test';
import { executeCheckinJob } from '../platform/src/platform/automation/checkin-execution.js';
import { executeAutomationJob } from '../platform/src/platform/automation/manager-runtime-execution.js';
import {
  automationJobLifecycle,
  automationRunLifecycle,
  resolveJobEnablement,
} from '../platform/src/platform/automation/manager-runtime-helpers.js';
import type { AutomationJob } from '../platform/src/platform/automation/jobs.js';
import type { AutomationRun } from '../platform/src/platform/automation/runs.js';
import type { AutomationManagerExecutionContext } from '../platform/src/platform/automation/manager-runtime-execution.js';

function job(kind?: 'checkin'): AutomationJob {
  return { id: 'job-1', ...(kind ? { kind } : {}), name: 'Job', enabled: true, status: 'enabled',
    createdAt: 1, updatedAt: 1, createdBy: 'owner', labels: [],
    source: { id: 's', kind: 'manual', enabled: true, createdAt: 1, updatedAt: 1, label: 'Owner', metadata: {} },
    execution: { target: { kind: 'isolated' }, prompt: 'go' }, schedule: { kind: 'cron', expression: '0 * * * *' },
    delivery: {}, failure: { maxConsecutiveFailures: 3 },
    runCount: 0, successCount: 0, failureCount: 0 } as unknown as AutomationJob;
}

function cancelStoredRun(runs: Map<string, AutomationRun>): void {
  const [run] = [...runs.values()];
  runs.set(run!.id, { ...run!, status: 'cancelled', cancelledReason: 'operator-cancelled' });
}

test('a check-in run cancelled while it is evaluating is not overwritten as completed', async () => {
  const j = job('checkin');
  const jobs = new Map([[j.id, j]]);
  const runs = new Map<string, AutomationRun>();
  const emitted: string[] = [];
  const context = { jobs, runs, saveJobs: async () => {}, saveRuns: async () => {}, pruneRunHistory: () => {},
    syncRunToRuntime: () => {}, syncJobToRuntime: () => {}, emitRunQueued: () => {}, emitRunStarted: () => {},
    emitRunCompleted: (_j: AutomationJob, r: AutomationRun) => emitted.push(r.status),
    emitRunFailed: () => {} } as unknown as AutomationManagerExecutionContext;
  const result = await executeCheckinJob(context, async () => {
    cancelStoredRun(runs);
    return { outcome: 'delivered', summary: 'sent' };
  }, j, 'scheduled', true, 1);
  expect(result.status).toBe('cancelled');
  expect([...runs.values()][0]!.status).toBe('cancelled');
  expect(jobs.get(j.id)!.successCount).toBe(0);
  expect(emitted).toEqual([]);
});

test('a run cancelled while its start path fails is not overwritten as failed', async () => {
  const j = job();
  const jobs = new Map([[j.id, j]]);
  const runs = new Map<string, AutomationRun>();
  const failed: string[] = [];
  const context = {
    jobs, runs, configManager: { get: () => undefined },
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    sessionBroker: { start: async () => {} },
    spawnTask: () => 'agent-1',
    saveJobs: async () => {}, saveRuns: async () => {}, pruneRunHistory: () => {},
    syncExecutionRoute: async () => { cancelStoredRun(runs); throw new Error('route sync failed'); },
    syncRunToRuntime: () => {}, syncJobToRuntime: () => {}, emitRunQueued: () => {}, emitRunStarted: () => {},
    emitRunCompleted: () => {}, emitRunFailed: (_j: AutomationJob, r: AutomationRun) => failed.push(r.status),
    applyFailureToJob: (x: AutomationJob) => ({ ...x, failureCount: x.failureCount + 1 }),
    sessionBrokerAppend: async () => {},
  } as unknown as AutomationManagerExecutionContext;
  await expect(executeAutomationJob(context, j, 'manual', false)).rejects.toThrow('route sync failed');
  expect([...runs.values()][0]!.status).toBe('cancelled');
  expect(failed).toEqual([]);
  expect(jobs.get(j.id)!.failureCount).toBe(0);
});

test('run lifecycle: terminal states are final; running settles to any terminal', () => {
  for (const s of ['completed', 'failed', 'cancelled', 'missed'] as const) expect(automationRunLifecycle.isTerminal(s)).toBe(true);
  expect(automationRunLifecycle.next('running')).toEqual(['completed', 'failed', 'cancelled']);
  const refused = automationRunLifecycle.check('cancelled', 'completed');
  expect(refused.ok).toBe(false);
  // 'queued' is read by scheduler-capacity and accepted from persisted data, so it stays declared.
  expect(automationRunLifecycle.isState('queued')).toBe(true);
});

test('job lifecycle declares persisted-only states and enabled/status derive from one function', () => {
  expect(automationJobLifecycle.isState('error')).toBe(true);
  expect(automationJobLifecycle.isState('archived')).toBe(true);
  expect(automationJobLifecycle.can('enabled', 'paused')).toBe(true);
  expect(automationJobLifecycle.can('paused', 'enabled')).toBe(true);
  expect(resolveJobEnablement({ enabled: false })).toEqual({ enabled: false, status: 'paused' });
  expect(resolveJobEnablement({ status: 'enabled' })).toEqual({ enabled: true, status: 'enabled' });
  expect(resolveJobEnablement({ status: 'paused' })).toEqual({ enabled: false, status: 'paused' });
  expect(resolveJobEnablement({ enabled: true, status: 'error' })).toEqual({ enabled: true, status: 'error' });
  expect(resolveJobEnablement({ enabled: true })).toEqual({ enabled: true, status: 'enabled' });
});
