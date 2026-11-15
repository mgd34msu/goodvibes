/**
 * Replay diff compares a recording against an independent replayed stream.
 */
import { describe, expect, test } from 'bun:test';
import { DeterministicReplayEngine } from '../platform/src/platform/core/deterministic-replay.ts';
import type { LedgerEntry } from '../platform/src/platform/runtime/telemetry/exporters/local-ledger.ts';

const entry = (rev: number, eventName: string, payload: unknown = {}): LedgerEntry => ({ runId: 'run-1', rev, eventName, payload, ts: rev });
const snapshot = { capturedAt: 0, domains: [] };

const recording = [
  entry(1, 'TURN_SUBMITTED', { turnId: 't1' }),
  entry(2, 'TOOL_CALLED', { name: 'read', ok: true }),
  entry(3, 'TURN_COMPLETED', { turnId: 't1', stopReason: 'end_turn' }),
];

function loaded() {
  const engine = new DeterministicReplayEngine('/tmp/replay-project');
  engine.load('run-1', snapshot, recording);
  return engine;
}

describe('DeterministicReplayEngine.diff', () => {
  test('without a replayed stream nothing is compared and the snapshot says so', () => {
    const engine = loaded();

    expect(engine.diff()).toEqual([]);
    expect(engine.getSnapshot().diffSource).toBe('none');
  });

  test('an identical replayed stream has no mismatches', () => {
    const engine = loaded();

    expect(engine.diff(recording)).toEqual([]);
    expect(engine.getSnapshot().diffSource).toBe('replayed-events');
  });

  test('a replayed stream missing an event reports it', () => {
    const engine = loaded();
    const mismatches = engine.diff([recording[0]!, recording[1]!]);

    expect(mismatches.some((m) => m.kind === 'missing_event' && m.eventName === 'TURN_COMPLETED')).toBe(true);
    expect(engine.getSnapshot().mismatches).toEqual(mismatches);
  });

  test('a replayed event with a different payload value is a payload mismatch', () => {
    const engine = loaded();
    const mismatches = engine.diff([recording[0]!, entry(2, 'TOOL_CALLED', { name: 'write', ok: true }), recording[2]!]);

    expect(mismatches.map((m) => m.failureMode)).toContain('payload_value_mismatch');
  });

  test('a different terminal outcome for a turn is reported as divergence', () => {
    const engine = loaded();
    const mismatches = engine.diff([recording[0]!, recording[1]!, entry(3, 'TURN_ERROR', { turnId: 't1', error: 'boom' })]);

    expect(mismatches.map((m) => m.failureMode)).toContain('terminal_outcome_diverged');
  });

  test('extra replayed events are reported', () => {
    const engine = loaded();
    const mismatches = engine.diff([...recording, entry(4, 'TOOL_CALLED', {})]);

    expect(mismatches.some((m) => m.kind === 'extra_event')).toBe(true);
  });

  test('loading another run clears the earlier diff source', () => {
    const engine = loaded();
    engine.diff(recording);
    engine.load('run-2', snapshot, recording);

    expect(engine.getSnapshot().diffSource).toBe('none');
  });
});
