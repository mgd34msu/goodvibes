import { captureScheduleEffect, createScheduleInputProjector, formatScheduleOperatorResult } from './schedule-effect.js';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { buildReminderSchedulePreview, parseReminderScheduleArgs } from './reminder-schedule.js';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import type { AgentInProcessHost } from './in-process-host.js';
import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { writePersonalOpsEffectReceipt, type PersonalOpsEffectReceiptStatus } from './personal-ops-effect-receipt.js';

function createdScheduleId(output: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(output ?? '');
    const body = parsed && typeof parsed === 'object' && 'body' in parsed ? parsed.body : undefined;
    return body && typeof body === 'object' && 'id' in body && typeof body.id === 'string' ? body.id : undefined;
  } catch { return undefined; }
}

type ReminderScheduleKind = 'at' | 'every' | 'cron';

export interface AgentReminderScheduleToolArgs {
  readonly message?: unknown;
  readonly scheduleKind?: unknown;
  readonly scheduleValue?: unknown;
  readonly timezone?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deliveryChannel?: unknown;
  readonly deliveryRoute?: unknown;
  readonly deliveryWebhook?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

const SCHEDULE_KINDS: readonly ReminderScheduleKind[] = ['at', 'every', 'cron'];

function isScheduleKind(value: unknown): value is ReminderScheduleKind {
  return typeof value === 'string' && SCHEDULE_KINDS.includes(value as ReminderScheduleKind);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value);
  return text ? text : null;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function addOptionalArg(args: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (!text) return;
  // The inline form keeps free text that begins with dashes from being read as the next option.
  args.push(`${flag}=${text}`);
}

function scheduleFlag(kind: ReminderScheduleKind): string {
  if (kind === 'cron') return '--cron';
  if (kind === 'every') return '--every';
  return '--at';
}

function buildReminderScheduleArgs(rawArgs: AgentReminderScheduleToolArgs): readonly string[] {
  const message = readOptionalString(rawArgs.message);
  const scheduleValue = readOptionalString(rawArgs.scheduleValue);
  if (!message) throw new Error('message is required.');
  if (!isScheduleKind(rawArgs.scheduleKind)) throw new Error('scheduleKind must be one of: at, every, cron.');
  if (!scheduleValue) throw new Error('scheduleValue is required.');

  const args = [
    `${scheduleFlag(rawArgs.scheduleKind)}=${scheduleValue}`,
    `--message=${message}`,
  ];
  addOptionalArg(args, '--timezone', rawArgs.timezone);
  addOptionalArg(args, '--name', rawArgs.name);
  addOptionalArg(args, '--provider', rawArgs.provider);
  addOptionalArg(args, '--model', rawArgs.model);
  addOptionalArg(args, '--delivery-channel', rawArgs.deliveryChannel);
  addOptionalArg(args, '--delivery-route', rawArgs.deliveryRoute);
  addOptionalArg(args, '--delivery-webhook', rawArgs.deliveryWebhook);
  if (readBoolean(rawArgs.disabled)) args.push('--disabled');

  return args;
}

export function createAgentReminderScheduleTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  registry: ToolRegistry,
  artifactStore?: ArtifactStore,
  inProcess?: AgentInProcessHost,
): Tool {
  /** The Personal Ops reminders lane lists one receipt per schedule request that reached the connected host. */
  const recordEffect = (status: PersonalOpsEffectReceiptStatus, summary: string, subjectId?: string) => writePersonalOpsEffectReceipt(artifactStore, {
    laneId: 'reminders', sourceTool: 'agent_reminder_schedule', operation: 'automation.schedules.create', providerId: 'connected-host', status, summary,
    ...(subjectId ? { subjectId } : {}), ...(status === 'succeeded' ? {} : { failureReason: summary }),
  });
  return {
    definition: {
      name: 'agent_reminder_schedule',
      activity: { doing: 'Setting', did: 'set', object: 'a reminder', objects: 'reminders' },
      description: 'Schedule one GoodVibes Agent reminder under recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Reminder text to deliver when the schedule fires.',
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
            description: 'Optional provider row id for reminder execution.',
          },
          model: {
            type: 'string',
            description: 'Optional model id for reminder execution.',
          },
          deliveryChannel: {
            type: 'string',
            description: 'Optional delivery channel target.',
          },
          deliveryRoute: {
            type: 'string',
            description: 'Optional connected route target: routeId:label.',
          },
          deliveryWebhook: {
            type: 'string',
            description: 'Optional http(s) webhook target.',
          },
          disabled: {
            type: 'boolean',
            description: 'Create the schedule disabled.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('recorded in the schedule prompt'),
        },
        required: ['message', 'scheduleKind', 'scheduleValue'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      let effect: ReturnType<typeof captureScheduleEffect> | undefined;
      try {
        effect = captureScheduleEffect(rawArgs, options, shellPaths, configManager, registry, inProcess);
        const parsed = parseReminderScheduleArgs(buildReminderScheduleArgs(rawArgs));
        if (parsed.errors.length > 0) return { success: false, error: parsed.errors.join('\n') };
        const preview = buildReminderSchedulePreview(parsed);
        // Recorded in the prompt as the autonomy schedule does, so the created schedule shows what the owner asked for.
        const provenance = readOptionalString(rawArgs.explicitUserRequest);
        const payload = provenance
          ? { ...preview.payload, prompt: `Request provenance:\n${provenance}\n\n${preview.payload.prompt}` }
          : preview.payload;
        const result = await effect.invoke('automation.schedules.create', payload);
        const when = `${String(rawArgs.scheduleKind ?? '')} ${String(rawArgs.scheduleValue ?? '')}`.trim();
        if (result.success) await recordEffect('succeeded', `Reminder scheduled (${when}).`, createdScheduleId(result.output));
        else await recordEffect('failed', result.error ?? 'The connected host refused the reminder schedule.');
        return formatScheduleOperatorResult(result, 'Created GoodVibes schedule for Agent reminder');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only a request already handed to the transport can have been applied.
        if (effect?.sent) {
          await recordEffect('unknown', `The reminder schedule request was sent and then failed (${message}).`);
          return { success: false, error: `outcome_unknown: the schedule request was sent to the connected host and then failed (${message}). It may have been applied; read the schedule list before repeating it.` };
        }
        return { success: false, error: effect ? `${message} Nothing was sent to the connected host.` : message };
      }
    },
  };
}

/** `inProcess`: the daemon hosting this Agent turn, reached in process; absent in the Agent's own process. */
export function registerAgentReminderScheduleTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  artifactStore?: ArtifactStore,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentReminderScheduleTool(shellPaths, configManager, registry, artifactStore, inProcess),
    { inputProjection: createScheduleInputProjector(shellPaths, configManager, inProcess) });
}
