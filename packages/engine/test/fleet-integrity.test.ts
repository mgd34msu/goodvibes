/**
 * Fleet read-model honesty: an agent that only reports progress can stall, an
 * automation control request that failed shows on its node, and the archive
 * count follows the sources.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createProcessRegistry } from '../platform/src/platform/runtime/fleet/index.ts';
import { withFleetArchive } from '../platform/src/platform/runtime/fleet/archive.ts';
import { automationJobNodeId } from '../platform/src/platform/runtime/fleet/adapters/automation.ts';
import type { FleetSnapshot, ProcessNode, ProcessRegistry, ProcessState } from '../platform/src/platform/runtime/fleet/types.ts';
import type { ProcessRegistryDeps } from '../platform/src/platform/runtime/fleet/registry.ts';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.ts';
import type { AutomationJob } from '../platform/src/platform/automation/index.ts';
import { ownedAutomationJob } from '../platform/src/platform/automation/job-mutations.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { emitAgentAwaitingTool, emitAgentProgress } from '../platform/src/platform/runtime/emitters/agents.ts';
import type { EmitterContext } from '../platform/src/platform/runtime/emitters/index.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';

const T0 = 1_750_000_000_000;
const ctx: EmitterContext = { sessionId: 's', traceId: 't', source: 'test' };
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

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
    now: () => T0,
    ...overrides,
  };
}

const agent = (id: string): AgentRecord => ({
  id, task: 'work', template: 'engineer', tools: [], status: 'running', startedAt: T0, toolCallCount: 0,
  orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
});

describe('agent stall detection', () => {
  async function stateAfterSilence(emit: (bus: RuntimeEventBus) => void): Promise<ProcessState> {
    const bus = new RuntimeEventBus();
    let clock = T0 + 1_000;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent('a')], cancel: () => false },
      runtimeBus: bus, now: () => clock, stalledThresholdMs: 20_000,
    }));
    emit(bus);
    await flush();
    clock = T0 + 90_000;
    const state = registry.getNode('a')!.state;
    registry.dispose();
    return state;
  }

  test('silence after a progress line stalls', async () => {
    expect(await stateAfterSilence((bus) => emitAgentProgress(bus, ctx, { agentId: 'a', progress: 'Turn 2 · bash' }))).toBe('stalled');
  });

  test('silence during a started tool call does not', async () => {
    expect(await stateAfterSilence((bus) => emitAgentAwaitingTool(bus, ctx, { agentId: 'a', callId: 'c', tool: 'bash' }))).toBe('executing-tool');
  });

  test('a progress report from inside a started tool call does not end the exemption', async () => {
    expect(await stateAfterSilence((bus) => {
      emitAgentProgress(bus, ctx, { agentId: 'a', progress: 'Turn 2 · bash' });
      emitAgentAwaitingTool(bus, ctx, { agentId: 'a', callId: 'c', tool: 'bash' });
      emitAgentProgress(bus, ctx, { agentId: 'a', progress: 'Turn 2 · bash' });
    })).toBe('executing-tool');
  });
});

describe('automation control requests', () => {
  const job = ownedAutomationJob({
    id: 'job-1', labels: [], createdAt: T0, updatedAt: T0, name: 'Job', status: 'enabled', enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 }, execution: { target: { kind: 'isolated' }, prompt: 'x' },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 60_000, retryPolicy: { maxAttempts: 3, delayMs: 1_000, strategy: 'fixed' } },
    source: { id: 'src', kind: 'manual', label: 't', enabled: true, createdAt: T0, updatedAt: T0, metadata: {} },
    runCount: 0, successCount: 0, failureCount: 0, deleteAfterRun: false,
  } satisfies AutomationJob);

  test('a kill whose removal is rejected is shown on the job node', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    let fail = true;
    const registry = createProcessRegistry(makeDeps({
      automationManager: { listJobs: () => [job], setEnabled: async () => job, removeJob: async () => { if (fail) throw new Error('store is read-only'); return true; } },
    }));
    const id = automationJobNodeId('job-1');
    expect(registry.getNode(id)?.controlFailure).toBeUndefined();
    expect(registry.kill(id)).toEqual([id]);
    await flush();
    expect(registry.getNode(id)?.controlFailure).toMatchObject({ op: 'kill', message: expect.stringContaining('store is read-only') });
    // A later request that goes through clears the failure.
    fail = false;
    registry.kill(id);
    await flush();
    expect(registry.getNode(id)?.controlFailure).toBeUndefined();
    registry.dispose();
    warn.mockRestore();
  });
});

describe('fleet archive count', () => {
  const node = (id: string): ProcessNode => ({
    id, kind: 'agent', label: id, state: 'done', elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  });

  test('an archived node the source dropped is no longer counted, and a reused id is visible again', () => {
    let nodes = [node('a'), node('b')];
    const base: ProcessRegistry = {
      query: (): FleetSnapshot => ({ capturedAt: 1, nodes }),
      getNode: (id) => nodes.find((n) => n.id === id) ?? null,
      subscribe: () => () => {}, interrupt: () => false, resume: () => false, kill: () => [],
      steer: () => ({ queued: false, reason: 'fake' }), dispose: () => {},
    };
    const archive = withFleetArchive(base);
    expect(archive.archive('a').archived).toBe(true);
    expect(archive.archivedCount()).toBe(1);
    nodes = [node('b')];
    expect(archive.archivedCount()).toBe(0);
    nodes = [node('a'), node('b')];
    expect(archive.query().nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
