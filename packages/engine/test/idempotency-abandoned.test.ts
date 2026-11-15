/**
 * A caller that dies without finalizing its record must not block retries of
 * that key forever, nor leave the store growing without bound.
 */
import { describe, expect, test } from 'bun:test';
import { IdempotencyStore } from '../platform/src/platform/runtime/idempotency/index.ts';

function clocked(config: ConstructorParameters<typeof IdempotencyStore>[0] = {}) {
  let t = 1_000;
  const store = new IdempotencyStore({ now: () => t, ...config });
  return { store, advance: (ms: number) => { t += ms; } };
}

describe('IdempotencyStore abandoned records', () => {
  test('an in-flight record blocks a retry until it is older than the timeout, then the retry is new', () => {
    const { store, advance } = clocked({ inFlightTimeoutMs: 60_000 });
    expect(store.checkAndRecord('k').status).toBe('new');
    advance(59_000);
    expect(store.checkAndRecord('k').status).toBe('in-flight');
    advance(2_000);
    expect(store.checkAndRecord('k').status).toBe('new');
    expect(store.size).toBe(1);
  });

  test('a record that was finalized in time keeps its result', () => {
    const { store, advance } = clocked({ inFlightTimeoutMs: 60_000 });
    store.checkAndRecord('k');
    store.markComplete('k', 'result');
    advance(30_000);
    expect(store.checkAndRecord('k')).toMatchObject({ status: 'duplicate', record: { result: 'result' } });
  });

  test('sweep drops abandoned in-flight records', () => {
    const { store, advance } = clocked({ inFlightTimeoutMs: 1_000 });
    store.checkAndRecord('a');
    advance(5_000);
    store.sweep();
    expect(store.size).toBe(0);
  });

  test('maxRecords bounds finalized records but never drops a live in-flight one', () => {
    const { store } = clocked({ maxRecords: 3 });
    store.checkAndRecord('live');
    for (const key of ['a', 'b', 'c', 'd']) { store.checkAndRecord(key); store.markComplete(key); }
    store.sweep();
    expect(store.size).toBe(3);
    expect(store.getRecord('live')?.status).toBe('in-flight');
    expect(store.getRecord('a')).toBeUndefined();
  });
});
