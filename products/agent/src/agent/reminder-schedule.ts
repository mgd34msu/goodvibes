import { parseEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import {
  classifyConnectedHostScheduleError,
  resolveAgentConnectedHostConnection,
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type AgentConnectedHostConfigReader,
  type AgentConnectedHostConnection,
  type RoutineScheduleKind,
  type RoutineScheduleSpec,
} from './routine-schedule-promotion.ts';
import {
  deliveryModeFromTargets,
  normalizeProviderModel,
  parseChannelDeliveryTarget,
  parseLinkDeliveryTarget,
  parseRouteDeliveryTarget,
  parseWebhookDeliveryTarget,
  readOptionValue as optionValue,
  toDeliveryTargetInput,
  validateDeliveryTargets,
  type RoutineScheduleDeliveryTargetSpec,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

export const REMINDER_SCHEDULE_METHOD = ROUTINE_SCHEDULE_METHOD;
export const REMINDER_SCHEDULE_ROUTE = ROUTINE_SCHEDULE_ROUTE;

export interface ParsedReminderScheduleArgs {
  readonly message: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly deliveryTargets: readonly RoutineScheduleDeliveryTargetSpec[];
  readonly name?: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

export interface ReminderSchedulePreview {
  readonly message: string;
  readonly route: typeof REMINDER_SCHEDULE_ROUTE;
  readonly method: typeof REMINDER_SCHEDULE_METHOD;
  readonly payload: ScheduleCreateInput;
}

export interface ReminderScheduleSuccess {
  readonly ok: true;
  readonly kind: typeof REMINDER_SCHEDULE_METHOD;
  readonly route: typeof REMINDER_SCHEDULE_ROUTE;
  readonly message: string;
  readonly schedule: ScheduleCreateOutput;
  readonly request: ScheduleCreateInput;
  /**
   * True when the host already held this exact schedule (same name, kind and
   * time), so nothing was created. A retry after a dropped connection lands
   * here instead of adding a second reminder.
   */
  readonly alreadyExisted?: true;
}

export interface ReminderScheduleFailure {
  readonly ok: false;
  readonly kind:
    | 'confirmation_required'
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof REMINDER_SCHEDULE_ROUTE;
  readonly baseUrl?: string;
}

export type ReminderScheduleResult = ReminderScheduleSuccess | ReminderScheduleFailure;

export function parseReminderScheduleArgs(args: readonly string[]): ParsedReminderScheduleArgs {
  let message: string | null = null;
  let schedule: RoutineScheduleSpec | null = null;
  const deliveryTargets: RoutineScheduleDeliveryTargetSpec[] = [];
  let name: string | undefined;
  let timezone: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let enabled = true;
  let yes = false;
  const errors: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? '';
    const equals = raw.indexOf('=');
    const optionName = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;

    if (raw === '--yes') {
      yes = true;
      continue;
    }
    if (raw === '--disabled') {
      enabled = false;
      continue;
    }
    if (
      optionName === '--message'
      || optionName === '--name'
      || optionName === '--timezone'
      || optionName === '--provider'
      || optionName === '--model'
    ) {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      if (optionName === '--message') message = value;
      if (optionName === '--name') name = value;
      if (optionName === '--timezone') timezone = value;
      if (optionName === '--provider') provider = value;
      if (optionName === '--model') model = value;
      continue;
    }
    if (optionName === '--cron' || optionName === '--every' || optionName === '--at') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      if (schedule) {
        errors.push('Choose exactly one schedule selector: --cron, --every, or --at.');
        continue;
      }
      schedule = {
        kind: optionName === '--cron' ? 'cron' : optionName === '--every' ? 'every' : 'at',
        value,
      };
      continue;
    }
    if (optionName === '--delivery-channel' || optionName === '--deliver-channel') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseChannelDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-route' || optionName === '--deliver-route') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseRouteDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-webhook' || optionName === '--deliver-webhook') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseWebhookDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-link' || optionName === '--deliver-link') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseLinkDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (raw.startsWith('--')) {
      errors.push(`Unknown option ${raw}`);
      continue;
    }
    positional.push(raw);
  }

  if (!message && positional.length > 0) message = positional.join(' ').trim();
  if (!message) errors.push('Reminder message is required: use --message <text> or trailing text.');
  if (!schedule) errors.push('Schedule is required: use --cron <expr>, --every <interval>, or --at <iso-time>.');
  if (timezone && schedule && schedule.kind !== 'cron') {
    errors.push(`--timezone only applies to --cron schedules; a --${schedule.kind} schedule would ignore it. Remove --timezone or use --cron.`);
  }
  const deliveryError = validateDeliveryTargets(deliveryTargets, 'reminder command');
  if (deliveryError) errors.push(deliveryError);
  return { message, schedule, deliveryTargets, name, timezone, provider, model, enabled, yes, errors };
}

export function buildReminderSchedulePrompt(message: string): string {
  return [
    'GoodVibes Agent scheduled reminder.',
    '',
    'Reminder:',
    message,
    '',
    'Operator policy:',
    '- Treat this as a reminder delivery, not an autonomous hidden workflow.',
    '- Use isolated Agent Knowledge routes only when lookup is needed; never use default knowledge or non-Agent knowledge spaces as fallback.',
    '- Perform each effect only under current recorded effect admission and its unchanged source and target constraints.',
    '- Do not request GoodVibes TUI delegation from a reminder. If build/fix/review work is needed, ask the user to delegate it explicitly to GoodVibes TUI.',
    '- Keep the reminder concise and state any next action the user can take.',
  ].join('\n');
}

export function buildReminderSchedulePayload(parsed: ParsedReminderScheduleArgs): ScheduleCreateInput {
  if (!parsed.message) throw new Error('Reminder message is required.');
  if (!parsed.schedule) throw new Error('Schedule is required.');
  const modelRoute = normalizeProviderModel(parsed.provider, parsed.model);
  const payload: ScheduleCreateInput = {
    name: parsed.name ?? `Agent reminder: ${parsed.message.slice(0, 48)}`,
    prompt: buildReminderSchedulePrompt(parsed.message),
    kind: parsed.schedule.kind,
    enabled: parsed.enabled,
    target: {
      kind: 'main',
      surfaceKind: 'service',
      preserveThread: true,
      createIfMissing: true,
    },
    delivery: {
      mode: deliveryModeFromTargets(parsed.deliveryTargets),
      targets: parsed.deliveryTargets.map(toDeliveryTargetInput),
      fallbackTargets: [],
      includeSummary: true,
      includeTranscript: false,
      includeLinks: true,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 3_600_000,
      retryPolicy: {
        maxAttempts: 2,
        delayMs: 60_000,
        strategy: 'exponential',
        maxDelayMs: 900_000,
        jitterMs: 30_000,
      },
      disableAfterFailures: false,
    },
    lightContext: true,
    autoApprove: false,
    allowUnsafeExternalContent: false,
    ...modelRoute,
  };
  if (parsed.schedule.kind === 'cron') {
    return {
      ...payload,
      cron: parsed.schedule.value,
      timezone: parsed.timezone,
    };
  }
  if (parsed.schedule.kind === 'every') {
    return { ...payload, every: parsed.schedule.value };
  }
  return { ...payload, at: parsed.schedule.value };
}

export function buildReminderSchedulePreview(parsed: ParsedReminderScheduleArgs): ReminderSchedulePreview {
  if (!parsed.message) throw new Error('Reminder message is required.');
  return {
    message: parsed.message,
    route: REMINDER_SCHEDULE_ROUTE,
    method: REMINDER_SCHEDULE_METHOD,
    payload: buildReminderSchedulePayload(parsed),
  };
}

const INCOMPATIBLE_MESSAGE =
  'Connected GoodVibes host compatibility does not satisfy Agent schedule requirements; automation.schedules.create is unavailable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The host's schedule with the same name, kind and time as `payload`, or null.
 * Cron expressions, one-shot times and intervals (compared in milliseconds, as
 * the host stores them) are matched; the create payload carries no idempotency
 * key, so this lookup is what keeps a retry from adding a second reminder.
 * A host that cannot list schedules simply yields no match.
 */
async function findExistingSchedule(
  platformClient: ReturnType<typeof createBrowserGoodVibesPlatform>,
  payload: ScheduleCreateInput,
): Promise<ScheduleCreateOutput | null> {
  let intervalMs: number | undefined;
  if (payload.kind === 'every') {
    try {
      intervalMs = parseEveryInterval(String(payload.every));
    } catch {
      return null;
    }
  } else if (payload.kind !== 'cron' && payload.kind !== 'at') {
    return null;
  }
  let listed: unknown;
  try {
    listed = await platformClient.operator.invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
  } catch {
    return null;
  }
  const jobs: readonly unknown[] = isRecord(listed) && Array.isArray(listed['jobs']) ? listed['jobs'] : [];
  for (const job of jobs) {
    if (!isRecord(job) || job['name'] !== payload.name) continue;
    const schedule = job['schedule'];
    if (!isRecord(schedule) || schedule['kind'] !== payload.kind) continue;
    if (payload.kind === 'cron') {
      const zone = typeof schedule['timezone'] === 'string' ? schedule['timezone'] : undefined;
      // Without --timezone the host stores its own local zone, so only an explicit zone is compared.
      if (schedule['expression'] === payload.cron && (!payload.timezone || zone === payload.timezone)) return job as unknown as ScheduleCreateOutput;
    } else if (payload.kind === 'every') {
      if (schedule['intervalMs'] === intervalMs) return job as unknown as ScheduleCreateOutput;
    } else if (typeof schedule['at'] === 'number' && schedule['at'] === Date.parse(String(payload.at))) {
      return job as unknown as ScheduleCreateOutput;
    }
  }
  return null;
}

export async function createReminderSchedule(
  connection: AgentConnectedHostConnection,
  preview: ReminderSchedulePreview,
): Promise<ReminderScheduleResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      route: REMINDER_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
    };
  }
  try {
    const platformClient = createBrowserGoodVibesPlatform({ baseUrl: connection.baseUrl, authToken: connection.token });
    // A create that dropped after the host committed reads as "unavailable" and
    // invites a retry, which would add a second reminder. Look first.
    const existing = await findExistingSchedule(platformClient, preview.payload);
    if (existing) {
      return {
        ok: true,
        kind: REMINDER_SCHEDULE_METHOD,
        route: REMINDER_SCHEDULE_ROUTE,
        message: preview.message,
        schedule: existing,
        request: preview.payload,
        alreadyExisted: true,
      };
    }
    const schedule = await platformClient.operator.invoke(REMINDER_SCHEDULE_METHOD, preview.payload);
    return {
      ok: true,
      kind: REMINDER_SCHEDULE_METHOD,
      route: REMINDER_SCHEDULE_ROUTE,
      message: preview.message,
      schedule,
      request: preview.payload,
    };
  } catch (error) {
    return classifyConnectedHostScheduleError(error, connection, {
      route: REMINDER_SCHEDULE_ROUTE,
      incompatibleMessage: INCOMPATIBLE_MESSAGE,
    });
  }
}

export function resolveReminderConnectedHostConnection(configManager: AgentConnectedHostConfigReader, homeDirectory: string): AgentConnectedHostConnection {
  return resolveAgentConnectedHostConnection(configManager, homeDirectory);
}
