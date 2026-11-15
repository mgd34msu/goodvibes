import { describe, expect, test } from 'bun:test';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentCalendarRegistry } from '../../agent/calendar-registry.ts';
import { expandRecurringEvent, parseIcs } from '../../agent/ics-calendar.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function calendar(events: readonly (readonly string[])[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('events without a UID', () => {
  test('two UID-less events that start together are both imported, and a re-import skips both', () => {
    const root = makeProjectTempDir('goodvibes-agent-ics-identity');
    const registry = AgentCalendarRegistry.fromShellPaths(createShellPathService({ workingDirectory: root, homeDirectory: root }));
    const ics = calendar([
      ['SUMMARY:Dentist', 'DTSTART:20250301T100000Z', 'DTEND:20250301T110000Z'],
      ['SUMMARY:Standup', 'DTSTART:20250301T100000Z', 'DTEND:20250301T103000Z'],
    ]);

    const first = registry.importIcs(ics);
    expect(first.imported.map((event) => event.title).sort()).toEqual(['Dentist', 'Standup']);
    expect(first.skipped).toBe(0);

    const second = registry.importIcs(ics);
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toBe(2);
  });

  test('the fallback identity is stable for one event and differs when any of its fields does', () => {
    const uidOf = (lines: readonly string[]) => parseIcs(calendar([lines]))[0]!.uid;
    const base = ['SUMMARY:Dentist', 'DTSTART:20250301T100000Z', 'DTEND:20250301T110000Z', 'LOCATION:Main St'];
    expect(uidOf(base)).toBe(uidOf([...base]));
    expect(uidOf(base)).not.toBe(uidOf(base.map((line) => line.replace('Main St', 'Side St'))));
    expect(uidOf(base)).not.toBe(uidOf(base.map((line) => line.replace('110000Z', '120000Z'))));
  });
});

describe('text escapes', () => {
  test('an escaped backslash followed by n is a backslash and an n, not a newline', () => {
    const [event] = parseIcs(calendar([['UID:esc@test', 'SUMMARY:Path', 'DTSTART:20250301T100000Z', 'DESCRIPTION:C:\\\\new;one\\, two\\nthree']]));
    expect(event!.description).toBe('C:\\new;one, two\nthree');
  });
});

describe('recurrence expansion', () => {
  test('a monthly series from the 31st lands on each month end and does not drift to the 28th', () => {
    const event = { uid: 'm', summary: 'Rent', dtstart: '2024-01-31T09:00:00Z', allDay: false, rrule: 'FREQ=MONTHLY;COUNT=4' };
    const starts = expandRecurringEvent(event, new Date('2024-01-01T00:00:00Z'), 200).map((occurrence) => occurrence.dtstart);
    expect(starts).toEqual(['2024-01-31T09:00:00Z', '2024-02-29T09:00:00Z', '2024-03-31T09:00:00Z', '2024-04-30T09:00:00Z']);
  });

  test('the same holds for a series anchored in a time zone', () => {
    const event = {
      uid: 'tz', summary: 'Rent', dtstart: '2024-01-31T09:00:00', tzid: 'America/New_York', allDay: false, rrule: 'FREQ=MONTHLY;COUNT=3',
    };
    const starts = expandRecurringEvent(event, new Date('2024-01-01T00:00:00Z'), 200).map((occurrence) => occurrence.dtstart);
    expect(starts).toEqual(['2024-01-31T09:00:00', '2024-02-29T09:00:00', '2024-03-31T09:00:00']);
  });

  test('COUNT counts from the start of the series, so a series that already ended yields nothing', () => {
    const event = { uid: 'c', summary: 'Trial', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=DAILY;COUNT=2' };
    expect(expandRecurringEvent(event, new Date('2024-06-01T00:00:00Z'))).toEqual([]);
  });

  test('COUNT still bounds the occurrences that fall after the reference date', () => {
    const event = { uid: 'c2', summary: 'Trial', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=DAILY;COUNT=3' };
    const starts = expandRecurringEvent(event, new Date('2024-01-02T00:00:00Z')).map((occurrence) => occurrence.dtstart);
    expect(starts).toEqual(['2024-01-02T09:00:00Z', '2024-01-03T09:00:00Z']);
  });
});
