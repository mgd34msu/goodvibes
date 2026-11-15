import { expect, test } from 'bun:test';
import { createEventEnvelope } from '../platform/src/platform/runtime/events/envelope.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { registerContractRuntimeEvents } from '../platform/src/platform/runtime/bootstrap-runtime-events.ts';
import type { AgentManager } from '../platform/src/platform/tools/agent/index.ts';

type Agent = { id: string; status: string; cohort: string; startedAt: number; toolCallCount: number; completedAt?: number };

function fixture(agents: Agent[]) {
  const low: string[] = [];
  const followUps: string[] = [];
  const bus = new RuntimeEventBus();
  const agentManager = {
    listByCohort: (cohort: string) => agents.filter((agent) => agent.cohort === cohort),
    getStatus: (id: string) => agents.find((agent) => agent.id === id) ?? null,
  } as unknown as AgentManager;
  registerContractRuntimeEvents({
    runtimeBus: bus,
    getSystemMessageRouter: () => ({ low: (message) => { low.push(message); }, high: () => {}, contract: () => {} }),
    queueConversationFollowUp: (item) => { followUps.push(item.key); },
    requestRender: () => {},
    agentManager,
    contractRunner: {
      get: () => ({ units: [{ agentIds: ['a1'] }] }) as never,
      list: () => [],
    },
  });
  // Listeners run in a microtask after emit.
  const finish = async (): Promise<void> => { bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', {
    type: 'CONTRACT_FAILED', contractId: 'c1', reason: 'fixture', occurrenceId: 'o',
  } as never, { sessionId: 's', traceId: 't', source: 'test' })); await Promise.resolve(); };
  return { low, followUps, finish, agents };
}

test('a repeated end event for a finished cohort reports it once', async () => {
  const fixtureState = fixture([{ id: 'a1', status: 'completed', cohort: 'batch', startedAt: 0, toolCallCount: 1, completedAt: 1000 }]);
  await fixtureState.finish();
  await fixtureState.finish();
  expect(fixtureState.low.filter((line) => line.includes("Cohort 'batch' complete"))).toHaveLength(1);
});

test('the cohort is reported again when its set of agents or their outcomes changed', async () => {
  const state = fixture([{ id: 'a1', status: 'completed', cohort: 'batch', startedAt: 0, toolCallCount: 1, completedAt: 1000 }]);
  await state.finish();
  state.agents.push({ id: 'a2', status: 'failed', cohort: 'batch', startedAt: 0, toolCallCount: 0, completedAt: 5 });
  await state.finish();
  expect(state.low.filter((line) => line.includes("Cohort 'batch' complete"))).toHaveLength(2);
});
