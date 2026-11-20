import { captureScheduleEffect, createScheduleInputProjector, formatExistingScheduleResult, formatScheduleOperatorResult } from './schedule-effect.js';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { buildAutonomySchedulePreview, parseAutonomyScheduleArgs } from './autonomy-schedule.js';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { readFlag, readString } from './tool-args.js';

type AutonomyScheduleKind = 'at' | 'every' | 'cron';

export interface AgentAutonomyScheduleToolArgs {
  readonly task?: unknown;
  readonly successCriteria?: unknown;
  readonly scheduleKind?: unknown;
  readonly scheduleValue?: unknown;
  readonly timezone?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deliveryChannel?: unknown;
  readonly deliveryRoute?: unknown;
  readonly deliveryWebhook?: unknown;
  readonly deliveryLink?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

const SCHEDULE_KINDS: readonly AutonomyScheduleKind[] = ['at', 'every', 'cron'];

function isScheduleKind(value: unknown): value is AutonomyScheduleKind {
  return typeof value === 'string' && SCHEDULE_KINDS.includes(value as AutonomyScheduleKind);
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value);
  return text ? text : null;
}

// Model-written text goes in as `--flag=value`, so a value that is itself the
// name of an option (a task that is just "--disabled") stays a value instead of
// being read as the next flag.
function addOptionalArg(args: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (!text) return;
  args.push(`${flag}=${text}`);
}

function scheduleFlag(kind: AutonomyScheduleKind): string {
  if (kind === 'cron') return '--cron';
  if (kind === 'every') return '--every';
  return '--at';
}

function buildAutonomyScheduleArgs(rawArgs: AgentAutonomyScheduleToolArgs): readonly string[] {
  const task = readOptionalString(rawArgs.task);
  const successCriteria = readOptionalString(rawArgs.successCriteria);
    const scheduleValue = readOptionalString(rawArgs.scheduleValue);
  if (!task) throw new Error('task is required.');
  if (!successCriteria) throw new Error('successCriteria is required.');
  if (!isScheduleKind(rawArgs.scheduleKind)) throw new Error('scheduleKind must be one of: at, every, cron.');
  if (!scheduleValue) throw new Error('scheduleValue is required.');

  const args = [
    `${scheduleFlag(rawArgs.scheduleKind)}=${scheduleValue}`,
    `--task=${task}`,
    `--success-criteria=${successCriteria}`,
  ];
  addOptionalArg(args, '--timezone', rawArgs.timezone);
  addOptionalArg(args, '--name', rawArgs.name);
  addOptionalArg(args, '--provider', rawArgs.provider);
  addOptionalArg(args, '--model', rawArgs.model);
  addOptionalArg(args, '--delivery-channel', rawArgs.deliveryChannel);
  addOptionalArg(args, '--delivery-route', rawArgs.deliveryRoute);
  addOptionalArg(args, '--delivery-webhook', rawArgs.deliveryWebhook);
  addOptionalArg(args, '--delivery-link', rawArgs.deliveryLink);
  if (readFlag(rawArgs.disabled, 'disabled', false)) args.push('--disabled');
  addOptionalArg(args, '--explicit-user-request', rawArgs.explicitUserRequest);
  return args;
}

export function createAgentAutonomyScheduleTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  registry: ToolRegistry,
  inProcess?: AgentInProcessHost,
): Tool {
  return {
    definition: {
      name: 'agent_autonomy_schedule',
      activity: { doing: 'Scheduling', did: 'scheduled', object: 'background work' },
      description: 'Schedule one visible autonomous Agent task under recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Exact autonomous task the schedule should run.',
          },
          successCriteria: {
            type: 'string',
            description: 'What a successful scheduled run must report or produce.',
          },
          scheduleKind: {
            type: 'string',
            enum: [...SCHEDULE_KINDS],
            description: 'Schedule kind: at, every, or cron.',
          },
          scheduleValue: {
            type: 'string',
            description: 'ISO timestamp, interval, or cron expression matching scheduleKind.',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone for cron schedules only.',
          },
          name: {
            type: 'string',
            description: 'Optional connected schedule display name.',
          },
          provider: {
            type: 'string',
            description: 'Optional provider row id for scheduled execution.',
          },
          model: {
            type: 'string',
            description: 'Optional model id for scheduled execution.',
          },
          deliveryChannel: {
            type: 'string',
            description: 'Optional delivery channel target: "<channel>", "<channel>:<route id>" or "<channel>:<route id> | <label>".',
          },
          deliveryRoute: {
            type: 'string',
            description: 'Optional connected route target: "<route id>" or "<route id> | <label>" (the route id is taken whole, colons included).',
          },
          deliveryWebhook: {
            type: 'string',
            description: 'Optional http(s) webhook target.',
          },
          deliveryLink: {
            type: 'string',
            description: 'Optional link target: each result is published as a document on the host under this name and its link shown on the owner\'s web surface.',
          },
          disabled: {
            type: 'boolean',
            description: 'Create the schedule disabled.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['task', 'successCriteria', 'scheduleKind', 'scheduleValue'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      // A webhook target is chosen in the call: one the owner has not configured or allowed is his to decide.
      subjects: { recipients: ['deliveryWebhook'] },
    },
    execute: async (rawArgs, options) => {
      let effect: ReturnType<typeof captureScheduleEffect> | undefined;
      try {
        effect = captureScheduleEffect(rawArgs, options, shellPaths, configManager, registry, inProcess);
        const parsed = parseAutonomyScheduleArgs(buildAutonomyScheduleArgs(rawArgs), { requireExplicitUserRequest: false });
        if (parsed.errors.length > 0) return { success: false, error: parsed.errors.join('\n') };
        const preview = buildAutonomySchedulePreview(parsed);
        effect.assertCurrent();
        // A retry after a lost answer finds the schedule the first attempt made instead of adding a second.
        const existing = await effect.findExisting(preview.payload);
        if (existing) return formatExistingScheduleResult(existing.id, 'GoodVibes schedule for autonomous Agent work');
        // Once the host has answered, its answer is the outcome: no check runs after it.
        const result = await effect.invoke('automation.schedules.create', preview.payload);
        return formatScheduleOperatorResult(result, 'Created GoodVibes schedule for autonomous Agent work');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only a request already handed to the transport can have been applied.
        if (effect?.sent) {
          return { success: false, error: `outcome_unknown: the schedule request was sent to the connected host and then failed (${message}). It may have been applied; read the schedule list before repeating it.` };
        }
        return { success: false, error: effect ? `${message} Nothing was sent to the connected host.` : message };
      }
    },
  };
}

/** `inProcess`: the daemon hosting this Agent turn, reached in process; absent in the Agent's own process. */
export function registerAgentAutonomyScheduleTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentAutonomyScheduleTool(shellPaths, configManager, registry, inProcess),
    { inputProjection: createScheduleInputProjector(shellPaths, configManager, inProcess) });
}
