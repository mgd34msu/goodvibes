import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';
import { failureMessage } from './agent-projection-failure.ts';
import { agentLocalStateWrite, assertAgentLocalStateCurrent, createAgentLocalStateInputProjector } from './agent-local-state-admission.ts';
import {
  WORK_PLAN_STATUSES,
  type WorkPlanItem,
  type WorkPlanItemStatus,
  type WorkPlanStore,
} from '@goodvibes-jev/engine/platform/platform/workflow';

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
  return `${item.id}  ${formatStatus(item.status)}${owner}${source}${completed}  ${item.title}`;
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
    nextRouteLine('markDone', workPlanRoute('set_status', item.id, 'done')),
    nextRouteLine('markBlocked', workPlanRoute('set_status', item.id, 'blocked')),
  ];
}

function formatItemDetail(item: WorkPlanItem): string {
  return [
    formatItem(item),
    `created ${new Date(item.createdAt).toISOString()}`,
    `updated ${new Date(item.updatedAt).toISOString()}`,
    ...(item.linked ? [`linked ${Object.entries(item.linked).map(([key, value]) => `${key} ${String(value)}`).join(', ')}`] : []),
    '',
    item.notes || '(no notes)',
    '',
    ...workPlanNextRouteLines(item),
  ].join('\n');
}

function resolveItem(store: WorkPlanStore, idOrPrefix: string): WorkPlanItem {
  const needle = idOrPrefix.trim();
  if (!needle) throw new Error('id is required.');
  const items = store.listItems();
  const exact = items.find((item) => item.id === needle);
  if (exact) return exact;
  const matches = items.filter((item) => item.id.startsWith(needle));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Work plan item id "${needle}" is ambiguous. Matches ${matches.map((item) => item.id).join(', ')}`);
  }
  throw new Error(`Work plan item not found ${needle}`);
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

function readListLimit(value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return DEFAULT_LIST_LIMIT;
  const limit = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(limit) || limit < 1) throw new Error(`limit must be a number from 1 to ${MAX_LIST_LIMIT}.`);
  return Math.min(Math.trunc(limit), MAX_LIST_LIMIT);
}

function listOutput(store: WorkPlanStore, filter?: WorkPlanItemStatus, limit = DEFAULT_LIST_LIMIT): string {
  const plan = store.getActivePlan();
  const counts = new Map<WorkPlanItemStatus, number>(WORK_PLAN_STATUSES.map((status) => [status, 0]));
  for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const matching = filter ? plan.items.filter((item) => item.status === filter) : plan.items;
  const lines = [
    'Agent todo list',
    plan.registration === 'unregistered' && !plan.id ? '  plan not saved; adding the first item creates it' : `  plan ${plan.id}`,
    `  project ${plan.projectRoot}`,
    `  items ${plan.items.length}; pending ${counts.get('pending') ?? 0}; active ${counts.get('in_progress') ?? 0}; blocked ${counts.get('blocked') ?? 0}; done ${counts.get('done') ?? 0}; failed ${counts.get('failed') ?? 0}; cancelled ${counts.get('cancelled') ?? 0}`,
  ];
  if (plan.housekeeping?.recoveryRequired) lines.push('Saved local plan is unreadable; this inspection left the file unchanged. The next create or update moves it aside to a recovery copy next to it and starts a fresh plan; nothing is deleted.');
  if (plan.housekeeping?.preservedUnverifiedQuarantines) lines.push(`${plan.housekeeping.preservedUnverifiedQuarantines} unverified historical recovery path(s) were preserved for inspection.`);
  if (plan.unassignedPlanPaths?.length) {
    lines.push('Preserved work-plan files could not be assigned to a project. Inspect these before recovering their items:', ...plan.unassignedPlanPaths);
  }
  if (plan.items.length === 0) {
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

function updatePatch(args: AgentWorkPlanToolArgs): Parameters<WorkPlanStore['updateItem']>[1] {
  const status = readOptionalStatus(args.status);
  return {
    ...(args.title !== undefined ? { title: requireTitle(args) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(args.owner !== undefined ? { owner: readString(args.owner) || null } : {}),
    ...(args.source !== undefined ? { source: readString(args.source) || null } : {}),
    ...(args.notes !== undefined ? { notes: readString(args.notes) || null } : {}),
  };
}

export function createAgentWorkPlanTool(store: WorkPlanStore): Tool {
  return {
    definition: {
      name: 'agent_work_plan',
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
      try {
        const args = captureCatalogData(rawArgs);
        options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
        if (!isAction(args.action)) return failure(`Unknown agent_work_plan action. Valid values ${ACTIONS.join(', ')}.`);
        if (args.action === 'list' || args.action === 'get') {
          const result = args.action === 'list' ? listOutput(store, readOptionalStatus(args.status), readListLimit(args.limit)) : formatItemDetail(resolveItem(store, requireId(args)));
          assertAgentLocalStateCurrent(rawArgs, options); return output(result);
        }
        const effects = agentLocalStateWrite(rawArgs, options);
        if (args.action === 'create') {
          const item = store.addItem(requireTitle(args), {
            status: readOptionalStatus(args.status) ?? 'pending',
            owner: readString(args.owner) || 'agent',
            source: readString(args.source) || 'main-conversation',
            notes: readString(args.notes) || undefined,
          }, effects);
          return output([
            'Created Agent todo',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'update') {
          const patch = updatePatch(args);
          if (Object.keys(patch).length === 0) return failure('Nothing to update: give at least one of title, status, owner, source or notes.');
          const item = store.updateItem(requireId(args), patch, effects);
          return output([
            'Updated Agent todo',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'set_status') {
          const status = readOptionalStatus(args.status);
          if (!status) throw new Error('status is required.');
          const item = store.setItemStatus(requireId(args), status, effects);
          return output([
            'Set Agent todo status',
            `  id ${item.id}`,
            `  status ${formatStatus(item.status)}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'remove') {
          const item = store.removeItem(requireId(args), effects);
          return output([
            'Removed Agent todo',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        const count = store.clearCompleted(effects);
        return output([
          `Cleared ${count} done or cancelled Agent todos`,
          `  count ${count}`,
        ].join('\n'));
      } catch (error) {
        return failure(failureMessage(error, options?.signal));
      }
    },
  };
}

export function registerAgentWorkPlanTool(registry: ToolRegistry, store: WorkPlanStore): void {
  // The store's home and plan file are fixed when it is built, so the target needs no re-check.
  registry.register(createAgentWorkPlanTool(store), { inputProjection: createAgentLocalStateInputProjector(() => ({
    targets: [{ root: store.homeDirectory, path: store.filePath, access: 'write' }], assertDescriptors: () => {},
  }), args => args.action === 'list' || args.action === 'get') });
}
