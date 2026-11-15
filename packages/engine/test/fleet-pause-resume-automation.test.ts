/**
 * Pause<->resume through the fleet registry, and /schedule automation jobs
 * surfacing into the fleet tree.
 */
import { describe, expect, test, spyOn, type Mock } from 'bun:test';
import { createProcessRegistry } from '../platform/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps } from '../platform/src/platform/runtime/fleet/registry.js';
import type { ScheduleEntry, TriggerDefinition } from '../platform/src/platform/tools/workflow/index.js';
import type { AutomationJob, ManagedAutomationJob } from '../platform/src/platform/automation/index.js';
import { ownedAutomationJob } from '../platform/src/platform/automation/job-mutations.js';
import { adaptAutomationJob, automationJobNodeId } from '../platform/src/platform/runtime/fleet/adapters/automation.js';
import { logger } from '../platform/src/platform/utils/logger.js';

const T0 = 1_750_000_000_000;

function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    contractRunner: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    now: () => T0 + 5_000,
    ...overrides,
  };
}

function makeAutomationJob(overrides: Partial<AutomationJob> & { id: string }): ManagedAutomationJob {
  return ownedAutomationJob({
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    name: `Job ${overrides.id}`,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 },
    execution: { target: { kind: 'isolated' }, prompt: 'do the thing' },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 60_000,
      retryPolicy: { maxAttempts: 3, delayMs: 1_000, strategy: 'fixed' },
    },
    source: { id: 'src-1', kind: 'manual', label: 'test', enabled: true, createdAt: T0, updatedAt: T0, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  });
}

/**
 * Records the promise a fake automation manager hands back, so a test can wait
 * for exactly the fire-and-forget work the registry started. The registry
 * attaches its own handler to the same promise before the test awaits it, so
 * its handler has run by the time the wait returns.
 */
function pendingOps(): { track<T>(promise: Promise<T>): Promise<T>; settled(): Promise<void> } {
  const pending: Array<Promise<unknown>> = [];
  return {
    track(promise) { pending.push(promise); return promise; },
    async settled() { await Promise.allSettled(pending); },
  };
}

// ---------------------------------------------------------------------------
// Pause <-> resume
// ---------------------------------------------------------------------------

describe('fleet registry: pause/resume', () => {
  test('trigger: disabled is "paused" (not "killed"), resumable only while paused; resume() re-arms via triggerManager.enable', () => {
    const trigger: TriggerDefinition = { id: 'trg-1', event: 'push', action: 'run tests', enabled: false };
    const enableCalls: string[] = [];
    const registry = createProcessRegistry(makeDeps({
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: {
          list: () => [trigger],
          remove: () => false,
          disable: () => false,
          enable: (id: string) => {
            enableCalls.push(id);
            trigger.enabled = true;
            return true;
          },
        },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      },
    }));

    const node = registry.getNode('trg-1')!;
    expect(node.state).toBe('paused');
    expect(node.capabilities.resumable).toBe(true);
    expect(node.capabilities.pausable).toBe(false);

    expect(registry.resume('trg-1')).toBe(true);
    expect(enableCalls).toEqual(['trg-1']);
    expect(registry.getNode('trg-1')!.state).toBe('idle');
    expect(registry.getNode('trg-1')!.capabilities.resumable).toBe(false);
    registry.dispose();
  });

  test('schedule: disabled is "paused"; resume() re-arms via scheduleManager.enable(name)', () => {
    const schedule: ScheduleEntry = { name: 'nightly', interval: '1h', command: 'make build', enabled: false };
    const enableCalls: string[] = [];
    const registry = createProcessRegistry(makeDeps({
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
        scheduleManager: {
          list: () => [schedule],
          remove: () => false,
          disable: () => false,
          enable: (name: string) => {
            enableCalls.push(name);
            schedule.enabled = true;
            return true;
          },
        },
      },
    }));

    expect(registry.getNode('schedule:nightly')!.state).toBe('paused');
    expect(registry.resume('schedule:nightly')).toBe(true);
    expect(enableCalls).toEqual(['nightly']);
    expect(registry.getNode('schedule:nightly')!.state).toBe('idle');
    registry.dispose();
  });

  test('resume() honestly refuses: unknown id, an already-armed trigger, and a kind with no enable-based resume (agent)', () => {
    const trigger: TriggerDefinition = { id: 'trg-armed', event: 'push', action: 'run', enabled: true };
    let enableCalled = false;
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [{
          id: 'ag-1', task: 'x', template: 'engineer', tools: [], status: 'running' as const, startedAt: T0,
          toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct' as const, reviewMode: 'none' as const,
          communicationLane: 'parent-only' as const,
        }],
        cancel: () => false,
      },
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: {
          list: () => [trigger],
          remove: () => false,
          disable: () => false,
          enable: () => { enableCalled = true; return true; },
        },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      },
    }));

    expect(registry.resume('does-not-exist')).toBe(false);
    expect(registry.resume('ag-1')).toBe(false); // agent: never resumable
    expect(registry.resume('trg-armed')).toBe(false); // already idle, nothing to resume
    expect(enableCalled).toBe(false); // never dispatched for any of the above
    registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// /schedule automation jobs in the fleet tree
// ---------------------------------------------------------------------------

describe('adaptAutomationJob', () => {
  test('maps enabled -> idle / disabled -> paused, kind "schedule", raw.source marker set', () => {
    const enabledNode = adaptAutomationJob(makeAutomationJob({ id: 'job-a', enabled: true, status: 'enabled' }));
    expect(enabledNode.kind).toBe('schedule');
    expect(enabledNode.state).toBe('idle');
    expect(enabledNode.capabilities.killable).toBe(true);
    expect(enabledNode.capabilities.resumable).toBe(false);
    expect(enabledNode.id).toBe(automationJobNodeId('job-a'));
    expect((enabledNode.raw as { source: string }).source).toBe('automation-manager');

    const pausedNode = adaptAutomationJob(makeAutomationJob({ id: 'job-b', enabled: false, status: 'paused' }));
    expect(pausedNode.state).toBe('paused');
    expect(pausedNode.capabilities.resumable).toBe(true);
  });
});

describe('fleet registry: automation jobs in the fleet tree', () => {
  test('absent automationManager dep: zero automation-job nodes (graceful degrade)', () => {
    const registry = createProcessRegistry(makeDeps());
    expect(registry.query().nodes).toEqual([]);
    registry.dispose();
  });

  test('present automationManager dep: enumerates jobs as schedule-kind nodes, namespaced apart from workflow ScheduleEntry ids', () => {
    const job = makeAutomationJob({ id: 'nightly', enabled: true });
    // A workflow-tool ScheduleEntry happens to share the literal name "nightly",
    // must not collide with the automation job's node id.
    const scheduleEntry: ScheduleEntry = { name: 'nightly', interval: '1h', command: 'x', enabled: true };
    const registry = createProcessRegistry(makeDeps({
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
        scheduleManager: { list: () => [scheduleEntry], remove: () => false, disable: () => false, enable: () => false },
      },
      automationManager: { listJobs: () => [job], setEnabled: async () => job, removeJob: async () => true },
    }));

    const ids = registry.query().nodes.map((n) => n.id);
    expect(ids).toContain('schedule:nightly');
    expect(ids).toContain(automationJobNodeId('nightly'));
    expect(ids.filter((id) => id.includes('nightly')).length).toBe(2); // both present, distinct ids
    registry.dispose();
  });

  test('kill() dispatches removeJob() fire-and-forget: returns the node id synchronously, next query reflects removal once settled', async () => {
    const jobs = new Map<string, ManagedAutomationJob>([['job-1', makeAutomationJob({ id: 'job-1' })]]);
    const ops = pendingOps();
    const registry = createProcessRegistry(makeDeps({
      automationManager: {
        listJobs: () => [...jobs.values()],
        setEnabled: async () => null,
        removeJob: (jobId: string) => ops.track((async () => {
          jobs.delete(jobId);
          return true;
        })()),
      },
    }));

    const nodeId = automationJobNodeId('job-1');
    expect(registry.getNode(nodeId)).not.toBeNull();
    const affected = registry.kill(nodeId);
    expect(affected).toEqual([nodeId]); // dispatched, reported synchronously
    await ops.settled();
    expect(registry.getNode(nodeId)).toBeNull();
    registry.dispose();
  });

  test('interrupt() and resume() dispatch setEnabled(false/true) fire-and-forget; next query reflects the toggle', async () => {
    let job = makeAutomationJob({ id: 'job-2', enabled: true });
    const setEnabledCalls: Array<{ jobId: string; enabled: boolean }> = [];
    const ops = pendingOps();
    const registry = createProcessRegistry(makeDeps({
      automationManager: {
        listJobs: () => [job],
        setEnabled: (jobId: string, enabled: boolean) => ops.track((async () => {
          setEnabledCalls.push({ jobId, enabled });
          job = ownedAutomationJob({ ...job, enabled });
          return job;
        })()),
        removeJob: async () => true,
      },
    }));

    const nodeId = automationJobNodeId('job-2');
    expect(registry.getNode(nodeId)!.state).toBe('idle');
    expect(registry.interrupt(nodeId)).toBe(true);
    await ops.settled();
    expect(registry.getNode(nodeId)!.state).toBe('paused');
    expect(registry.getNode(nodeId)!.capabilities.resumable).toBe(true);

    expect(registry.resume(nodeId)).toBe(true);
    await ops.settled();
    expect(registry.getNode(nodeId)!.state).toBe('idle');

    expect(setEnabledCalls).toEqual([
      { jobId: 'job-2', enabled: false },
      { jobId: 'job-2', enabled: true },
    ]);
    registry.dispose();
  });

  test('a rejected async control call is logged, never silently lost, and never thrown synchronously', async () => {
    const job = makeAutomationJob({ id: 'job-3', enabled: true });
    const ops = pendingOps();
    const registry = createProcessRegistry(makeDeps({
      automationManager: {
        listJobs: () => [job],
        setEnabled: () => ops.track((async () => { throw new Error('automation backend unavailable'); })()),
        removeJob: () => ops.track((async () => { throw new Error('automation backend unavailable'); })()),
      },
    }));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    const nodeId = automationJobNodeId('job-3');

    expect(() => registry.interrupt(nodeId)).not.toThrow();
    await ops.settled();
    expect(warnSpy).toHaveBeenCalled();
    const loggedAutomationFailure = warnSpy.mock.calls.some((call) =>
      typeof call[0] === 'string' && call[0].includes('automation job') && call[0].includes('failed'));
    expect(loggedAutomationFailure).toBe(true);

    warnSpy.mockRestore();
    registry.dispose();
  });
});
