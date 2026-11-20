import { captureScheduleEffect, createScheduleInputProjector, formatScheduleOperatorResult } from './schedule-effect.js';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { buildScheduleEditPreview, parseScheduleEditArgs, scheduleEditKindFromValue } from './schedule-edit.js';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { readString } from './tool-args.js';

export interface AgentScheduleEditToolArgs {
  readonly scheduleId?: unknown;
  readonly jobId?: unknown;
  readonly scheduleKind?: unknown;
  readonly scheduleValue?: unknown;
  readonly timezone?: unknown;
  readonly staggerMs?: unknown;
  readonly name?: unknown;
  readonly prompt?: unknown;
  readonly task?: unknown;
  readonly successCriteria?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value);
  return text ? text : null;
}

function addOptionalArg(args: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (!text) return;
  // The inline form keeps free text that begins with dashes from being read as the next option.
  args.push(`${flag}=${text}`);
}

function addOptionalNumber(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'number') {
    args.push(`${flag}=${value}`);
    return;
  }
  addOptionalArg(args, flag, value);
}

function buildScheduleEditArgs(rawArgs: AgentScheduleEditToolArgs): readonly string[] {
  const scheduleId = readOptionalString(rawArgs.scheduleId) ?? readOptionalString(rawArgs.jobId);
  if (!scheduleId) throw new Error('scheduleId is required.');

  const args = [`--schedule-id=${scheduleId}`];
  const scheduleKind = scheduleEditKindFromValue(rawArgs.scheduleKind);
  const scheduleValue = readOptionalString(rawArgs.scheduleValue);
  if (scheduleKind && !scheduleValue) throw new Error('scheduleValue is required when scheduleKind is set.');
  if (!scheduleKind && scheduleValue) throw new Error('scheduleKind is required when scheduleValue is set.');
  if (scheduleKind && scheduleValue) args.push(`--${scheduleKind}=${scheduleValue}`);

  addOptionalArg(args, '--timezone', rawArgs.timezone);
  addOptionalNumber(args, '--stagger-ms', rawArgs.staggerMs);
  addOptionalArg(args, '--name', rawArgs.name);
  addOptionalArg(args, '--prompt', rawArgs.prompt);
  addOptionalArg(args, '--task', rawArgs.task);
  addOptionalArg(args, '--success-criteria', rawArgs.successCriteria);
  addOptionalArg(args, '--request-provenance', rawArgs.explicitUserRequest);
  return args;
}

export function createAgentScheduleEditTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  registry: ToolRegistry,
  inProcess?: AgentInProcessHost,
): Tool {
  return {
    definition: {
      name: 'agent_schedule_edit',
      activity: { doing: 'Updating', did: 'updated', object: 'a schedule', objects: 'schedules' },
      description: 'Edit one connected GoodVibes schedule under recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'Connected schedule id to edit.',
          },
          jobId: {
            type: 'string',
            description: 'Automation job id when known instead of scheduleId.',
          },
          scheduleKind: {
            type: 'string',
            enum: ['at', 'every', 'cron'],
            description: 'Optional replacement schedule kind.',
          },
          scheduleValue: {
            type: 'string',
            description: 'Replacement ISO time, interval, or cron expression.',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone for cron replacements.',
          },
          staggerMs: {
            type: 'number',
            description: 'Optional cron stagger in milliseconds.',
          },
          name: {
            type: 'string',
            description: 'Optional replacement schedule display name.',
          },
          prompt: {
            type: 'string',
            description: 'Optional exact replacement prompt.',
          },
          task: {
            type: 'string',
            description: 'Optional replacement autonomous task.',
          },
          successCriteria: {
            type: 'string',
            description: 'Required with task; expected run outcome.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('written into the prompt rebuilt from task'),
        },
        anyOf: [{ required: ['scheduleId'] }, { required: ['jobId'] }],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      let effect: ReturnType<typeof captureScheduleEffect> | undefined;
      try {
        effect = captureScheduleEffect(rawArgs, options, shellPaths, configManager, registry, inProcess);
        const parsed = parseScheduleEditArgs(buildScheduleEditArgs(rawArgs));
        if (parsed.errors.length > 0) return { success: false, error: parsed.errors.join('\n') };
        const preview = buildScheduleEditPreview(parsed);
        const result = await effect.invoke('automation.jobs.update', preview.payload);
        return formatScheduleOperatorResult(result, 'Updated GoodVibes schedule');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only a request already handed to the transport can have been applied.
        if (effect?.sent) {
          return { success: false, error: `outcome_unknown: the schedule edit request was sent to the connected host and then failed (${message}). It may have been applied; read the schedule list before repeating it.` };
        }
        return { success: false, error: effect ? `${message} Nothing was sent to the connected host.` : message };
      }
    },
  };
}

/** `inProcess`: the daemon hosting this Agent turn, reached in process; absent in the Agent's own process. */
export function registerAgentScheduleEditTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentScheduleEditTool(shellPaths, configManager, registry, inProcess),
    { inputProjection: createScheduleInputProjector(shellPaths, configManager, inProcess) });
}
