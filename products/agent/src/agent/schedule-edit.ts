/**
 * schedule-edit.ts, a schedule edit applied on this Agent's connected host by
 * the /schedule command: the preview reads the schedule as it is now, and the
 * confirmed edit is bound to the revision that read saw. Parsing the arguments
 * and building the request is the shared Agent turn's
 * (`@goodvibes-jev/engine/terminal-shell/agent-turn`), re-exported here for
 * this file's importers.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { formatEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  createConnectedHost,
  isHostFailure,
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  SCHEDULE_EDIT_METHOD,
  SCHEDULE_EDIT_ROUTE,
  type ScheduleEditCurrentSchedule,
  type ScheduleEditFieldDiff,
  type ScheduleEditPreview,
  type ScheduleEditResult,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

export {
  SCHEDULE_EDIT_METHOD,
  SCHEDULE_EDIT_ROUTE,
  buildScheduleEditPayload,
  buildScheduleEditPreview,
  parseScheduleEditArgs,
  scheduleEditKindFromValue,
  type ParseScheduleEditOptions,
  type ParsedScheduleEditArgs,
  type ScheduleEditCurrentSchedule,
  type ScheduleEditFailure,
  type ScheduleEditFieldDiff,
  type ScheduleEditPreview,
  type ScheduleEditResult,
  type ScheduleEditSuccess,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';

type SchedulePatchInput = OperatorMethodInput<'automation.jobs.update'>;
type ScheduleListOutput = OperatorMethodOutput<'automation.schedules.list'>;

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
