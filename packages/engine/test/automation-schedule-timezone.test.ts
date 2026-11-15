import { describe, expect, test } from 'bun:test';
import { getNextAutomationOccurrence, normalizeCronSchedule } from '@goodvibes-jev/engine/platform/platform/automation';

describe('automation cron uses requested timezone boundaries', () => {
  test.each([
    ['Monday west of UTC', '0 9 * * 1', 'America/New_York', '2026-07-10T23:50:00Z', '2026-07-13T13:00:00Z'],
    ['Sunday west of UTC', '0 0 * * 0', 'America/New_York', '2026-07-10T23:50:00Z', '2026-07-12T04:00:00Z'],
    ['weekday wraps east of UTC', '0 9 * * 1', 'Pacific/Auckland', '2026-07-12T22:00:00Z', '2026-07-19T21:00:00Z'],
    ['fractional-hour zone', '0 9 * * *', 'Asia/Kathmandu', '2026-07-10T23:50:00Z', '2026-07-11T03:15:00Z'],
    ['month boundary in requested zone', '0 9 1 8 *', 'Asia/Kathmandu', '2026-07-31T21:00:00Z', '2026-08-01T03:15:00Z'],
    ['strictly after matching time', '0 9 * * *', 'Asia/Kathmandu', '2026-07-11T03:15:00Z', '2026-07-12T03:15:00Z'],
    ['DST gap', '30 2 * * *', 'America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T06:30:00Z'],
    ['DST fold after first occurrence', '30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
    ['DST fold from inside the repeated hour', '30 1 * * *', 'America/New_York', '2026-11-01T06:15:00Z', '2026-11-01T06:30:00Z'],
    ['DST fold after the second occurrence', '30 1 * * *', 'America/New_York', '2026-11-01T06:30:00Z', '2026-11-02T06:30:00Z'],
    ['weekdays across the 25-hour day', '0 9 * * 1-5', 'America/New_York', '2026-11-01T00:00:00Z', '2026-11-02T14:00:00Z'],
    ['month-restricted across the fall-back', '30 1 1 12 *', 'America/New_York', '2026-10-31T12:00:00Z', '2026-12-01T06:30:00Z'],
  ])('%s', (_name, expression, timezone, after, expected) => {
    const schedule = normalizeCronSchedule(expression, timezone, 0);
    expect(getNextAutomationOccurrence(schedule, Date.parse(after))).toBe(Date.parse(expected));
  });
});

describe('cron day-of-month across years', () => {
  test('a leap-day schedule is accepted and fires on the next February 29th', () => {
    const schedule = normalizeCronSchedule('0 0 29 2 *', 'UTC', 0);
    expect(getNextAutomationOccurrence(schedule, Date.parse('2026-03-01T00:00:00Z'))).toBe(Date.parse('2028-02-29T00:00:00Z'));
  });

  test('a day no named month has is refused when the schedule is made', () => {
    expect(() => normalizeCronSchedule('0 0 31 2,4 *', 'UTC', 0)).toThrow('never fires');
  });
});
