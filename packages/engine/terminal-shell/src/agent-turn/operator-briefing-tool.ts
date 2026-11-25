import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { requireOperatorHttpBinding } from './operator-contract-routes.js';
import { runDaemonMethodNested } from './capability-tools.js';

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
  readonly kind: 'connected_host_error';
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

/** The first line of why a read did not come back, short: the nested call's own words. */
function shortReason(error: string): string {
  const line = error.split('\n').find((entry) => entry.trim() !== '') ?? 'no answer';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * One read of the briefing, as a nested `capability_run` call naming its method: judged by the method's own
 * declarations (a read), with the credential the daemon-method runner holds.
 */
async function readRoute(route: OperatorRouteDescriptor, options: Parameters<Tool['execute']>[1]): Promise<OperatorRouteResult> {
  const answer = await runDaemonMethodNested(route.id, {}, options);
  if (!answer.ok) return { ok: false, route, kind: 'connected_host_error', error: shortReason(answer.error) };
  // An answer that is not the route's documented shape (a proxy page, an error envelope) is not data.
  if (!hasExpectedShape(route.id, answer.body)) return { ok: false, route, kind: 'connected_host_error', error: 'unexpected response shape' };
  return { ok: true, route, body: answer.body };
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

/** How many approvals the briefing names one by one. */
const APPROVAL_LINES = 5;

/**
 * The count from each approval's reading (what is waiting is its phase, not a
 * status this tool interprets), then one line per approval that still needs
 * something: still waiting, or decided while its asker has not confirmed it
 * received it. Each line says why (the reading's reason), on whom, and the
 * reading's own next move, so an agent stops polling and does not re-ask.
 */
function formatApprovals(body: unknown): string {
  const approvals = readArray(body, 'approvals');
  const readingOf = (entry: unknown): Record<string, unknown> | null => {
    const reading = isRecord(entry) ? entry.reading : undefined;
    return isRecord(reading) ? reading : null;
  };
  const waiting = approvals.filter((entry) => readingOf(entry)?.phase === 'waiting');
  const unreceived = approvals.filter((entry) => readingOf(entry)?.phase === 'decided' && readString(readRecord(readingOf(entry), 'receipt'), 'state') === 'waiting');
  const head = `  approvals: waiting ${waiting.length}; decided and not yet received ${unreceived.length}; total ${approvals.length}; mode ${['allow-all', 'background-restricted', 'custom', 'default', 'plan'].includes(readString(body, 'mode') ?? '') ? readString(body, 'mode') : 'unknown'}; awaiting decision ${Boolean(isRecord(body) && body.awaitingDecision === true)}`;
  const lines = [...waiting, ...unreceived].slice(0, APPROVAL_LINES).map((entry) => {
    const reading = readingOf(entry)!;
    const ref = readRecord(reading, 'ref');
    const next = readArray(reading, 'next').map((move) => readString(move, 'text')).find((text) => text !== null);
    const deadline = readNumber(readRecord(reading, 'deadline'), 'remainingMs');
    return `    ${readString(ref, 'id') ?? readString(entry, 'id') ?? '?'}@${readString(ref, 'node') ?? '?'} (revision ${readNumber(reading, 'revision') ?? '?'}): `
      + `${readString(reading, 'reason') ?? 'unknown'}${deadline !== null ? `, ${Math.round(deadline / 1000)}s left` : ''}`
      + `; receipt ${readString(readRecord(reading, 'receipt'), 'state') ?? 'unknown'}${next ? `; next: ${next}` : ''}`;
  });
  return [head, ...lines].join('\n');
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

function formatRoute(result: OperatorRouteResult): string {
  if (!result.ok) return `  ${result.route.id}: unavailable (${result.error})`;
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

const REPORTED_STATES = ['pending', 'in_progress', 'blocked', 'complete', 'cancelled'] as const;
const VERIFICATION_STATES = ['unverified', 'verified', 'failed', 'unavailable', 'stale'] as const;

/** The work ledger's snapshot as counts: each work's reported state and its verification state. */
function formatNativeWork(snapshot: unknown): string {
  const works = readArray(snapshot, 'works');
  const count = (states: readonly string[], read: (entry: unknown) => string | null) => states
    .map((state) => `${state} ${works.filter((entry) => read(entry) === state).length}`).join('; ');
  return [
    `  native work: total ${works.length}; revision ${readNumber(snapshot, 'revision') ?? '?'}`,
    `  reportedState: ${count(REPORTED_STATES, (entry) => readString(readRecord(entry, 'work'), 'reportedState'))}`,
    `  verification.state: ${count(VERIFICATION_STATES, (entry) => readString(readRecord(entry, 'verification'), 'state'))}`,
  ].join('\n');
}

/**
 * `agent_operator_briefing`: what the daemon holds of the owner's work, approvals, automation and capacity, read in
 * one call. Every read is a nested `capability_run` call naming its method (a read, judged by the method's own
 * declarations), the one gate a model's daemon call goes through.
 */
export function createAgentOperatorBriefingTool(
  _shellPaths: ShellPathService,
  _configManager: AgentConnectedHostConfigReader,
  _deadlineMs?: number,
  _inProcess?: AgentInProcessHost,
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
      // Every read reaches only the daemon, through nested capability_run calls.
      sideEffects: ['state'],
      category: 'read',
    },
    execute: async (_args, options) => {
      if (options?.signal?.aborted) return { success: false, error: 'briefing_cancelled: the call was cancelled before anything was read' };
      const readNative = async (): Promise<NativeWorkReading> => {
        // This program's project's work (the daemon keeps Work per project, by folder).
        const folder = _shellPaths.workingDirectory;
        const project = await runDaemonMethodNested('workLedger.project', { workingDirectory: folder }, options);
        const projectId = project.ok ? readString(project.body, 'projectId') : null;
        if (!project.ok || !projectId) return { text: `  native work: unavailable (${project.ok ? 'no project' : shortReason(project.error)}; no historical fallback)`, available: false };
        const snapshot = await runDaemonMethodNested('workLedger.snapshot', { projectId, workingDirectory: folder }, options);
        if (!snapshot.ok || !isRecord(snapshot.body)) return { text: `  native work: unavailable (${snapshot.ok ? 'unexpected response shape' : shortReason(snapshot.error)}; no historical fallback)`, available: false };
        return { text: formatNativeWork(snapshot.body), available: true };
      };
      const routes = briefingRoutes().filter((route) => route.id !== 'workLedger.project' && route.id !== 'workLedger.snapshot');
      const nativeWork = await readNative();
      const results: OperatorRouteResult[] = [];
      for (const route of routes) results.push(await readRoute(route, options));
      if (options?.signal?.aborted) return { success: false, error: 'briefing_cancelled: the call was cancelled before the host answered' };
      return { success: true, output: formatBriefing(nativeWork, results) };
    },
  };
}

/**
 * `inProcess`: the daemon hosting this turn, which is then the host the
 * briefing reads (in-process-host.ts); absent in the Agent's own process. The
 * reads are sent by the nested daemon-method runner, which holds the connection.
 */
export function registerAgentOperatorBriefingTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentOperatorBriefingTool(shellPaths, configManager, undefined, inProcess));
}
