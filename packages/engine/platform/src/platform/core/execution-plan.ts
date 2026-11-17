/**
 * The session's execution plan: a view of the project work plan.
 *
 * There is one plan, the project work plan (`knowledge/project-planning/work-plan.ts`):
 * the model keeps it with the `work_plan` tool, the person sees and edits it
 * in the work plan view, and contracts link to it. This class reads that plan
 * as the plan the turn shows the model (`hostInstructions` key `plan`), the
 * compaction summary keeps, and the completion check reads; and it writes item
 * statuses back to it when a contract unit's agents finish
 * (`contract/plan-sync.ts`). It keeps no file of its own.
 */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

export interface PlanItem {
  id: string;
  phase: string;
  description: string;
  status: PlanItemStatus;
  agentId?: string; // set when an agent is assigned
  dependencies?: string[]; // IDs of items that must complete first
}

export type ExecutionPlanStatus = 'draft' | 'active' | 'complete' | 'failed';

export interface ExecutionPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | undefined;
  status: ExecutionPlanStatus;
  items: PlanItem[];
  /** Open items left out of this view to keep what the model is sent bounded. */
  omitted?: number;
}

/** A work plan task's status, as the project work plan records it. */
export type WorkPlanTaskState = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled';

/** The fields of a work plan task the view reads. */
export interface WorkPlanTaskView {
  readonly taskId: string;
  readonly title: string;
  readonly status: WorkPlanTaskState;
  readonly owner?: string | undefined;
  readonly agentId?: string | undefined;
  /** The session the task was recorded in. */
  readonly sessionId?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The slice of the project work plan (`ProjectWorkPlan`) the view reads and
 * writes: one synchronous read of the plan, and a status change.
 */
export interface ExecutionPlanSource {
  snapshotNow(): { readonly workPlanId: string; readonly tasks: readonly WorkPlanTaskView[]; readonly updatedAt: number };
  setStatus(idOrPrefix: string, status: WorkPlanTaskState): Promise<unknown>;
}

/**
 * At most this many open items reach the model per user turn; the rest are
 * counted, and `work_plan list` shows them all.
 */
export const EXECUTION_PLAN_VIEW_LIMIT = 40;

const OPEN_PHASE = 'Open items';
const PLAN_PHASE = 'Work plan';

const STATUS_CHECKBOX: Record<PlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  complete: '[x]',
  failed: '[!]',
  skipped: '[-]',
};

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: 'PENDING',
  in_progress: 'IN_PROGRESS',
  complete: 'COMPLETE',
  failed: 'FAILED',
  skipped: 'SKIPPED',
};

const FROM_WORK_PLAN: Record<WorkPlanTaskState, PlanItemStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  blocked: 'pending',
  done: 'complete',
  failed: 'failed',
  cancelled: 'skipped',
};

const TO_WORK_PLAN: Record<PlanItemStatus, WorkPlanTaskState> = {
  pending: 'pending',
  in_progress: 'in_progress',
  complete: 'done',
  failed: 'failed',
  skipped: 'cancelled',
};

function isOpen(item: WorkPlanTaskView): boolean {
  return item.status === 'pending' || item.status === 'in_progress' || item.status === 'blocked';
}

function planItemOf(item: WorkPlanTaskView, phase: string): PlanItem {
  // An item's agent is its link when it has one, else its owner: the
  // `work_plan` tool records an assigned agent as the owner.
  const agentId = item.agentId ?? item.owner;
  return {
    id: item.taskId,
    phase,
    description: item.status === 'blocked' ? `${item.title} (blocked)` : item.title,
    status: FROM_WORK_PLAN[item.status],
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * The plan's top-level status as a pure function of its items: complete when
 * everything finished or was skipped, failed when any item failed, active
 * while an item is under way, a draft otherwise.
 */
export function derivePlanStatus(items: readonly Pick<PlanItem, 'status'>[]): ExecutionPlanStatus {
  if (items.length > 0 && items.every((i) => i.status === 'complete' || i.status === 'skipped')) return 'complete';
  if (items.some((i) => i.status === 'failed')) return 'failed';
  if (items.some((i) => i.status === 'in_progress')) return 'active';
  return 'draft';
}

function phaseStatus(items: PlanItem[]): string {
  if (items.length === 0) return 'PENDING';
  if (items.every((i) => i.status === 'complete' || i.status === 'skipped')) return 'COMPLETE';
  if (items.some((i) => i.status === 'in_progress')) return 'IN_PROGRESS';
  if (items.some((i) => i.status === 'failed')) return 'FAILED';
  return 'PENDING';
}

type PlanRead = ReturnType<ExecutionPlanSource['snapshotNow']>;

function viewOf(plan: PlanRead, items: readonly WorkPlanTaskView[], phase: string, omitted: number): ExecutionPlan {
  const planItems = items.map((item) => planItemOf(item, phase));
  const createdAt = Math.min(plan.updatedAt, ...items.map((item) => item.createdAt));
  return {
    id: plan.workPlanId,
    title: 'Work plan',
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(plan.updatedAt).toISOString(),
    status: derivePlanStatus(planItems),
    items: planItems,
    ...(omitted > 0 ? { omitted } : {}),
  };
}

// ---------------------------------------------------------------------------
// ExecutionPlanManager
// ---------------------------------------------------------------------------

export class ExecutionPlanManager {
  private readonly workPlan: ExecutionPlanSource | null;

  /** `null` where the composition has no project work plan: there is then no active plan. */
  constructor(workPlan: ExecutionPlanSource | null) {
    this.workPlan = workPlan;
  }

  /** The plan as stored now; null when there is none or its store is still opening. */
  private read(): PlanRead | null {
    if (!this.workPlan) return null;
    try {
      return this.workPlan.snapshotNow();
    } catch (error) {
      logger.debug('ExecutionPlanManager: the work plan could not be read yet', { error: summarizeError(error) });
      return null;
    }
  }

  /**
   * The open work this session recorded in the project work plan, or null
   * when it has none. Without a session id, every open item of the plan.
   */
  getActive(sessionId?: string): ExecutionPlan | null {
    const plan = this.read();
    if (!plan) return null;
    const open = plan.tasks.filter((task) => isOpen(task) && (sessionId === undefined || task.sessionId === sessionId));
    if (open.length === 0) return null;
    // Work under way first, then waiting work in plan order.
    const ordered = [...open.filter((i) => i.status === 'in_progress'), ...open.filter((i) => i.status !== 'in_progress')];
    const shown = ordered.slice(0, EXECUTION_PLAN_VIEW_LIMIT);
    return viewOf(plan, shown, OPEN_PHASE, ordered.length - shown.length);
  }

  /** The work under way, for the completion check: an item no one started is not this answer's obligation. */
  getInProgress(sessionId?: string): ExecutionPlan | null {
    const active = this.getActive(sessionId);
    if (!active) return null;
    const items = active.items.filter((i) => i.status === 'in_progress');
    if (items.length === 0) return null;
    return { id: active.id, title: active.title, createdAt: active.createdAt, updatedAt: active.updatedAt, status: 'active', items };
  }

  /**
   * Write an item's status back to the work plan. The write is the plan's own
   * transaction; a failure (the item was removed meanwhile) is logged and the
   * plan is left as it is.
   */
  updateItem(planId: string, itemId: string, status: PlanItemStatus): Promise<void> {
    const plan = this.read();
    if (!this.workPlan || !plan || plan.workPlanId !== planId || !plan.tasks.some((task) => task.taskId === itemId)) return Promise.resolve();
    return this.workPlan.setStatus(itemId, TO_WORK_PLAN[status]).then(() => undefined, (error: unknown) => {
      logger.warn('ExecutionPlanManager: a work plan item was not updated', { planId, itemId, error: summarizeError(error) });
    });
  }

  /** The whole work plan, finished items included, as the one plan there is; empty when it has no items. */
  list(): ExecutionPlan[] {
    const plan = this.read();
    return !plan || plan.tasks.length === 0 ? [] : [viewOf(plan, plan.tasks, PLAN_PHASE, 0)];
  }

  // --------------------------------------------------------------------------
  // Markdown rendering
  // --------------------------------------------------------------------------

  /**
   * Render plan as markdown for injection into model context.
   *
   * Format:
   *   # Plan Title
   *   ## Open items [IN_PROGRESS]
   *   - [~] Description -- IN_PROGRESS (agent-id)
   */
  toMarkdown(plan: ExecutionPlan): string {
    const lines: string[] = [`# ${plan.title}`, ''];

    // Group items by phase (preserve insertion order)
    const phaseOrder: string[] = [];
    const byPhase = new Map<string, PlanItem[]>();
    for (const item of plan.items) {
      if (!byPhase.has(item.phase)) {
        byPhase.set(item.phase, []);
        phaseOrder.push(item.phase);
      }
      byPhase.get(item.phase)?.push(item);
    }

    for (const phase of phaseOrder) {
      const items = byPhase.get(phase) ?? [];
      lines.push(`## ${phase} [${phaseStatus(items)}]`);
      for (const item of items) {
        let line = `- ${STATUS_CHECKBOX[item.status]} ${item.description} -- ${STATUS_LABEL[item.status]}`;
        if (item.agentId) line += ` (${item.agentId})`;
        if (item.dependencies && item.dependencies.length > 0) {
          const depDescs = item.dependencies
            .map((depId) => plan.items.find((i) => i.id === depId)?.description ?? depId)
            .join(', ');
          line += ` (depends: ${depDescs})`;
        }
        lines.push(line);
      }
      lines.push('');
    }
    if (plan.omitted) lines.push(`(${plan.omitted} more open item(s) not shown; \`work_plan\` action \`list\` shows all.)`);

    return lines.join('\n').trimEnd() + '\n';
  }

  // --------------------------------------------------------------------------
  // Query helpers
  // --------------------------------------------------------------------------

  /** Human-readable summary: "Open items: 1/3 complete" */
  getSummary(plan: ExecutionPlan): string {
    const phaseOrder: string[] = [];
    const byPhase = new Map<string, PlanItem[]>();
    for (const item of plan.items) {
      if (!byPhase.has(item.phase)) {
        byPhase.set(item.phase, []);
        phaseOrder.push(item.phase);
      }
      byPhase.get(item.phase)?.push(item);
    }

    // Find the first non-complete phase
    for (const phase of phaseOrder) {
      const phaseItems = byPhase.get(phase)!;
      const done = phaseItems.filter(
        (i) => i.status === 'complete' || i.status === 'skipped',
      ).length;
      if (done < phaseItems.length) {
        return `${phase}: ${done}/${phaseItems.length} complete`;
      }
    }

    return `${plan.title}: all complete`;
  }

  /** Get next actionable items: dependencies met, status=pending. */
  getNextItems(plan: ExecutionPlan): PlanItem[] {
    const completeIds = new Set(
      plan.items
        .filter((i) => i.status === 'complete' || i.status === 'skipped')
        .map((i) => i.id),
    );

    return plan.items.filter((item) => {
      if (item.status !== 'pending') return false;
      if (!item.dependencies || item.dependencies.length === 0) return true;
      return item.dependencies.every((depId) => completeIds.has(depId));
    });
  }
}
