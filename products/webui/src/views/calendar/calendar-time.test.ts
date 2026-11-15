import { describe, expect, test } from 'bun:test';
import { eventDayKey, eventTimeLabel, isAllDayEvent, localDateOffset, localDayEndIso, localDayStartIso } from './calendar-time';

// The runtime reads the zone once, so pin it before any date is built.
process.env.TZ = 'America/Los_Angeles';

describe('all-day events west of UTC', () => {
  test('an all-day event stays on its own date', () => {
    expect(eventDayKey('2026-12-25T00:00:00.000Z', '2026-12-26T00:00:00.000Z')).toBe('2026-12-25');
    expect(eventTimeLabel('2026-12-25T00:00:00.000Z', '2026-12-26T00:00:00.000Z')).toBe('All day');
  });

  test('an all-day event with no DTEND (end equals start) stays on its own date', () => {
    expect(eventDayKey('2026-12-25T00:00:00.000Z', '2026-12-25T00:00:00.000Z')).toBe('2026-12-25');
    expect(eventTimeLabel('2026-12-25T00:00:00.000Z', '2026-12-25T00:00:00.000Z')).toBe('All day');
  });

  test('a timed event still lands on the viewer local date', () => {
    expect(isAllDayEvent('2026-12-25T00:00:00.000Z', '2026-12-25T01:00:00.000Z')).toBe(false);
    expect(eventDayKey('2026-12-25T00:00:00.000Z', '2026-12-25T01:00:00.000Z')).toBe('2026-12-24');
  });

  test('an event without a readable end is never all-day', () => {
    expect(isAllDayEvent('2026-12-25T00:00:00.000Z')).toBe(false);
  });
});

describe('range bounds follow the local calendar day', () => {
  test('the end bound is the last millisecond of the local date, not 23:59 UTC', () => {
    // 23:59:59.999 on 2026-12-05 in UTC-8 is 07:59:59.999Z on the 6th.
    expect(localDayEndIso('2026-12-05')).toBe('2026-12-06T07:59:59.999Z');
    expect(localDayStartIso('2026-12-05')).toBe('2026-12-05T08:00:00.000Z');
  });

  test('today is the local date', () => {
    // 02:00Z on the 6th is still the 5th in Los Angeles.
    expect(localDateOffset(0, new Date('2026-12-06T02:00:00.000Z'))).toBe('2026-12-05');
    expect(localDateOffset(14, new Date('2026-12-06T02:00:00.000Z'))).toBe('2026-12-19');
  });

  test('no date gives no bound', () => {
    expect(localDayStartIso('')).toBe('');
    expect(localDayEndIso('')).toBe('');
  });
});
