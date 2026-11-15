import type { DaemonRuntimeAutomationRouteHandlers } from './context.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { withAdmin } from './auth-helpers.js';
import { jsonErrorResponse, readServiceErrorResponse } from './error-response.js';
import { hasPaginationParams, paginateItems } from './pagination.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readBoundedPositiveInteger,
  readOptionalStringField,
  readStringArrayField,
  type JsonRecord,
} from './route-helpers.js';

const DEFAULT_AUTOMATION_LIST_LIMIT = 100;
const MAX_AUTOMATION_LIST_LIMIT = 500;

type AutomationScheduleBody = {
  readonly prompt: string;
  readonly kind: string;
  readonly cron?: string | undefined;
  readonly every?: string | undefined;
  readonly at?: string | number | undefined;
  readonly timezone?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fallbackModels?: string[] | undefined;
};

export function createDaemonRuntimeAutomationRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeAutomationRouteHandlers {
  return {
    getAutomationJobs: (url?: URL) => handleGetAutomationJobs(context, url),
    postAutomationJob: async (request) => withAdmin(context, request, () => handlePostSchedule(context, request)),
    getAutomationRuns: (url?: URL) => handleGetAutomationRuns(context, url),
    getAutomationRun: (runId) => handleGetAutomationRun(context, runId),
    getAutomationHeartbeat: () => Response.json({ pending: context.automationManager.listHeartbeatWakes?.() ?? [] }),
    postAutomationHeartbeat: async (request) => withAdmin(context, request, () => handlePostAutomationHeartbeat(context, request)),
    automationRunAction: async (runId, action, request) => withAdmin(context, request, () => handleAutomationRunAction(context, runId, action, request)),
    patchAutomationJob: async (jobId, request) => withAdmin(context, request, () => handlePatchSchedule(context, jobId, request)),
    deleteAutomationJob: async (jobId, request) => withAdmin(context, request, () => rejectNativeFallback(request, () => handleDeleteSchedule(context, jobId))),
    setAutomationJobEnabled: async (jobId, enabled, request) => withAdmin(context, request, () => rejectNativeFallback(request, () => handleSetScheduleEnabled(context, jobId, enabled))),
    runAutomationJobNow: async (jobId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, jobId)),
    getSchedules: () => handleGetSchedules(context),
    postSchedule: (request) => withAdmin(context, request, () => handlePostSchedule(context, request)),
    deleteSchedule: async (scheduleId, request) => withAdmin(context, request, () => rejectNativeFallback(request, () => handleDeleteSchedule(context, scheduleId))),
    setScheduleEnabled: (scheduleId, enabled, request) => withAdmin(context, request, () => rejectNativeFallback(request, () => handleSetScheduleEnabled(context, scheduleId, enabled))),
    runScheduleNow: (scheduleId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, scheduleId)),
    getSchedulerCapacity: (req) => withAdmin(context, req, () => Response.json(context.automationManager.getSchedulerCapacity())),
  };
}

function nativeFallbackError(): Response {
  return jsonErrorResponse({ error: 'Autonomous automation requires the registered native handler.', code: 'NATIVE_MUTATION_AUTH_REQUIRED' }, { status: 403 });
}

async function rejectNativeFallback(request: Request, effect: () => Promise<Response>): Promise<Response> {
  request.signal.throwIfAborted();
  const body: unknown = await request.clone().json().catch(() => null);
  request.signal.throwIfAborted();
  if (body !== null && typeof body === 'object' && 'admission' in body && body.admission === 'autonomous') return nativeFallbackError();
  return await effect();
}


function handleGetSchedules(context: DaemonRuntimeRouteContext): Response {
  const jobs = context.automationManager.listJobs();
  const runs = context.automationManager.listRuns().slice(0, 50);
  return Response.json({ jobs, runs });
}

const automationBodySchemas = createRouteBodySchemaRegistry({
  schedule: createRouteBodySchema<AutomationScheduleBody>('POST /api/automation/schedules', (body) => {
    const prompt = readOptionalStringField(body, 'prompt');
    if (!prompt) return jsonErrorResponse({ error: 'Missing required field: prompt (string)' }, { status: 400 });
    if (prompt.length > 10_000) {
      return jsonErrorResponse({ error: 'prompt exceeds maximum length of 10000 characters' }, { status: 400 });
    }
    const scheduleObj = body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
      ? body.schedule as JsonRecord
      : null;
    const timeoutMs = readScheduleTimeoutMs(body.timeoutMs);
    if (timeoutMs instanceof Response) return timeoutMs;
    const cron = readOptionalStringField(body, 'cron') ?? readOptionalStringField(scheduleObj ?? {}, 'expression');
    const every = readOptionalStringField(body, 'every');
    const timezone = readOptionalStringField(body, 'timezone');
    const fallbackModels = readStringArrayField(body, 'fallbackModels');
    return {
      prompt,
      kind: readOptionalStringField(body, 'kind') ?? 'cron',
      ...(cron ? { cron } : {}),
      ...(every ? { every } : {}),
      ...(typeof body.at === 'string' || typeof body.at === 'number' ? { at: body.at } : {}),
      ...(timezone ? { timezone } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(fallbackModels ? { fallbackModels } : {}),
    };
  }),
});

function readScheduleTimeoutMs(value: unknown): number | Response | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return jsonErrorResponse({ error: 'timeoutMs must be a finite positive number' }, { status: 400 });
  }
  return readBoundedBodyInteger(value, 1, 86_400_000);
}

async function handlePostSchedule(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (body.admission === 'autonomous') return nativeFallbackError();
  const input = automationBodySchemas.schedule.parse(body);
  if (input instanceof Response) return input;
  try {
    const schedule = input.kind === 'every'
      ? context.normalizeEverySchedule(input.every ?? '')
      : input.kind === 'at'
        ? context.normalizeAtSchedule(readAtSchedule(input.at))
        : context.normalizeCronSchedule(input.cron ?? '', input.timezone, body.staggerMs ?? body.stagger);
    const job = await context.automationManager.createJob({
      name: typeof body.name === 'string' ? body.name : input.prompt.slice(0, 40),
      prompt: input.prompt,
      schedule,
      description: input.prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      ...(input.fallbackModels ? { fallbackModels: input.fallbackModels } : {}),
      template: typeof body.template === 'string' ? body.template : undefined,
      target: typeof body.target === 'object' && body.target !== null ? body.target as Record<string, unknown> : undefined,
      reasoningEffort: body.reasoningEffort,
      thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
      wakeMode: body.wakeMode,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist.filter((value: unknown): value is string => typeof value === 'string') : undefined,
      autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : undefined,
      allowUnsafeExternalContent: typeof body.allowUnsafeExternalContent === 'boolean' ? body.allowUnsafeExternalContent : undefined,
      externalContentSource: body.externalContentSource,
      lightContext: typeof body.lightContext === 'boolean' ? body.lightContext : undefined,
      delivery: typeof body.delivery === 'object' && body.delivery !== null ? body.delivery : undefined,
      failure: typeof body.failure === 'object' && body.failure !== null ? body.failure : undefined,
      enabled: body.enabled !== false,
      deleteAfterRun: typeof body.deleteAfterRun === 'boolean' ? body.deleteAfterRun : undefined,
    });
    return Response.json(job, { status: 201 });
  } catch (e: unknown) {
    return readServiceErrorResponse(e, { fallbackStatus: 400, fallbackMessage: 'Failed to create schedule' });
  }
}

function readAtSchedule(at: string | number | undefined): number {
  const value = typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(value)) {
    throw new Error('Invalid at schedule; expected an epoch timestamp or parseable date string');
  }
  return value;
}

async function handlePatchSchedule(context: DaemonRuntimeRouteContext, id: string, req: Request): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (body.admission === 'autonomous') return nativeFallbackError();
  const invalid = validateSchedulePatch(body);
  if (invalid) return invalid;
  try {
    const updated = await context.automationManager.updateJob(job.id, body as Record<string, unknown>);
    return updated
      ? Response.json(updated)
      : jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  } catch (error) {
    return readServiceErrorResponse(error, { fallbackStatus: 400, fallbackMessage: 'Failed to update schedule' });
  }
}

const PATCH_BOOLEAN_FIELDS = ['enabled', 'autoApprove', 'allowUnsafeExternalContent', 'lightContext', 'deleteAfterRun'] as const;
const PATCH_STRING_FIELDS = ['name', 'description', 'prompt', 'template', 'model', 'provider', 'thinking'] as const;
const PATCH_OBJECT_FIELDS = ['target', 'delivery', 'failure', 'routing'] as const;
const PATCH_STRING_LIST_FIELDS = ['toolAllowlist', 'fallbackModels'] as const;

/**
 * A patch field of the wrong type must be refused, not stored: a string "false"
 * for `enabled` is truthy and would keep a job running that the caller meant to
 * pause. Absent fields leave the job untouched.
 */
function validateSchedulePatch(body: JsonRecord): Response | null {
  // null means "leave as is" to the manager (`patch.x ?? current`), so it is accepted.
  const present = (value: unknown): boolean => value !== undefined && value !== null;
  const refuse = (field: string, expected: string): Response =>
    jsonErrorResponse({ error: `${field} must be ${expected}. Nothing was changed.`, code: 'INVALID_SCHEDULE_PATCH' }, { status: 400 });
  for (const field of PATCH_BOOLEAN_FIELDS) {
    if (present(body[field]) && typeof body[field] !== 'boolean') return refuse(field, 'true or false (a JSON boolean)');
  }
  for (const field of PATCH_STRING_FIELDS) {
    if (present(body[field]) && typeof body[field] !== 'string') return refuse(field, 'a string');
  }
  for (const field of PATCH_OBJECT_FIELDS) {
    const value = body[field];
    if (present(value) && (typeof value !== 'object' || Array.isArray(value))) return refuse(field, 'an object');
  }
  for (const field of PATCH_STRING_LIST_FIELDS) {
    const value = body[field];
    if (present(value) && (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))) return refuse(field, 'an array of strings');
  }
  if (present(body.timeoutMs) && (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)) {
    return refuse('timeoutMs', 'a finite positive number');
  }
  return null;
}

async function handleDeleteSchedule(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  await context.automationManager.removeJob(job.id);
  return Response.json({ removed: true, id: job.id });
}

async function handleSetScheduleEnabled(context: DaemonRuntimeRouteContext, id: string, enabled: boolean): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  const updated = await context.automationManager.setEnabled(job.id, enabled);
  return Response.json(updated ?? { id: job.id, enabled });
}

async function handleRunScheduleNow(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  try {
    const run = await context.automationManager.runNow(job.id);
    return Response.json({ jobId: job.id, runId: run.id, agentId: run.agentId, status: run.status });
  } catch (e: unknown) {
    return readServiceErrorResponse(e, { fallbackMessage: 'Failed to run schedule' });
  }
}

async function handlePostAutomationHeartbeat(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  // Only `source` is consumed; extra fields are ignored.
  const result = await context.automationManager.triggerHeartbeat({
    source: body && typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'api',
  });
  return Response.json(result);
}

async function handleAutomationRunAction(
  context: DaemonRuntimeRouteContext,
  runId: string,
  action: 'cancel' | 'retry',
  req: Request,
): Promise<Response> {
  if (action === 'cancel') {
    const body = await context.parseOptionalJsonBody(req);
    if (body instanceof Response) return body;
    const reason = body && typeof body.reason === 'string'
      ? body.reason
      : 'operator-cancelled';
    const run = await context.automationManager.cancelRun(runId, reason);
    return run
      ? context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }))
      : context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, jsonErrorResponse({ error: 'Unknown automation run' }, { status: 404 }));
  }
  try {
    const run = await context.automationManager.retryRun(runId);
    return context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }, { status: 202 }));
  } catch (error) {
    return context.recordApiResponse(
      req,
      `/api/automation/runs/${runId}/${action}`,
      await readServiceErrorResponse(error, { fallbackStatus: 400, fallbackMessage: 'Failed to retry automation run' }),
    );
  }
}

function handleGetAutomationRun(context: DaemonRuntimeRouteContext, runId: string): Response {
  const run = context.automationManager.getRun(runId);
  if (!run) {
    return jsonErrorResponse({ error: 'Unknown automation run' }, { status: 404 });
  }
  return Response.json({ run, deliveries: [] });
}

function findAutomationJob(context: DaemonRuntimeRouteContext, id: string) {
  // exact-match only, prefix match was non-deterministic when multiple ids share a prefix.
  return context.automationManager.listJobs().find((entry) => entry.id === id);
}

/**
 * Handle GET /api/automation/jobs.
 *
 * Without pagination params (`?limit=` / `?cursor=`): returns `{ jobs: [...] }` (backward compat).
 * With pagination params: returns `PaginatedResponse<AutomationJobLike>` as `{ items, nextCursor, hasMore }`.
 *
 * ### Deletion recovery
 * `AutomationJobLike` exposes only `{ id: string }` at the platform boundary, there is
 * no stable timestamp field on jobs.  Insertion-point recovery on mid-walk deletion
 * is therefore **not available** for this endpoint; if the cursor item is deleted,
 * the request is refused with a 400 ("Cursor expired") so the client restarts the
 * listing on purpose rather than re-reading from the start.  If a timestamp is
 * added to `AutomationJobLike` in the future, thread it as `getCreatedAt` here.
 */
function handleGetAutomationJobs(context: DaemonRuntimeRouteContext, url: URL | undefined): Response {
  const jobs = context.automationManager.listJobs();
  if (!url || !hasPaginationParams(url)) {
    // While automation is enabled with zero routines, the response carries
    // the how-to-create-your-first-routine empty state so surfaces render a
    // usable starting point instead of a bare empty list.
    const emptyState = jobs.length === 0 ? context.automationEmptyState?.() ?? null : null;
    return Response.json({ jobs, ...(emptyState ? { emptyState } : {}) });
  }
  const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), DEFAULT_AUTOMATION_LIST_LIMIT, MAX_AUTOMATION_LIST_LIMIT);
  const rawCursor = url.searchParams.get('cursor');
  const result = paginateItems(jobs, limit, rawCursor, (j) => j.id, undefined, { onMissingCursor: 'error' });
  if ('error' in result) {
    return jsonErrorResponse({ error: result.error }, { status: 400 });
  }
  return Response.json(result);
}

/**
 * Apply an optional `?since=<epoch-ms>` filter to the run list.
 *
 * A run is kept when it was active on or after `since`, queued at/after it, or
 * ended at/after it (a run that started earlier but finished during the window).
 * This is the host-side source an away-digest reads to report the runs that
 * fired, failed, were missed, or delivered since the operator was last present.
 * An absent or non-numeric `since` leaves the list untouched.
 */
function filterRunsSince<T extends { readonly queuedAt: number; readonly endedAt?: number | undefined }>(
  runs: readonly T[],
  url: URL | undefined,
): T[] {
  const raw = url?.searchParams.get('since');
  if (raw === null || raw === undefined) return [...runs];
  const since = Number(raw);
  if (!Number.isFinite(since)) return [...runs];
  return runs.filter((run) => run.queuedAt >= since || (run.endedAt !== undefined && run.endedAt >= since));
}

/**
 * Handle GET /api/automation/runs.
 *
 * Without pagination params (`?limit=` / `?cursor=`): returns `{ runs: [...] }` (backward compat).
 * With pagination params: returns `PaginatedResponse<AutomationRunLike>` as `{ items, nextCursor, hasMore }`.
 *
 * ### Deletion recovery
 * `AutomationRunLike` carries a required `queuedAt: number` field which is
 * the stable creation-time timestamp.  Insertion-point recovery on mid-walk
 * deletion is **active** for this endpoint via `getCreatedAt: (r) => r.queuedAt`.
 * Runs are listed in descending `queuedAt` order (newest first), so
 * `descending: true` is passed to `paginateItems` for correct recovery.
 */
function handleGetAutomationRuns(context: DaemonRuntimeRouteContext, url: URL | undefined): Response {
  const runs = filterRunsSince(context.automationManager.listRuns(), url);
  if (!url || !hasPaginationParams(url)) {
    return Response.json({ runs });
  }
  const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), DEFAULT_AUTOMATION_LIST_LIMIT, MAX_AUTOMATION_LIST_LIMIT);
  const rawCursor = url.searchParams.get('cursor');
  const result = paginateItems(runs, limit, rawCursor, (r) => r.id, (r) => r.queuedAt, { descending: true });
  if ('error' in result) {
    return jsonErrorResponse({ error: result.error }, { status: 400 });
  }
  return Response.json(result);
}
