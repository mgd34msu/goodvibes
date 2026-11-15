import { describe, expect, test } from 'bun:test';
import { checkUsagePct, parseCompactionCheck, parseCompactionReceipt } from './compaction';

const RAW_RECEIPT = {
  type: 'COMPACTION_RECEIPT',
  sessionId: 's-1',
  trigger: 'auto',
  strategy: 'summarize-oldest',
  tokensAfter: 20,
  outcome: 'applied',
};

// The control-plane stream wraps each runtime event: the event's fields live in `payload`.
function envelope(event: Record<string, unknown>, sessionId = 's-1') {
  return { type: event.type, ts: 1, traceId: 't-1', sessionId, source: 'runtime', payload: event };
}

describe('enveloped frames', () => {
  test('a receipt inside the stream envelope keeps its outcome and token counts', () => {
    const receipt = parseCompactionReceipt(envelope({ ...RAW_RECEIPT, outcome: 'applied', tokensBefore: 100 }));
    expect(receipt?.outcome).toBe('applied');
    expect(receipt?.tokensBefore).toBe(100);
    expect(receipt?.sessionId).toBe('s-1');
  });

  test('a check inside the stream envelope yields the live usage numbers', () => {
    const check = parseCompactionCheck(envelope({ type: 'COMPACTION_CHECK', sessionId: 's-1', tokenCount: 80, threshold: 100 }));
    expect(check?.tokenCount).toBe(80);
    expect(check ? checkUsagePct(check) : null).toBe(80);
  });
});
