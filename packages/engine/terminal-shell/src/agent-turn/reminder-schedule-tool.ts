import { captureScheduleEffect, createScheduleInputProjector, formatExistingScheduleResult, formatScheduleOperatorResult } from './schedule-effect.js';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { buildReminderSchedulePreview, parseReminderScheduleArgs } from './reminder-schedule.js';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import type { AgentInProcessHost } from './in-process-host.js';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { writePersonalOpsEffectReceipt, type PersonalOpsEffectReceiptStatus } from './personal-ops-effect-receipt.js';
import { readFlag, readString } from './tool-args.js';

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
  readonly deliveryLink?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

const SCHEDULE_KINDS: readonly ReminderScheduleKind[] = ['at', 'every', 'cron'];

function isScheduleKind(value: unknown): value is ReminderScheduleKind {
  return typeof value === 'string' && SCHEDULE_KINDS.includes(value as ReminderScheduleKind);
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
  addOptionalArg(args, '--delivery-link', rawArgs.deliveryLink);
  if (readFlag(rawArgs.disabled, 'disabled', false)) args.push('--disabled');

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
            description: 'Optional IANA timezone for cron schedules only. Without one the reminder is kept in daemon.timezone (where the owner is), or the daemon host\'s zone when that is unset; give one only when the owner names a different zone.',
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
          explicitUserRequest: requestParameter('recorded in the schedule prompt'),
        },
        required: ['message', 'scheduleKind', 'scheduleValue'],
        additionalProperties: false,
      },
      // This call only routes the reminder to the daemon's `automation.schedules.create`, a nested method call judged by
      // that method's own declarations (its question "Add a schedule …?" is the one asked), and writes the act's receipt
      // as its record (record-of-decided-call.ts). Classed a read: one act, one question.
      sideEffects: ['state'],
      category: 'read',
      // A webhook target is chosen in the call: one the owner has not configured or allowed is his to decide.
      subjects: { recipients: ['deliveryWebhook'] },
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
        // A retry after a lost answer finds the reminder the first attempt made instead of adding a second.
        const existing = await effect.findExisting(payload);
        const when = `${String(rawArgs.scheduleKind ?? '')} ${String(rawArgs.scheduleValue ?? '')}`.trim();
        if (existing) {
          await recordEffect('succeeded', `Reminder already scheduled (${when}); nothing new was created.`, existing.id);
          return formatExistingScheduleResult(existing.id, 'GoodVibes schedule for Agent reminder');
        }
        const result = await effect.invoke('automation.schedules.create', payload);
        const written = result.success
          ? await recordEffect('succeeded', `Reminder scheduled (${when}).`, createdScheduleId(result.output))
          : await recordEffect('failed', result.error ?? 'The connected host refused the reminder schedule.');
        const formatted = formatScheduleOperatorResult(result, 'Created GoodVibes schedule for Agent reminder');
        // A record a rule or plan mode refused: said after the act, which ran.
        return written.notSaved && formatted.success && typeof formatted.output === 'string'
          ? { ...formatted, output: `${formatted.output}\n${written.notSaved}.` } : formatted;
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
