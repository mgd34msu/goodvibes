/**
 * UX Anti-Regression: Cancellation During Heavy Updates
 *
 * Drives the real runtime store through its domain dispatch: a turn is cancelled
 * while tools and agents are in flight, and the resulting conversation and agent
 * state is what the UI would render.
 */
import { describe, test, expect } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import {
  selectConversation,
  selectAgents,
  selectIsTurnActive,
  selectRunningAgents,
} from '../../runtime/store/selectors/index.ts';

const TURN_ID = 'turn-cancel-001';

function startBusyTurn(toolCount: number, agentCount: number) {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);

  dispatch.dispatchTurnEvent({ type: 'TURN_SUBMITTED', turnId: TURN_ID, prompt: 'work' });
  dispatch.dispatchTurnEvent({ type: 'STREAM_START', turnId: TURN_ID });
  dispatch.dispatchTurnEvent({
    type: 'STREAM_DELTA',
    turnId: TURN_ID,
    content: 'partial...',
    accumulated: 'partial...',
    toolCalls: [],
  });
  for (let i = 0; i < toolCount; i++) {
    const callId = `tc-${i}`;
    dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId, turnId: TURN_ID, tool: `Tool${i}`, args: {} });
    dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId, turnId: TURN_ID, tool: `Tool${i}`, startedAt: 1 });
  }
  for (let i = 0; i < agentCount; i++) {
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: `agent-${i}`, task: `task ${i}` });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: `agent-${i}` });
  }
  return { store, dispatch };
}

describe('ux:cancellation: abort during heavy tool/agent updates', () => {
  test('setup leaves the turn streaming with every tool executing and every agent running', () => {
    const { store } = startBusyTurn(4, 3);
    const conversation = selectConversation(store.getState());
    expect(conversation.turnState).toBe('streaming');
    expect(selectIsTurnActive(store.getState())).toBe(true);
    expect([...conversation.activeToolCalls.values()].every((tc) => tc.state === 'executing')).toBe(true);
    expect(selectRunningAgents(store.getState())).toHaveLength(3);
  });

  test('TURN_CANCEL ends the turn: cancelled, no longer active, reason recorded', () => {
    const { store, dispatch } = startBusyTurn(3, 0);
    const before = selectConversation(store.getState());

    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, reason: 'user abort', stopReason: 'cancelled' });

    const after = selectConversation(store.getState());
    expect(after.turnState).toBe('cancelled');
    expect(selectIsTurnActive(store.getState())).toBe(false);
    expect(after.turnEndedAt).toBeDefined();
    expect(after.lastTurnError).toBe('user abort');
    expect(after.lastTurnStopReason).toBe('cancelled');
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.source).toBe('TURN_CANCEL');
  });

  test('tools still executing at cancel are settled by their own TOOL_CANCELLED, none left executing', () => {
    const { store, dispatch } = startBusyTurn(8, 0);
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, stopReason: 'cancelled' });

    for (let i = 0; i < 8; i++) {
      dispatch.dispatchToolEvent({ type: 'TOOL_CANCELLED', callId: `tc-${i}`, turnId: TURN_ID, tool: `Tool${i}` });
    }

    const { activeToolCalls } = selectConversation(store.getState());
    expect(activeToolCalls.size).toBe(8);
    expect([...activeToolCalls.values()].map((tc) => tc.state)).toEqual(Array(8).fill('cancelled'));
  });

  test('a tool that already succeeded is not rewritten to cancelled by a late cancel', () => {
    const { store, dispatch } = startBusyTurn(2, 0);
    dispatch.dispatchToolEvent({ type: 'TOOL_SUCCEEDED', callId: 'tc-0', turnId: TURN_ID, tool: 'Tool0', durationMs: 5 });
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, stopReason: 'cancelled' });
    dispatch.dispatchToolEvent({ type: 'TOOL_CANCELLED', callId: 'tc-0', turnId: TURN_ID, tool: 'Tool0' });
    dispatch.dispatchToolEvent({ type: 'TOOL_CANCELLED', callId: 'tc-1', turnId: TURN_ID, tool: 'Tool1' });

    const { activeToolCalls } = selectConversation(store.getState());
    expect(activeToolCalls.get('tc-0')?.state).toBe('succeeded');
    expect(activeToolCalls.get('tc-1')?.state).toBe('cancelled');
  });

  test('a stream delta arriving after the cancel does not revive the turn', () => {
    const { store, dispatch } = startBusyTurn(1, 0);
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, stopReason: 'cancelled' });
    const cancelled = selectConversation(store.getState());

    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: TURN_ID,
      content: 'late',
      accumulated: 'partial...late',
      toolCalls: [],
    });

    const after = selectConversation(store.getState());
    expect(after.turnState).toBe('cancelled');
    expect(after.stream.accumulated).toBe(cancelled.stream.accumulated);
  });

  test('cancelling twice keeps the first end time and reason', () => {
    const { store, dispatch } = startBusyTurn(0, 0);
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, reason: 'first', stopReason: 'cancelled' });
    const first = selectConversation(store.getState());

    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, reason: 'second', stopReason: 'cancelled' });

    const second = selectConversation(store.getState());
    expect(second.lastTurnError).toBe('first');
    expect(second.turnEndedAt).toBe(first.turnEndedAt);
    expect(second.revision).toBe(first.revision);
  });

  test('a cancel for a different turn id is ignored', () => {
    const { store, dispatch } = startBusyTurn(1, 0);
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: 'some-other-turn', stopReason: 'cancelled' });
    expect(selectConversation(store.getState()).turnState).toBe('streaming');
  });

  test('cancelled agents leave the running set and keep a terminal status with an end time', () => {
    const { store, dispatch } = startBusyTurn(2, 5);
    expect(selectRunningAgents(store.getState())).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId: `agent-${i}`, reason: 'user abort' });
    }

    const agents = selectAgents(store.getState());
    expect(agents.activeAgentIds).toHaveLength(0);
    expect(selectRunningAgents(store.getState())).toHaveLength(0);
    for (const agent of agents.agents.values()) {
      expect(agent.status).toBe('cancelled');
      expect(agent.endedAt).toBeDefined();
    }
  });

  test('a late AGENT_RUNNING does not bring a cancelled agent back', () => {
    const { store, dispatch } = startBusyTurn(0, 1);
    dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId: 'agent-0' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'agent-0' });

    expect(selectAgents(store.getState()).agents.get('agent-0')?.status).toBe('cancelled');
    expect(selectRunningAgents(store.getState())).toHaveLength(0);
  });

  test('cancelling an idle store changes nothing', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: TURN_ID, stopReason: 'cancelled' });
    expect(selectConversation(store.getState()).turnState).toBe('idle');
  });
});
