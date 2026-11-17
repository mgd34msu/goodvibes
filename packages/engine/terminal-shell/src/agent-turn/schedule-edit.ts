/**
 * schedule-edit.ts, the arguments and the update request of one schedule
 * edit: parsed from the command's options and built into the
 * `automation.jobs.update` body. Sending it, and reading the schedule as it is
 * now for the preview, is the caller's: the `agent_schedule_edit` tool under
 * its own effect admission, or the Agent's /schedule command on its connected
 * host.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationScheduleDefinition,
} from '@goodvibes-jev/engine/platform/platform/automation';
import { buildAutonomySchedulePrompt } from './autonomy-schedule.js';
import { findOperatorHttpBinding } from './operator-contract-routes.js';
import {
  readOptionValue as optionValue,
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type RoutineScheduleKind,
  type RoutineScheduleSpec,
} from './schedule-delivery-targets.js';

type SchedulePatchInput = OperatorMethodInput<'automation.jobs.update'>;
type SchedulePatchOutput = OperatorMethodOutput<'automation.jobs.update'>;
type SchedulePatchDefinition = NonNullable<SchedulePatchInput['schedule']>;

export const SCHEDULE_EDIT_METHOD = 'automation.jobs.update';
/** The contract's binding for the edit, `PATCH /api/automation/jobs/{jobId}`. */
export const SCHEDULE_EDIT_ROUTE: string = (() => {
  const binding = findOperatorHttpBinding(SCHEDULE_EDIT_METHOD);
  return binding ? `${binding.httpMethod} ${binding.pathTemplate}` : SCHEDULE_EDIT_METHOD;
})();

export interface ParsedScheduleEditArgs {
  readonly scheduleId: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly name?: string | undefined;
  readonly prompt?: string | undefined;
  readonly task?: string | undefined;
  readonly successCriteria?: string | undefined;
  readonly timezone?: string | undefined;
  readonly staggerMs?: number | undefined;
  /** The schedule revision the person confirmed, from the preview's confirm line. */
  readonly revision?: string | undefined;
  readonly yes: boolean;
  /** Who asked for a rebuilt autonomous prompt; written into that prompt, never authority. */
  readonly requestProvenance: string | null;
  readonly errors: readonly string[];
}

export interface ParseScheduleEditOptions {
  readonly defaultRequestProvenance?: string | undefined;
}

export interface ScheduleEditPreview {
  readonly scheduleId: string;
  readonly route: string;
  readonly method: typeof SCHEDULE_EDIT_METHOD;
  readonly requestProvenance: string;
  readonly changes: readonly string[];
  readonly payload: SchedulePatchInput;
  /** The arguments that reproduce this edit, for the printed confirm command. */
  readonly commandArgs: readonly string[];
  /**
   * The schedule revision this edit applies to: the one the preview read, or
   * the one the confirm command carried. The host refuses the edit when the
   * schedule has changed since.
   */
  readonly revision?: string | undefined;
  readonly current?: ScheduleEditCurrentSchedule | undefined;
}

export interface ScheduleEditFieldDiff {
  readonly field: 'name' | 'schedule' | 'prompt';
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

export interface ScheduleEditCurrentSchedule {
  readonly method: typeof ROUTINE_SCHEDULE_LIST_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly scheduleId: string;
  readonly found: boolean;
  readonly status?: string | undefined;
  readonly diffs: readonly ScheduleEditFieldDiff[];
  readonly note?: string | undefined;
}

export interface ScheduleEditSuccess {
  readonly ok: true;
  readonly kind: typeof SCHEDULE_EDIT_METHOD;
  readonly route: string;
  readonly scheduleId: string;
  readonly schedule: SchedulePatchOutput;
  readonly request: SchedulePatchInput;
}

export interface ScheduleEditFailure {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'stale'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: string;
  readonly baseUrl?: string | undefined;
}

export type ScheduleEditResult = ScheduleEditSuccess | ScheduleEditFailure;

function parseOptionalNumber(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return `${flag} must be a finite number greater than or equal to 0.`;
  return value;
}

function scheduleDefinition(schedule: RoutineScheduleSpec, timezone?: string, staggerMs?: number): SchedulePatchDefinition {
  if (schedule.kind === 'cron') return toSchedulePatchDefinition(normalizeCronSchedule(schedule.value, timezone, staggerMs));
  if (timezone) throw new Error('--timezone is only valid with --cron.');
  if (staggerMs !== undefined) throw new Error('--stagger-ms is only valid with --cron.');
  if (schedule.kind === 'every') return toSchedulePatchDefinition(normalizeEverySchedule(schedule.value));
  const at = Date.parse(schedule.value);
  if (!Number.isFinite(at)) throw new Error(`Invalid --at timestamp: ${schedule.value}`);
  return toSchedulePatchDefinition(normalizeAtSchedule(at));
}

/** The normalized schedule as the edit request carries it: an unset optional field is left out, not sent empty. */
function toSchedulePatchDefinition(schedule: AutomationScheduleDefinition): SchedulePatchDefinition {
  if (schedule.kind === 'at') return { kind: 'at', at: schedule.at };
  if (schedule.kind === 'every') {
    return {
      kind: 'every',
      intervalMs: schedule.intervalMs,
      ...(schedule.anchorAt !== undefined ? { anchorAt: schedule.anchorAt } : {}),
    };
  }
  return {
    kind: 'cron',
    expression: schedule.expression,
    ...(schedule.timezone !== undefined ? { timezone: schedule.timezone } : {}),
    ...(schedule.staggerMs !== undefined ? { staggerMs: schedule.staggerMs } : {}),
    ...(schedule.staggerPhase !== undefined ? { staggerPhase: schedule.staggerPhase } : {}),
  };
}

function pushRequiredPairErrors(parsed: {
  readonly prompt?: string | undefined;
  readonly task?: string | undefined;
  readonly successCriteria?: string | undefined;
}, errors: string[]): void {
  const hasTaskPrompt = Boolean(parsed.task || parsed.successCriteria);
  if (parsed.prompt && hasTaskPrompt) {
    errors.push('Use either --prompt or --task with --success-criteria, not both.');
  }
  if (hasTaskPrompt && (!parsed.task || !parsed.successCriteria)) {
    errors.push('Use --task and --success-criteria together when rebuilding an autonomous schedule prompt.');
  }
}

export function parseScheduleEditArgs(
  args: readonly string[],
  options: ParseScheduleEditOptions = {},
): ParsedScheduleEditArgs {
  let scheduleId: string | null = null;
  let schedule: RoutineScheduleSpec | null = null;
  let name: string | undefined;
  let prompt: string | undefined;
  let task: string | undefined;
  let successCriteria: string | undefined;
  let timezone: string | undefined;
  let staggerMs: number | undefined;
  let revision: string | undefined;
  let yes = false;
  let requestProvenance: string | null = options.defaultRequestProvenance ?? null;
  const errors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? '';
    const equals = raw.indexOf('=');
    const optionName = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;

    if (raw === '--yes') {
      yes = true;
      continue;
    }
    if (
      optionName === '--schedule-id'
      || optionName === '--job-id'
      || optionName === '--name'
      || optionName === '--prompt'
      || optionName === '--task'
      || optionName === '--success-criteria'
      || optionName === '--timezone'
      || optionName === '--revision'
      || optionName === '--request-provenance'
    ) {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      if (optionName === '--schedule-id' || optionName === '--job-id') scheduleId = value;
      if (optionName === '--name') name = value;
      if (optionName === '--prompt') prompt = value;
      if (optionName === '--task') task = value;
      if (optionName === '--success-criteria') successCriteria = value;
      if (optionName === '--timezone') timezone = value;
      if (optionName === '--revision') revision = value;
      if (optionName === '--request-provenance') requestProvenance = value;
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
    if (optionName === '--stagger-ms') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push('--stagger-ms requires a value.');
        continue;
      }
      const parsed = parseOptionalNumber(value, '--stagger-ms');
      if (typeof parsed === 'string') errors.push(parsed);
      else staggerMs = parsed;
      continue;
    }
    if (raw.startsWith('--')) {
      errors.push(`Unknown option ${raw}`);
      continue;
    }
    if (!scheduleId) {
      scheduleId = raw;
      continue;
    }
    errors.push(`Unexpected argument: ${raw}`);
  }

  if (!scheduleId) errors.push('Schedule id is required.');
  pushRequiredPairErrors({ prompt, task, successCriteria }, errors);
  if (!schedule && !name && !prompt && !task && !successCriteria) {
    errors.push('At least one edit is required: --cron, --every, --at, --name, --prompt, or --task with --success-criteria.');
  }
  if (!schedule && (timezone || staggerMs !== undefined)) {
    errors.push('--timezone and --stagger-ms require a schedule selector.');
  }
  if (schedule && schedule.kind !== 'cron' && (timezone || staggerMs !== undefined)) {
    errors.push('--timezone and --stagger-ms are only valid with --cron.');
  }
  return { scheduleId, schedule, name, prompt, task, successCriteria, timezone, staggerMs, ...(revision ? { revision } : {}), yes, requestProvenance, errors };
}

function schedulePatchPrompt(parsed: ParsedScheduleEditArgs): string | undefined {
  if (parsed.prompt) return parsed.prompt;
  if (!parsed.task || !parsed.successCriteria) return undefined;
  return buildAutonomySchedulePrompt({
    task: parsed.task,
    successCriteria: parsed.successCriteria,
    explicitUserRequest: parsed.requestProvenance,
  });
}

function changeList(parsed: ParsedScheduleEditArgs): readonly string[] {
  return [
    parsed.name ? 'name' : '',
    parsed.schedule ? 'schedule' : '',
    parsed.prompt ? 'prompt' : '',
    parsed.task ? 'autonomous-task-prompt' : '',
  ].filter((value): value is string => value.length > 0);
}

export function buildScheduleEditPayload(parsed: ParsedScheduleEditArgs): SchedulePatchInput {
  if (!parsed.scheduleId) throw new Error('Schedule id is required.');
  const payload: SchedulePatchInput = { jobId: parsed.scheduleId };
  if (parsed.name) payload.name = parsed.name;
  const prompt = schedulePatchPrompt(parsed);
  if (prompt) payload.prompt = prompt;
  if (parsed.schedule) payload.schedule = scheduleDefinition(parsed.schedule, parsed.timezone, parsed.staggerMs);
  return payload;
}

/** The edit's own arguments, without `--yes` or `--revision`, in the order the parser reads them. */
function commandArgs(parsed: ParsedScheduleEditArgs): readonly string[] {
  const args: string[] = [parsed.scheduleId ?? ''];
  if (parsed.schedule) args.push(`--${parsed.schedule.kind}`, parsed.schedule.value);
  if (parsed.timezone) args.push('--timezone', parsed.timezone);
  if (parsed.staggerMs !== undefined) args.push('--stagger-ms', String(parsed.staggerMs));
  if (parsed.name) args.push('--name', parsed.name);
  if (parsed.prompt) args.push('--prompt', parsed.prompt);
  if (parsed.task) args.push('--task', parsed.task);
  if (parsed.successCriteria) args.push('--success-criteria', parsed.successCriteria);
  return args;
}

export function buildScheduleEditPreview(parsed: ParsedScheduleEditArgs): ScheduleEditPreview {
  if (!parsed.scheduleId) throw new Error('Schedule id is required.');
  return {
    scheduleId: parsed.scheduleId,
    route: SCHEDULE_EDIT_ROUTE,
    method: SCHEDULE_EDIT_METHOD,
    requestProvenance: parsed.requestProvenance ?? '',
    changes: changeList(parsed),
    payload: buildScheduleEditPayload(parsed),
    commandArgs: commandArgs(parsed),
    ...(parsed.revision ? { revision: parsed.revision } : {}),
  };
}

export function scheduleEditKindFromValue(value: unknown): RoutineScheduleKind | null {
  return value === 'at' || value === 'every' || value === 'cron' ? value : null;
}
