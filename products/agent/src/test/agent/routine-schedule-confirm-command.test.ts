import { describe, expect, test } from 'bun:test';
import { routineScheduleConfirmCommand } from '../../agent/routine-schedule-format.ts';
import { parseRoutineSchedulePromotionArgs } from '../../agent/routine-schedule-args.ts';
import {
  buildRoutineSchedulePayload,
  buildRoutineSchedulePreview,
} from '../../agent/routine-schedule-promotion.ts';
import type { AgentRoutineRecord } from '../../agent/routine-registry.ts';

const routine = {
  id: 'r1',
  name: 'Morning review',
  description: 'Look over the inbox.',
  steps: '1. Read',
  tags: [],
  triggers: [],
  reviewState: 'approved',
} as unknown as AgentRoutineRecord;

// The slash command splits on whitespace but keeps a JSON-quoted argument whole.
function tokenize(command: string): string[] {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  return tokens.map((token) => (token.startsWith('"') ? (JSON.parse(token) as string) : token));
}

function confirmedPayload(args: readonly string[]) {
  const parsed = parseRoutineSchedulePromotionArgs(args);
  expect(parsed.errors).toEqual([]);
  const preview = buildRoutineSchedulePreview(routine, parsed);
  const command = routineScheduleConfirmCommand(preview);
  const [slash, ...rest] = tokenize(command);
  expect(slash).toBe('/schedule');
  const reparsed = parseRoutineSchedulePromotionArgs(rest.slice(1));
  expect(reparsed.errors).toEqual([]);
  expect(reparsed.yes).toBe(true);
  return { preview, payload: buildRoutineSchedulePayload(routine, reparsed) };
}

describe('the printed confirmation command', () => {
  test('creates exactly the schedule the preview showed, including paused state, name, model and delivery', () => {
    const { preview, payload } = confirmedPayload([
      'r1',
      '--cron', '0 9 * * *',
      '--timezone', 'America/New_York',
      '--disabled',
      '--name', 'Daily review',
      '--provider', 'openai',
      '--model', 'gpt-5',
      '--delivery-webhook', 'https://example.test/hook?x=1',
    ]);
    expect(preview.payload.enabled).toBe(false);
    expect(payload).toEqual(preview.payload);
  });

  test('round-trips channel and route targets with ids and labels', () => {
    const channel = confirmedPayload(['r1', '--every', '1h', '--delivery-channel', 'slack:C123:Ops team']);
    expect(channel.payload).toEqual(channel.preview.payload);
    const labelOnly = confirmedPayload(['r1', '--at', '2030-01-01T00:00:00Z', '--delivery-channel', 'slack::Ops']);
    expect(labelOnly.payload).toEqual(labelOnly.preview.payload);
    const route = confirmedPayload(['r1', '--cron', '0 9 * * *', '--delivery-route', 'route-1:Label']);
    expect(route.payload).toEqual(route.preview.payload);
    const link = confirmedPayload(['r1', '--cron', '0 9 * * *', '--delivery-link', 'https://example.test/x']);
    expect(link.payload).toEqual(link.preview.payload);
  });
});
