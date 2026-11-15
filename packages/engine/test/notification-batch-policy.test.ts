import { describe, expect, test } from 'bun:test';
import { BatchPolicy } from '../platform/src/platform/runtime/notifications/policies/batch-policy.ts';
import type { Notification } from '../platform/src/platform/runtime/notifications/types.ts';

function note(timestamp: number): Notification {
  return { domain: 'tools', level: 'warning', timestamp } as unknown as Notification;
}

describe('BatchPolicy', () => {
  test('groups that collapsed nothing leave nothing to flush across many windows', () => {
    const policy = new BatchPolicy(1_000);
    for (let i = 0; i < 50; i++) expect(policy.evaluate(note(i * 5_000))).toBeUndefined();
    expect(policy.flush(1_000_000)).toEqual([]);
  });

  test('a group that collapsed notifications is flushed once with its count', () => {
    const policy = new BatchPolicy(1_000);
    expect(policy.evaluate(note(0))).toBeUndefined();
    expect(policy.evaluate(note(100))).toBe('tools:warning');
    expect(policy.evaluate(note(200))).toBe('tools:warning');
    const flushed = policy.flush(5_000);
    expect(flushed.map((f) => f.batchCount)).toEqual([3]);
    expect(policy.flush(6_000)).toEqual([]);
  });

  test('collapsed groups from expired windows are held for flush, bounded when never flushed', () => {
    const policy = new BatchPolicy(10);
    let t = 0;
    for (let i = 0; i < 500; i++) {
      policy.evaluate(note(t));
      policy.evaluate(note(t + 1));
      t += 1_000;
    }
    expect(policy.flush(t + 1_000).length).toBeLessThanOrEqual(201);
  });
});
