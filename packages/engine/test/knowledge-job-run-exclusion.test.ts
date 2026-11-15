/**
 * One run of a knowledge job at a time per process: repeated requests join the
 * run in progress, a schedule does not start a second copy, a closed scheduler
 * starts nothing, and a run settled as failed at shutdown still gets its
 * closing event.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEverySchedule } from '../platform/src/platform/automation/schedules.ts';
import { KnowledgeScheduleService } from '../platform/src/platform/knowledge/scheduling.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';

let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'knowledge-job-exclusion-')); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  cleanups.push(() => store.close());
  await store.init();
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let bodies = 0;
  const scheduler = new KnowledgeScheduleService({
    store,
    emitIfReady: (emit) => emit({ emit: (_domain: string, event: { type: string }) => { events.push(event.type); } } as never,
      { traceId: 't', sessionId: 's', source: 'test' }),
    runJobByKind: async () => { bodies += 1; started.resolve(); await gate.promise; return {}; },
  });
  cleanups.push(() => { gate.resolve(); return scheduler.dispose(); });
  await scheduler.whenReady();
  return { store, scheduler, events, gate, started, bodies: () => bodies };
}

test('a second request for a job already running joins that run instead of repeating the work', async () => {
  const h = await harness();
  const first = await h.scheduler.runJob('knowledge-reindex');
  await h.started.promise;
  const second = await h.scheduler.runJob('knowledge-reindex');
  const inline = h.scheduler.runJob('knowledge-reindex', { mode: 'inline' });
  expect(second.id).toBe(first.id);
  h.gate.resolve();
  expect((await inline).status).toBe('completed');
  expect(h.bodies()).toBe(1);
  expect(h.store.listJobRuns(100, 'knowledge-reindex')).toHaveLength(1);
  // Finished work is not joined: the next request is a new run.
  await h.scheduler.runJob('knowledge-reindex', { mode: 'inline' });
  expect(h.bodies()).toBe(2);
});

test('a schedule that comes due while its job is still running neither starts another run nor claims to have run', async () => {
  const h = await harness();
  const running = await h.scheduler.runJob('knowledge-reindex');
  await h.started.promise;
  const schedule = await h.store.upsertSchedule({
    jobId: 'knowledge-reindex', label: 'Reindex', enabled: true, schedule: normalizeEverySchedule('1m'),
    nextRunAt: Date.now() - 1_000, metadata: {},
  });
  await (h.scheduler as unknown as { runScheduledJob(id: string): Promise<void> }).runScheduledJob(schedule.id);
  expect(h.bodies()).toBe(1);
  expect(h.store.listJobRuns(100, 'knowledge-reindex').map((run) => run.id)).toEqual([running.id]);
  expect(h.store.getSchedule(schedule.id)?.lastRunAt).toBeUndefined();
  h.gate.resolve();
});

test('a closed scheduler refuses to start a run and writes no run record', async () => {
  const h = await harness();
  await h.scheduler.dispose();
  await expect(h.scheduler.runJob('knowledge-lint')).rejects.toThrow('Knowledge scheduler is closed');
  expect(h.store.listJobRuns(100)).toHaveLength(0);
});

test('a run failed by shutdown is closed with one failed event', async () => {
  const h = await harness();
  const run = await h.scheduler.runJob('knowledge-reindex');
  await h.started.promise;
  await h.scheduler.dispose();
  expect(h.store.getJobRun(run.id)?.status).toBe('failed');
  h.gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.events.filter((type) => type === 'KNOWLEDGE_JOB_FAILED')).toHaveLength(1);
});
