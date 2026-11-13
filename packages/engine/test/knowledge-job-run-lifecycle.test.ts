/**
 * Knowledge job runs: a run left queued/running by a process exit is settled as
 * failed (interrupted) when the scheduling service starts, runs this process
 * started are left alone, and a settled run is never moved by a late write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeScheduleService } from '../platform/src/platform/knowledge/scheduling.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { knowledgeJobRunLifecycle } from '../platform/src/platform/knowledge/types.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'knowledge-job-run-lifecycle-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function openStore(): KnowledgeStore {
  return new KnowledgeStore({
    configManager: { getControlPlaneConfigDir: () => root },
    family: 'wiki',
  } as never);
}

describe('knowledge job run lifecycle', () => {
  test('declares queued -> running|failed, running -> completed|failed, finals', () => {
    expect(knowledgeJobRunLifecycle.can('queued', 'running')).toBe(true);
    expect(knowledgeJobRunLifecycle.can('running', 'completed')).toBe(true);
    expect(knowledgeJobRunLifecycle.can('queued', 'completed')).toBe(false);
    expect(knowledgeJobRunLifecycle.isTerminal('completed')).toBe(true);
    expect(knowledgeJobRunLifecycle.isTerminal('failed')).toBe(true);
  });

  test('runs left queued/running for hours by a process that is gone are settled as failed on start; recent ones are left alone', async () => {
    const seed = openStore();
    await seed.init();
    const longAgo = Date.now() - 7 * 60 * 60 * 1000;
    const queued = await seed.upsertJobRun({ jobId: 'knowledge-reindex', status: 'queued', mode: 'background', requestedAt: longAgo });
    const running = await seed.upsertJobRun({ jobId: 'knowledge-reindex', status: 'running', mode: 'background', requestedAt: longAgo, startedAt: longAgo });
    const done = await seed.upsertJobRun({ jobId: 'knowledge-lint', status: 'completed', mode: 'inline', completedAt: 9 });
    // The store is shared between running instances: a recent run may still be another instance's.
    const recent = await seed.upsertJobRun({ jobId: 'knowledge-reindex', status: 'running', mode: 'background', requestedAt: Date.now() - 60_000, startedAt: Date.now() - 60_000 });
    seed.close();

    const store = openStore();
    const service = new KnowledgeScheduleService({ store, emitIfReady: () => undefined, runJobByKind: async () => ({}) });
    await service.whenReady();
    try {
      for (const id of [queued.id, running.id]) {
        const run = store.getJobRun(id)!;
        expect(run.status).toBe('failed');
        expect(run.error).toContain('interrupted');
        expect(typeof run.completedAt).toBe('number');
      }
      expect(store.getJobRun(done.id)!.status).toBe('completed');
      expect(store.getJobRun(recent.id)!.status).toBe('running');
    } finally {
      service.dispose();
      store.close();
    }
  });

  test('a run this process started while initialization was pending is not settled', async () => {
    const store = openStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new KnowledgeScheduleService({
      store,
      emitIfReady: () => undefined,
      runJobByKind: async () => { await gate; return { ok: true }; },
    });
    const run = await service.runJob('knowledge-reindex', { mode: 'background' });
    await service.whenReady();
    try {
      expect(['queued', 'running']).toContain(store.getJobRun(run.id)!.status);
      release();
      for (let i = 0; i < 50 && store.getJobRun(run.id)!.status !== 'completed'; i++) await Bun.sleep(10);
      expect(store.getJobRun(run.id)!.status).toBe('completed');
    } finally {
      service.dispose();
      store.close();
    }
  });

  test('a failure of the first running write settles the row failed instead of leaving it queued', async () => {
    const store = openStore();
    const service = new KnowledgeScheduleService({ store, emitIfReady: () => undefined, runJobByKind: async () => ({}) });
    await service.whenReady();
    const original = store.upsertJobRun.bind(store);
    store.upsertJobRun = (async (input) => {
      if (input.status === 'running') throw new Error('disk full');
      return original(input);
    }) as typeof store.upsertJobRun;
    try {
      const run = await service.runJob('knowledge-reindex', { mode: 'background' });
      for (let i = 0; i < 50 && store.getJobRun(run.id)!.status === 'queued'; i++) await Bun.sleep(10);
      const settled = store.getJobRun(run.id)!;
      expect(settled.status).toBe('failed');
      expect(settled.error).toContain('disk full');
    } finally {
      service.dispose();
      store.close();
    }
  });
});
