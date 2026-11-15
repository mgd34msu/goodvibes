import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConversationFollowUpItem } from '@goodvibes-jev/engine/platform/platform/core';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';

function record(overrides: Record<string, unknown>) {
  return { id: 'agent-aaaaaaaa', template: 'engineer', task: 'summarize the report', status: 'completed', startedAt: 0, completedAt: 4000, toolCallCount: 3, fullOutput: '  the answer  ', cohort: undefined as string | undefined, ...overrides };
}

function wire(agent: ReturnType<typeof record>) {
  const runtimeBus = new RuntimeEventBus();
  const followUps: ConversationFollowUpItem[] = [];
  const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
    runtimeBus,
    domainDispatch: createDomainDispatch(createRuntimeStore()),
    contractRunner: { get: () => null, list: () => [] },
    getSystemMessageRouter: () => ({ contract: () => {}, high: () => {}, low: () => {} }),
    queueConversationFollowUp: (item) => { followUps.push(item); },
    requestRender: () => {},
    configManager: {} as ConfigManager,
    agentManager: { getStatus: () => agent, list: () => [] } as unknown as AgentManager,
    toolRegistry: { execute: async () => { throw new Error('unused'); } },
  });
  if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
  const emitCompleted = () => runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: agent.id, durationMs: 4000 }, { sessionId: 's', source: 'test' }));
  const emitFailed = () => runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: agent.id, error: 'boom', durationMs: 4000 }, { sessionId: 's', source: 'test' }));
  return { followUps, emitCompleted, emitFailed, dispose: () => { for (const unsub of unsubs) unsub(); } };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe('delegated-task follow-ups', () => {
  test('a finished standalone agent queues one follow-up carrying its output', async () => {
    const h = wire(record({}));
    h.emitCompleted();
    await flush();
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0]!.key).toBe('agent:agent-aaaaaaaa:completed');
    expect(h.followUps[0]!.result).toBe('the answer');
    h.dispose();
  });

  test('an agent working a contract queues no follow-up of its own: the contract delivers the answer', async () => {
    const h = wire(record({ contractId: 'contract-1' }));
    h.emitCompleted();
    await flush();
    expect(h.followUps).toEqual([]);
    h.dispose();
  });

  test('a failed contract member is also not announced separately', async () => {
    const h = wire(record({ contractId: 'contract-1', status: 'failed' }));
    h.emitFailed();
    await flush();
    expect(h.followUps).toEqual([]);
    h.dispose();
  });
});

describe('cohort summary for agents without contracts', () => {
  test('the last agent of a cohort to end reports the cohort once, and an earlier end does not', async () => {
    const agents = [
      record({ id: 'agent-aaaaaaaa', cohort: 'batch', status: 'completed' }),
      record({ id: 'agent-bbbbbbbb', cohort: 'batch', status: 'running' }),
    ];
    const runtimeBus = new RuntimeEventBus();
    const lines: string[] = [];
    const followUps: ConversationFollowUpItem[] = [];
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch: createDomainDispatch(createRuntimeStore()),
      contractRunner: { get: () => null, list: () => [] },
      getSystemMessageRouter: () => ({ contract: () => {}, high: () => {}, low: (message: string) => { lines.push(message); } }),
      queueConversationFollowUp: (item) => { followUps.push(item); },
      requestRender: () => {},
      configManager: {} as ConfigManager,
      agentManager: {
        getStatus: (id: string) => agents.find((a) => a.id === id) ?? null,
        listByCohort: (cohort: string) => agents.filter((a) => a.cohort === cohort),
        list: () => [],
      } as unknown as AgentManager,
      toolRegistry: { execute: async () => { throw new Error('unused'); } },
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
    const complete = (agentId: string) => runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId, durationMs: 1 }, { sessionId: 's', source: 'test' }));

    complete('agent-aaaaaaaa');
    await flush();
    expect(followUps.filter((item) => item.key.startsWith('cohort:'))).toEqual([]);

    agents[1]!.status = 'completed';
    complete('agent-bbbbbbbb');
    await flush();
    expect(followUps.filter((item) => item.key === 'cohort:batch:complete')).toHaveLength(1);
    expect(lines.some((line) => line.includes('batch'))).toBe(true);
    for (const unsub of unsubs) unsub();
  });
});
