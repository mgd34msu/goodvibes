import { describe, expect, test } from 'bun:test';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentCalendarRegistry } from '../../agent/calendar-registry.ts';
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
    expect(first.duplicates).toBe(0);

    const second = registry.importIcs(ics);
    expect(second.imported).toHaveLength(0);
    expect(second.duplicates).toBe(2);
  });
});
