/**
 * A schedule create whose answer was lost is retried after one list read, and
 * the listed job that is the same schedule is reported instead of a second
 * one. A job that only shares the name, time and prompt is not the same: if it
 * were taken for it, the schedule asked for is never created and its messages
 * are never sent.
 *
 * The listed jobs are stored by the host's own cron normaliser.
 */
import { expect, test } from 'bun:test';
import { normalizeCronSchedule } from '../platform/src/platform/automation/schedules.ts';
import { findSameSchedule } from '../terminal-shell/src/agent-turn/schedule-delivery-targets.ts';

type CreatePayload = Parameters<typeof findSameSchedule>[1];

const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OTHER_ZONE = HOST_ZONE === 'Asia/Tokyo' ? 'Europe/London' : 'Asia/Tokyo';

function job(timezone: string | undefined, delivery?: unknown): Record<string, unknown> {
  return {
    id: 'job-1',
    name: 'standup',
    enabled: true,
    execution: { prompt: 'Post the standup notes' },
    schedule: normalizeCronSchedule('0 9 * * 1-5', timezone),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

const listed = (...jobs: Record<string, unknown>[]) => ({ jobs, runs: [], defaultTimezone: HOST_ZONE });
const payload = (extra: Record<string, unknown> = {}) =>
  ({ name: 'standup', kind: 'cron', cron: '0 9 * * 1-5', prompt: 'Post the standup notes', ...extra }) as CreatePayload;

test('a retried create without a zone finds the job the host stored in its own zone', () => {
  expect(findSameSchedule(listed(job(undefined)), payload())?.id).toBe('job-1');
});

test('a job pinned to another zone is not the one a create without a zone makes', () => {
  expect(findSameSchedule(listed(job(OTHER_ZONE)), payload())).toBeUndefined();
  expect(findSameSchedule(listed(job(OTHER_ZONE)), payload({ timezone: OTHER_ZONE }))?.id).toBe('job-1');
});

test('a job delivering to another channel is not the one asked for', () => {
  const slack = { mode: 'channel', targets: [{ kind: 'surface', surfaceKind: 'slack', address: 'C-1' }] };
  const telegram = { mode: 'channel', targets: [{ kind: 'surface', surfaceKind: 'telegram', address: 'T-1' }] };
  expect(findSameSchedule(listed(job(undefined, slack)), payload({ delivery: telegram }))).toBeUndefined();
  expect(findSameSchedule(listed(job(undefined, slack)), payload({ delivery: slack }))?.id).toBe('job-1');
});
