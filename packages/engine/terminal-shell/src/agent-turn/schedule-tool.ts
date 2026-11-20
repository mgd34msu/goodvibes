import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { randomUUID } from 'node:crypto';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { readString } from './tool-args.js';

type ScheduleAction =
  | 'list'
  | 'create'
  | 'reminder'
  | 'edit'
  | 'run'
  | 'pause'
  | 'resume'
  | 'delete';

interface AgentScheduleToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly scheduleId?: unknown;
  readonly jobId?: unknown;
  readonly targetId?: unknown;
  readonly task?: unknown;
  readonly message?: unknown;
  readonly successCriteria?: unknown;
  readonly scheduleKind?: unknown;
  readonly kind?: unknown;
  readonly scheduleValue?: unknown;
  readonly value?: unknown;
  readonly at?: unknown;
  readonly every?: unknown;
  readonly cron?: unknown;
  readonly timezone?: unknown;
  readonly staggerMs?: unknown;
  readonly name?: unknown;
  readonly prompt?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deliveryChannel?: unknown;
  readonly deliveryRoute?: unknown;
  readonly deliveryWebhook?: unknown;
  readonly deliveryLink?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly query?: unknown;
  readonly limit?: unknown;
}

const LIFECYCLE_ACTIONS: Readonly<Record<'run' | 'pause' | 'resume' | 'delete', string>> = {
  run: 'automation.schedules.run',
  pause: 'automation.schedules.pause',
  resume: 'automation.schedules.resume',
  delete: 'automation.schedules.delete',
};

function readScheduleId(args: AgentScheduleToolArgs): string {
  return readString(args.scheduleId) || readString(args.jobId) || readString(args.targetId);
}

function normalizeAction(value: unknown): ScheduleAction | null {
  const action = readString(value).toLowerCase();
  if (!action) return null;
  if (action === 'autonomous' || action === 'schedule' || action === 'create_task' || action === 'create-task') return 'create';
  if (action === 'remind' || action === 'reminder' || action === 'create_reminder' || action === 'create-reminder') return 'reminder';
  if (action === 'update' || action === 'patch') return 'edit';
  if (action === 'disable' || action === 'stop' || action === 'cancel') return 'pause';
  if (action === 'enable' || action === 'start') return 'resume';
  if (action === 'remove') return 'delete';
  if (action === 'ls' || action === 'status' || action === 'show') return 'list';
  if (action === 'list' || action === 'create' || action === 'edit' || action === 'run' || action === 'pause' || action === 'resume' || action === 'delete') return action;
  return null;
}

function hasEditFields(args: AgentScheduleToolArgs): boolean {
  return Boolean(
    readString(args.scheduleKind)
      || readString(args.kind)
      || readString(args.scheduleValue)
      || readString(args.value)
      || readString(args.at)
      || readString(args.every)
      || readString(args.cron)
      || readString(args.name)
      || readString(args.prompt)
      || readString(args.task)
      || readString(args.successCriteria)
      || args.staggerMs !== undefined,
  );
}

const SCHEDULE_ACTION_WORDS = ['list', 'show', 'create', 'autonomous', 'remind', 'reminder', 'edit', 'run', 'pause', 'resume', 'enable', 'disable', 'delete'] as const;

/** The action to take, or a refusal naming why none can be chosen. */
function readAction(args: AgentScheduleToolArgs): { readonly action: ScheduleAction } | { readonly refusal: string } {
  // A word that was sent but is not an action is refused: inferring one from the
  // other fields would carry out something the caller did not ask for.
  const word = readString(args.action) || readString(args.mode);
  if (word) {
    const explicit = normalizeAction(word);
    if (!explicit) return { refusal: `Unknown schedule action "${word}". Use one of: ${SCHEDULE_ACTION_WORDS.join(', ')}.` };
    return { action: explicit };
  }
  const scheduleId = readScheduleId(args);
  if (readString(args.message)) {
    // `message` is the text of a new reminder; no edit path accepts it. Creating
    // a second reminder while the named one keeps firing would look like a success.
    if (scheduleId) {
      return { refusal: `schedule {scheduleId, message} would create a new reminder and leave ${scheduleId} unchanged: a reminder's text cannot be edited with message. Use action:edit with prompt to change what ${scheduleId} says, or action:delete and then action:reminder to replace it.` };
    }
    return { action: 'reminder' };
  }
  if (readString(args.task)) return { action: scheduleId && hasEditFields(args) ? 'edit' : 'create' };
  if (scheduleId && hasEditFields(args)) return { action: 'edit' };
  return { action: 'list' };
}

function scheduleKind(args: AgentScheduleToolArgs): string {
  const direct = readString(args.scheduleKind) || readString(args.kind);
  if (direct) return direct.toLowerCase();
  if (readString(args.at)) return 'at';
  if (readString(args.every)) return 'every';
  if (readString(args.cron)) return 'cron';
  return '';
}

function scheduleValue(args: AgentScheduleToolArgs, kind: string): string {
  const direct = readString(args.scheduleValue) || readString(args.value);
  if (direct) return direct;
  if (kind === 'at') return readString(args.at);
  if (kind === 'every') return readString(args.every);
  if (kind === 'cron') return readString(args.cron);
  return readString(args.at) || readString(args.every) || readString(args.cron);
}

function sharedCreateArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  const kind = scheduleKind(args);
  return {
    scheduleKind: kind,
    scheduleValue: scheduleValue(args, kind),
    timezone: args.timezone,
    name: args.name,
    provider: args.provider,
    model: args.model,
    deliveryChannel: args.deliveryChannel,
    deliveryRoute: args.deliveryRoute,
    deliveryWebhook: args.deliveryWebhook,
    deliveryLink: args.deliveryLink,
    disabled: args.disabled,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  };
}

function autonomyArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  return {
    task: args.task,
    successCriteria: args.successCriteria,
    ...sharedCreateArgs(args),
  };
}

function reminderArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  return {
    message: args.message,
    ...sharedCreateArgs(args),
  };
}

function editArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  const kind = scheduleKind(args);
  return {
    scheduleId: readScheduleId(args),
    scheduleKind: kind || undefined,
    // Passed on even with no kind, so the edit tool refuses the half-given pair
    // instead of this call dropping the value and reporting an edit.
    scheduleValue: scheduleValue(args, kind) || undefined,
    timezone: args.timezone,
    staggerMs: args.staggerMs,
    name: args.name,
    prompt: args.prompt,
    task: args.task,
    successCriteria: args.successCriteria,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  };
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The host lists every schedule and takes no filter, so the lookup the tool
 * offers is done here, on the list it already received: a schedule id returns
 * that one schedule, `query` matches id or name, and `limit` bounds the rows.
 */
function selectListedSchedules(result: Awaited<ReturnType<Tool['execute']>>, args: AgentScheduleToolArgs): Awaited<ReturnType<Tool['execute']>> {
  if (!result.success || !result.output) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(result.output); } catch { return result; }
  const receipt = parsed;
  if (!isRecord(receipt) || !isRecord(receipt.body) || !Array.isArray(receipt.body.jobs)) return result;
  const body = receipt.body;
  const jobs: readonly unknown[] = receipt.body.jobs;
  const scheduleId = readScheduleId(args);
  if (scheduleId) {
    const job = jobs.find(entry => isRecord(entry) && entry.id === scheduleId);
    if (!job) return { success: false, error: `No schedule with id ${scheduleId} is on the connected host (${jobs.length} listed). Call schedule action:"list" to see the ids.` };
    return { success: true, output: JSON.stringify({ ...receipt, body: { ...body, jobs: [job] }, shown: 1, total: jobs.length }, null, 2) };
  }
  const query = readString(args.query).toLowerCase();
  const matching = query
    ? jobs.filter(entry => isRecord(entry) && [entry.id, entry.name].some(field => typeof field === 'string' && field.toLowerCase().includes(query)))
    : jobs;
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
    ? Math.min(args.limit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const shown = matching.slice(0, limit);
  const more = matching.length - shown.length;
  return { success: true, output: JSON.stringify({
    ...receipt,
    body: { ...body, jobs: shown },
    shown: shown.length,
    total: jobs.length,
    ...(query ? { matching: matching.length } : {}),
    note: `${shown.length} of ${query ? `${matching.length} matching (${jobs.length} in all)` : jobs.length} shown.${more > 0 ? ` Pass limit (up to ${MAX_LIST_LIMIT}) or a narrower query to see the other ${more}.` : ''}`,
  }, null, 2) };
}

export function createAgentScheduleTool(
  _shellPaths: ShellPathService,
  _configManager: AgentConnectedHostConfigReader,
  registry?: ToolRegistry,
): Tool {
  return {
    definition: {
      name: 'schedule',
      activity: {
        doing: 'Checking', did: 'checked', object: 'schedules',
        byAction: {
          change: { doing: 'Updating', did: 'updated', object: 'a schedule', objects: 'schedules' },
          run: { doing: 'Running', did: 'ran', object: 'a scheduled job', objects: 'scheduled jobs' },
          delete: { doing: 'Deleting', did: 'deleted', object: 'a schedule', objects: 'schedules' },
        },
      },
      description: 'List, create, edit, run, pause, resume schedules.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...SCHEDULE_ACTION_WORDS],
            description: 'Schedule action; show is list with a scheduleId. Changes require a current recorded admission.',
          },
          scheduleId: { type: 'string', description: 'Connected schedule id for edit/run/pause/resume/delete; with action:list, shows that one schedule.' },
          jobId: { type: 'string', description: 'Alias for scheduleId.' },
          targetId: { type: 'string', description: 'Alias for scheduleId.' },
          task: { type: 'string', description: 'Autonomous task for action:create, or replacement task for action:edit.' },
          message: { type: 'string', description: 'Reminder text for action:reminder (creates a new reminder; it cannot edit one).' },
          successCriteria: { type: 'string', description: 'Required for autonomous scheduled tasks.' },
          scheduleKind: { type: 'string', enum: ['at', 'every', 'cron'], description: 'Schedule kind.' },
          kind: { type: 'string', enum: ['at', 'every', 'cron'], description: 'Alias for scheduleKind.' },
          scheduleValue: { type: 'string', description: 'ISO timestamp, interval, or cron expression.' },
          value: { type: 'string', description: 'Alias for scheduleValue.' },
          at: { type: 'string', description: 'ISO timestamp shortcut.' },
          every: { type: 'string', description: 'Interval shortcut such as 1d or 30m.' },
          cron: { type: 'string', description: 'Cron expression shortcut.' },
          timezone: { type: 'string', description: 'Optional IANA timezone.' },
          staggerMs: { type: 'number', description: 'Optional cron stagger in milliseconds for edits.' },
          name: { type: 'string', description: 'Connected schedule display name.' },
          prompt: { type: 'string', description: 'Exact replacement prompt for action:edit.' },
          provider: { type: 'string', description: 'Optional provider row id for scheduled execution.' },
          model: { type: 'string', description: 'Optional model id for scheduled execution.' },
          deliveryChannel: { type: 'string', description: 'Optional delivery channel target.' },
          deliveryRoute: { type: 'string', description: 'Optional connected route target.' },
          deliveryWebhook: { type: 'string', description: 'Optional webhook target.' },
          deliveryLink: { type: 'string', description: 'Optional link target: the result is published as a document under this name and its link shown on the web surface.' },
          disabled: { type: 'boolean', description: 'Create schedule disabled.' },
          query: { type: 'string', description: 'For action:list, show only schedules whose id or name contains this text.' },
          limit: { type: 'number', description: `For action:list, the most schedules to show (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).` },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('kept as provenance; the original admitted source stays authoritative'),
        },
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      // A webhook target is chosen in the call: one the owner has not configured or allowed is his to decide.
      subjects: { recipients: ['deliveryWebhook'] },
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      if (!registry || !assertCurrentToolInvocation(rawArgs, options)) {
        return { success: false, error: 'Schedule dispatch requires the current recorded tool admission.' };
      }
      const args: AgentScheduleToolArgs = rawArgs;
      const run = (name: string, input: Record<string, unknown>) => registry.executeNested(randomUUID(), name,
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), options);
      const chosen = readAction(args);
      if ('refusal' in chosen) return { success: false, error: chosen.refusal };
      const action = chosen.action;
      if ((action === 'create' || action === 'reminder') && readScheduleId(args)) {
        return { success: false, error: `schedule action:${action} creates a new schedule and takes no scheduleId; to change ${readScheduleId(args)} use action:edit.` };
      }
      if (action === 'list') {
        return selectListedSchedules(await run('agent_operator_method', { methodId: 'automation.schedules.list', input: {} }), args);
      }
      if (action === 'create') return run('agent_autonomy_schedule', autonomyArgs(args));
      if (action === 'reminder') return run('agent_reminder_schedule', reminderArgs(args));
      if (action === 'edit') return run('agent_schedule_edit', editArgs(args));

      const scheduleId = readScheduleId(args);
      if (!scheduleId) {
        return {
          success: false,
          error: `scheduleId is required for schedule action:${action}.`,
        };
      }
      return run('agent_operator_action', {
        action: LIFECYCLE_ACTIONS[action],
        scheduleId,
      });
    },
  };
}

export function registerAgentScheduleTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  if (!registry.has('schedule')) registry.register(createAgentScheduleTool(shellPaths, configManager, registry));
}
