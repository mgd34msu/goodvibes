/**
 * The project work plan as one product holds it: the planning service's task
 * rows for one project, bound once at composition. Every surface (the
 * `work_plan` and `agent_work_plan` tools, a spawned worker's `work_plan`, the
 * /work-plan and /workplan commands and the Work Plan modal) reads and edits the
 * plan through this binding, so there is one store, one revision and one event
 * family (`WORK_PLAN_*`, emitted by the service) for the plan. The rows live in
 * the user's shared plan file (work-plan-rows.ts), so the terminal app, the
 * Agent and the daemon keep the same plan for a project.
 *
 * An edit is one immediate transaction on the rows it changes and answers with
 * the changed task and the plan's counts read in that transaction; a task may be
 * named by its id or a unique prefix of it, resolved inside the same transaction.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { StaleError, type RevisionSource } from '../../utils/revision.js';
import type { ProjectPlanningService } from './service.js';
import type {
  ProjectWorkPlanCounts,
  ProjectWorkPlanMutationResult,
  ProjectWorkPlanSnapshot,
  ProjectWorkPlanTask,
  ProjectWorkPlanTaskListInput,
  ProjectWorkPlanTaskMutationSource,
  ProjectWorkPlanTaskStatus,
} from './types.js';

export const WORK_PLAN_TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly ProjectWorkPlanTaskStatus[];

export function isWorkPlanTaskStatus(value: unknown): value is ProjectWorkPlanTaskStatus {
  return typeof value === 'string' && (WORK_PLAN_TASK_STATUSES as readonly string[]).includes(value);
}

/** The checklist cycle: pending, in progress, done, back to pending; blocked, failed and cancelled go to pending. */
export function nextWorkPlanTaskStatus(status: ProjectWorkPlanTaskStatus): ProjectWorkPlanTaskStatus {
  switch (status) {
    case 'pending': return 'in_progress';
    case 'in_progress': return 'done';
    case 'done':
    case 'blocked':
    case 'failed':
    case 'cancelled':
      return 'pending';
  }
}

/** "12 items: 3 pending, 1 in progress, 8 done", statuses with no items left out. */
export function summarizeWorkPlanCounts(counts: ProjectWorkPlanCounts): string {
  const parts = WORK_PLAN_TASK_STATUSES.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status.replace(/_/g, ' ')}`);
  return `${counts.total} item${counts.total === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * The plan line an edit answers with: the counts read in the edit's own
 * transaction, and the finished items the edit removed automatically, if any
 * ("12 items: 3 pending, 9 done; removed 2 finished items untouched for 30 days or beyond the 200 most recent").
 */
export function summarizeWorkPlanEdit(result: Pick<ProjectWorkPlanMutationResult, 'counts' | 'reclaimedTaskIds'>): string {
  const reclaimed = result.reclaimedTaskIds?.length ?? 0;
  const summary = summarizeWorkPlanCounts(result.counts);
  return reclaimed === 0 ? summary
    : `${summary}; removed ${reclaimed} finished item${reclaimed === 1 ? '' : 's'} untouched for 30 days or beyond the 200 most recent`;
}

/** What a caller may set when adding a task. */
export interface WorkPlanTaskFields {
  readonly status?: ProjectWorkPlanTaskStatus | undefined;
  readonly owner?: string | undefined;
  readonly source?: ProjectWorkPlanTaskMutationSource | undefined;
  readonly notes?: string | undefined;
  readonly agentId?: string | undefined;
  readonly contractId?: string | undefined;
  readonly sessionId?: string | undefined;
}

/** A change to a task: a field set to null is cleared. */
export interface WorkPlanTaskPatch {
  readonly title?: string | undefined;
  readonly status?: ProjectWorkPlanTaskStatus | undefined;
  readonly owner?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface ProjectWorkPlanOptions {
  readonly service: ProjectPlanningService;
  readonly projectId: string;
  readonly projectRoot: string;
  /** Recorded as `originSurface` on tasks this binding adds (`tui`, `agent`, `daemon`). */
  readonly surface?: string | undefined;
  /** Where `exportMarkdown` writes the plan's checklist; absent, export is not offered. */
  readonly exportDirectory?: string | undefined;
}

export type WorkPlanTaskMutation = ProjectWorkPlanMutationResult & { readonly task: ProjectWorkPlanTask };

const text = (value: string | null | undefined): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
};

export class ProjectWorkPlan implements RevisionSource {
  readonly id = 'work plan';
  readonly service: ProjectPlanningService;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly surface: string | undefined;
  readonly exportDirectory: string | undefined;

  constructor(options: ProjectWorkPlanOptions) {
    this.service = options.service;
    this.projectId = options.projectId;
    this.projectRoot = options.projectRoot;
    this.surface = options.surface;
    this.exportDirectory = options.exportDirectory;
  }

  /** The plan's revision: one indexed statement. Moves on every committed edit, by any process. */
  revision(): number {
    return this.service.getWorkPlanRevisionNow({ projectId: this.projectId });
  }

  /**
   * Calls `listener` when the plan may have changed: after an edit through this
   * program, or when another program (the terminal app, the Agent, the daemon)
   * committed to the plan. A surface compares `revision()` with the one it shows
   * and reads the plan again only when it moved. Answers the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    return this.service.subscribeWorkPlan({ projectId: this.projectId }, listener);
  }

  /** The file that holds this plan (shared by every GoodVibes program of this user). */
  get file(): string {
    return this.service.workPlanFile;
  }

  snapshot(filter: Omit<ProjectWorkPlanTaskListInput, 'projectId' | 'knowledgeSpaceId' | 'workPlanId'> = {}): Promise<ProjectWorkPlanSnapshot> {
    return this.service.getWorkPlanSnapshot({ ...filter, projectId: this.projectId });
  }

  /** The snapshot for a caller that cannot await; throws while the store is still opening. */
  snapshotNow(filter: Omit<ProjectWorkPlanTaskListInput, 'projectId' | 'knowledgeSpaceId' | 'workPlanId'> = {}): ProjectWorkPlanSnapshot {
    return this.service.getWorkPlanSnapshotNow({ ...filter, projectId: this.projectId });
  }

  /** One task by id or unique id prefix. */
  async get(idOrPrefix: string): Promise<ProjectWorkPlanTask> {
    const result = await this.service.getWorkPlanTask({ projectId: this.projectId, taskId: idOrPrefix }, { matchPrefix: true });
    if (!result.task) throw new Error(`Work plan task not found: ${idOrPrefix.trim()}`);
    return result.task;
  }

  async add(title: string, fields: WorkPlanTaskFields = {}): Promise<WorkPlanTaskMutation> {
    const normalized = title.trim();
    if (!normalized) throw new Error('Work plan task title is required.');
    const result = await this.service.createWorkPlanTask({
      projectId: this.projectId,
      task: {
        title: normalized,
        ...(fields.status ? { status: fields.status } : {}),
        ...(text(fields.owner) ? { owner: text(fields.owner) } : {}),
        ...(text(fields.source) ? { source: text(fields.source) } : {}),
        ...(text(fields.notes) ? { notes: text(fields.notes) } : {}),
        ...(text(fields.agentId) ? { agentId: text(fields.agentId) } : {}),
        ...(text(fields.contractId) ? { contractId: text(fields.contractId) } : {}),
        ...(text(fields.sessionId) ? { sessionId: text(fields.sessionId) } : {}),
        ...(this.surface ? { originSurface: this.surface } : {}),
      },
    });
    return result as WorkPlanTaskMutation;
  }

  async update(idOrPrefix: string, patch: WorkPlanTaskPatch): Promise<WorkPlanTaskMutation> {
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('Work plan task title is required.');
    const result = await this.service.updateWorkPlanTask({
      projectId: this.projectId,
      taskId: idOrPrefix,
      patch: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.owner !== undefined ? { owner: text(patch.owner) } : {}),
        ...(patch.source !== undefined ? { source: text(patch.source) } : {}),
        ...(patch.notes !== undefined ? { notes: text(patch.notes) } : {}),
      },
    }, { matchPrefix: true });
    return result as WorkPlanTaskMutation;
  }

  async setStatus(idOrPrefix: string, status: ProjectWorkPlanTaskStatus, reason?: string): Promise<WorkPlanTaskMutation> {
    const result = await this.service.setWorkPlanTaskStatus({
      projectId: this.projectId,
      taskId: idOrPrefix,
      status,
      ...(text(reason) ? { reason: text(reason) } : {}),
    }, { matchPrefix: true });
    return result as WorkPlanTaskMutation;
  }

  async cycle(idOrPrefix: string): Promise<WorkPlanTaskMutation> {
    const result = await this.service.cycleWorkPlanTaskStatus({ projectId: this.projectId, taskId: idOrPrefix }, { matchPrefix: true });
    return result as WorkPlanTaskMutation;
  }

  async remove(idOrPrefix: string): Promise<ProjectWorkPlanMutationResult & { readonly deletedTask: ProjectWorkPlanTask }> {
    const result = await this.service.deleteWorkPlanTask({ projectId: this.projectId, taskId: idOrPrefix }, { matchPrefix: true });
    return result as ProjectWorkPlanMutationResult & { readonly deletedTask: ProjectWorkPlanTask };
  }

  /** Removes done and cancelled tasks; failed and blocked tasks stay. */
  clearCompleted(): Promise<ProjectWorkPlanMutationResult> {
    return this.service.clearCompletedWorkPlanTasks({ projectId: this.projectId, statuses: ['done', 'cancelled'] });
  }

  toMarkdown(snapshot: ProjectWorkPlanSnapshot): string {
    const lines = [
      // The model's running checklist, called a checklist (a plan is a piece of work's own).
      '# Checklist',
      '',
      `Project: ${this.projectRoot}`,
      `Project ID: ${this.projectId}`,
      `Updated: ${new Date(snapshot.updatedAt).toISOString()}`,
      '',
    ];
    if (snapshot.tasks.length === 0) {
      lines.push('No work plan items recorded.');
      return lines.join('\n');
    }
    for (const task of snapshot.tasks) {
      const marker = task.status === 'done' ? 'x' : ' ';
      const suffix = task.status === 'pending' ? '' : ` (${task.status.replace(/_/g, ' ')})`;
      lines.push(`- [${marker}] ${task.title}${suffix}`);
      if (task.owner) lines.push(`  - Owner: ${task.owner}`);
      if (task.source) lines.push(`  - Source: ${task.source}`);
      if (task.notes) lines.push(`  - Notes: ${task.notes}`);
    }
    return lines.join('\n');
  }

  /** Writes the checklist as Markdown so it can be opened outside the product; answers with the path written. */
  async exportMarkdown(): Promise<{ readonly path: string; readonly markdown: string }> {
    if (!this.exportDirectory) throw new Error('This product has no export location for the work plan.');
    const markdown = this.toMarkdown(await this.snapshot());
    const hash = createHash('sha256').update(this.projectId).update('\0').update(this.projectRoot).digest('hex').slice(0, 32);
    const path = join(this.exportDirectory, `project-${hash}.md`);
    atomicWriteFileSync(path, `${markdown}\n`, { mkdirp: true });
    return { path, markdown };
  }
}

export interface WorkPlanTasksObservation {
  readonly tasks: readonly ProjectWorkPlanTask[];
  /** Integer compare of the plan's revision; throws a StaleError naming the work plan when an edit committed since the read. */
  assertCurrent(): void;
}

/** One read of the plan for a caller-owned synchronous step; the revision is the one that read saw. */
export function captureWorkPlanTasks(plan: ProjectWorkPlan): WorkPlanTasksObservation {
  const snapshot = plan.snapshotNow();
  return {
    tasks: snapshot.tasks,
    assertCurrent: () => {
      const current = plan.revision();
      if (current !== snapshot.revision) throw new StaleError(plan, snapshot.revision, current);
    },
  };
}
