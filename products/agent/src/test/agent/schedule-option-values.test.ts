import { describe, expect, test } from 'bun:test';
import { parseAutonomyScheduleArgs } from '../../agent/autonomy-schedule.ts';
import { readOptionValue } from '../../agent/schedule-delivery-targets.ts';

const BASE = ['--task', 'Tidy inbox', '--explicit-user-request', 'Please tidy my inbox every morning.', '--cron', '0 9 * * *'];

describe('option values that start with dashes', () => {
  for (const criteria of ['--- no failed runs', '-- no errors', '--dry-run only']) {
    test(`success criteria "${criteria}" is a value, not a missing one`, () => {
      const parsed = parseAutonomyScheduleArgs([...BASE, '--success-criteria', criteria]);
      expect(parsed.errors).toEqual([]);
      expect(parsed.successCriteria).toBe(criteria);
    });
  }

  test('a following option is still not consumed as a value', () => {
    expect(readOptionValue(['--name', '--cron'], 0, undefined)).toEqual({ value: undefined, nextIndex: 0 });
    const parsed = parseAutonomyScheduleArgs(['--task', '--cron', '0 9 * * *']);
    expect(parsed.errors).toContain('--task requires a value.');
  });
});
