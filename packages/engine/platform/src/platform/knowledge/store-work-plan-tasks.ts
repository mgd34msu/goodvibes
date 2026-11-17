import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../state/sqlite-store.js';
import type { KnowledgeSourceRecord } from './types.js';

/**
 * Work-plan tasks, one row each, in their own table beside the knowledge
 * records. Search, listings, enrichment, the answer path and the knowledge
 * export read `knowledge_sources`, `knowledge_nodes` and their companion
 * tables (store-load.ts), never this one, so a task is not a knowledge source
 * and no reader has to filter it out.
 *
 * `revision` is the plan's commit counter. A commit to a plan takes the plan's
 * highest revision plus one and stamps it on every row it writes, so the
 * plan's revision is MAX(revision), one index lookup, and a task's revision
 * is the commit that last wrote it. A commit that only removes tasks keeps one
 * of them as a tombstone (no task, no status) carrying the new revision, so
 * the plan's revision never goes back after a delete; a tombstone exists only
 * at the plan's highest revision, and the next commit removes it.
 *
 * `record_id` is the row's opaque identity for the work-ledger legacy import,
 * fixed when the row is first written.
 */
export const projectWorkPlanTaskTableSql = `CREATE TABLE IF NOT EXISTS project_work_plan_tasks (
  space_id TEXT NOT NULL,
  work_plan_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT,
  sort_order REAL,
  task_json TEXT,
  PRIMARY KEY (space_id, work_plan_id, task_id)
)`;

const projectWorkPlanTaskIndexSql = [
  'CREATE INDEX IF NOT EXISTS idx_project_work_plan_tasks_revision ON project_work_plan_tasks(space_id, work_plan_id, revision)',
  'CREATE INDEX IF NOT EXISTS idx_project_work_plan_tasks_order ON project_work_plan_tasks(space_id, work_plan_id, sort_order)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_project_work_plan_tasks_record ON project_work_plan_tasks(record_id)',
] as const;

export function createProjectWorkPlanTaskTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run(projectWorkPlanTaskTableSql);
  for (const sql of projectWorkPlanTaskIndexSql) db.run(sql);
}

/** A stored task as written by the planning service; it was admitted at that write. */
export interface StoredWorkPlanTask {
  readonly taskId: string;
  readonly recordId: string;
  readonly revision: number;
  readonly task: Readonly<Record<string, unknown>>;
}

/** The plan's revision and the time of its last commit (null when nothing was ever written). */
export interface WorkPlanHead {
  readonly revision: number;
  readonly updatedAt: number | null;
}

/** One task to write: its identity, the two columns the plan is queried by, and the task itself. */
export interface WorkPlanTaskWrite {
  readonly taskId: string;
  readonly status: string;
  readonly order: number;
  readonly task: object;
}

/**
 * What one read or one commit of a plan sees, from one transaction: the plan's
 * head, its rows on demand, and `legacy`, the single knowledge-source row a plan
 * was stored in before its tasks had rows (null once the first commit moved it).
 */
export interface WorkPlanTaskView {
  readonly head: WorkPlanHead;
  readonly legacy: KnowledgeSourceRecord | null;
  task(taskId: string): StoredWorkPlanTask | null;
  tasks(statuses?: readonly string[]): StoredWorkPlanTask[];
  maxOrder(): number | null;
}

/** What a commit writes: nothing when both lists are empty. `at` stamps the rows. */
export interface WorkPlanTaskCommit<T> {
  readonly value: T;
  readonly put: readonly WorkPlanTaskWrite[];
  readonly remove: readonly string[];
  readonly at: number;
}

export interface WorkPlanTaskCommitResult<T> {
  readonly value: T;
  readonly changed: boolean;
  /** The plan's head after the commit (unchanged when nothing was written). */
  readonly head: WorkPlanHead;
}

type Db = Pick<SqlDatabase, 'exec'>;

export function workPlanTaskView(db: Db, spaceId: string, workPlanId: string, legacy: KnowledgeSourceRecord | null): WorkPlanTaskView {
  return {
    head: readWorkPlanHead(db, spaceId, workPlanId),
    legacy,
    task: taskId => readWorkPlanTask(db, spaceId, workPlanId, taskId),
    tasks: statuses => readWorkPlanTasks(db, spaceId, workPlanId, statuses),
    maxOrder: () => readWorkPlanMaxOrder(db, spaceId, workPlanId),
  };
}

const TASK_COLUMNS = 'task_id, record_id, revision, task_json';

function storedTask(row: readonly unknown[]): StoredWorkPlanTask | null {
  const [taskId, recordId, revision, json] = row;
  if (typeof taskId !== 'string' || typeof recordId !== 'string' || typeof json !== 'string') return null;
  const task: unknown = JSON.parse(json);
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  return { taskId, recordId, revision: Number(revision), task: task as Record<string, unknown> };
}

function storedTasks(rows: ReturnType<Db['exec']>): StoredWorkPlanTask[] {
  const result: StoredWorkPlanTask[] = [];
  for (const row of rows[0]?.values ?? []) {
    const task = storedTask(row);
    if (task) result.push(task);
  }
  return result;
}

export function readWorkPlanHead(db: Db, spaceId: string, workPlanId: string): WorkPlanHead {
  const row = db.exec('SELECT revision, updated_at FROM project_work_plan_tasks WHERE space_id = ? AND work_plan_id = ? ORDER BY revision DESC LIMIT 1',
    [spaceId, workPlanId])[0]?.values[0];
  return row ? { revision: Number(row[0]), updatedAt: Number(row[1]) } : { revision: 0, updatedAt: null };
}

export function readWorkPlanTask(db: Db, spaceId: string, workPlanId: string, taskId: string): StoredWorkPlanTask | null {
  const row = db.exec(`SELECT ${TASK_COLUMNS} FROM project_work_plan_tasks
    WHERE space_id = ? AND work_plan_id = ? AND task_id = ? AND task_json IS NOT NULL`, [spaceId, workPlanId, taskId])[0]?.values[0];
  return row ? storedTask(row) : null;
}

/** Every live task of the plan, in plan order; with `statuses`, only tasks in one of them. */
export function readWorkPlanTasks(db: Db, spaceId: string, workPlanId: string, statuses?: readonly string[]): StoredWorkPlanTask[] {
  const filter = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : '';
  return storedTasks(db.exec(`SELECT ${TASK_COLUMNS} FROM project_work_plan_tasks
    WHERE space_id = ? AND work_plan_id = ? AND task_json IS NOT NULL${filter} ORDER BY sort_order`, [spaceId, workPlanId, ...(statuses ?? [])]));
}

export function readWorkPlanMaxOrder(db: Db, spaceId: string, workPlanId: string): number | null {
  const value = db.exec('SELECT MAX(sort_order) FROM project_work_plan_tasks WHERE space_id = ? AND work_plan_id = ?', [spaceId, workPlanId])[0]?.values[0]?.[0];
  return typeof value === 'number' ? value : null;
}

/**
 * Write one commit of a plan: `put` rows are inserted or replaced, `remove`
 * rows deleted, all stamped with the plan's next revision, which is returned.
 * Rows this commit does not name are not touched, except a tombstone left by
 * the previous commit.
 */
export function writeWorkPlanCommit(
  db: Pick<SqlDatabase, 'exec' | 'run'>,
  spaceId: string,
  workPlanId: string,
  put: readonly WorkPlanTaskWrite[],
  remove: readonly string[],
  at: number,
): number {
  const head = readWorkPlanHead(db, spaceId, workPlanId);
  const revision = head.revision + 1;
  const named = new Set<string>([...put.map(write => write.taskId), ...remove]);
  const tombstones = db.exec('SELECT task_id FROM project_work_plan_tasks WHERE space_id = ? AND work_plan_id = ? AND revision = ? AND task_json IS NULL',
    [spaceId, workPlanId, head.revision])[0]?.values ?? [];
  for (const [taskId] of tombstones) {
    if (typeof taskId === 'string' && !named.has(taskId)) {
      db.run('DELETE FROM project_work_plan_tasks WHERE space_id = ? AND work_plan_id = ? AND task_id = ?', [spaceId, workPlanId, taskId]);
    }
  }
  for (const write of put) {
    db.run(`INSERT INTO project_work_plan_tasks (space_id, work_plan_id, task_id, record_id, revision, updated_at, status, sort_order, task_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id, work_plan_id, task_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at,
        status = excluded.status, sort_order = excluded.sort_order, task_json = excluded.task_json`,
    [spaceId, workPlanId, write.taskId, newRecordId(), revision, at, write.status, write.order, JSON.stringify(write.task)]);
  }
  const tombstone = put.length === 0 ? remove.at(-1) : undefined;
  for (const taskId of remove) {
    if (taskId === tombstone) {
      db.run(`INSERT INTO project_work_plan_tasks (space_id, work_plan_id, task_id, record_id, revision, updated_at, status, sort_order, task_json)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(space_id, work_plan_id, task_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at,
          status = NULL, sort_order = NULL, task_json = NULL`, [spaceId, workPlanId, taskId, newRecordId(), revision, at]);
    } else {
      db.run('DELETE FROM project_work_plan_tasks WHERE space_id = ? AND work_plan_id = ? AND task_id = ?', [spaceId, workPlanId, taskId]);
    }
  }
  return revision;
}

function newRecordId(): string {
  return `project-work-plan-task-${randomUUID()}`;
}

/** Plans with at least one live task, and their live tasks, in one space. */
export function countWorkPlanTasksInSpace(db: Db, spaceId: string): { readonly workPlans: number; readonly tasks: number } {
  const row = db.exec('SELECT COUNT(DISTINCT work_plan_id), COUNT(*) FROM project_work_plan_tasks WHERE space_id = ? AND task_json IS NOT NULL', [spaceId])[0]?.values[0];
  return { workPlans: Number(row?.[0] ?? 0), tasks: Number(row?.[1] ?? 0) };
}

export function deleteWorkPlanTasksInSpace(db: Pick<SqlDatabase, 'run'>, spaceId: string): void {
  db.run('DELETE FROM project_work_plan_tasks WHERE space_id = ?', [spaceId]);
}

/** Space ids that hold work-plan task rows. */
export function listWorkPlanTaskSpaces(db: Db): string[] {
  return (db.exec('SELECT DISTINCT space_id FROM project_work_plan_tasks')[0]?.values ?? [])
    .map(row => row[0]).filter((value): value is string => typeof value === 'string');
}

/** The import record ids of every live task in one space. */
export function listWorkPlanTaskRecordIds(db: Db, spaceId: string): string[] {
  return (db.exec('SELECT record_id FROM project_work_plan_tasks WHERE space_id = ? AND task_json IS NOT NULL ORDER BY record_id', [spaceId])[0]?.values ?? [])
    .map(row => row[0]).filter((value): value is string => typeof value === 'string');
}

export const WORK_PLAN_TASK_IMPORT_KIND = 'work-plan-task';

/**
 * One task as the work-ledger legacy import captures it: shaped like a planning
 * source (connector, metadata envelope, the task as `metadata.value`) under the
 * kind `work-plan-task`, with the row's revision as its generation. Null when
 * no live task has that record id.
 */
export function readWorkPlanTaskImportRecord(db: Db, recordId: string): { readonly source: Record<string, unknown> | null; readonly generation: string | null } {
  const row = db.exec(`SELECT space_id, work_plan_id, ${TASK_COLUMNS} FROM project_work_plan_tasks WHERE record_id = ? AND task_json IS NOT NULL`, [recordId])[0]?.values[0];
  const stored = row ? storedTask(row.slice(2)) : null;
  if (!row || !stored || typeof row[0] !== 'string' || typeof row[1] !== 'string') return { source: null, generation: null };
  const task = stored.task;
  return {
    source: {
      id: stored.recordId,
      connectorId: 'goodvibes-project-planning',
      title: task.title,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      metadata: {
        projectPlanning: true,
        planningArtifactKind: WORK_PLAN_TASK_IMPORT_KIND,
        planningArtifactId: stored.taskId,
        workPlanId: row[1],
        knowledgeSpaceId: row[0],
        projectId: task.projectId,
        value: task,
      },
    },
    generation: `wpt-${stored.revision}`,
  };
}
