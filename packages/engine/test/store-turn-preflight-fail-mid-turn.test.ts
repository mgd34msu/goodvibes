import { describe, expect, test } from 'bun:test';
import { createInitialConversationState } from '../platform/src/platform/runtime/store/domains/conversation.ts';
import { updateConversationState } from '../platform/src/platform/runtime/store/helpers/reducers/conversation.ts';

describe('store conversation turn: preflight failure after the first provider call', () => {
  test('ends the streaming turn as failed and lets the next turn start', () => {
    let d = createInitialConversationState();
    d = updateConversationState(d, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    d = updateConversationState(d, { type: 'PREFLIGHT_OK', turnId: 't1' });
    d = updateConversationState(d, { type: 'STREAM_START', turnId: 't1' });
    d = updateConversationState(d, { type: 'PREFLIGHT_FAIL', turnId: 't1', reason: 'context window preflight failed', stopReason: 'context_overflow' } as never);
    expect(d.turnState).toBe('failed');
    expect(d.lastPreflightFailure).toBe('context window preflight failed');

    d = updateConversationState(d, { type: 'TURN_SUBMITTED', turnId: 't2', prompt: 'again' });
    expect(d.turnState).toBe('preflight');
    expect(d.currentTurnId).toBe('t2');
  });

  test('a preflight failure for another turn id leaves the running turn alone', () => {
    let d = createInitialConversationState();
    d = updateConversationState(d, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    d = updateConversationState(d, { type: 'STREAM_START', turnId: 't1' });
    d = updateConversationState(d, { type: 'PREFLIGHT_FAIL', turnId: 'duplicate', reason: 'duplicate', stopReason: 'preflight_failed' } as never);
    expect(d.turnState).toBe('streaming');
    expect(d.currentTurnId).toBe('t1');
  });
});
