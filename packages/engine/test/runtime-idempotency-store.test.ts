import { describe, expect, test } from 'bun:test';
import { GoodVibesError } from '../errors/src/index.js';
import { IdempotencyStore } from '../platform/src/platform/runtime/idempotency/index.js';

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('IdempotencyStore finalization', () => {
  test('separator-containing identifiers cannot alias another call tuple', () => {
    const store = new IdempotencyStore();
    const first = store.generateKey({ sessionId: 'session:part', turnId: 'turn', callId: 'call' });
    const second = store.generateKey({ sessionId: 'session', turnId: 'part:turn', callId: 'call' });
    expect(first).not.toBe(second);
    expect(store.checkAndRecord(first).status).toBe('new');
    expect(store.checkAndRecord(second).status).toBe('new');
    expect(store.checkAndRecord(store.generateKey({ sessionId: 'session:part', turnId: 'turn', callId: 'call' })).status).toBe('in-flight');
  });

  test('markComplete surfaces a missing record', () => {
    const store = new IdempotencyStore();
    const err = captureThrown(() => store.markComplete('missing-key'));

    expect(err).toBeInstanceOf(GoodVibesError);
    expect((err as GoodVibesError).code).toBe('IDEMPOTENCY_RECORD_NOT_FOUND');
    expect((err as GoodVibesError).operation).toBe('markComplete');
  });

  test('markFailed surfaces a missing record', () => {
    const store = new IdempotencyStore();
    const err = captureThrown(() => store.markFailed('missing-key'));

    expect(err).toBeInstanceOf(GoodVibesError);
    expect((err as GoodVibesError).code).toBe('IDEMPOTENCY_RECORD_NOT_FOUND');
    expect((err as GoodVibesError).operation).toBe('markFailed');
  });

  test('normal finalization keeps completed records queryable', () => {
    const store = new IdempotencyStore();
    const key = store.generateKey({ sessionId: 's', turnId: 't', callId: 'c' });

    expect(store.checkAndRecord(key).status).toBe('new');
    store.markComplete(key, { ok: true });

    const record = store.getRecord(key);
    expect(record?.status).toBe('completed');
    expect(record?.result).toEqual({ ok: true });
  });
});
