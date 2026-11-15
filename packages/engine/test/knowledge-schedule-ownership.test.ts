/**
 * Knowledge schedules and job runs across restarts and across processes that
 * share one store file: interrupted runs are settled, a schedule runs once per
 * due time, a failed run leaves the schedule armed, and only one owner of the
 * file executes schedules.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEverySchedule } from '../platform/src/platform/automation/schedules.ts';
import { KnowledgeScheduleService } from '../platform/src/platform/knowledge/scheduling.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import { waitFor } from './_helpers/test-timeout.ts';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const OWNER = /knowledge\/scheduling\.ts/;
let pending: Map<unknown, string>;
let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-schedule-owner-'));
  pending = new Map<unknown, string>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const stack = new Error().stack ?? '';
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => { pending.delete(handle); fn(...a); };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    // Only timers the scheduler itself creates (not, say, a logger flush it triggers).
    if (OWNER.test(stack.split('\n')[2] ?? '')) pending.set(handle, stack);
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((h: never) => { pending.delete(h); return realClearTimeout(h); }) as typeof globalThis.clearTimeout;
});

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

const dbPath = () => join(root, 'knowledge.sqlite');

async function openStore(): Promise<KnowledgeStore> {
  const store = new KnowledgeStore({ dbPath: dbPath() });
  cleanups.push(() => store.close());
  await store.init();
  return store;
}

function service(
  store: KnowledgeStore,
  runJobByKind: (kind: string) => Promise<Record<string, unknown>> = async () => ({}),
): KnowledgeScheduleService {
  const created = new KnowledgeScheduleService({ store, emitIfReady: () => undefined, runJobByKind });
  cleanups.push(() => created.dispose());
  return created;
}

/** What a due timer does, awaited: the scheduler's own timer callback only starts it. */
function fireSchedule(scheduler: KnowledgeScheduleService, scheduleId: string): Promise<void> {
  const run: unknown = Reflect.get(scheduler, 'runScheduledJob');
  if (typeof run !== 'function') throw new Error('No scheduled run entry point');
  return Reflect.apply(run, scheduler, [scheduleId]) as Promise<void>;
}

test('disposing with a run in flight settles it failed, and its late completion does not overwrite that', async () => {
  const store = await openStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = service(store, async () => { await gate; return { late: true }; });
  await scheduler.whenReady();
  const run = await scheduler.runJob('knowledge-reindex', { mode: 'background' });
  await waitFor(() => store.getJobRun(run.id)?.status === 'running');
  const refused = spyOn(logger, 'warn');

  await scheduler.dispose();
  expect(store.getJobRun(run.id)).toMatchObject({ status: 'failed' });
  expect(store.getJobRun(run.id)?.error).toContain('interrupted');
  release();
  // The scheduler logs when it refuses to record a completion over a settled run.
  try { await waitFor(() => refused.mock.calls.some(([message]) => String(message).includes('completion not recorded over it'))); }
  finally { refused.mockRestore(); }
  expect(store.getJobRun(run.id)?.status).toBe('failed');

  await store.close();
  const reopened = await openStore();
  expect(reopened.getJobRun(run.id)?.status).toBe('failed');
});

test('a recent run whose owning process is gone is settled at startup instead of waiting six hours', async () => {
  const exited = Bun.spawn([process.execPath, '-e', '']);
  await exited.exited;
  const seed = await openStore();
  const orphan = await seed.upsertJobRun({
    jobId: 'knowledge-reindex', status: 'running', mode: 'background',
    requestedAt: Date.now() - 60_000, startedAt: Date.now() - 60_000,
    metadata: { owner: { instanceId: 'gone', pid: exited.pid } },
  });
  await seed.close();

  const store = await openStore();
  await service(store).whenReady();
  expect(store.getJobRun(orphan.id)).toMatchObject({ status: 'failed' });
});

test('overlapping schedule edits leave exactly one timer per enabled schedule', async () => {
  const store = await openStore();
  const scheduler = service(store);
  await scheduler.whenReady();
  await Promise.all([
    scheduler.saveSchedule({ jobId: 'knowledge-lint', label: 'a', schedule: normalizeEverySchedule('1h') }),
    scheduler.saveSchedule({ jobId: 'knowledge-reindex', label: 'b', schedule: normalizeEverySchedule('1h') }),
    scheduler.saveSchedule({ jobId: 'knowledge-lint', label: 'c', schedule: normalizeEverySchedule('2h') }),
  ]);
  const enabled = store.listSchedules(100).filter((schedule) => schedule.enabled).length;
  expect(pending.size).toBe(enabled);
});

test('a scheduled run whose job write fails stays armed for its next occurrence', async () => {
  const seed = await openStore();
  await seed.upsertSchedule({ id: 'due-lint', jobId: 'knowledge-lint', label: 'Due lint', enabled: true, schedule: normalizeEverySchedule('1h'), nextRunAt: Date.now() - 1_000, metadata: {} });
  await seed.close();

  const store = await openStore();
  const original = store.upsertJobRun.bind(store);
  let failures = 0;
  store.upsertJobRun = (async (input) => {
    if (input.jobId === 'knowledge-lint' && failures === 0) { failures += 1; throw new Error('disk full'); }
    return original(input);
  }) as typeof store.upsertJobRun;
  const scheduler = service(store);
  await scheduler.whenReady();
  await expect(fireSchedule(scheduler, 'due-lint')).rejects.toThrow('disk full');
  const enabled = store.listSchedules(100).filter((schedule) => schedule.enabled).length;
  expect(failures).toBe(1);
  await waitFor(() => pending.size === enabled);
});

test('two owners of one store file run a due schedule once, in the process that owns schedules', async () => {
  const seed = await openStore();
  await seed.upsertSchedule({ id: 'due-lint', jobId: 'knowledge-lint', label: 'Due lint', enabled: true, schedule: normalizeEverySchedule('1h'), nextRunAt: Date.now() - 1_000, metadata: {} });
  await seed.close();

  const calls = { first: 0, second: 0 };
  const firstStore = await openStore();
  const first = service(firstStore, async (kind) => { if (kind === 'lint') calls.first += 1; return {}; });
  await first.whenReady();
  const secondStore = await openStore();
  const second = service(secondStore, async (kind) => { if (kind === 'lint') calls.second += 1; return {}; });
  await second.whenReady();
  const queuedBySecond = spyOn(secondStore, 'upsertJobRun');
  // Both owners' due timers end in this same entry point; the second one must
  // refuse before it queues anything.
  await fireSchedule(second, 'due-lint');
  await fireSchedule(first, 'due-lint');
  await waitFor(() => calls.first === 1);
  expect(queuedBySecond).not.toHaveBeenCalled();
  expect(calls).toEqual({ first: 1, second: 0 });
});
