/**
 * The agent run record's lifecycle table, and the rule that a late executor
 * rejection never relabels a cancelled run as failed.
 */
import { describe, expect, test } from 'bun:test';
import { AgentManager, type AgentExecutor } from '../platform/src/platform/tools/agent/manager.ts';
import { agentRunLifecycle, moveAgentRun } from '../platform/src/platform/tools/agent/record.ts';

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
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(record.status).toBe('cancelled');
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBe(completedAt);
  });

  test('still marks a running run failed on rejection', async () => {
    const manager = makeManager({ runAgent: async (record) => { record.status = 'running'; throw new Error('boom'); } });
    const record = manager.spawn({ mode: 'spawn', task: 'do work', outsideContract: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(record.status).toBe('failed');
    expect(record.error).toContain('boom');
  });
});
