import { WORK_PLAN_TASK_STATUSES } from '../../knowledge/project-planning/work-plan.js';

/** The work_plan tool's input. */
export const WORK_PLAN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'update', 'set_status', 'remove', 'clear_completed'],
      description: 'list the items; add one; update its title, owner or notes; set_status; remove one; clear_completed removes done and cancelled items.',
    },
    id: {
      type: 'string',
      description: '(update, set_status, remove) The item id, or a unique prefix of it.',
    },
    title: {
      type: 'string',
      description: '(add, update) What the item is, in a short line.',
    },
    status: {
      type: 'string',
      enum: [...WORK_PLAN_TASK_STATUSES],
      description: '(add, set_status) The item status. add defaults to pending. (list) Show only items in this status.',
    },
    owner: {
      type: 'string',
      description: '(add, update) Who is doing it: an agent id, a cohort name or the user. (update) An empty string clears it.',
    },
    notes: {
      type: 'string',
      description: '(add, update) Detail, acceptance notes or what is blocking it. (update) An empty string clears it.',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

export interface WorkPlanToolInput {
  readonly action: 'list' | 'add' | 'update' | 'set_status' | 'remove' | 'clear_completed';
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: string | undefined;
  readonly owner?: string | undefined;
  readonly notes?: string | undefined;
}
