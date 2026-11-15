/**
 * UX Anti-Regression: Streaming + Tool Burst + Agent Burst
 *
 * Drives the real runtime store with interleaved stream deltas, tool phase events
 * and agent events, and checks that the conversation and agent domains each keep
 * the state the UI renders from.
 */
import { describe, test, expect } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import {
  selectConversation,
  selectAgents,
  selectIsTurnActive,
  selectRunningAgents,
} from '../../runtime/store/selectors/index.ts';

const TURN_ID = 'turn-stream-001';

function startStreamingTurn() {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  dispatch.dispatchTurnEvent({ type: 'TURN_SUBMITTED', turnId: TURN_ID, prompt: 'go' });
  dispatch.dispatchTurnEvent({ type: 'STREAM_START', turnId: TURN_ID });
  return { store, dispatch };
}

function delta(accumulated: string) {
  return { type: 'STREAM_DELTA' as const, turnId: TURN_ID, content: accumulated.slice(-1), accumulated, toolCalls: [] };
}

describe('ux:streaming-burst: simultaneous streaming + tool + agent bursts', () => {
  describe('streaming state integrity during concurrent tool calls', () => {
    test('tool calls registered while streaming do not change the turn state', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchTurnEvent(delta('partial response text'));

      for (const [callId, tool] of [['call-001', 'Read'], ['call-002', 'Edit'], ['call-003', 'Bash']] as const) {
        dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId, turnId: TURN_ID, tool, args: { path: '/tmp/test.ts' } });
        dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId, turnId: TURN_ID, tool, startedAt: 1 });
      }

      const conversation = selectConversation(store.getState());
      expect(conversation.turnState).toBe('streaming');
      expect(selectIsTurnActive(store.getState())).toBe(true);
      expect(conversation.activeToolCalls.size).toBe(3);
      expect(conversation.toolCallsThisTurn).toBe(3);
      expect(conversation.activeToolCalls.get('call-002')?.toolName).toBe('Edit');
    });

    test('stream accumulation is not disturbed by tool events between deltas', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchTurnEvent(delta('He'));
      dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: 'c1', turnId: TURN_ID, tool: 'Read', args: {} });
      dispatch.dispatchTurnEvent(delta('Hel'));
      dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId: 'c1', turnId: TURN_ID, tool: 'Read', startedAt: 1 });
      dispatch.dispatchTurnEvent(delta('Hello'));
      dispatch.dispatchToolEvent({ type: 'TOOL_SUCCEEDED', callId: 'c1', turnId: TURN_ID, tool: 'Read', durationMs: 3 });

      const { stream } = selectConversation(store.getState());
      expect(stream.accumulated).toBe('Hello');
      expect(stream.deltaCount).toBe(3);
      expect(stream.firstDeltaAt).toBeDefined();
    });

    test('a burst of 10 concurrent tool calls keeps every call id and counts each once', () => {
      const { store, dispatch } = startStreamingTurn();
      for (let i = 0; i < 10; i++) {
        dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: `call-${i}`, turnId: TURN_ID, tool: `Tool${i}`, args: {} });
      }

      const conversation = selectConversation(store.getState());
      expect([...conversation.activeToolCalls.keys()]).toEqual(Array.from({ length: 10 }, (_, i) => `call-${i}`));
      expect(conversation.toolCallsThisTurn).toBe(conversation.activeToolCalls.size);
    });

    test('tool events carrying another turn id are dropped', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: 'stray', turnId: 'other-turn', tool: 'Read', args: {} });

      const conversation = selectConversation(store.getState());
      expect(conversation.activeToolCalls.size).toBe(0);
      expect(conversation.toolCallsThisTurn).toBe(0);
    });

    test('a settled tool call is not reopened by a stale phase event from the burst', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: 'c1', turnId: TURN_ID, tool: 'Read', args: {} });
      dispatch.dispatchToolEvent({ type: 'TOOL_SUCCEEDED', callId: 'c1', turnId: TURN_ID, tool: 'Read', durationMs: 1 });
      dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId: 'c1', turnId: TURN_ID, tool: 'Read', startedAt: 2 });

      expect(selectConversation(store.getState()).activeToolCalls.get('c1')?.state).toBe('succeeded');
    });

    test('the batch-ready event moves the streaming turn on to tool dispatch', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchTurnEvent(delta('x'));
      dispatch.dispatchTurnEvent({ type: 'TOOL_BATCH_READY', turnId: TURN_ID, toolCalls: ['c1', 'c2'] });
      expect(selectConversation(store.getState()).turnState).toBe('tool_dispatch');
    });
  });

  describe('agent burst during active streaming', () => {
    test('spawning agents while streaming leaves the conversation slice untouched', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchTurnEvent(delta('streaming'));
      const conversation = selectConversation(store.getState());

      for (let i = 0; i < 5; i++) {
        dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: `agent-${i}`, task: `task ${i}` });
        dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: `agent-${i}` });
      }

      expect(selectConversation(store.getState())).toBe(conversation);
      expect(selectAgents(store.getState()).totalSpawned).toBe(5);
      expect(selectRunningAgents(store.getState())).toHaveLength(5);
    });

    test('a child agent records its parent and peak concurrency counts the whole burst', () => {
      const { store, dispatch } = startStreamingTurn();
      dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'parent', task: 'lead' });
      dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'parent' });
      for (let i = 0; i < 3; i++) {
        dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: `child-${i}`, task: `sub ${i}`, parentAgentId: 'parent' });
        dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: `child-${i}`, parentAgentId: 'parent' });
      }

      const agents = selectAgents(store.getState());
      for (let i = 0; i < 3; i++) expect(agents.agents.get(`child-${i}`)?.parentAgentId).toBe('parent');
      expect(agents.agents.get('parent')?.parentAgentId).toBeUndefined();
      expect(agents.peakConcurrency).toBe(4);
    });
  });

  describe('state consistency invariants under burst load', () => {
    test('the conversation revision only ever increases across a mixed burst', () => {
      const { store, dispatch } = startStreamingTurn();
      let previous = selectConversation(store.getState()).revision;
      const burst = [
        () => dispatch.dispatchTurnEvent(delta('a')),
        () => dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: 'c1', turnId: TURN_ID, tool: 'Read', args: {} }),
        () => dispatch.dispatchTurnEvent(delta('ab')),
        () => dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId: 'c1', turnId: TURN_ID, tool: 'Read', startedAt: 1 }),
        () => dispatch.dispatchTurnEvent(delta('abc')),
        () => dispatch.dispatchToolEvent({ type: 'TOOL_SUCCEEDED', callId: 'c1', turnId: TURN_ID, tool: 'Read', durationMs: 1 }),
      ];
      for (const step of burst) {
        step();
        const revision = selectConversation(store.getState()).revision;
        expect(revision).toBeGreaterThan(previous);
        previous = revision;
      }
    });

    test('activeAgentIds matches exactly the agents that are not finished', () => {
      const { store, dispatch } = startStreamingTurn();
      for (let i = 0; i < 6; i++) {
        dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: `a${i}`, task: 't' });
        dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: `a${i}` });
      }
      dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'a0', durationMs: 1 });
      dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'a1', error: 'boom', durationMs: 1 });
      dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId: 'a2' });

      const agents = selectAgents(store.getState());
      expect([...agents.activeAgentIds].sort()).toEqual(['a3', 'a4', 'a5']);
      expect(agents.totalCompleted).toBe(1);
      expect(agents.totalFailed).toBe(1);
      expect(agents.agents.size).toBe(6);
    });
  });
});
