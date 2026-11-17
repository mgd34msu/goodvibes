import { WORK_PLAN_STATUSES } from '../../workflow/work-plan-store.js';

/** The work_plan tool's input. */
export const WORK_PLAN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'update', 'set_status', 'remove', 'clear_completed'],
      description: 'list the items; add one; update its title, owner or notes; set_status; remove one; clear_completed removes finished items.',
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
      enum: [...WORK_PLAN_STATUSES],
      description: '(add, set_status) The item status. add defaults to pending.',
    },
    owner: {
      type: 'string',
      description: '(add, update) Who is doing it: an agent id, a cohort name or the user.',
    },
    notes: {
      type: 'string',
      description: '(add, update) Detail, acceptance notes or what is blocking it.',
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
