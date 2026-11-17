import type { Tool } from '../../types/tools.js';
import { toRecord } from '../../utils/record-coerce.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  WORK_PLAN_STATUSES,
  type WorkPlanItem,
  type WorkPlanItemStatus,
  type WorkPlanStore,
} from '../../workflow/work-plan-store.js';
import { WORK_PLAN_TOOL_SCHEMA, type WorkPlanToolInput } from './schema.js';

/** The slice of the project work plan the tool uses. */
export type WorkPlanToolStore = Pick<WorkPlanStore, 'getActivePlan' | 'addItem' | 'updateItem' | 'setItemStatus' | 'removeItem' | 'clearCompleted'>;

const SOURCE = 'agent';

function isStatus(value: unknown): value is WorkPlanItemStatus {
  return typeof value === 'string' && (WORK_PLAN_STATUSES as readonly string[]).includes(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function itemView(item: WorkPlanItem) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.owner ? { owner: item.owner } : {}),
    ...(item.notes ? { notes: item.notes } : {}),
    updatedAt: item.updatedAt,
  };
}

/**
 * The model's checklist is the project work plan: the same items the user
 * sees in the work plan view (/plan) and that contracts link to. Items are
 * kept per project across sessions and restarts.
 */
export function createWorkPlanTool(store: WorkPlanToolStore): Tool {
  return {
    definition: {
      name: 'work_plan',
      description: 'Keep the project work plan: a checklist of work items with status, owner and notes that the user sees in the work plan view and that lasts across sessions.'
        + ' Use it to plan multi-step work and to track who is doing what (owner: an agent id, a cohort name or the user); give spawned workers their brief through the agent tool (context and successCriteria).'
        + ` Statuses: ${WORK_PLAN_STATUSES.join(', ')}.`,
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
            const plan = store.getActivePlan();
            const counts: Record<string, number> = {};
            for (const item of plan.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
            return { success: true, output: JSON.stringify({ planId: plan.id, count: plan.items.length, counts, items: plan.items.map(itemView) }) };
          }
          case 'add': {
            const title = text(input.title);
            if (!title) return { success: false, error: 'add requires "title".' };
            if (input.status !== undefined && !isStatus(input.status)) return { success: false, error: `Unknown status "${input.status}". Use one of: ${WORK_PLAN_STATUSES.join(', ')}.` };
            const owner = text(input.owner), notes = text(input.notes);
            const item = store.addItem(title, {
              source: SOURCE,
              ...(input.status ? { status: input.status } : {}),
              ...(owner ? { owner } : {}),
              ...(notes ? { notes } : {}),
            });
            return { success: true, output: JSON.stringify(itemView(item)) };
          }
          case 'update': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'update requires "id".' };
            const title = text(input.title), owner = text(input.owner), notes = text(input.notes);
            if (!title && owner === undefined && notes === undefined) return { success: false, error: 'update requires at least one of "title", "owner" or "notes". Nothing was changed.' };
            const item = store.updateItem(id, {
              ...(title ? { title } : {}),
              ...(owner !== undefined ? { owner } : {}),
              ...(notes !== undefined ? { notes } : {}),
            });
            return { success: true, output: JSON.stringify(itemView(item)) };
          }
          case 'set_status': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'set_status requires "id".' };
            if (!isStatus(input.status)) return { success: false, error: `set_status requires "status", one of: ${WORK_PLAN_STATUSES.join(', ')}.` };
            return { success: true, output: JSON.stringify(itemView(store.setItemStatus(id, input.status))) };
          }
          case 'remove': {
            const id = text(input.id);
            if (!id) return { success: false, error: 'remove requires "id".' };
            const item = store.removeItem(id);
            return { success: true, output: JSON.stringify({ removed: item.id, title: item.title }) };
          }
          case 'clear_completed':
            return { success: true, output: JSON.stringify({ cleared: store.clearCompleted() }) };
          default:
            return { success: false, error: `Unknown action "${String((args as { action?: unknown }).action)}". Use list, add, update, set_status, remove or clear_completed.` };
        }
      } catch (err) {
        // Unknown or ambiguous id, a busy plan file: the store's message names it and nothing was changed.
        return { success: false, error: `Work plan not changed: ${summarizeError(err)}` };
      }
    },
  };
}
