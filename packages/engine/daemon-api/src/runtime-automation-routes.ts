import type { DaemonRuntimeAutomationRouteHandlers } from './context.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { withAdmin } from './auth-helpers.js';
import { jsonErrorResponse, readServiceErrorResponse } from './error-response.js';
import { listingEnvelope, paginateItems } from './pagination.js';
import { readBoundedPositiveInteger } from './route-helpers.js';

const MAX_AUTOMATION_LIST_LIMIT = 500;

/**
 * Reads, run actions and run-now. Job and schedule create, update, delete,
 * enable, disable, pause and resume are gateway verbs served through the
 * gateway REST table (`gateway-rest-routes.ts`) by the native automation
 * handlers, which carry the mutation revision and the publication.
 */
export function createDaemonRuntimeAutomationRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeAutomationRouteHandlers {
  return {
    getAutomationJobs: (url?: URL) => handleGetAutomationJobs(context, url),
    getAutomationRuns: (url?: URL) => handleGetAutomationRuns(context, url),
    getAutomationRun: (runId) => handleGetAutomationRun(context, runId),
    getAutomationHeartbeat: () => Response.json({ pending: context.automationManager.listHeartbeatWakes?.() ?? [] }),
    postAutomationHeartbeat: async (request) => withAdmin(context, request, () => handlePostAutomationHeartbeat(context, request)),
    automationRunAction: async (runId, action, request) => withAdmin(context, request, () => handleAutomationRunAction(context, runId, action, request)),
    runAutomationJobNow: async (jobId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, jobId)),
    getSchedules: () => handleGetSchedules(context),
    runScheduleNow: (scheduleId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, scheduleId)),
    getSchedulerCapacity: (req) => withAdmin(context, req, () => Response.json(context.automationManager.getSchedulerCapacity())),
  };
}

/**
 * `defaultTimezone` is the zone a cron schedule created without one is stored
 * in (the owner's zone, `daemon.timezone`, else the host's), so a client can
 * tell whether a listed schedule is the one its zone-less create would make.
 */
function handleGetSchedules(context: DaemonRuntimeRouteContext): Response {
  const jobs = context.automationManager.listJobs();
  const runs = context.automationManager.listRuns().slice(0, 50);
  const defaultTimezone = context.automationManager.defaultTimezone();
  return Response.json({ jobs, runs, ...(defaultTimezone ? { defaultTimezone } : {}) });
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

/** A listing's limit: every item when the caller set none, so the older key keeps carrying the whole list. */
function readListLimit(url: URL | undefined, total: number): number {
  const raw = url?.searchParams.get('limit') ?? null;
  return raw === null ? Math.max(1, total) : readBoundedPositiveInteger(raw, 100, MAX_AUTOMATION_LIST_LIMIT);
}

/**
 * Handle GET /api/automation/jobs: `{ items, hasMore, nextCursor?, jobs }`
 * with or without `limit`/`cursor`. Jobs carry no timestamp at this boundary,
 * so a cursor whose job was deleted cannot be placed and is refused (400) for
 * the client to restart the listing, never silently restarted.
 */
function handleGetAutomationJobs(context: DaemonRuntimeRouteContext, url: URL | undefined): Response {
  const jobs = context.automationManager.listJobs();
  const result = paginateItems(jobs, readListLimit(url, jobs.length), url?.searchParams.get('cursor') ?? null, (j) => j.id);
  if ('error' in result) return jsonErrorResponse({ error: result.error, code: 'INVALID_CURSOR' }, { status: 400 });
  // While automation is enabled with zero routines, the response carries the
  // how-to-create-your-first-routine empty state so surfaces render a usable
  // starting point instead of a bare empty list.
  const emptyState = jobs.length === 0 ? context.automationEmptyState?.() ?? null : null;
  return Response.json(listingEnvelope('jobs', result, emptyState ? { emptyState } : undefined));
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
 * Handle GET /api/automation/runs: `{ items, hasMore, nextCursor?, runs }`
 * with or without `limit`/`cursor`. Runs are newest first by `queuedAt`, which
 * the cursor encodes, so a run deleted mid-walk is passed over.
 */
function handleGetAutomationRuns(context: DaemonRuntimeRouteContext, url: URL | undefined): Response {
  const runs = filterRunsSince(context.automationManager.listRuns(), url);
  const result = paginateItems(runs, readListLimit(url, runs.length), url?.searchParams.get('cursor') ?? null, (r) => r.id, (r) => r.queuedAt, { descending: true });
  if ('error' in result) return jsonErrorResponse({ error: result.error, code: 'INVALID_CURSOR' }, { status: 400 });
  return Response.json(listingEnvelope('runs', result));
}
