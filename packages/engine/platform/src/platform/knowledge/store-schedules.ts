import { ensureAutomationCronPhase } from '../automation/schedules.js';
import { SQLiteStore } from '../state/sqlite-store.js';
import { nowMs } from './store-schema.js';
import type {
  KnowledgeScheduleRecord,
  KnowledgeScheduleUpsertInput,
} from './types.js';

export async function upsertKnowledgeSchedule(
  sqlite: SQLiteStore,
  schedules: Map<string, KnowledgeScheduleRecord>,
  input: KnowledgeScheduleUpsertInput,
  idFactory: () => string,
): Promise<KnowledgeScheduleRecord> {
  const existing = input.id ? schedules.get(input.id) : null;
  // `updated_at` moves on every write of a schedule, so it is the row's revision: a run's write-back compares it.
  const now = Math.max(nowMs(), (existing?.updatedAt ?? 0) + 1);
  const record: KnowledgeScheduleRecord = {
    id: existing?.id ?? input.id ?? idFactory(),
    jobId: input.jobId,
    label: input.label.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    schedule: ensureAutomationCronPhase(input.schedule, existing?.schedule),
    ...(typeof input.lastRunAt === 'number' ? { lastRunAt: input.lastRunAt } : existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(typeof input.nextRunAt === 'number' ? { nextRunAt: input.nextRunAt }
      : input.nextRunAt === undefined && existing?.nextRunAt ? { nextRunAt: existing.nextRunAt } : {}),
    metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_schedules (
      id, job_id, label, enabled, schedule, last_run_at, next_run_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.jobId,
    record.label,
    record.enabled ? 1 : 0,
    JSON.stringify(record.schedule),
    record.lastRunAt ?? null,
    record.nextRunAt ?? null,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
  schedules.set(record.id, record);
  await sqlite.save();
  return record;
}

/** What a scheduled run writes back when it settles: when it ran, when it is next due, whether it stays enabled. */
export interface KnowledgeScheduleRunWrite {
  readonly enabled: boolean;
  readonly lastRunAt: number | undefined;
  readonly nextRunAt: number | undefined;
}

/**
 * Records a scheduled run's end on its schedule only while the schedule is the one the run started from: same
 * revision (`updated_at`, which every write of it moves) and still enabled. A disable, an edit or a delete made
 * while the run was going wins, and the write is refused (`applied: false`, with the schedule as it is now).
 * Only the run's own columns are set, never the definition. One statement, the compare inside it.
 */
export async function completeKnowledgeScheduleRun(
  sqlite: SQLiteStore,
  schedules: Map<string, KnowledgeScheduleRecord>,
  expected: KnowledgeScheduleRecord,
  write: KnowledgeScheduleRunWrite,
): Promise<{ readonly applied: true; readonly record: KnowledgeScheduleRecord } | { readonly applied: false; readonly current: KnowledgeScheduleRecord | null }> {
  const updatedAt = Math.max(nowMs(), expected.updatedAt + 1);
  // -1 stands for "none" (exec binds strings and numbers only); no schedule time is negative.
  const applied = sqlite.exec(`
    UPDATE knowledge_schedules
    SET enabled = ?, last_run_at = NULLIF(?, -1), next_run_at = NULLIF(?, -1), updated_at = ?
    WHERE id = ? AND updated_at = ? AND enabled = 1
    RETURNING id
  `, [write.enabled ? 1 : 0, write.lastRunAt ?? -1, write.nextRunAt ?? -1, updatedAt, expected.id, expected.updatedAt]).length > 0;
  if (!applied) return { applied: false, current: schedules.get(expected.id) ?? null };
  const { lastRunAt: _lastRunAt, nextRunAt: _nextRunAt, ...definition } = expected;
  const record: KnowledgeScheduleRecord = {
    ...definition,
    enabled: write.enabled,
    ...(write.lastRunAt !== undefined ? { lastRunAt: write.lastRunAt } : {}),
    ...(write.nextRunAt !== undefined ? { nextRunAt: write.nextRunAt } : {}),
    updatedAt,
  };
  schedules.set(record.id, record);
  await sqlite.save();
  return { applied: true, record };
}

export async function deleteKnowledgeSchedule(
  sqlite: SQLiteStore,
  schedules: Map<string, KnowledgeScheduleRecord>,
  id: string,
): Promise<boolean> {
  const existing = schedules.get(id);
  if (!existing) return false;
  sqlite.run('DELETE FROM knowledge_schedules WHERE id = ?', [id]);
  schedules.delete(id);
  await sqlite.save();
  return true;
}
