import { describe, expect, test } from 'bun:test';
import { buildScheduleEditPreview, parseScheduleEditArgs } from '../../agent/schedule-edit.ts';
import { formatScheduleEditPreview } from '../../agent/schedule-edit-format.ts';

const REQUEST = ['--explicit-user-request', 'Move the morning review'];

function preview(args: readonly string[]) {
  const parsed = parseScheduleEditArgs(['sched-1', ...args, ...REQUEST]);
  expect(parsed.errors).toEqual([]);
  return buildScheduleEditPreview(parsed);
}

/** The `key:value` arguments of the printed `schedule action:"edit"` route. */
function routeArguments(text: string): Record<string, string> {
  const line = text.split('\n').find((candidate) => candidate.includes('schedule action:"edit"'));
  expect(line).toBeDefined();
  const out: Record<string, string> = {};
  for (const match of line!.matchAll(/(\w+):("(?:[^"\\]|\\.)*"|[^\s]+)/g)) {
    out[match[1]!] = match[2]!.startsWith('"') ? (JSON.parse(match[2]!) as string) : match[2]!;
  }
  return out;
}

describe('the schedule edit confirmation route', () => {
  test('carries the bare cron expression, with timezone and stagger as their own arguments', () => {
    const before = preview(['--cron', '0 9 * * *', '--timezone', 'America/New_York', '--stagger-ms', '5000']);
    const route = routeArguments(formatScheduleEditPreview(before));

    expect(route.scheduleKind).toBe('cron');
    expect(route.scheduleValue).toBe('0 9 * * *');
    expect(route.timezone).toBe('America/New_York');
    expect(route.staggerMs).toBe('5000');

    // Feeding the route's arguments back through the parser reproduces the previewed edit.
    const replayed = parseScheduleEditArgs([
      'sched-1',
      '--cron', route.scheduleValue!,
      '--timezone', route.timezone!,
      '--stagger-ms', route.staggerMs!,
      ...REQUEST,
    ]);
    expect(replayed.errors).toEqual([]);
    expect(buildScheduleEditPreview(replayed).payload.schedule).toEqual(before.payload.schedule);
  });

  test('an interval edit keeps its value and adds no cron-only arguments', () => {
    const route = routeArguments(formatScheduleEditPreview(preview(['--every', '2h'])));
    expect(route.scheduleKind).toBe('every');
    expect(route.timezone).toBeUndefined();
    expect(route.staggerMs).toBeUndefined();
  });
});
