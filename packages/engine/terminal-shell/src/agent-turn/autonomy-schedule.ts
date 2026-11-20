/**
 * autonomy-schedule.ts, the arguments and the create request of one autonomous
 * Agent schedule: parsed from the command's options and built into the
 * `automation.schedules.create` body. Sending it is the caller's: the
 * `agent_autonomy_schedule` tool sends it under its own effect admission.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { buildAutonomySchedulePrompt } from '@goodvibes/engine/platform/platform/automation';
import {
  deliveryModeFromTargets,
  normalizeProviderModel,
  parseChannelDeliveryTarget,
  parseLinkDeliveryTarget,
  parseRouteDeliveryTarget,
  parseWebhookDeliveryTarget,
  readOptionValue as optionValue,
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  toDeliveryTargetInput,
  validateDeliveryTargets,
  type RoutineScheduleDeliveryTargetSpec,
  type RoutineScheduleSpec,
} from './schedule-delivery-targets.js';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

export const AUTONOMY_SCHEDULE_METHOD = ROUTINE_SCHEDULE_METHOD;
export const AUTONOMY_SCHEDULE_ROUTE = ROUTINE_SCHEDULE_ROUTE;

export interface ParsedAutonomyScheduleArgs {
  readonly task: string | null;
  readonly successCriteria: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly deliveryTargets: readonly RoutineScheduleDeliveryTargetSpec[];
  readonly name?: string | undefined;
  readonly timezone?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly enabled: boolean;
  readonly yes: boolean;
  readonly explicitUserRequest: string | null;
  readonly errors: readonly string[];
}

export interface AutonomySchedulePreview {
  readonly task: string;
  readonly successCriteria: string;
  readonly explicitUserRequest: string;
  readonly route: typeof AUTONOMY_SCHEDULE_ROUTE;
  readonly method: typeof AUTONOMY_SCHEDULE_METHOD;
  readonly payload: ScheduleCreateInput;
}

export interface AutonomyScheduleSuccess {
  readonly ok: true;
  readonly kind: typeof AUTONOMY_SCHEDULE_METHOD;
  readonly route: typeof AUTONOMY_SCHEDULE_ROUTE;
  readonly task: string;
  readonly successCriteria: string;
  readonly schedule: ScheduleCreateOutput;
  readonly request: ScheduleCreateInput;
  /** True when an earlier create already made this schedule (its answer was lost); nothing new was created. */
  readonly alreadyExisted?: boolean | undefined;
}

export interface AutonomyScheduleFailure {
  readonly ok: false;
  readonly kind:
    | 'confirmation_required'
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof AUTONOMY_SCHEDULE_ROUTE;
  readonly baseUrl?: string | undefined;
}

export type AutonomyScheduleResult = AutonomyScheduleSuccess | AutonomyScheduleFailure;

export function parseAutonomyScheduleArgs(args: readonly string[], options: { readonly requireExplicitUserRequest?: boolean } = {}): ParsedAutonomyScheduleArgs {
  let task: string | null = null;
  let successCriteria: string | null = null;
  let explicitUserRequest: string | null = null;
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
      optionName === '--task'
      || optionName === '--success-criteria'
      || optionName === '--explicit-user-request'
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
      if (optionName === '--task') task = value;
      if (optionName === '--success-criteria') successCriteria = value;
      if (optionName === '--explicit-user-request') explicitUserRequest = value;
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

  if (!task && positional.length > 0) task = positional.join(' ').trim();
  if (!task) errors.push('Autonomous task is required: use --task <work to perform>.');
  if (!successCriteria) errors.push('Success criteria are required: use --success-criteria <what a good run reports or produces>.');
  if (options.requireExplicitUserRequest !== false && !explicitUserRequest) errors.push('Explicit user request is required: use --explicit-user-request <authorizing request>.');
  if (!schedule) errors.push('Schedule is required: use --cron <expr>, --every <interval>, or --at <iso-time>.');
  if (timezone && schedule && schedule.kind !== 'cron') {
    errors.push(`--timezone only applies to --cron schedules; a --${schedule.kind} schedule would ignore it. Remove --timezone or use --cron.`);
  }
  const deliveryError = validateDeliveryTargets(deliveryTargets, 'autonomous schedule command');
  if (deliveryError) errors.push(deliveryError);
  return { task, successCriteria, schedule, deliveryTargets, name, timezone, provider, model, enabled, yes, explicitUserRequest, errors };
}

/** The prompt of one autonomous schedule; its one owner is the automation module, where the daemon builds it too. */
export { buildAutonomySchedulePrompt };

export function buildAutonomySchedulePayload(parsed: ParsedAutonomyScheduleArgs): ScheduleCreateInput {
  if (!parsed.task) throw new Error('Autonomous task is required.');
  if (!parsed.successCriteria) throw new Error('Success criteria are required.');
  if (!parsed.schedule) throw new Error('Schedule is required.');
  const modelRoute = normalizeProviderModel(parsed.provider, parsed.model);
  const payload: ScheduleCreateInput = {
    name: parsed.name ?? `Agent automation: ${parsed.task.slice(0, 48)}`,
    prompt: buildAutonomySchedulePrompt({
      task: parsed.task,
      successCriteria: parsed.successCriteria,
      explicitUserRequest: parsed.explicitUserRequest,
    }),
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
    allowUnsafeExternalContent: false,
    ...modelRoute,
  };
  if (parsed.schedule.kind === 'cron') {
    return {
      ...payload,
      cron: parsed.schedule.value,
      ...(parsed.timezone ? { timezone: parsed.timezone } : {}),
    };
  }
  if (parsed.schedule.kind === 'every') {
    return { ...payload, every: parsed.schedule.value };
  }
  return { ...payload, at: parsed.schedule.value };
}

export function buildAutonomySchedulePreview(parsed: ParsedAutonomyScheduleArgs): AutonomySchedulePreview {
  if (!parsed.task) throw new Error('Autonomous task is required.');
  if (!parsed.successCriteria) throw new Error('Success criteria are required.');
  return {
    task: parsed.task,
    successCriteria: parsed.successCriteria,
    explicitUserRequest: parsed.explicitUserRequest ?? '',
    route: AUTONOMY_SCHEDULE_ROUTE,
    method: AUTONOMY_SCHEDULE_METHOD,
    payload: buildAutonomySchedulePayload(parsed),
  };
}
