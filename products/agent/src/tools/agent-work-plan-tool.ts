import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';
import { agentLocalStateWrite, assertAgentLocalStateCurrent, createAgentLocalStateInputProjector } from './agent-local-state-admission.ts';
import {
  WORK_PLAN_TASK_STATUSES as WORK_PLAN_STATUSES,
  summarizeWorkPlanEdit,
  type ProjectWorkPlan,
  type ProjectWorkPlanMutationResult,
  type ProjectWorkPlanTask as WorkPlanItem,
  type ProjectWorkPlanTaskStatus as WorkPlanItemStatus,
  type WorkPlanTaskPatch,
} from '@goodvibes-jev/engine/platform/platform/knowledge';

/** The slice of the project work plan this tool uses. */
export type AgentWorkPlanStore = Pick<ProjectWorkPlan, 'projectRoot' | 'snapshot' | 'get' | 'add' | 'update' | 'setStatus' | 'remove' | 'clearCompleted'>;

export type AgentWorkPlanAction =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'set_status'
  | 'remove'
  | 'clear_completed';

export interface AgentWorkPlanToolArgs {
  readonly action?: unknown;
  readonly id?: unknown;
  readonly ids?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly owner?: unknown;
  readonly source?: unknown;
  readonly notes?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

const ACTIONS: readonly AgentWorkPlanAction[] = [
  'list',
  'get',
  'create',
  'update',
  'set_status',
  'remove',
  'clear_completed',
];

function isAction(value: unknown): value is AgentWorkPlanAction {
  return typeof value === 'string' && ACTIONS.some(action => action === value);
}

function isStatus(value: unknown): value is WorkPlanItemStatus {
  return typeof value === 'string' && WORK_PLAN_STATUSES.some(status => status === value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

/** The changed item's lines plus one line on where the plan stands, counted in the edit's own transaction. */
function changedOutput(edit: Pick<ProjectWorkPlanMutationResult, 'counts' | 'reclaimedTaskIds'>, lines: readonly string[]): { readonly success: true; readonly output: string } {
  return output([...lines, `  plan ${summarizeWorkPlanEdit(edit)}`].join('\n'));
}

function requireId(args: AgentWorkPlanToolArgs): string {
  const id = readString(args.id);
  if (!id) throw new Error('id is required.');
  return id;
}

function requireTitle(args: AgentWorkPlanToolArgs): string {
  const title = readString(args.title);
  if (!title) throw new Error('title is required.');
  return title;
}

function readOptionalStatus(value: unknown): WorkPlanItemStatus | undefined {
  if (value === undefined || value === null || readString(value) === '') return undefined;
  if (!isStatus(value)) throw new Error(`Invalid status. Valid values ${WORK_PLAN_STATUSES.join(', ')}.`);
  return value;
}

function formatStatus(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

function formatItem(item: WorkPlanItem): string {
  const owner = item.owner ? ` owner ${item.owner}` : '';
  const source = item.source ? ` source=${item.source}` : '';
  const completed = item.completedAt ? ` completed ${new Date(item.completedAt).toISOString()}` : '';
  return `${item.taskId}  ${formatStatus(item.status)}${owner}${source}${completed}  ${item.title}`;
}

function routeArg(value: string): string {
  return JSON.stringify(value);
}

function workPlanRoute(action: string, id?: string, status?: WorkPlanItemStatus): string {
  return [
    `agent_work_plan action:${routeArg(action)}`,
    id ? `id:${routeArg(id)}` : '',
    status ? `status:${routeArg(status)}` : '',
  ].filter(Boolean).join(' ');
}

function nextRouteLine(id: string, route: string): string {
  return `    ${id} ${route}`;
}

function workPlanNextRouteLines(item: WorkPlanItem): readonly string[] {
  return [
    '  nextRoutes',
    nextRouteLine('markDone', workPlanRoute('set_status', item.taskId, 'done')),
    nextRouteLine('markBlocked', workPlanRoute('set_status', item.taskId, 'blocked')),
  ];
}

function formatItemDetail(item: WorkPlanItem): string {
  return [
    formatItem(item),
    `created ${new Date(item.createdAt).toISOString()}`,
    `updated ${new Date(item.updatedAt).toISOString()}`,
    ...(linkedText(item) ? [`linked ${linkedText(item)}`] : []),
    '',
    item.notes || '(no notes)',
    '',
    ...workPlanNextRouteLines(item),
  ].join('\n');
}

function linkedText(item: WorkPlanItem): string {
  return [
    item.agentId ? `agentId ${item.agentId}` : '',
    item.contractId ? `contractId ${item.contractId}` : '',
    item.sessionId ? `sessionId ${item.sessionId}` : '',
  ].filter(Boolean).join(', ');
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

function readListLimit(value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return DEFAULT_LIST_LIMIT;
  const limit = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(limit) || limit < 1) throw new Error(`limit must be a number from 1 to ${MAX_LIST_LIMIT}.`);
  return Math.min(Math.trunc(limit), MAX_LIST_LIMIT);
}

async function listOutput(store: AgentWorkPlanStore, filter?: WorkPlanItemStatus, limit = DEFAULT_LIST_LIMIT): Promise<string> {
  const plan = await store.snapshot(filter ? { status: filter } : {});
  const counts = plan.counts;
  const matching = plan.tasks;
  const lines = [
    'Agent todo list',
    `  plan revision ${plan.revision}`,
    `  project ${store.projectRoot}`,
    `  items ${counts.total}; pending ${counts.pending}; active ${counts.in_progress}; blocked ${counts.blocked}; done ${counts.done}; failed ${counts.failed}; cancelled ${counts.cancelled}`,
  ];
  if (counts.total === 0) {
    lines.push('', 'No local work plan items.');
    return lines.join('\n');
  }
  if (matching.length === 0) {
    lines.push('', `No ${filter ? `${formatStatus(filter)} ` : ''}items.`);
  } else {
    lines.push('', ...matching.slice(0, limit).map(formatItem));
    if (matching.length > limit) lines.push(`${matching.length - limit} more ${filter ? `${formatStatus(filter)} ` : ''}item(s) omitted; raise limit (at most ${MAX_LIST_LIMIT}) or filter with status to see them.`);
  }
  return lines.join('\n');
}

function updatePatch(args: AgentWorkPlanToolArgs): WorkPlanTaskPatch {
  const status = readOptionalStatus(args.status);
  return {
    ...(args.title !== undefined ? { title: requireTitle(args) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(args.owner !== undefined ? { owner: readString(args.owner) || null } : {}),
    ...(args.source !== undefined ? { source: readString(args.source) || null } : {}),
    ...(args.notes !== undefined ? { notes: readString(args.notes) || null } : {}),
  };
}

export function createAgentWorkPlanTool(store: AgentWorkPlanStore): Tool {
  return {
    definition: {
      name: 'agent_work_plan',
      activity: { doing: 'Organizing', did: 'organized', object: 'work' },
      description: 'The Agent\'s todo list for this project: track items and their status. It records work; it does not run it (the owner starts work with /work). clear_completed removes done and cancelled items; failed items stay.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          id: { type: 'string', description: 'Work plan item id or unique id prefix for get/update/set_status/remove.' },
          title: { type: 'string', description: 'Work plan item title for create/update.' },
          status: { type: 'string', enum: [...WORK_PLAN_STATUSES], description: 'Work plan item status; with action:list it shows only items in that status.' },
          limit: { type: 'number', description: `action:list only: items to show (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).` },
          owner: { type: 'string', description: 'Optional owner label.' },
          source: { type: 'string', description: 'Optional source/provenance label.' },
          notes: { type: 'string', description: 'Optional work-plan notes.' },
          confirm: { type: 'boolean', description: 'Optional caller provenance; never grants write authority.' },
          explicitUserRequest: { type: 'string', description: 'Optional request provenance; never grants write authority.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs, options) => {
      const args = captureCatalogData(rawArgs);
      options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
      if (!isAction(args.action)) return failure(`Unknown agent_work_plan action. Valid values ${ACTIONS.join(', ')}.`);
      if (args.action === 'list' || args.action === 'get') {
        const result = args.action === 'list' ? await listOutput(store, readOptionalStatus(args.status), readListLimit(args.limit)) : formatItemDetail(await store.get(requireId(args)));
        assertAgentLocalStateCurrent(rawArgs, options); return output(result);
      }
      // The registry-issued write authority is checked once, before the one transaction that writes.
      agentLocalStateWrite(rawArgs, options);
      if (args.action === 'create') {
        const edit = await store.add(requireTitle(args), {
          status: readOptionalStatus(args.status) ?? 'pending',
          owner: readString(args.owner) || 'agent',
          source: readString(args.source) || 'main-conversation',
          notes: readString(args.notes) || undefined,
        });
        return changedOutput(edit, [
          'Created Agent todo',
          `  id ${edit.task.taskId}`,
          `  title ${edit.task.title}`,
        ]);
      }
      if (args.action === 'update') {
        const patch = updatePatch(args);
        if (Object.keys(patch).length === 0) return failure('Nothing to update: give at least one of title, status, owner, source or notes.');
        const edit = await store.update(requireId(args), patch);
        return changedOutput(edit, [
          'Updated Agent todo',
          `  id ${edit.task.taskId}`,
          `  title ${edit.task.title}`,
        ]);
      }
      if (args.action === 'set_status') {
        const status = readOptionalStatus(args.status);
        if (!status) throw new Error('status is required.');
        const edit = await store.setStatus(requireId(args), status);
        return changedOutput(edit, [
          'Set Agent todo status',
          `  id ${edit.task.taskId}`,
          `  status ${formatStatus(edit.task.status)}`,
          `  title ${edit.task.title}`,
        ]);
      }
      if (args.action === 'remove') {
        const { deletedTask, ...edit } = await store.remove(requireId(args));
        return changedOutput(edit, [
          'Removed Agent todo',
          `  id ${deletedTask.taskId}`,
          `  title ${deletedTask.title}`,
        ]);
      }
      const result = await store.clearCompleted();
      const count = result.clearedTaskIds?.length ?? 0;
      const cleared = [
        `Cleared ${count} done or cancelled Agent todos`,
        `  count ${count}`,
      ];
      return count > 0 ? changedOutput(result, cleared) : output(cleared.join('\n'));
    },
  };
}

export function registerAgentWorkPlanTool(registry: ToolRegistry, store: AgentWorkPlanStore): void {
  // The plan is rows in the knowledge database, not a file this tool names: the projection screens a
  // write for secret-like text and binds the registry's write authority; there is no file target to hold.
  registry.register(createAgentWorkPlanTool(store), { inputProjection: createAgentLocalStateInputProjector(() => ({
    targets: [], assertDescriptors: () => {},
  }), args => args.action === 'list' || args.action === 'get') });
}
