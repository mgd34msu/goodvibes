import { describe, expect, test } from 'bun:test';
import { createInitialConversationState } from '../platform/src/platform/runtime/store/domains/conversation.ts';
import { updateConversationState } from '../platform/src/platform/runtime/store/helpers/reducers/conversation.ts';
import type { ConversationDomainState } from '../platform/src/platform/runtime/store/domains/conversation.ts';

const TURN = 'turn-1';

function live(): ConversationDomainState {
  let d = createInitialConversationState();
  d = updateConversationState(d, { type: 'TURN_SUBMITTED', turnId: TURN, prompt: 'hi' });
  d = updateConversationState(d, { type: 'PREFLIGHT_OK', turnId: TURN });
  d = updateConversationState(d, { type: 'STREAM_START', turnId: TURN });
  d = updateConversationState(d, { type: 'TOOL_RECEIVED', turnId: TURN, callId: 'c1', tool: 'read', args: {} } as never);
  return d;
}

const base = { turnId: TURN, callId: 'c1', tool: 'read' };

describe('store tool-call state is final once settled', () => {
  test('a late executing/failed event cannot overwrite succeeded', () => {
    let d = live();
    d = updateConversationState(d, { type: 'TOOL_SUCCEEDED', ...base, durationMs: 1 } as never);
    d = updateConversationState(d, { type: 'TOOL_EXECUTING', ...base } as never);
    d = updateConversationState(d, { type: 'TOOL_FAILED', ...base, error: 'late', durationMs: 1 } as never);
    expect(d.activeToolCalls.get('c1')?.state).toBe('succeeded');
    expect(d.activeToolCalls.get('c1')?.error).toBeUndefined();
  });

  test('cancelled is not overwritten by a failure', () => {
    let d = live();
    d = updateConversationState(d, { type: 'TOOL_CANCELLED', ...base } as never);
    d = updateConversationState(d, { type: 'TOOL_FAILED', ...base, error: 'x', durationMs: 1 } as never);
    expect(d.activeToolCalls.get('c1')?.state).toBe('cancelled');
  });

  test('a budget event then TOOL_FAILED still records the failure message', () => {
    let d = live();
    d = updateConversationState(d, { type: 'BUDGET_EXCEEDED_MS', ...base, phase: 'executing', limitMs: 5, elapsedMs: 9 } as never);
    d = updateConversationState(d, { type: 'TOOL_FAILED', ...base, error: 'over budget', durationMs: 9 } as never);
    expect(d.activeToolCalls.get('c1')?.state).toBe('failed');
    expect(d.activeToolCalls.get('c1')?.error).toBe('over budget');
  });

  test('non-terminal progress still advances', () => {
    let d = live();
    d = updateConversationState(d, { type: 'TOOL_EXECUTING', ...base } as never);
    expect(d.activeToolCalls.get('c1')?.state).toBe('executing');
  });
});
