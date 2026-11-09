import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeScheduleService } from '../platform/src/platform/knowledge/scheduling.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { activateClassicFallback, withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'classic-knowledge-schedule-'));
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  let requests = 0;
  const previous = installJudgmentPort({ get model(): never { throw new Error('Unexpected decision model access'); },
    async ask(): Promise<never> { requests++; throw new Error('Unexpected decision request'); } } satisfies JudgmentPort);
  disposals.push(() => { installJudgmentPort(previous); });
  const store = new KnowledgeStore({ configManager: { getControlPlaneConfigDir: () => root }, family: 'wiki' } as never);
  const completed = Promise.withResolvers<void>();
  const saveRun = store.upsertJobRun.bind(store);
  const writes = spyOn(store, 'upsertJobRun').mockImplementation(async input => {
    const record = await saveRun(input);
    if (record.status === 'completed') completed.resolve();
    return record;
  });
  disposals.push(() => writes.mockRestore());
  const service = new KnowledgeScheduleService({ store, emitIfReady: () => undefined, runJobByKind: async () => ({ native: true }) });
  disposals.push(() => service.dispose());
  await service.whenReady();
  // Drive the timer's owned callback directly to avoid waiting for real daily
  // timers. Store writes, policy checks, job dispatch and rearming are real.
  const fire = (id: string) => (service as unknown as { runScheduledJob(scheduleId: string): Promise<void> }).runScheduledJob(id);
  return { store, fire, completed: completed.promise, requests: () => requests };
}

for (const policy of ['Classic - Off', 'Preferred'] as const) {
  test.each([undefined, Date.parse('2026-11-05T12:00:00Z')])(`${policy} skips semantic schedules without inventing a run (previous timestamp %s)`, async lastRunAt => {
    await withDecisionModelPolicy(() => policy, async () => {
      if (policy === 'Preferred') expect(activateClassicFallback(new JudgmentError('unavailable', 'Synthetic exhausted chain'))).toBe(true);
      const f = await fixture();
      const saved = await f.store.upsertSchedule({ jobId: 'knowledge-semantic-enrichment', label: 'Semantic schedule', enabled: true,
        schedule: { kind: 'every', intervalMs: 3_600_000 }, lastRunAt, nextRunAt: Date.now() - 1, metadata: {} });
      await f.fire(saved.id);
      const retained = f.store.getSchedule(saved.id);
      expect(retained?.lastRunAt).toBe(lastRunAt);
      expect(retained?.enabled).toBe(true);
      expect(retained?.nextRunAt).toBeGreaterThan(saved.nextRunAt ?? 0);
      expect(f.store.listJobRuns(100, saved.jobId)).toEqual([]);
      expect(f.requests()).toBe(0);
    });
  });
}

test('Classic still dispatches native maintenance and records its actual scheduled run', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = await fixture();
    const saved = await f.store.upsertSchedule({ jobId: 'knowledge-lint', label: 'Native lint', enabled: true,
      schedule: { kind: 'every', intervalMs: 3_600_000 }, nextRunAt: Date.now() - 1, metadata: {} });
    const before = Date.now();
    await f.fire(saved.id);
    await f.completed;
    expect(f.store.getSchedule(saved.id)?.lastRunAt).toBeGreaterThanOrEqual(before);
    expect(f.store.listJobRuns(100, saved.jobId)).toHaveLength(1);
    expect(f.requests()).toBe(0);
  });
});
