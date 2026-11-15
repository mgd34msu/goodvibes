import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { normalizeCronSchedule } from '../platform/src/platform/automation/schedules.js';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = makeProjectTempDir('automation-create-defaults');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const f = automationMutationFixture(directory); cleanup.push(() => f.close());
  f.config.set('automation.deleteAfterRun', true);
  return f;
}

test('the delete-after-run default applies to a one-shot job and not to a recurring one', async () => {
  const f = fixture();
  const base = { name: 'job', prompt: 'Synthetic', enabled: false };
  const once = await f.manager.createJob({ ...base, schedule: { kind: 'at', at: Date.now() + 3_600_000 } });
  const cron = await f.manager.createJob({ ...base, schedule: { kind: 'cron', expression: '0 9 * * *' } });
  const every = await f.manager.createJob({ ...base, schedule: { kind: 'every', intervalMs: 3_600_000 } });
  expect(once.deleteAfterRun).toBe(true);
  expect(cron.deleteAfterRun).toBe(false);
  expect(every.deleteAfterRun).toBe(false);
});

test('an explicit deleteAfterRun on a recurring job is still honoured', async () => {
  const f = fixture();
  const job = await f.manager.createJob({ name: 'job', prompt: 'Synthetic', enabled: false, deleteAfterRun: true, schedule: { kind: 'cron', expression: '0 9 * * *' } });
  expect(job.deleteAfterRun).toBe(true);
});

test('a cron schedule without a timezone is stored with the process zone', () => {
  expect(normalizeCronSchedule('0 9 * * *').timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(normalizeCronSchedule('0 9 * * *', 'Asia/Kathmandu').timezone).toBe('Asia/Kathmandu');
});

test('a literal cron schedule created without a timezone is stored with the process zone, and an explicit zone is kept', async () => {
  const f = fixture();
  const base = { name: 'job', prompt: 'Synthetic', enabled: false };
  const bare = await f.manager.createJob({ ...base, schedule: { kind: 'cron', expression: '0 9 * * *' } });
  const zoned = await f.manager.createJob({ ...base, schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Kathmandu' } });
  expect(bare.schedule).toMatchObject({ kind: 'cron', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  expect(zoned.schedule).toMatchObject({ timezone: 'Asia/Kathmandu' });
});
