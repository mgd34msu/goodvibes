import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationJobStore, getNextAutomationOccurrence, type AutomationJob } from '../sdk/src/platform/automation/index.ts';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.ts';
import { KnowledgeScheduleService } from '../sdk/src/platform/knowledge/scheduling.ts';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';

function oldJob(): AutomationJob {
  return {
    id: 'operator-chosen-job', labels: [], createdAt: 1, updatedAt: 1, name: 'Existing hourly job', status: 'enabled', enabled: true,
    schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'UTC', staggerMs: 300_000 },
    execution: { target: { kind: 'background' } },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 30_000, retryPolicy: { maxAttempts: 2, delayMs: 1000, strategy: 'fixed' } },
    source: { id: 'owner', kind: 'schedule', label: 'Owner', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} },
    nextRunAt: Date.parse('2030-01-01T10:01:23Z'), runCount: 0, successCount: 0, failureCount: 0, deleteAfterRun: false,
  };
}

test('automation migration persists a phase before exposure and preserves the pending due time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'automation-cron-phase-'));
  try {
    const path = join(root, 'jobs.json'); const original = oldJob();
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [original] }));
    const store = new AutomationJobStore(path);
    const first = (await store.load()).jobs[0]!;
    expect(first.schedule.kind).toBe('cron');
    if (first.schedule.kind !== 'cron') throw new Error('Expected cron');
    const phase = first.schedule.staggerPhase;
    expect(Number.isInteger(phase)).toBe(true);
    expect(first.nextRunAt).toBe(original.nextRunAt);
    const published = JSON.parse(readFileSync(path, 'utf8')) as { jobs: AutomationJob[] };
    expect(published.jobs[0]?.schedule).toMatchObject({ staggerPhase: phase });
    const reopened = new AutomationJobStore(path);
    const restored = (await reopened.load()).jobs[0]!;
    expect(restored.schedule).toEqual(first.schedule);
    expect(restored.mutationRevision).toBe(first.mutationRevision);
    const from = Date.parse('2030-01-01T12:00:00Z');
    expect(getNextAutomationOccurrence(restored.schedule, from)).toBe(getNextAutomationOccurrence(first.schedule, from));
    await reopened.save([{ ...restored, schedule: { kind: 'cron', expression: '0 */2 * * *', timezone: 'UTC' } }]);
    expect((await new AutomationJobStore(path).load()).jobs[0]?.schedule).toMatchObject({ staggerPhase: phase });
    const beforeInvalid = readFileSync(path);
    await expect(reopened.save([{ ...restored, schedule: { ...first.schedule, staggerPhase: -1 } }])).rejects.toBeDefined();
    expect(readFileSync(path).equals(beforeInvalid)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('knowledge cron phases survive the real SQLite store and older rows migrate before timers arm', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-cron-phase-'));
  const dbPath = join(root, 'knowledge-wiki.sqlite');
  const create = () => new KnowledgeStore({ dbPath });
  const stores: KnowledgeStore[] = [];
  let service: KnowledgeScheduleService | undefined;
  try {
    const store = create(); stores.push(store); await store.init();
    const schedule = oldJob().schedule; const due = Date.parse('2030-01-01T10:01:23Z');
    const saved = await store.upsertSchedule({ id: 'chosen-hourly', jobId: 'knowledge-lint', label: 'Hourly lint', enabled: true, schedule, nextRunAt: due });
    expect(saved.schedule).toHaveProperty('staggerPhase');
    await store.close();
    const reopened = create(); stores.push(reopened); await reopened.init();
    expect(reopened.getSchedule(saved.id)?.schedule).toEqual(saved.schedule);
    await reopened.close();
    // Simulate a previously written schedule row that predates the phase field.
    const older = new SQLiteStore(dbPath);
    try {
      await older.init();
      older.run('UPDATE knowledge_schedules SET schedule = ? WHERE id = ?', [JSON.stringify(schedule), saved.id]);
      await older.save();
    } finally { older.close(); }
    const migrated = create(); stores.push(migrated);
    service = new KnowledgeScheduleService({ store: migrated, emitIfReady() {}, runJobByKind: async () => ({}) });
    await service.whenReady();
    const current = migrated.getSchedule(saved.id)!;
    expect(current.schedule).toHaveProperty('staggerPhase');
    expect(current.nextRunAt).toBe(due);
    service.dispose(); await migrated.close();
    const afterMigration = create(); stores.push(afterMigration); await afterMigration.init();
    expect(afterMigration.getSchedule(saved.id)?.schedule).toEqual(current.schedule);
    expect(afterMigration.getSchedule(saved.id)?.nextRunAt).toBe(due);
  } finally {
    service?.dispose();
    for (const store of stores) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
