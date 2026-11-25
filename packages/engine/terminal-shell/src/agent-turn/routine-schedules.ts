/**
 * routine-schedules.ts, a routine run on a schedule on a GoodVibes host: the
 * schedule it asks for, creating it there (a retry after a lost answer finds
 * the one already made), the local receipts of each attempt
 * (`~/.goodvibes/agent/routines/schedule-receipts.json`), comparing them with
 * the host's live schedules, and their words.
 *
 * The daemon runs these for every program (capabilities/builtin/routines.ts:
 * `routines.promote`, `receipts`, `receipt`, `reconcile`), with itself as the
 * host; the Agent's command line and its other connected-host callers use the
 * same connection helpers.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { formatEveryInterval, type AutomationScheduleDefinition } from '@goodvibes/engine/platform/platform/automation';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import {
  createConnectedHost, isHostFailure, resolveConnectedHost,
  type ConnectedHostConnection, type ConnectedHostSource, type ConnectedHostUnavailable, type HostFailureKind,
} from './connected-host-client.js';
import { formatAgentRecordReviewState } from './record-labels.js';
import { evaluateAgentRoutineReadiness, type AgentRoutineRecord } from './routine-registry.js';
import { formatAgentSkillRequirement } from './skill-registry.js';
import { readJsonStore, updateJsonStore, type JsonStoreSpec } from './store-file.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import {
  deliveryModeFromTargets, deliveryTargetFlag, findSameSchedule, isRoutineScheduleDeliverySurfaceKind, normalizeProviderModel, toDeliveryTargetInput,
  ROUTINE_SCHEDULE_LIST_METHOD, ROUTINE_SCHEDULE_METHOD, ROUTINE_SCHEDULE_ROUTE,
  type RoutineScheduleDeliveryKind, type RoutineScheduleDeliverySurfaceKind, type RoutineScheduleDeliveryTargetSpec, type RoutineScheduleKind, type RoutineScheduleSpec,
} from './schedule-delivery-targets.js';
import { scheduleConfirmationRouteLines, scheduleNextRouteLines, scheduleRouteArg } from './schedule-next-routes.js';

export { ROUTINE_SCHEDULE_LIST_METHOD, ROUTINE_SCHEDULE_METHOD, ROUTINE_SCHEDULE_ROUTE, type RoutineScheduleKind, type RoutineScheduleSpec };
export type { RoutineScheduleDeliveryKind, RoutineScheduleDeliverySurfaceKind, RoutineScheduleDeliveryTargetSpec };

export type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
export type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;
type ScheduleDeliveryInput = NonNullable<ScheduleCreateInput['delivery']>;
type ScheduleListOutput = OperatorMethodOutput<'automation.schedules.list'>;

// ---------------------------------------------------------------------------- the connection

export interface AgentConnectedHostConfigReader {
  get(key: string): unknown;
}

export interface AgentConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for, safe to show: a file path, a store name or a setting. */
  readonly tokenPath: string;
  /** Which source the credential came from. */
  readonly source?: ConnectedHostSource | undefined;
  /** Present when `token` is null: why (dial turned off, no credential, host too old) and the next step. */
  readonly unavailable?: ConnectedHostUnavailable | undefined;
}

/**
 * The connected host and credential, through the Agent's one resolution
 * (`resolveConnectedHost`): one precedence, `daemon.connectedHost.enabled` and
 * the host build check honoured, and the reason carried when there is no token.
 */
export function resolveAgentConnectedHostConnection(configManager: AgentConnectedHostConfigReader, homeDirectory: string): AgentConnectedHostConnection {
  const resolved = resolveConnectedHost({ configManager, homeDirectory });
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    tokenPath: resolved.credential,
    ...(resolved.source === undefined ? {} : { source: resolved.source }),
    ...(resolved.unavailable === undefined ? {} : { unavailable: resolved.unavailable }),
  };
}

/** The connected-host client's view of an Agent connection, the reason for a missing credential included. */
export function connectedHostOf(connection: AgentConnectedHostConnection): ConnectedHostConnection {
  return {
    baseUrl: connection.baseUrl,
    token: connection.token,
    credential: connection.tokenPath,
    ...(connection.source === undefined ? {} : { source: connection.source }),
    ...(connection.unavailable === undefined ? {} : { unavailable: connection.unavailable }),
  };
}

/** The failure kind of a connection without a token: a host older than this build is incompatible, anything else needs a credential. */
export function connectionUnavailableKind(connection: AgentConnectedHostConnection): 'auth_required' | 'connected_host_incompatible' {
  return connection.unavailable?.code === 'host_too_old' ? 'connected_host_incompatible' : 'auth_required';
}

/** Why a connection without a token cannot be used, with the next step. */
export function connectionUnavailableMessage(connection: AgentConnectedHostConnection): string {
  const unavailable = connection.unavailable;
  if (!unavailable) return `No connected-host operator token found at ${connection.tokenPath}`;
  const next = unavailable.next[0];
  return `${unavailable.reason}${next ? `; ${next}` : ''}`;
}

/** `  delivery <mode> (<n> targets)` for a schedule record as the host returned it. */
export function scheduleDeliveryLine(schedule: Record<string, unknown>): string {
  const delivery = schedule['delivery'];
  const policy: Record<string, unknown> = delivery && typeof delivery === 'object' && !Array.isArray(delivery) ? delivery as Record<string, unknown> : {};
  const mode = typeof policy['mode'] === 'string' ? policy['mode'] : 'none';
  const count = Array.isArray(policy['targets']) ? policy['targets'].length : 0;
  return `  delivery ${mode}${count > 0 ? ` (${count} target${count === 1 ? '' : 's'})` : ''}`;
}

export type ConnectedScheduleCreateResult =
  | { readonly ok: true; readonly schedule: ScheduleCreateOutput; readonly alreadyExisted: boolean }
  | { readonly ok: false; readonly kind: Exclude<HostFailureKind, 'cancelled'>; /** `<what failed>: <cause>; <next step>`. */ readonly error: string; readonly baseUrl: string };

/**
 * Create `payload` on the connected host, or return the schedule a lost
 * earlier answer already created (the host takes no idempotency key on
 * `automation.schedules.create`). A host that cannot list schedules yields no
 * match and the create goes ahead.
 */
export async function createConnectedSchedule(
  connection: AgentConnectedHostConnection,
  payload: ScheduleCreateInput,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ConnectedScheduleCreateResult> {
  const host = createConnectedHost(() => connectedHostOf(connection));
  try {
    const listed: unknown = await host.invoke('automation.schedules.list', {}, { signal: options.signal }).catch((error: unknown) => {
      // A failure the create would meet the same way ends it here; anything else only skips the lookup.
      if (isHostFailure(error) && error.kind !== 'connected_host_error' && error.kind !== 'connected_host_route_unavailable') throw error;
      return null;
    });
    const existing = findSameSchedule(listed, payload);
    if (existing) return { ok: true, schedule: existing as unknown as ScheduleCreateOutput, alreadyExisted: true };
    const schedule = await host.invoke('automation.schedules.create', payload, { signal: options.signal });
    return { ok: true, schedule, alreadyExisted: false };
  } catch (error) {
    if (isHostFailure(error)) {
      return { ok: false, kind: error.kind === 'cancelled' ? 'connected_host_error' : error.kind, error: error.message, baseUrl: connection.baseUrl };
    }
    return { ok: false, kind: 'connected_host_error', error: `automation.schedules.create on the connected host failed: ${error instanceof Error ? error.message : String(error)}`, baseUrl: connection.baseUrl };
  }
}

// ---------------------------------------------------------------------------- the promotion

export interface RoutineScheduleReceiptDeliveryTarget {
  readonly kind: RoutineScheduleDeliveryKind;
  readonly surfaceKind?: RoutineScheduleDeliverySurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface ParsedRoutineSchedulePromotionArgs {
  readonly routineId: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly deliveryTargets: readonly RoutineScheduleDeliveryTargetSpec[];
  readonly name?: string | undefined;
  readonly timezone?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly enabled: boolean;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

export interface RoutineSchedulePromotionPreview {
  readonly routineId: string;
  readonly routineName: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly method: typeof ROUTINE_SCHEDULE_METHOD;
  readonly payload: ScheduleCreateInput;
}

export interface RoutineSchedulePromotionSuccess {
  readonly ok: true;
  readonly kind: typeof ROUTINE_SCHEDULE_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly routineId: string;
  readonly routineName: string;
  readonly schedule: ScheduleCreateOutput;
  readonly request: ScheduleCreateInput;
  /** True when the host already held this exact schedule (a retry after a lost answer), so nothing was created. */
  readonly alreadyExisted?: true | undefined;
}

export interface RoutineSchedulePromotionFailure {
  readonly ok: false;
  readonly kind: 'confirmation_required' | 'auth_required' | 'connected_host_unavailable' | 'connected_host_incompatible' | 'connected_host_route_unavailable' | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string | undefined;
}

export type RoutineSchedulePromotionResult = RoutineSchedulePromotionSuccess | RoutineSchedulePromotionFailure;

export interface RoutineScheduleReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly method: typeof ROUTINE_SCHEDULE_METHOD;
  readonly status: 'created' | 'failed';
  readonly connectedHostBaseUrl: string;
  readonly scheduleId?: string | undefined;
  readonly scheduleStatus?: string | undefined;
  readonly scheduleName: string;
  readonly scheduleKind: RoutineScheduleKind;
  readonly scheduleValue: string;
  readonly timezone?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly enabled: boolean;
  readonly target: {
    readonly kind?: string | undefined;
    readonly surfaceKind?: string | undefined;
    readonly preserveThread?: boolean | undefined;
    readonly createIfMissing?: boolean | undefined;
  };
  readonly deliveryMode?: string | undefined;
  readonly deliveryTargets?: readonly RoutineScheduleReceiptDeliveryTarget[] | undefined;
  readonly failureKind?: RoutineSchedulePromotionFailure['kind'] | undefined;
  readonly failureError?: string | undefined;
}

export interface RoutineScheduleReceiptSnapshot {
  readonly path: string;
  readonly receipts: readonly RoutineScheduleReceipt[];
}

export interface RoutineScheduleLiveRecord {
  readonly id: string;
  readonly name: string;
  readonly status?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly scheduleKind?: RoutineScheduleKind | undefined;
  readonly scheduleValue?: string | undefined;
  readonly timezone?: string | undefined;
  /** The schedule as the host keeps it, for showing it in words. */
  readonly definition?: AutomationScheduleDefinition | undefined;
  /** What the schedule runs: the task the host keeps with it. */
  readonly prompt?: string | undefined;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly runCount?: number | undefined;
  readonly successCount?: number | undefined;
  readonly failureCount?: number | undefined;
}

export interface RoutineScheduleCorrelation {
  readonly receipt: RoutineScheduleReceipt;
  readonly liveStatus: 'matched' | 'missing' | 'failed-receipt';
  readonly matchReason: 'schedule-id' | 'name-and-cadence' | 'failed-receipt' | 'not-found';
  readonly schedule?: RoutineScheduleLiveRecord | undefined;
}

export interface RoutineScheduleCorrelationSuccess {
  readonly ok: true;
  readonly kind: typeof ROUTINE_SCHEDULE_LIST_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl: string;
  readonly scheduleCount: number;
  readonly receiptCount: number;
  readonly correlations: readonly RoutineScheduleCorrelation[];
  /** What this reconciliation retired from the local receipt store (receipts whose schedule the host no longer lists). */
  readonly reaping?: { readonly reaped: number; readonly withinGrace: number; readonly reapedIds: readonly string[] } | undefined;
}

export interface RoutineScheduleCorrelationFailure {
  readonly ok: false;
  readonly kind: 'auth_required' | 'connected_host_unavailable' | 'connected_host_incompatible' | 'connected_host_route_unavailable' | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string | undefined;
}

export type RoutineScheduleCorrelationResult = RoutineScheduleCorrelationSuccess | RoutineScheduleCorrelationFailure;

export function buildRoutineSchedulePrompt(routine: AgentRoutineRecord): string {
  return [
    'GoodVibes Agent scheduled routine.',
    '',
    `Routine: ${routine.name}`,
    `Routine reference: ${routine.id}`,
    `Review: ${formatAgentRecordReviewState(routine.reviewState)}`,
    `Tags: ${routine.tags.join(', ') || '(none)'}`,
    `Triggers: ${routine.triggers.join(', ') || '(manual)'}`,
    '',
    'Operator policy:',
    '- Run this as a serial GoodVibes Agent operator routine.',
    '- Use isolated Agent Knowledge routes only; never use default knowledge or non-Agent knowledge spaces as fallback.',
    '- Do not perform destructive, costly, externally visible, or secret-handling actions without explicit approval.',
    '- Do not request GoodVibes TUI delegation unless this scheduled routine explicitly delegates build/fix/review work to GoodVibes TUI.',
    '- Summarize what was checked, what changed, and what still needs user review.',
    '',
    'Routine description:',
    routine.description,
    '',
    'Routine steps:',
    routine.steps,
  ].join('\n');
}

/** The name a promoted schedule is created under: the sent name, or the routine's own when none was given. */
export function routineScheduleName(preview: Pick<RoutineSchedulePromotionPreview, 'routineName' | 'payload'>): string {
  return preview.payload.name ?? `Agent routine: ${preview.routineName}`;
}

export function buildRoutineSchedulePayload(routine: AgentRoutineRecord, parsed: ParsedRoutineSchedulePromotionArgs): ScheduleCreateInput {
  if (!parsed.schedule) throw new Error('Schedule is required.');
  const modelRoute = normalizeProviderModel(parsed.provider, parsed.model);
  const payload: ScheduleCreateInput = {
    name: parsed.name ?? `Agent routine: ${routine.name}`,
    prompt: buildRoutineSchedulePrompt(routine),
    kind: parsed.schedule.kind,
    enabled: parsed.enabled,
    target: { kind: 'main', surfaceKind: 'service', preserveThread: true, createIfMissing: true },
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
      retryPolicy: { maxAttempts: 2, delayMs: 60_000, strategy: 'exponential', maxDelayMs: 900_000, jitterMs: 30_000 },
      disableAfterFailures: false,
    },
    lightContext: true,
    allowUnsafeExternalContent: false,
    ...modelRoute,
  };
  if (parsed.schedule.kind === 'cron') return { ...payload, cron: parsed.schedule.value, ...(parsed.timezone ? { timezone: parsed.timezone } : {}) };
  if (parsed.schedule.kind === 'every') return { ...payload, every: parsed.schedule.value };
  return { ...payload, at: parsed.schedule.value };
}

export function buildRoutineSchedulePreview(routine: AgentRoutineRecord, parsed: ParsedRoutineSchedulePromotionArgs): RoutineSchedulePromotionPreview {
  return { routineId: routine.id, routineName: routine.name, route: ROUTINE_SCHEDULE_ROUTE, method: ROUTINE_SCHEDULE_METHOD, payload: buildRoutineSchedulePayload(routine, parsed) };
}

/**
 * What stands between a routine and an unattended, recurring schedule: it must
 * be switched on, reviewed, and have nothing missing. Each blocker names what
 * clears it where the refusal is read (the place's controls, or the Agent's
 * command line).
 */
export function routinePromotionBlockers(routine: AgentRoutineRecord, surface: 'place' | 'cli' = 'place'): readonly string[] {
  const blockers: string[] = [];
  if (surface === 'cli') {
    if (!routine.enabled) blockers.push(`it is switched off (run goodvibes-agent routines enable ${routine.id})`);
    if (routine.reviewState !== 'reviewed') blockers.push(`it has not been reviewed (read its steps with goodvibes-agent routines show ${routine.id}, then run goodvibes-agent routines review ${routine.id})`);
  } else {
    if (!routine.enabled) blockers.push('it is switched off (switch it on, on the routine in Memory and knowledge or Automation)');
    if (routine.reviewState !== 'reviewed') blockers.push('it has not been reviewed (read its steps, then mark it reviewed, on the routine in Memory and knowledge)');
  }
  const readiness = evaluateAgentRoutineReadiness(routine);
  if (!readiness.ready) blockers.push(`setup is missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`);
  return blockers;
}

/** Create the routine's standing schedule on the connected host; a retry after a lost answer returns the one the first attempt made. */
export async function promoteRoutineToConnectedSchedule(
  connection: AgentConnectedHostConnection,
  preview: RoutineSchedulePromotionPreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<RoutineSchedulePromotionResult> {
  const created = await createConnectedSchedule(connection, preview.payload, options);
  if (!created.ok) return { ok: false, kind: created.kind, error: created.error, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: created.baseUrl };
  return {
    ok: true, kind: ROUTINE_SCHEDULE_METHOD, route: ROUTINE_SCHEDULE_ROUTE, routineId: preview.routineId, routineName: preview.routineName,
    schedule: created.schedule, request: preview.payload, ...(created.alreadyExisted ? { alreadyExisted: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------- the receipts

const RECEIPT_STORE_VERSION = 1;
/** Count cap on stored receipts: one per promotion attempt, a deliberate act; 200 is months of use. Applied with the age TTL. */
const ROUTINE_SCHEDULE_RECEIPT_LIMIT = 200;
/** Age TTL: after a quarter the live schedule (or its absence) is the authority. */
const ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A schedule created seconds ago can be absent from a list that raced it; five minutes before such a receipt may be reaped. */
const ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS = 5 * 60 * 1000;

/** What a store read/prune had to recover from or reclaim. */
export interface RoutineScheduleReceiptMaintenance {
  readonly path: string;
  readonly recovered: 'none' | 'unreadable';
  readonly expired: number;
  readonly overflow: number;
  readonly kept: number;
}

/** What a reconcile-time reap removed. */
export interface RoutineScheduleReceiptReaping {
  readonly authoritative: boolean;
  readonly reaped: number;
  readonly reapedIds: readonly string[];
  readonly withinGrace: number;
}

interface ReceiptPruneOutcome { readonly kept: readonly RoutineScheduleReceipt[]; readonly expired: number; readonly overflow: number }

/** Both bounds: the age TTL first, then the count cap; a receipt with an unreadable date is kept. */
function pruneReceipts(receipts: readonly RoutineScheduleReceipt[], now: number, limit: number, maxAgeMs: number): ReceiptPruneOutcome {
  const ordered = [...receipts].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fresh = ordered.filter((receipt) => { const created = Date.parse(receipt.createdAt); return !Number.isFinite(created) || now - created <= maxAgeMs; });
  const kept = fresh.slice(-Math.max(1, limit));
  return { kept, expired: ordered.length - fresh.length, overflow: fresh.length - kept.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}
function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}
function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function redactedDeliveryAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try { const url = new URL(address); return `${url.protocol}//${url.host}/...`; } catch { return '[redacted]'; }
}

function redactedDeliveryTargets(delivery: ScheduleDeliveryInput | undefined): readonly RoutineScheduleReceiptDeliveryTarget[] | undefined {
  if (!delivery) return undefined;
  return delivery.targets.map((target) => ({
    kind: target.kind as RoutineScheduleDeliveryKind,
    surfaceKind: typeof target.surfaceKind === 'string' && isRoutineScheduleDeliverySurfaceKind(target.surfaceKind) ? target.surfaceKind : undefined,
    address: redactedDeliveryAddress(typeof target.address === 'string' ? target.address : undefined),
    routeId: typeof target.routeId === 'string' ? target.routeId : undefined,
    label: typeof target.label === 'string' ? target.label : undefined,
  }));
}

function normalizeFailureKind(value: unknown): RoutineScheduleReceipt['failureKind'] {
  if (value === 'confirmation_required' || value === 'auth_required' || value === 'connected_host_incompatible') return value;
  if (value === 'connected_host_unavailable' || value === 'connected_host_route_unavailable' || value === 'connected_host_error') return value;
  if (value === 'daemon_unavailable') return 'connected_host_unavailable';
  if (value === 'daemon_route_unavailable') return 'connected_host_route_unavailable';
  if (value === 'daemon_error') return 'connected_host_error';
  return undefined;
}

function readReceipt(value: unknown): RoutineScheduleReceipt | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id')?.trim();
  const createdAt = readString(value, 'createdAt')?.trim();
  const routineId = readString(value, 'routineId')?.trim();
  const routineName = readString(value, 'routineName')?.trim();
  const status = value['status'] === 'created' || value['status'] === 'failed' ? value['status'] : null;
  const scheduleKind = value['scheduleKind'] === 'cron' || value['scheduleKind'] === 'every' || value['scheduleKind'] === 'at' ? value['scheduleKind'] : null;
  const scheduleValue = readString(value, 'scheduleValue')?.trim();
  const target = isRecord(value['target']) ? value['target'] : {};
  const rawTargets = value['deliveryTargets'];
  const deliveryTargets = Array.isArray(rawTargets)
    ? rawTargets.map((entry): RoutineScheduleReceiptDeliveryTarget | null => {
      if (!isRecord(entry)) return null;
      const kind = entry['kind'] === 'webhook' || entry['kind'] === 'surface' || entry['kind'] === 'integration' || entry['kind'] === 'link' ? entry['kind'] : null;
      if (!kind) return null;
      const surfaceKind = readString(entry, 'surfaceKind') ?? undefined;
      return {
        kind,
        surfaceKind: surfaceKind && isRoutineScheduleDeliverySurfaceKind(surfaceKind) ? surfaceKind : undefined,
        address: readString(entry, 'address') ?? undefined,
        routeId: readString(entry, 'routeId') ?? undefined,
        label: readString(entry, 'label') ?? undefined,
      };
    }).filter((entry): entry is RoutineScheduleReceiptDeliveryTarget => entry !== null)
    : undefined;
  if (!id || !createdAt || !routineId || !routineName || !status || !scheduleKind || !scheduleValue) return null;
  return {
    id, createdAt, routineId, routineName, route: ROUTINE_SCHEDULE_ROUTE, method: ROUTINE_SCHEDULE_METHOD, status,
    connectedHostBaseUrl: readString(value, 'connectedHostBaseUrl') ?? readString(value, 'daemonBaseUrl') ?? '',
    scheduleId: readString(value, 'scheduleId') ?? undefined,
    scheduleStatus: readString(value, 'scheduleStatus') ?? undefined,
    scheduleName: readString(value, 'scheduleName') ?? routineName,
    scheduleKind, scheduleValue,
    timezone: readString(value, 'timezone') ?? undefined,
    provider: readString(value, 'provider') ?? undefined,
    model: readString(value, 'model') ?? undefined,
    enabled: value['enabled'] !== false,
    target: {
      kind: readString(target, 'kind') ?? undefined,
      surfaceKind: readString(target, 'surfaceKind') ?? undefined,
      preserveThread: readBoolean(target, 'preserveThread'),
      createIfMissing: readBoolean(target, 'createIfMissing'),
    },
    deliveryMode: readString(value, 'deliveryMode') ?? undefined,
    deliveryTargets,
    failureKind: normalizeFailureKind(value['failureKind']),
    failureError: readString(value, 'failureError') ?? undefined,
  };
}

const RECEIPT_STORE: JsonStoreSpec<RoutineScheduleReceipt> = { label: 'routine schedule receipt store', entriesKey: 'receipts', version: RECEIPT_STORE_VERSION, parseEntry: readReceipt };

/** One spelling of a host address, so `http://Host:3421/` and `http://host:3421` compare equal. */
function normalizeHostUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return value.trim().replace(/\/+$/, '').toLowerCase(); }
}

function receiptId(createdAt: string, routineId: string, existing: readonly RoutineScheduleReceipt[]): string {
  const dayStamp = createdAt.slice(0, 10).replace(/-/g, '');
  const base = `routine-schedule-${routineId}-${dayStamp}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ids = new Set(existing.map((receipt) => receipt.id));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) { const candidate = `${base}-${index}`; if (!ids.has(candidate)) return candidate; }
  return `${base}-${existing.length + 1}`;
}

function scheduleValueOf(payload: ScheduleCreateInput): string {
  if (payload.kind === 'cron') return String(payload.cron ?? '');
  if (payload.kind === 'every') return String(payload.every ?? '');
  return String(payload.at ?? '');
}

function scheduleKindOf(payload: ScheduleCreateInput): RoutineScheduleKind {
  if (payload.kind === 'cron' || payload.kind === 'every' || payload.kind === 'at') return payload.kind;
  throw new Error('Routine schedule payload is missing a schedule kind.');
}

function targetSummary(payload: ScheduleCreateInput): RoutineScheduleReceipt['target'] {
  const target: unknown = payload.target;
  return isRecord(target)
    ? {
      kind: typeof target['kind'] === 'string' ? target['kind'] : undefined,
      surfaceKind: typeof target['surfaceKind'] === 'string' ? target['surfaceKind'] : undefined,
      preserveThread: typeof target['preserveThread'] === 'boolean' ? target['preserveThread'] : undefined,
      createIfMissing: typeof target['createIfMissing'] === 'boolean' ? target['createIfMissing'] : undefined,
    }
    : {};
}

function buildReceipt(existing: readonly RoutineScheduleReceipt[], connection: AgentConnectedHostConnection, preview: RoutineSchedulePromotionPreview, result: RoutineSchedulePromotionResult): RoutineScheduleReceipt {
  const createdAt = new Date().toISOString();
  const kind = scheduleKindOf(preview.payload);
  const schedule: Record<string, unknown> = result.ok && isRecord(result.schedule) ? result.schedule : {};
  const delivery: unknown = preview.payload.delivery;
  return {
    id: receiptId(createdAt, preview.routineId, existing),
    createdAt,
    routineId: preview.routineId,
    routineName: preview.routineName,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status: result.ok ? 'created' : 'failed',
    connectedHostBaseUrl: connection.baseUrl,
    scheduleId: readString(schedule, 'id') ?? undefined,
    scheduleStatus: readString(schedule, 'status') ?? (schedule['enabled'] === false ? 'paused' : schedule['enabled'] === true ? 'enabled' : undefined),
    scheduleName: String(preview.payload.name ?? `Agent routine: ${preview.routineName}`),
    scheduleKind: kind,
    scheduleValue: scheduleValueOf(preview.payload),
    timezone: kind === 'cron' ? preview.payload.timezone : undefined,
    provider: preview.payload.provider,
    model: preview.payload.model,
    enabled: preview.payload.enabled !== false,
    target: targetSummary(preview.payload),
    deliveryMode: isRecord(delivery) && typeof delivery['mode'] === 'string' ? delivery['mode'] : undefined,
    deliveryTargets: redactedDeliveryTargets(preview.payload.delivery),
    failureKind: result.ok ? undefined : result.kind,
    failureError: result.ok ? undefined : result.error,
  };
}

export function routineScheduleReceiptStorePath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'schedule-receipts.json');
}

export class RoutineScheduleReceiptStore {
  private lastMaintenanceSummary: RoutineScheduleReceiptMaintenance | null = null;

  public constructor(
    private readonly storePath: string,
    private readonly limit = ROUTINE_SCHEDULE_RECEIPT_LIMIT,
    private readonly maxAgeMs = ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS,
  ) {}

  public static fromShellPaths(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): RoutineScheduleReceiptStore {
    return new RoutineScheduleReceiptStore(routineScheduleReceiptStorePath(shellPaths));
  }

  public get path(): string { return this.storePath; }

  /** The last read/prune's record, or null when the store has not been read yet. */
  public lastMaintenance(): RoutineScheduleReceiptMaintenance | null { return this.lastMaintenanceSummary; }

  public snapshot(): RoutineScheduleReceiptSnapshot {
    // Reading applies both bounds and writes only when something was dropped; the write re-reads under the lock.
    const read = readJsonStore(this.storePath, RECEIPT_STORE);
    let prune = pruneReceipts(read.entries, Date.now(), this.limit, this.maxAgeMs);
    if ((prune.expired > 0 || prune.overflow > 0) && read.newerVersion === undefined) {
      prune = updateJsonStore(this.storePath, RECEIPT_STORE, (current) => {
        const pruned = pruneReceipts(current.entries, Date.now(), this.limit, this.maxAgeMs);
        return pruned.expired > 0 || pruned.overflow > 0 ? { value: pruned, entries: pruned.kept } : { value: pruned };
      }).value;
      if (prune.expired > 0 || prune.overflow > 0) logger.info('Agent routine schedule receipts pruned', { path: this.storePath, expired: prune.expired, overflow: prune.overflow, kept: prune.kept.length });
    }
    this.lastMaintenanceSummary = { path: this.storePath, recovered: read.unreadable === undefined ? 'none' : 'unreadable', expired: prune.expired, overflow: prune.overflow, kept: prune.kept.length };
    return { path: this.storePath, receipts: [...prune.kept].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
  }

  public get(id: string): RoutineScheduleReceipt | null {
    const normalized = id.trim().toLowerCase();
    if (!normalized) return null;
    return this.snapshot().receipts.find((receipt) => receipt.id.toLowerCase() === normalized) ?? null;
  }

  /** Record one promotion attempt (entries this build cannot read stay as they were). */
  public append(connection: AgentConnectedHostConnection, preview: RoutineSchedulePromotionPreview, result: RoutineSchedulePromotionResult): RoutineScheduleReceipt {
    return updateJsonStore(this.storePath, RECEIPT_STORE, (read) => {
      const receipt = buildReceipt(read.entries, connection, preview, result);
      const prune = pruneReceipts([...read.entries, receipt], Date.now(), this.limit, this.maxAgeMs);
      if (prune.expired > 0 || prune.overflow > 0) logger.info('Agent routine schedule receipts pruned on append', { path: this.storePath, expired: prune.expired, overflow: prune.overflow, kept: prune.kept.length });
      return { value: receipt, entries: prune.kept };
    }).value;
  }

  /** Remove receipts by id; how many were removed (a repeat removes nothing). */
  public remove(receiptIds: readonly string[]): number {
    const ids = new Set(receiptIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
    if (ids.size === 0) return 0;
    return updateJsonStore(this.storePath, RECEIPT_STORE, (read) => {
      const kept = read.entries.filter((receipt) => !ids.has(receipt.id.toLowerCase()));
      const removed = read.entries.length - kept.length;
      return removed === 0 ? { value: 0 } : { value: removed, entries: kept };
    }).value;
  }
}

/** Reap receipts whose schedule the host authoritatively does not have; a failed list reaps nothing, a young receipt is left. */
export function reapMissingRoutineScheduleReceipts(store: RoutineScheduleReceiptStore, result: RoutineScheduleCorrelationResult, now: number = Date.now()): RoutineScheduleReceiptReaping {
  if (!result.ok) return { authoritative: false, reaped: 0, reapedIds: [], withinGrace: 0 };
  const reapable: string[] = [];
  let withinGrace = 0;
  for (const correlation of result.correlations) {
    if (correlation.liveStatus !== 'missing') continue;
    const created = Date.parse(correlation.receipt.createdAt);
    if (Number.isFinite(created) && now - created < ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS) { withinGrace += 1; continue; }
    reapable.push(correlation.receipt.id);
  }
  const reaped = store.remove(reapable);
  if (reaped > 0) logger.info('Agent routine schedule receipts reaped: the connected host no longer has these schedules', { path: store.path, reaped, withinGrace, scheduleCount: result.scheduleCount });
  return { authoritative: true, reaped, reapedIds: reaped > 0 ? reapable : [], withinGrace };
}

function normalizeForMatch(value: string | undefined): string { return (value ?? '').trim().toLowerCase(); }
function isoTime(value: string): string | null { const time = new Date(value).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : null; }

function readLiveScheduleDefinition(value: unknown): { readonly kind?: RoutineScheduleKind | undefined; readonly value?: string | undefined; readonly timezone?: string | undefined } {
  if (!isRecord(value)) return {};
  if (value['kind'] === 'cron') return { kind: 'cron', value: readString(value, 'expression') ?? undefined, timezone: readString(value, 'timezone') ?? undefined };
  if (value['kind'] === 'every') { const intervalMs = readNumber(value, 'intervalMs'); return { kind: 'every', value: intervalMs === undefined ? undefined : formatEveryInterval(intervalMs) }; }
  if (value['kind'] === 'at') { const at = readNumber(value, 'at'); return { kind: 'at', value: at === undefined ? undefined : new Date(at).toISOString() }; }
  return {};
}

/** The host's schedule as it keeps it, for showing it in words; undefined when it does not read as one. */
function readLiveScheduleDefinitionWhole(value: unknown): AutomationScheduleDefinition | undefined {
  if (!isRecord(value)) return undefined;
  if (value['kind'] === 'cron') {
    const expression = readString(value, 'expression');
    if (!expression) return undefined;
    const timezone = readString(value, 'timezone');
    const staggerMs = readNumber(value, 'staggerMs');
    return { kind: 'cron', expression, ...(timezone ? { timezone } : {}), ...(staggerMs !== undefined ? { staggerMs } : {}) };
  }
  if (value['kind'] === 'every') { const intervalMs = readNumber(value, 'intervalMs'); return intervalMs === undefined ? undefined : { kind: 'every', intervalMs }; }
  if (value['kind'] === 'at') { const at = readNumber(value, 'at'); return at === undefined ? undefined : { kind: 'at', at }; }
  return undefined;
}

function readLiveScheduleRecord(value: unknown): RoutineScheduleLiveRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id')?.trim();
  const name = readString(value, 'name')?.trim();
  if (!id || !name) return null;
  const schedule = readLiveScheduleDefinition(value['schedule']);
  const definition = readLiveScheduleDefinitionWhole(value['schedule']);
  // What it runs: the job's execution prompt, else its description.
  const execution: Record<string, unknown> = isRecord(value['execution']) ? value['execution'] : {};
  const prompt = (readString(execution, 'prompt') ?? readString(value, 'description'))?.trim();
  return {
    id, name,
    status: readString(value, 'status') ?? undefined,
    enabled: readBoolean(value, 'enabled'),
    scheduleKind: schedule.kind, scheduleValue: schedule.value, timezone: schedule.timezone,
    ...(definition ? { definition } : {}),
    ...(prompt ? { prompt } : {}),
    nextRunAt: readNumber(value, 'nextRunAt'), lastRunAt: readNumber(value, 'lastRunAt'),
    runCount: readNumber(value, 'runCount'), successCount: readNumber(value, 'successCount'), failureCount: readNumber(value, 'failureCount'),
  };
}

function readLiveSchedules(output: ScheduleListOutput): readonly RoutineScheduleLiveRecord[] {
  const record: Record<string, unknown> = isRecord(output) ? output : {};
  const jobs: readonly unknown[] = Array.isArray(record['jobs']) ? record['jobs'] : [];
  return jobs.map(readLiveScheduleRecord).filter((schedule): schedule is RoutineScheduleLiveRecord => schedule !== null);
}

function cadenceMatches(receipt: RoutineScheduleReceipt, schedule: RoutineScheduleLiveRecord): boolean {
  if (receipt.scheduleKind !== schedule.scheduleKind) return false;
  if (receipt.scheduleKind === 'at') {
    const left = isoTime(receipt.scheduleValue);
    const right = schedule.scheduleValue ? isoTime(schedule.scheduleValue) : null;
    return Boolean(left && right && left === right);
  }
  return normalizeForMatch(receipt.scheduleValue) === normalizeForMatch(schedule.scheduleValue);
}

function findScheduleForReceipt(receipt: RoutineScheduleReceipt, schedules: readonly RoutineScheduleLiveRecord[]): { readonly reason: RoutineScheduleCorrelation['matchReason']; readonly schedule?: RoutineScheduleLiveRecord | undefined } {
  if (receipt.scheduleId) {
    const byId = schedules.find((schedule) => schedule.id === receipt.scheduleId);
    if (byId) return { reason: 'schedule-id', schedule: byId };
  }
  const byNameAndCadence = schedules.find((schedule) => normalizeForMatch(schedule.name) === normalizeForMatch(receipt.scheduleName) && cadenceMatches(receipt, schedule));
  return byNameAndCadence ? { reason: 'name-and-cadence', schedule: byNameAndCadence } : { reason: 'not-found' };
}

function correlateReceipts(receipts: readonly RoutineScheduleReceipt[], schedules: readonly RoutineScheduleLiveRecord[]): readonly RoutineScheduleCorrelation[] {
  return receipts.map((receipt): RoutineScheduleCorrelation => {
    if (receipt.status === 'failed') return { receipt, liveStatus: 'failed-receipt', matchReason: 'failed-receipt' };
    const match = findScheduleForReceipt(receipt, schedules);
    return match.schedule ? { receipt, liveStatus: 'matched', matchReason: match.reason, schedule: match.schedule } : { receipt, liveStatus: 'missing', matchReason: 'not-found' };
  });
}

function listFailure(error: unknown, connection: AgentConnectedHostConnection): RoutineScheduleCorrelationFailure {
  const kind = isHostFailure(error) ? (error.kind === 'cancelled' ? 'connected_host_unavailable' : error.kind) : 'connected_host_error';
  return { ok: false, kind, error: summarizeError(error), route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
}

/** A receipt created on a host other than the one connected now: listed, never checked or reaped against this host. */
export interface RoutineScheduleReceiptOnOtherHost {
  readonly receipt: RoutineScheduleReceipt;
  /** Where it was created; empty when an older build did not record it. */
  readonly host: string;
}

export type RoutineScheduleReconciliation =
  | (RoutineScheduleCorrelationSuccess & { readonly notChecked: readonly RoutineScheduleReceiptOnOtherHost[] })
  | RoutineScheduleCorrelationFailure;

/** Lines naming receipts that belong to another host, or none. */
export function formatReceiptsOnOtherHosts(result: RoutineScheduleReconciliation): readonly string[] {
  if (!result.ok || result.notChecked.length === 0) return [];
  return [
    `  not checked: ${result.notChecked.length} receipt${result.notChecked.length === 1 ? '' : 's'} created on another host (connect to that host to check them)`,
    ...result.notChecked.map(({ receipt, host }) => `  ${receipt.id}  created on ${host || 'an unrecorded host'}, not checked  routine ${receipt.routineId}`),
  ];
}

/**
 * Correlate local receipts against the host's live schedules. Only receipts
 * created on this host are compared and may be reaped; one from another host is
 * listed as not checked. Never rejects.
 */
export async function reconcileRoutineScheduleReceipts(
  connection: AgentConnectedHostConnection,
  snapshot: RoutineScheduleReceiptSnapshot,
  store?: RoutineScheduleReceiptStore,
): Promise<RoutineScheduleReconciliation> {
  if (!connection.token) {
    return { ok: false, kind: connectionUnavailableKind(connection), error: connectionUnavailableMessage(connection), route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
  }
  const here = normalizeHostUrl(connection.baseUrl);
  const ours = snapshot.receipts.filter((receipt) => receipt.connectedHostBaseUrl && normalizeHostUrl(receipt.connectedHostBaseUrl) === here);
  const notChecked = snapshot.receipts.filter((receipt) => !ours.includes(receipt)).map((receipt) => ({ receipt, host: receipt.connectedHostBaseUrl }));
  let result: RoutineScheduleCorrelationSuccess & { readonly notChecked: readonly RoutineScheduleReceiptOnOtherHost[] };
  try {
    const output = await createConnectedHost(() => connectedHostOf(connection)).invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    const schedules = readLiveSchedules(output);
    result = { ok: true, kind: ROUTINE_SCHEDULE_LIST_METHOD, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl, scheduleCount: schedules.length, receiptCount: ours.length, correlations: correlateReceipts(ours, schedules), notChecked };
  } catch (error) {
    return listFailure(error, connection);
  }
  const reapTarget = store ?? (snapshot.path ? new RoutineScheduleReceiptStore(snapshot.path) : null);
  if (!reapTarget) return result;
  try {
    const reaping = reapMissingRoutineScheduleReceipts(reapTarget, result);
    return { ...result, reaping: { reaped: reaping.reaped, withinGrace: reaping.withinGrace, reapedIds: reaping.reapedIds } };
  } catch (error) {
    // The host answered, so the listing is still true; only the housekeeping failed.
    logger.warn('Agent routine schedule receipt reap failed; the reconciliation result is unaffected', { path: reapTarget.path, error: summarizeError(error) });
    return result;
  }
}

export interface LiveSchedulesFetch {
  readonly ok: boolean;
  readonly schedules: readonly RoutineScheduleLiveRecord[];
  readonly error?: string | undefined;
}

/** Every live schedule on the connected host, with no receipt correlation; never throws. */
export async function fetchLiveSchedules(connection: AgentConnectedHostConnection): Promise<LiveSchedulesFetch> {
  if (!connection.token) return { ok: false, schedules: [], error: connectionUnavailableMessage(connection) };
  try {
    const output = await createConnectedHost(() => connectedHostOf(connection)).invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    return { ok: true, schedules: readLiveSchedules(output) };
  } catch (error) {
    return { ok: false, schedules: [], error: summarizeError(error) };
  }
}

// ---------------------------------------------------------------------------- their words

function formatDeliveryTargetKind(target: { readonly kind?: string | undefined; readonly surfaceKind?: string | undefined }): string {
  if (target.kind === 'surface') return `channel${target.surfaceKind ? `/${target.surfaceKind}` : ''}`;
  return `${target.kind ?? 'unknown'}${target.surfaceKind ? `/${target.surfaceKind}` : ''}`;
}

function formatDeliveryTarget(target: RoutineScheduleReceiptDeliveryTarget): string {
  const details = [target.routeId ? `route=${target.routeId}` : '', target.address ? `address=${target.address}` : '', target.label ? `label=${target.label}` : ''].filter(Boolean);
  return `${formatDeliveryTargetKind(target)}${details.length > 0 ? ` ${details.join(' ')}` : ''}`;
}

function formatRoutineScheduleFailureKind(kind: string): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  if (kind === 'connected_host_error') return 'connected host error';
  return kind.replace(/[_-]+/g, ' ');
}

/** The Agent command line that makes the same schedule, every option the preview shows repeated (a webhook address shown as a placeholder). */
export function routineScheduleConfirmCommand(preview: RoutineSchedulePromotionPreview, options: { readonly redactWebhook?: boolean | undefined } = {}): string {
  const { payload } = preview;
  const selector = payload.kind === 'cron' ? { flag: '--cron', value: String(payload.cron ?? '') } : payload.kind === 'every' ? { flag: '--every', value: String(payload.every ?? '') } : { flag: '--at', value: String(payload.at ?? '') };
  const args = ['goodvibes-agent routines promote', scheduleRouteArg(preview.routineId), selector.flag, scheduleRouteArg(selector.value)];
  if (typeof payload.timezone === 'string' && payload.timezone) args.push('--timezone', scheduleRouteArg(payload.timezone));
  if (typeof payload.name === 'string' && payload.name) args.push('--name', scheduleRouteArg(payload.name));
  if (typeof payload.provider === 'string' && payload.provider) args.push('--provider', scheduleRouteArg(payload.provider));
  if (typeof payload.model === 'string' && payload.model) args.push('--model', scheduleRouteArg(payload.model));
  if (payload.enabled === false) args.push('--disabled');
  for (const target of payload.delivery?.targets ?? []) {
    const flag = deliveryTargetFlag(target);
    const hidden = options.redactWebhook === true && flag?.flag === '--delivery-webhook';
    if (flag) args.push(flag.flag, scheduleRouteArg(hidden ? '<webhook-url>' : flag.value));
  }
  args.push('--yes');
  return args.join(' ');
}

export function formatRoutineSchedulePreview(preview: RoutineSchedulePromotionPreview): string {
  const schedule = preview.payload.kind === 'cron'
    ? `${preview.payload.cron}${preview.payload.timezone ? ` [${preview.payload.timezone}]` : ''}`
    : preview.payload.kind === 'every' ? String(preview.payload.every) : String(preview.payload.at);
  const delivery = preview.payload.delivery;
  const deliveryTargetCount = delivery?.targets.length ?? 0;
  return [
    'GoodVibes schedule preview for Agent routine',
    `  routine ${preview.routineName} (${preview.routineId})`,
    `  route ${preview.method} ${preview.route}`,
    `  name ${String(preview.payload.name ?? '(connected-host default)')}`,
    `  schedule ${preview.payload.kind} ${schedule}`,
    `  enabled ${preview.payload.enabled === false ? 'no' : 'yes'}`,
    `  delivery: ${delivery?.mode ?? 'none'}${deliveryTargetCount > 0 ? ` (${deliveryTargetCount} target${deliveryTargetCount === 1 ? '' : 's'})` : ''}`,
    '  target connected GoodVibes host/main conversation route',
    '  policy isolated Agent Knowledge only; no default knowledge/non-Agent fallback; no delegated review unless explicitly requested',
    ...scheduleConfirmationRouteLines({ workspace: 'workspace action:"run" actionId:"schedule-promote-routine"', cli: routineScheduleConfirmCommand(preview, { redactWebhook: true }) }),
  ].join('\n');
}

export function formatRoutineScheduleSuccess(result: RoutineSchedulePromotionSuccess): string {
  const record: Record<string, unknown> = isRecord(result.schedule) ? result.schedule : {};
  const id = readString(record, 'id') ?? '(unknown)';
  const status = readString(record, 'status') ?? (record['enabled'] === false ? 'paused' : 'enabled');
  return [
    result.alreadyExisted
      ? 'The schedule for this routine already exists (an earlier request made it); nothing new was made'
      : `Routine ${result.routineName} now runs on a schedule`,
    `  schedule ${id}`,
    `  status ${status}`,
    scheduleDeliveryLine(record),
    ...scheduleNextRouteLines(id),
  ].join('\n');
}

export function formatRoutineScheduleReceipts(snapshot: RoutineScheduleReceiptSnapshot, limit = 10): string {
  const receipts = snapshot.receipts.slice(0, Math.max(1, limit));
  if (snapshot.receipts.length === 0) {
    return ['Routines put on a schedule', '  None yet: run a routine on a schedule from the routine, in Memory and knowledge or Automation.'].join('\n');
  }
  return [
    `Routines put on a schedule (${snapshot.receipts.length})`,
    ...receipts.map((receipt) => {
      const schedule = receipt.scheduleId ? ` schedule=${receipt.scheduleId}` : '';
      const failure = receipt.status === 'failed' && receipt.failureKind ? ` failure ${formatRoutineScheduleFailureKind(receipt.failureKind)}` : '';
      return `  ${receipt.id}  ${receipt.status}  ${receipt.scheduleKind} ${receipt.scheduleValue}  routine ${receipt.routineId}${schedule}${failure}`;
    }),
    snapshot.receipts.length > receipts.length ? `  ...${snapshot.receipts.length - receipts.length} more` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleReceipt(receipt: RoutineScheduleReceipt): string {
  return [
    `Schedule receipt ${receipt.id}`,
    `  created ${receipt.createdAt}`,
    `  status ${receipt.status}`,
    `  routine ${receipt.routineName} (${receipt.routineId})`,
    `  host: ${receipt.connectedHostBaseUrl}`,
    `  schedule ${receipt.scheduleName}${receipt.scheduleId ? ` (${receipt.scheduleId})` : ''}`,
    receipt.scheduleStatus ? `  schedule status ${receipt.scheduleStatus}` : '',
    `  cadence: ${receipt.scheduleKind} ${receipt.scheduleValue}${receipt.timezone ? ` [${receipt.timezone}]` : ''}`,
    `  enabled ${receipt.enabled ? 'yes' : 'no'}`,
    receipt.provider ? `  provider ${receipt.provider}` : '',
    receipt.model ? `  model ${receipt.model}` : '',
    `  target ${formatDeliveryTargetKind(receipt.target)}`,
    receipt.deliveryMode ? `  delivery: ${receipt.deliveryMode}` : '',
    ...(receipt.deliveryTargets ?? []).map((target) => `  delivery target: ${formatDeliveryTarget(target)}`),
    receipt.failureKind ? `  failure: ${receipt.failureKind}` : '',
    receipt.failureError ? `  error: ${receipt.failureError}` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleCorrelation(result: RoutineScheduleCorrelationResult, limit = 10): string {
  if (!result.ok) {
    return [
      `Could not check the scheduled routines: ${formatRoutineScheduleFailureKind(result.kind)}`,
      `  ${result.error}`,
      result.baseUrl ? `  host ${result.baseUrl}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n');
  }
  const correlations = result.correlations.slice(0, Math.max(1, limit));
  if (result.receiptCount === 0) {
    return ['Scheduled routines checked against the host', `  live schedules: ${result.scheduleCount}`, '  No routine was put on a schedule on this host yet.'].join('\n');
  }
  const matched = result.correlations.filter((entry) => entry.liveStatus === 'matched').length;
  const missing = result.correlations.filter((entry) => entry.liveStatus === 'missing').length;
  const failed = result.correlations.filter((entry) => entry.liveStatus === 'failed-receipt').length;
  return [
    'Scheduled routines checked against the host',
    `  receipts: ${result.receiptCount}; live schedules: ${result.scheduleCount}; still there: ${matched}; gone: ${missing}; attempts that failed: ${failed}`,
    ...correlations.map((entry) => {
      const receipt = entry.receipt;
      const schedule = entry.schedule;
      const live = schedule ? ` live=${schedule.id}; status ${schedule.status ?? (schedule.enabled === false ? 'paused' : 'enabled')}` : '';
      const runs = schedule && schedule.runCount !== undefined ? ` runs ${schedule.runCount}/${schedule.successCount ?? 0}/${schedule.failureCount ?? 0}` : '';
      const next = schedule?.nextRunAt ? ` next ${new Date(schedule.nextRunAt).toISOString()}` : '';
      return `  ${receipt.id}  ${entry.liveStatus}  routine ${receipt.routineId}${live}${runs}${next}`;
    }),
    result.correlations.length > correlations.length ? `  ...${result.correlations.length - correlations.length} more` : '',
    result.reaping && result.reaping.reaped > 0
      ? `  retired ${result.reaping.reaped} receipt${result.reaping.reaped === 1 ? '' : 's'} whose schedule the host no longer has: ${result.reaping.reapedIds.join(', ')}`
      : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleFailure(failure: RoutineSchedulePromotionFailure): string {
  return [
    `No schedule was made: ${formatRoutineScheduleFailureKind(failure.kind)}`,
    `  ${failure.error}`,
    failure.baseUrl ? `  host ${failure.baseUrl}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}
