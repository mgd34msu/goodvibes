import { describe, expect, test } from 'bun:test';
import { hostedLiveMessageFromTurnFrame, isTerminalTurnFrame, readHostedStreamFrame } from './hosted-session-stream';

const frame = (type: string, payload: Record<string, unknown>) => readHostedStreamFrame({ type, sessionId: 's-1', payload })!;

describe('a turn that ends on the context window preflight', () => {
  const overflow = frame('PREFLIGHT_FAIL', { turnId: 't1', reason: 'context window preflight failed', stopReason: 'context_overflow' });

  test('ends the turn and tells the person what to do next', () => {
    expect(isTerminalTurnFrame(overflow)).toBe(true);
    const message = hostedLiveMessageFromTurnFrame(overflow, () => 5);
    expect(message?.role).toBe('system');
    expect(message?.content).toContain('context window preflight failed');
    expect(message?.content).toContain('Compact');
  });

  test('a rejected duplicate submission does not end the turn that is still running', () => {
    const duplicate = frame('PREFLIGHT_FAIL', { turnId: 't2', reason: 'duplicate submission', stopReason: 'preflight_failed' });
    expect(isTerminalTurnFrame(duplicate)).toBe(false);
    expect(hostedLiveMessageFromTurnFrame(duplicate)).toBeNull();
  });

  test('a frame with no stop reason is not taken as the end of a turn', () => {
    expect(isTerminalTurnFrame(frame('PREFLIGHT_FAIL', {}))).toBe(false);
  });
});

describe('a failed turn', () => {
  test('shows the daemon text as sent, including its hint and retry wait', () => {
    const message = hostedLiveMessageFromTurnFrame(
      frame('TURN_ERROR', { error: 'Provider rate limited. Hint: wait before retrying. Retry in 30s.' }),
      () => 1
    );
    expect(message?.content).toBe('Turn failed: Provider rate limited. Hint: wait before retrying. Retry in 30s.');
  });
});
