import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import {
  formatEveryInterval,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationScheduleDefinition,
} from '@goodvibes-jev/engine/platform/platform/automation';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  buildAutonomySchedulePrompt,
} from './autonomy-schedule.ts';
import { createConnectedHost, isHostFailure } from './connected-host-client.ts';
import { findOperatorHttpBinding } from './operator-contract-routes.ts';
import {
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type AgentConnectedHostConnection,
  type RoutineScheduleKind,
  type RoutineScheduleSpec,
} from './routine-schedule-promotion.ts';
import { readOptionValue as optionValue } from './schedule-delivery-targets.ts';

type SchedulePatchInput = OperatorMethodInput<'automation.jobs.update'>;
type SchedulePatchOutput = OperatorMethodOutput<'automation.jobs.update'>;
type ScheduleListOutput = OperatorMethodOutput<'automation.schedules.list'>;

export const SCHEDULE_EDIT_METHOD = 'automation.jobs.update';
/** The contract's binding for the edit, `PATCH /api/automation/jobs/{jobId}`. */
export const SCHEDULE_EDIT_ROUTE: string = (() => {
  const binding = findOperatorHttpBinding(SCHEDULE_EDIT_METHOD);
  return binding ? `${binding.httpMethod} ${binding.pathTemplate}` : SCHEDULE_EDIT_METHOD;
})();

export interface ParsedScheduleEditArgs {
  readonly scheduleId: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly name?: string;
  readonly prompt?: string;
  readonly task?: string;
  readonly successCriteria?: string;
  readonly timezone?: string;
  readonly staggerMs?: number;
  /** The schedule revision the person confirmed, from the preview's confirm line. */
  readonly revision?: string;
  readonly yes: boolean;
  /** Who asked for a rebuilt autonomous prompt; written into that prompt, never authority. */
  readonly requestProvenance: string | null;
  readonly errors: readonly string[];
}

export interface ParseScheduleEditOptions {
  readonly defaultRequestProvenance?: string;
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
  readonly revision?: string;
  readonly current?: ScheduleEditCurrentSchedule;
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
  readonly status?: string;
  readonly diffs: readonly ScheduleEditFieldDiff[];
  readonly note?: string;
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
  readonly baseUrl?: string;
}

export type ScheduleEditResult = ScheduleEditSuccess | ScheduleEditFailure;

function parseOptionalNumber(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return `${flag} must be a finite number greater than or equal to 0.`;
  return value;
}

function scheduleDefinition(schedule: RoutineScheduleSpec, timezone?: string, staggerMs?: number): AutomationScheduleDefinition {
  if (schedule.kind === 'cron') return normalizeCronSchedule(schedule.value, timezone, staggerMs);
  if (timezone) throw new Error('--timezone is only valid with --cron.');
  if (staggerMs !== undefined) throw new Error('--stagger-ms is only valid with --cron.');
  if (schedule.kind === 'every') return normalizeEverySchedule(schedule.value);
  const at = Date.parse(schedule.value);
  if (!Number.isFinite(at)) throw new Error(`Invalid --at timestamp: ${schedule.value}`);
  return normalizeAtSchedule(at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function scheduleValue(schedule: unknown): string {
  if (!isRecord(schedule)) return 'unknown';
  if (schedule.kind === 'cron') {
    return [
      readString(schedule, 'expression') ?? '',
      readString(schedule, 'timezone') ? `[${readString(schedule, 'timezone')}]` : '',
      typeof schedule.staggerMs === 'number' ? `[stagger ${schedule.staggerMs}ms]` : '',
    ].filter(Boolean).join(' ') || 'cron';
  }
  if (schedule.kind === 'every' && typeof schedule.intervalMs === 'number') return formatEveryInterval(schedule.intervalMs);
  if (schedule.kind === 'at' && typeof schedule.at === 'number') return new Date(schedule.at).toISOString();
  return String(schedule.kind ?? 'unknown');
}

function promptState(job: Record<string, unknown>): string {
  const execution = isRecord(job.execution) ? job.execution : {};
  const prompt = readString(execution, 'prompt') ?? readString(job, 'prompt');
  return prompt?.trim() ? 'existing prompt present' : 'no existing prompt';
}

function readScheduleJob(output: ScheduleListOutput, scheduleId: string): Record<string, unknown> | null {
  const record: Record<string, unknown> = isRecord(output as unknown) ? output as Record<string, unknown> : {};
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  for (const job of jobs) {
    if (!isRecord(job)) continue;
    if (readString(job, 'id') === scheduleId) return job;
  }
  return null;
}

function diffChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

function buildCurrentScheduleContext(
  preview: ScheduleEditPreview,
  output: ScheduleListOutput,
): ScheduleEditCurrentSchedule {
  const job = readScheduleJob(output, preview.scheduleId);
  if (!job) {
    return {
      method: ROUTINE_SCHEDULE_LIST_METHOD,
      route: ROUTINE_SCHEDULE_ROUTE,
      scheduleId: preview.scheduleId,
      found: false,
      diffs: [],
      note: 'No current schedule record matched this id; review the requested patch before confirming.',
    };
  }

  const diffs: ScheduleEditFieldDiff[] = [];
  if (preview.payload.name) {
    const before = readString(job, 'name') ?? 'unknown';
    const after = preview.payload.name;
    diffs.push({ field: 'name', before, after, changed: diffChanged(before, after) });
  }
  if (preview.payload.schedule) {
    const before = scheduleValue(job.schedule);
    const after = scheduleValue(preview.payload.schedule);
    diffs.push({ field: 'schedule', before, after, changed: diffChanged(before, after) });
  }
  if (preview.payload.prompt) {
    diffs.push({
      field: 'prompt',
      before: promptState(job),
      after: 'replacement prompt prepared',
      changed: true,
    });
  }

  return {
    method: ROUTINE_SCHEDULE_LIST_METHOD,
    route: ROUTINE_SCHEDULE_ROUTE,
    scheduleId: preview.scheduleId,
    found: true,
    status: readString(job, 'status') ?? undefined,
    diffs,
  };
}

function pushRequiredPairErrors(parsed: {
  readonly prompt?: string;
  readonly task?: string;
  readonly successCriteria?: string;
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

function connectedHostFor(connection: AgentConnectedHostConnection) {
  return createConnectedHost(() => ({ baseUrl: connection.baseUrl, token: connection.token, credential: connection.tokenPath }));
}

/**
 * Add the schedule as it is now and the revision the edit will be bound to.
 * The list read is the one request a preview makes; its row carries the
 * revision, so confirming costs no further read.
 */
export async function enrichScheduleEditPreviewFromConnectedHost(
  connection: AgentConnectedHostConnection,
  preview: ScheduleEditPreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ScheduleEditPreview> {
  if (!connection.token) return preview;
  try {
    const output = await connectedHostFor(connection).invoke(ROUTINE_SCHEDULE_LIST_METHOD, {}, { signal: options.signal });
    const job = readScheduleJob(output, preview.scheduleId);
    const revision = job ? readString(job, 'mutationRevision') : null;
    // Bound to what the preview read now; a revision an earlier confirm line carried is not kept.
    return {
      scheduleId: preview.scheduleId,
      route: preview.route,
      method: preview.method,
      requestProvenance: preview.requestProvenance,
      changes: preview.changes,
      payload: preview.payload,
      commandArgs: preview.commandArgs,
      ...(revision ? { revision } : {}),
      current: buildCurrentScheduleContext(preview, output),
    };
  } catch (error) {
    return {
      ...preview,
      current: {
        method: ROUTINE_SCHEDULE_LIST_METHOD,
        route: ROUTINE_SCHEDULE_ROUTE,
        scheduleId: preview.scheduleId,
        found: false,
        diffs: [],
        note: `Could not read current schedule state: ${summarizeError(error)}`,
      },
    };
  }
}

/**
 * Apply the edit. With a revision (the preview's confirm line carries one) the
 * host applies it only to the schedule the person saw; a schedule changed in
 * between (another device, the web UI, an agent) is refused, not overwritten.
 */
export async function editConnectedSchedule(
  connection: AgentConnectedHostConnection,
  preview: ScheduleEditPreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ScheduleEditResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      route: SCHEDULE_EDIT_ROUTE,
      baseUrl: connection.baseUrl,
    };
  }
  const request: SchedulePatchInput = preview.revision
    ? { ...preview.payload, expectedMutationRevision: preview.revision }
    : preview.payload;
  try {
    const schedule = await connectedHostFor(connection).invoke(SCHEDULE_EDIT_METHOD, request, { signal: options.signal, explicitUserRequest: true });
    return {
      ok: true,
      kind: SCHEDULE_EDIT_METHOD,
      route: SCHEDULE_EDIT_ROUTE,
      scheduleId: preview.scheduleId,
      schedule,
      request,
    };
  } catch (error) {
    if (isHostFailure(error) && error.refusal.status === 409 && preview.revision) {
      return {
        ok: false,
        kind: 'stale',
        error: `Schedule ${preview.scheduleId} changed on the connected host since the preview (revision ${preview.revision}), so nothing was changed. Run the edit again without --yes to see the schedule as it is now, then confirm that preview.`,
        route: SCHEDULE_EDIT_ROUTE,
        baseUrl: connection.baseUrl,
      };
    }
    if (isHostFailure(error)) {
      return { ok: false, kind: error.kind === 'cancelled' ? 'connected_host_error' : error.kind, error: error.message, route: SCHEDULE_EDIT_ROUTE, baseUrl: connection.baseUrl };
    }
    return { ok: false, kind: 'connected_host_error', error: `${SCHEDULE_EDIT_METHOD} on the connected host failed: ${summarizeError(error)}`, route: SCHEDULE_EDIT_ROUTE, baseUrl: connection.baseUrl };
  }
}

export function scheduleEditKindFromValue(value: unknown): RoutineScheduleKind | null {
  return value === 'at' || value === 'every' || value === 'cron' ? value : null;
}
