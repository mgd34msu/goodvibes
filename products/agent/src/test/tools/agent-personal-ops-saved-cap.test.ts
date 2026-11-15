import { describe, expect, test } from 'bun:test';
import { cappedCount } from '../../tools/agent-harness-personal-ops-records.ts';

describe('saved Personal Ops counts', () => {
  test('a count below the cap is the plain total', () => {
    expect(cappedCount(2, 'review')).toBe('2');
    expect(cappedCount(9, 'record')).toBe('9');
  });

  test('a count at the cap says the list may hold more than it shows', () => {
    expect(cappedCount(5, 'review')).toBe('5+ (newest 5 shown)');
    expect(cappedCount(10, 'record')).toBe('10+ (newest 10 shown)');
  });
});
