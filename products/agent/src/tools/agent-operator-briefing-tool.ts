import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';
import { getOperatorWorkLedgerProject } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/operator-read-client';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import { requireOperatorHttpBinding } from '../agent/operator-contract-routes.ts';

type WorkLedgerReadClient = ReturnType<typeof createOperatorWorkLedgerReadClient>;
type WorkLedgerReadSnapshot = Awaited<ReturnType<WorkLedgerReadClient['readSnapshot']>>;

type JsonRecord = Record<string, unknown>;

interface OperatorRouteDescriptor {
  readonly id: string;
  readonly path: string;
}

interface OperatorRouteSuccess {
  readonly ok: true;
  readonly route: OperatorRouteDescriptor;
  readonly body: unknown;
}

interface OperatorRouteFailure {
  readonly ok: false;
  readonly route: OperatorRouteDescriptor;
  readonly kind: 'auth_required' | 'connected_host_unavailable' | 'connected_host_route_unavailable' | 'connected_host_error';
  readonly error: string;
}

type OperatorRouteResult = OperatorRouteSuccess | OperatorRouteFailure;

/**
 * The read-only methods a briefing is assembled from.
 *
 * Ids only: each one's path comes from the contract that publishes it, so the
 * briefing cannot end up reading a route the daemon has moved. Exported because
 * the connected-host capability report describes this same set, and describing
 * it from a second hand-written list is how the two came to disagree.
 */
export const OPERATOR_BRIEFING_METHOD_IDS = [
  'workLedger.project',
  'workLedger.snapshot',
  'projectPlanning.workPlan.snapshot',
  'approvals.list',
  'automation.integration.snapshot',
  'automation.schedules.list',
  'scheduler.capacity',
] as const;

export function operatorBriefingRoutes(): readonly OperatorRouteDescriptor[] {
  return OPERATOR_BRIEFING_METHOD_IDS.map((id) => ({
    id,
    path: requireOperatorHttpBinding(id).pathTemplate,
  }));
}

// Resolved on first use, not at module load: the route lookup walks into the
// contract binding, and the single-file compiler's nondeterministic module
// order could evaluate this module before the contract's (the build-order
// lottery class fixed at runtime 2.0.13).
let operatorBriefingRoutesCache: readonly OperatorRouteDescriptor[] | null = null;
function briefingRoutes(): readonly OperatorRouteDescriptor[] {
  operatorBriefingRoutesCache ??= operatorBriefingRoutes();
  return operatorBriefingRoutesCache;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): JsonRecord {
  return isRecord(value) && isRecord(value[key]) ? value[key] as JsonRecord : {};
}

function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyHttpFailure(route: OperatorRouteDescriptor, status: number): OperatorRouteFailure {
  return {
    ok: false,
    route,
    kind: status === 401 || status === 403
      ? 'auth_required'
      : status === 404
        ? 'connected_host_route_unavailable'
        : 'connected_host_error',
    error: `HTTP ${status}`,
  };
}

/** One deadline for the whole briefing: every read runs at once, so the slowest one bounds the wait. */
const BRIEFING_DEADLINE_MS = 5_000;

function unanswered(signal: AbortSignal, deadlineMs: number): string {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? `no answer within ${deadlineMs / 1000}s` : 'cancelled';
}

async function fetchOperatorRoute(
  baseUrl: string,
  token: string,
  route: OperatorRouteDescriptor,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<OperatorRouteResult> {
  try {
    const response = await fetch(`${baseUrl}${route.path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(route, response.status);
    // A 200 that is not the route's documented shape (a proxy page, an error envelope) is not data.
    if (!hasExpectedShape(route.id, body)) {
      return { ok: false, route, kind: 'connected_host_error', error: 'unexpected response shape' };
    }
    return { ok: true, route, body };
  } catch (error) {
    return {
      ok: false,
      route,
      kind: 'connected_host_unavailable',
      error: signal.aborted ? unanswered(signal, deadlineMs) : `request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The minimum each formatter needs, so a shape it cannot read is reported instead of printed as zeros. */
function hasExpectedShape(routeId: string, body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (routeId === 'projectPlanning.workPlan.snapshot') return isRecord(body.counts) || Array.isArray(body.tasks);
  if (routeId === 'approvals.list') return Array.isArray(body.approvals);
  if (routeId === 'automation.integration.snapshot') return isRecord(body.totals) || Array.isArray(body.jobs);
  if (routeId === 'automation.schedules.list') return Array.isArray(body.jobs);
  return ['slotsInUse', 'slotsTotal', 'queueDepth'].some((key) => typeof body[key] === 'number');
}

function formatWorkPlan(body: unknown): string {
  const counts = readRecord(body, 'counts');
  const total = readNumber(counts, 'total') ?? readArray(body, 'tasks').length;
  return `  historical legacy work plan: total ${total}; pending ${readNumber(counts, 'pending') ?? 0}; active ${readNumber(counts, 'in_progress') ?? 0}; blocked ${readNumber(counts, 'blocked') ?? 0}; done ${readNumber(counts, 'done') ?? 0}`;
}

function formatApprovals(body: unknown): string {
  const approvals = readArray(body, 'approvals');
  const pending = approvals.filter((entry) => readString(entry, 'status') === 'pending').length;
  return `  approvals: pending ${pending}; total ${approvals.length}; mode ${['allow-all', 'background-restricted', 'custom', 'default', 'plan'].includes(readString(body, 'mode') ?? '') ? readString(body, 'mode') : 'unknown'}; awaiting decision ${Boolean(isRecord(body) && body.awaitingDecision === true)}`;
}

function formatAutomation(body: unknown): string {
  const totals = readRecord(body, 'totals');
  const jobs = readNumber(totals, 'jobs') ?? readArray(body, 'jobs').length;
  return `  automation: jobs ${jobs}; enabled ${readNumber(totals, 'enabled') ?? 0}; paused ${readNumber(totals, 'paused') ?? 0}; recent runs ${readNumber(totals, 'runs') ?? readArray(body, 'recentRuns').length}`;
}

function formatSchedules(body: unknown): string {
  const jobs = readArray(body, 'jobs');
  const runs = readArray(body, 'runs');
  const enabled = jobs.filter((entry) => isRecord(entry) && entry.enabled === true).length;
  return `  schedules: jobs ${jobs.length}; enabled ${enabled}; runs ${runs.length}`;
}

function formatCapacity(body: unknown): string {
  const slots = `slots ${readNumber(body, 'slotsInUse') ?? 0}/${readNumber(body, 'slotsTotal') ?? 0}`;
  const waiting = readNumber(body, 'queueDepth') ?? 0;
  const oldestMs = readNumber(body, 'oldestQueuedAgeMs');
  if (waiting === 0) return `  scheduler: ${slots}; nothing waiting`;
  const age = oldestMs === null ? '' : `, oldest waiting ${Math.round(oldestMs / 1000)}s`;
  return `  scheduler: ${slots}; ${waiting} due and waiting for a slot or heartbeat${age}`;
}

function formatRouteFailureKind(kind: OperatorRouteFailure['kind']): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  return 'connected host error';
}

function formatRoute(result: OperatorRouteResult): string {
  if (!result.ok) return `  ${result.route.id}: unavailable (${result.kind}; ${result.error})`;
  if (result.route.id === 'projectPlanning.workPlan.snapshot') return formatWorkPlan(result.body);
  if (result.route.id === 'approvals.list') return formatApprovals(result.body);
  if (result.route.id === 'automation.integration.snapshot') return formatAutomation(result.body);
  if (result.route.id === 'automation.schedules.list') return formatSchedules(result.body);
  return formatCapacity(result.body);
}

interface NativeWorkReading {
  readonly text: string;
  readonly available: boolean;
}

function formatBriefing(nativeWork: NativeWorkReading, results: readonly OperatorRouteResult[]): string {
  const failures = results.filter((result): result is OperatorRouteFailure => !result.ok);
  const unavailable = failures.length + (nativeWork.available ? 0 : 1);
  return [
    'Agent operator briefing',
    '  connected host: selected authenticated host',
    '  policy read-only public operator routes; no connected-host lifecycle, mutation routes, separate Agent jobs, delegated review, default knowledge, or non-Agent knowledge segments',
    '',
    nativeWork.text,
    ...results.map(formatRoute),
    '',
    unavailable === 0
      ? '  warnings: none'
      : `  warnings: ${unavailable} route(s) unavailable; retry after host/auth/version repair`,
  ].join('\n');
}

function formatNativeWork(snapshot: WorkLedgerReadSnapshot): string {
  const reported = { pending: 0, in_progress: 0, blocked: 0, complete: 0, cancelled: 0 };
  const verification = { unverified: 0, verified: 0, failed: 0, unavailable: 0, stale: 0 };
  for (const entry of snapshot.works) {
    reported[entry.work.reportedState] += 1;
    verification[entry.verification.state] += 1;
  }
  const counts = (values: Record<string, number>) => Object.entries(values).map(([state, count]) => `${state} ${count}`).join('; ');
  return [
    `  native work: total ${snapshot.works.length}; revision ${snapshot.revision}`,
    `  reportedState: ${counts(reported)}`,
    `  verification.state: ${counts(verification)}`,
  ].join('\n');
}

export function createAgentOperatorBriefingTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  deadlineMs: number = BRIEFING_DEADLINE_MS,
): Tool {
  return {
    definition: {
      name: 'agent_operator_briefing',
      activity: { doing: 'Preparing', did: 'prepared', object: 'a briefing', objects: 'briefings' },
      description: 'Read native work reported state and verification counts, historical legacy planning, approvals, automation, schedules, and capacity.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (_args, options) => {
      if (options?.signal?.aborted) return { success: false, error: 'briefing_cancelled: the call was cancelled before anything was read' };
      // The connection is resolved once; every read of this briefing uses it.
      const connection = resolveAgentConnectedHostConnection(configManager, shellPaths.homeDirectory);
      const token = connection.token;
      if (!token) return { success: false, error: 'auth_required: no connected-host operator token' };
      const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(options?.signal ? [options.signal] : [])]);
      // No streams, subscriptions, retries, history, or lifecycle calls. The
      // snapshot reader is disposed when the briefing ends, which aborts its request.
      const platformClient = createBrowserGoodVibesPlatform({ baseUrl: connection.baseUrl,
        getAuthToken: () => token, retry: { maxAttempts: 1 },
        fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }) });
      let reader: WorkLedgerReadClient | undefined;
      const readNative = async (): Promise<NativeWorkReading> => {
        try {
          const projectId = await getOperatorWorkLedgerProject(platformClient.operator, { signal });
          if (signal.aborted) throw signal.reason;
          reader = createOperatorWorkLedgerReadClient(platformClient.operator, projectId, { requestTimeoutMs: deadlineMs });
          const snapshot = await Promise.race([reader.readSnapshot(), new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })]);
          return { text: formatNativeWork(snapshot), available: true };
        } catch (error) {
          // The host's own error text is not repeated (it can carry request details); its status is.
          const status = isRecord(error) || error instanceof Error ? (error as { status?: unknown }).status : undefined;
          const cause = signal.aborted ? unanswered(signal, deadlineMs) : typeof status === 'number' ? `HTTP ${status}` : 'read failed';
          return { text: `  native work: unavailable (${cause}; no historical fallback)`, available: false };
        }
      };
      try {
        const routes = briefingRoutes().filter(route => route.id !== 'workLedger.project' && route.id !== 'workLedger.snapshot');
        const [nativeWork, results] = await Promise.all([
          readNative(),
          Promise.all(routes.map(route => fetchOperatorRoute(connection.baseUrl, token, route, signal, deadlineMs))),
        ]);
        if (options?.signal?.aborted) return { success: false, error: 'briefing_cancelled: the call was cancelled before the host answered' };
        return { success: true, output: formatBriefing(nativeWork, results) };
      } finally {
        reader?.dispose();
      }
    },
  };
}

export function registerAgentOperatorBriefingTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentOperatorBriefingTool(shellPaths, configManager));
}
