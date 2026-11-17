import type { Tool } from '../../types/tools.js';
import { toRecord } from '../../utils/record-coerce.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  WORK_PLAN_TASK_STATUSES,
  isWorkPlanTaskStatus,
  summarizeWorkPlanEdit,
  type ProjectWorkPlan,
} from '../../knowledge/project-planning/work-plan.js';
import type { ProjectWorkPlanMutationResult, ProjectWorkPlanTask } from '../../knowledge/project-planning/types.js';
import { WORK_PLAN_TOOL_SCHEMA, type WorkPlanToolInput } from './schema.js';

/** The slice of the project work plan the tool uses. */
export type WorkPlanToolStore = Pick<ProjectWorkPlan, 'snapshot' | 'add' | 'update' | 'setStatus' | 'remove' | 'clearCompleted'>;

export interface WorkPlanToolOptions {
  /** The session the tool runs in; recorded on the items it adds. Resolved per call. */
  readonly resolveSessionId?: (() => string | undefined) | undefined;
}

const SOURCE = 'agent';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function itemView(task: ProjectWorkPlanTask) {
  return {
    id: task.taskId,
    title: task.title,
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    updatedAt: task.updatedAt,
  };
}

/**
 * A change answers with the item it changed and one line on where the plan
 * stands, counted in the edit's own transaction; `list` is how the model reads
 * the plan.
 */
function changed(edit: Pick<ProjectWorkPlanMutationResult, 'counts' | 'reclaimedTaskIds'>, result: Record<string, unknown>): string {
  return JSON.stringify({ ...result, plan: summarizeWorkPlanEdit(edit) });
}

/**
 * The model's checklist is the project work plan: the same task rows the user
 * sees in the work plan view (/work-plan), that contracts link to and that the
 * operator's projectPlanning.workPlan methods serve. Kept per project across
 * sessions and restarts.
 */
export function createWorkPlanTool(store: WorkPlanToolStore, options: WorkPlanToolOptions = {}): Tool {
  return {
    definition: {
      name: 'work_plan',
      description: 'Keep the project work plan: a checklist of work items with status, owner and notes that the user sees in the work plan view and that lasts across sessions.'
        + ' Use it to plan multi-step work and to track who is doing what (owner: an agent id, a cohort name or the user); give spawned workers their brief through the agent tool (context and successCriteria).'
        + ` Statuses: ${WORK_PLAN_TASK_STATUSES.join(', ')}.`,
      parameters: toRecord(WORK_PLAN_TOOL_SCHEMA),
      category: 'write',
      readModes: { field: 'action', values: ['list'] },
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      const input = args as unknown as WorkPlanToolInput;
      try {
        switch (input.action) {
          case 'list': {
            if (input.status !== undefined && !isWorkPlanTaskStatus(input.status)) return { success: false, error: `Unknown status "${input.status}". Use one of: ${WORK_PLAN_TASK_STATUSES.join(', ')}.` };
            const plan = await store.snapshot(input.status ? { status: input.status } : {});
            const counts: Record<string, number> = {};
            for (const status of WORK_PLAN_TASK_STATUSES) if (plan.counts[status] > 0) counts[status] = plan.counts[status];
            return { success: true, output: JSON.stringify({ revision: plan.revision, count: plan.counts.total, counts, items: plan.tasks.map(itemView) }) };
          }
          case 'add': {
            const title = text(input.title);
            if (!title) return { success: false, error: 'add requires "title".' };
            if (input.status !== undefined && !isWorkPlanTaskStatus(input.status)) return { success: false, error: `Unknown status "${input.status}". Use one of: ${WORK_PLAN_TASK_STATUSES.join(', ')}.` };
            const sessionId = options.resolveSessionId?.();
            const result = await store.add(title, {
              source: SOURCE,
              ...(input.status ? { status: input.status } : {}),
              ...(text(input.owner) ? { owner: text(input.owner) } : {}),
              ...(text(input.notes) ? { notes: text(input.notes) } : {}),
              ...(sessionId ? { sessionId } : {}),
            });
            return { success: true, output: changed(result, itemView(result.task)) };
          }
          case 'update': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'update requires "id".' };
            const title = text(input.title), owner = text(input.owner), notes = text(input.notes);
            if (!title && owner === undefined && notes === undefined) return { success: false, error: 'update requires at least one of "title", "owner" or "notes". Nothing was changed.' };
            const result = await store.update(id, {
              ...(title ? { title } : {}),
              ...(owner !== undefined ? { owner } : {}),
              ...(notes !== undefined ? { notes } : {}),
            });
            return { success: true, output: changed(result, itemView(result.task)) };
          }
          case 'set_status': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'set_status requires "id".' };
            if (!isWorkPlanTaskStatus(input.status)) return { success: false, error: `set_status requires "status", one of: ${WORK_PLAN_TASK_STATUSES.join(', ')}.` };
            const result = await store.setStatus(id, input.status);
            return { success: true, output: changed(result, itemView(result.task)) };
          }
          case 'remove': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'remove requires "id".' };
            const result = await store.remove(id);
            return { success: true, output: changed(result, { removed: result.deletedTask.taskId, title: result.deletedTask.title }) };
          }
          case 'clear_completed': {
            const result = await store.clearCompleted();
            const cleared = result.clearedTaskIds?.length ?? 0;
            return { success: true, output: cleared > 0 ? changed(result, { cleared }) : JSON.stringify({ cleared }) };
          }
          default:
            return { success: false, error: `Unknown action "${String((args as { action?: unknown }).action)}". Use list, add, update, set_status, remove or clear_completed.` };
        }
      } catch (err) {
        // Unknown or ambiguous id, a store still opening: the message names it and nothing was changed.
        return { success: false, error: `Work plan not changed: ${summarizeError(err)}` };
      }
    },
  };
}
