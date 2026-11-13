/**
 * The store's compactionState mirrors the manager: it returns to idle after a
 * run ends and after a below-threshold check, while a failure stays visible
 * until the next compaction begins. The manager's table declares the
 * strategy-to-strategy moves that escalation and revert perform.
 */
import { describe, expect, test } from 'bun:test';
import { createInitialSessionState } from '../platform/src/platform/runtime/store/domains/session.ts';
import { updateSessionState } from '../platform/src/platform/runtime/store/helpers/reducers/lifecycle.ts';
import { compactionLifecycle } from '../platform/src/platform/runtime/compaction/lifecycle.ts';
import type { CompactionEvent } from '../platform/src/events/compaction.ts';

const S = 's1';
const run = (events: CompactionEvent[]) => events.reduce(updateSessionState, createInitialSessionState());

describe('compaction store mirror', () => {
  test('below-threshold check leaves the mirror idle, not "running"', () => {
    const s = run([{ type: 'COMPACTION_CHECK', sessionId: S, tokenCount: 100, threshold: 5000 }]);
    expect(s.compactionState).toBe('idle');
  });

  test('a check at or over threshold is active', () => {
    const s = run([{ type: 'COMPACTION_CHECK', sessionId: S, tokenCount: 6000, threshold: 5000 }]);
    expect(s.compactionState).toBe('checking_threshold');
  });

  test('a finished run settles to idle and keeps lastCompactedAt', () => {
    const s = run([
      { type: 'COMPACTION_CHECK', sessionId: S, tokenCount: 6000, threshold: 5000 },
      { type: 'COMPACTION_AUTOCOMPACT', sessionId: S } as CompactionEvent,
      { type: 'COMPACTION_DONE', sessionId: S, strategy: 'autocompact', tokensBefore: 6000, tokensAfter: 2000, durationMs: 5 },
    ]);
    expect(s.compactionState).toBe('idle');
    expect(s.lastCompactedAt).toBeGreaterThan(0);
  });

  test('an applied receipt does not strand the mirror in done', () => {
    const s = run([
      { type: 'COMPACTION_DONE', sessionId: S, strategy: 'autocompact', tokensBefore: 6000, tokensAfter: 2000, durationMs: 5 },
      { type: 'COMPACTION_RECEIPT', sessionId: S, outcome: 'applied' } as unknown as CompactionEvent,
    ]);
    expect(s.compactionState).toBe('idle');
  });

  test('a failure stays visible until the next compaction starts', () => {
    const failed = run([{ type: 'COMPACTION_FAILED', sessionId: S, strategy: 'autocompact', error: 'x' }]);
    expect(failed.compactionState).toBe('failed');
    expect(failed.recoveryError).toBe('x');
    const next = updateSessionState(failed, { type: 'COMPACTION_CHECK', sessionId: S, tokenCount: 6000, threshold: 5000 });
    expect(next.compactionState).toBe('checking_threshold');
  });
});

describe('compaction table', () => {
  test('declares the strategy-to-strategy moves escalation and revert perform', () => {
    const strategies = ['microcompact', 'collapse', 'autocompact', 'reactive_compact'] as const;
    for (const a of strategies) for (const b of strategies) {
      expect(compactionLifecycle.can(a, b)).toBe(a !== b);
    }
  });
});
