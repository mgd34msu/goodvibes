/**
 * The agent run record's lifecycle table, and the rule that a late executor
 * rejection never relabels a cancelled run as failed.
 */
import { describe, expect, test } from 'bun:test';
import { AgentManager, type AgentExecutor } from '../platform/src/platform/tools/agent/manager.ts';
import { agentRunLifecycle, moveAgentRun } from '../platform/src/platform/tools/agent/record.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

function makeManager(executor: AgentExecutor): AgentManager {
  return new AgentManager({
    configManager: { get: () => null } as never,
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    executor,
  });
}

describe('agentRunLifecycle', () => {
  test('cancelled is final; failed and completed can be woken', () => {
    expect(agentRunLifecycle.isTerminal('cancelled')).toBe(true);
    expect(agentRunLifecycle.can('failed', 'pending')).toBe(true);
    expect(agentRunLifecycle.can('failed', 'running')).toBe(true);
    expect(agentRunLifecycle.can('completed', 'pending')).toBe(true);
    expect(agentRunLifecycle.can('completed', 'running')).toBe(true);
    expect(agentRunLifecycle.can('cancelled', 'failed')).toBe(false);
    expect(agentRunLifecycle.can('running', 'failed')).toBe(true);
    expect(agentRunLifecycle.can('pending', 'completed')).toBe(false);
  });

  test('moveAgentRun leaves a refused record untouched', () => {
    const record = { status: 'cancelled' } as Parameters<typeof moveAgentRun>[0];
    expect(moveAgentRun(record, 'failed')).toBe(false);
    expect(record.status).toBe('cancelled');
    const running = { status: 'running' } as Parameters<typeof moveAgentRun>[0];
    expect(moveAgentRun(running, 'failed')).toBe(true);
    expect(running.status).toBe('failed');
  });
});

describe('late executor rejection', () => {
  test('does not turn a cancelled run into failed', async () => {
    let reject!: (e: Error) => void;
    const gate = new Promise<void>((_, rej) => { reject = rej; });
    const manager = makeManager({ runAgent: async (record) => { record.status = 'running'; await gate; } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    expect(manager.cancel(record.id)).toBe(true);
    const completedAt = record.completedAt;
    reject(new Error('late boom'));
    // join resolves once the rejection has been handled, so the assertions below see its final effect.
    await manager.join(record.id);
    expect(record.status).toBe('cancelled');
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBe(completedAt);
  });

  test('still marks a running run failed on rejection', async () => {
    const manager = makeManager({ runAgent: async (record) => { record.status = 'running'; throw new Error('boom'); } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await manager.join(record.id);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('boom');
  });
});

function busManager(executor: AgentExecutor): { manager: AgentManager; failed: string[] } {
  const manager = makeManager(executor);
  const bus = new RuntimeEventBus();
  const failed: string[] = [];
  bus.on('AGENT_FAILED', ({ payload }) => { failed.push((payload as { agentId: string }).agentId); });
  manager.setRuntimeBus(bus);
  return { manager, failed };
}

describe('a run that ends without its executor reporting it', () => {
  test('an executor rejection publishes one AGENT_FAILED', async () => {
    const { manager, failed } = busManager({ runAgent: async () => { throw new Error('context could not be built'); } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await manager.join(record.id);
    expect(record.status).toBe('failed');
    expect(failed).toEqual([record.id]);
  });

  test('a run the executor already failed and reported is not reported again', async () => {
    const { manager, failed } = busManager({ runAgent: async (record) => { record.status = 'failed'; throw new Error('late'); } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await manager.join(record.id);
    expect(failed).toEqual([]);
  });

  test('a woken run whose executor rejects publishes AGENT_FAILED', async () => {
    let calls = 0;
    const { manager, failed } = busManager({ runAgent: async (record) => {
      calls += 1;
      if (calls === 1) { record.status = 'failed'; return; }
      throw new Error('wake could not start');
    } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await manager.join(record.id);
    expect(manager.wakeWithSteer(record.id, 'try again').woke).toBe(true);
    await manager.join(record.id);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('wake could not start');
    expect(failed).toEqual([record.id]);
  });
});

describe('wakeWithSteer admission', () => {
  test('a second steer while a wake is queued is refused, and the queued run keeps the previous outcome until it starts', async () => {
    // The failed run's clean-up is still draining, so the wake waits behind it.
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const manager = makeManager({ runAgent: async (record) => {
      calls += 1;
      if (calls === 1) { record.status = 'failed'; await cleanup; return; }
      record.status = 'completed';
    } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    // The executor marks the run failed before it starts draining, so no waiting is needed.
    expect(record.status).toBe('failed');
    expect(manager.wakeWithSteer(record.id, 'first').woke).toBe(true);
    expect(record.status).toBe('failed');
    const second = manager.wakeWithSteer(record.id, 'second');
    expect(second.woke).toBe(false);
    expect(second.reason).toContain('already queued');
    release();
    await manager.join(record.id);
    expect(calls).toBe(2);
    expect(record.status).toBe('completed');
  });
});

describe('fleet capacity and a queued wake', () => {
  test('a wake waiting for the previous run to drain already holds its slot', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const manager = new AgentManager({
      configManager: { get: (key: string) => (key === 'fleet.maxSize' ? 1 : null) } as never,
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      executor: { runAgent: async (record) => {
        calls += 1;
        if (calls === 1) { record.status = 'failed'; await cleanup; return; }
        record.status = 'completed';
      } },
    });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    expect(record.status).toBe('failed');
    expect(manager.wakeWithSteer(record.id, 'again').woke).toBe(true);
    expect(record.status).toBe('failed');
    expect(() => manager.spawn({ mode: 'spawn', task: 'other work', outsideContract: true })).toThrow();
    release();
    await manager.join(record.id);
    expect(calls).toBe(2);
  });
});

describe('exportState', () => {
  test('a run interrupted by the export carries a reason', () => {
    const manager = makeManager({ runAgent: () => new Promise<void>(() => {}) });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    const exported = manager.exportState().find(agent => agent.id === record.id)!;
    expect(exported.status).toBe('failed');
    expect(exported.error).toBe('interrupted by a restart');
  });
});

describe('a wake as surfaces see it', () => {
  test('the woken run publishes a marked AGENT_RUNNING before its executor runs', async () => {
    let calls = 0;
    const manager = makeManager({ runAgent: async (record) => {
      calls += 1;
      record.status = calls === 1 ? 'failed' : 'completed';
    } });
    const bus = new RuntimeEventBus();
    const running: { type?: string; agentId: string; wake?: unknown }[] = [];
    bus.on('AGENT_RUNNING', ({ payload }) => { running.push(payload as { type?: string; agentId: string; wake?: unknown }); });
    manager.setRuntimeBus(bus);
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await manager.join(record.id);
    expect(running).toEqual([]);
    expect(manager.wakeWithSteer(record.id, 'try again').woke).toBe(true);
    await manager.join(record.id);
    expect(running).toEqual([{ type: 'AGENT_RUNNING', agentId: record.id, wake: true }]);
  });
});
