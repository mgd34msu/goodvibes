import { readJsonStore, updateJsonStore, type JsonStoreSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { formatEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { createConnectedHost, isHostFailure } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { isRoutineScheduleDeliverySurfaceKind } from './routine-schedule-args.ts';
import {
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type AgentConnectedHostConnection,
  type RoutineScheduleCorrelation,
  type RoutineScheduleCorrelationFailure,
  type RoutineScheduleCorrelationResult,
  type RoutineScheduleCorrelationSuccess,
  type RoutineScheduleDeliveryKind,
  type RoutineScheduleKind,
  type RoutineScheduleLiveRecord,
  type RoutineSchedulePromotionPreview,
  type RoutineSchedulePromotionResult,
  type RoutineScheduleReceipt,
  type RoutineScheduleReceiptDeliveryTarget,
  type RoutineScheduleReceiptSnapshot,
} from './routine-schedule-promotion.ts';

type ScheduleCreateInput = RoutineSchedulePromotionPreview['payload'];
type ScheduleDeliveryInput = NonNullable<ScheduleCreateInput['delivery']>;
type ScheduleListOutput = OperatorMethodOutput<'automation.schedules.list'>;

const RECEIPT_STORE_VERSION = 1;

/**
 * Count cap on stored routine-schedule receipts. These are low volume, one per
 * promotion attempt, which is a deliberate user action rather than a per-turn
 * event, so 200 is many months of normal use while still bounding the file to a
 * few hundred KB. Applied together with the age TTL: a receipt must survive BOTH.
 */
const ROUTINE_SCHEDULE_RECEIPT_LIMIT = 200;
/**
 * Age TTL on stored routine-schedule receipts. A receipt records a promotion
 * attempt against the connected host; after a quarter the live schedule (or its
 * absence) is the authority and the local record is history nobody consults.
 * 90 days is longer than the prompt-receipt TTL because these are rare, small,
 * and describe lasting host state rather than one turn.
 */
const ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Grace window before a receipt whose schedule the host does not list may be
 * reaped. A schedule created seconds ago can legitimately be absent from a list
 * response that raced it; five minutes is far longer than that window and far
 * shorter than the TTL, so a genuinely orphaned receipt still retires promptly.
 */
const ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS = 5 * 60 * 1000;

/** What a store read/prune had to recover from or reclaim, the disclosure record. */
export interface RoutineScheduleReceiptMaintenance {
  readonly path: string;
  /** `unreadable`: the file was not JSON; the next write copies it aside under a dated name before replacing it. */
  readonly recovered: 'none' | 'unreadable';
  /** Receipts dropped because they aged past the TTL. */
  readonly expired: number;
  /** Receipts dropped because they fell outside the count cap. */
  readonly overflow: number;
  readonly kept: number;
}

/** What a reconcile-time reap removed, the disclosure record. */
export interface RoutineScheduleReceiptReaping {
  /** False when the connected host was not authoritative (unreachable/auth/route failure): nothing is ever reaped then. */
  readonly authoritative: boolean;
  readonly reaped: number;
  /** Ids of the receipts removed, so the surface can name what it retired. */
  readonly reapedIds: readonly string[];
  /** Receipts the host did not list but that are too young to reap yet. */
  readonly withinGrace: number;
}

interface ReceiptPruneOutcome {
  readonly kept: readonly RoutineScheduleReceipt[];
  readonly expired: number;
  readonly overflow: number;
}

/**
 * Apply BOTH bounds: the age TTL first, then the count cap over what is left.
 * Receipts are ordered oldest-first so the tail is the newest set. A receipt with
 * an unparseable createdAt is kept, a bad timestamp must never read as "old".
 */
function pruneReceipts(
  receipts: readonly RoutineScheduleReceipt[],
  now: number,
  limit: number,
  maxAgeMs: number,
): ReceiptPruneOutcome {
  const ordered = [...receipts].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fresh = ordered.filter((receipt) => {
    const created = Date.parse(receipt.createdAt);
    return !Number.isFinite(created) || now - created <= maxAgeMs;
  });
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

function nowIso(): string {
  return new Date().toISOString();
}

function redactedDeliveryAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return `${url.protocol}//${url.host}/...`;
  } catch {
    return '[redacted]';
  }
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
  const status = value.status === 'created' || value.status === 'failed' ? value.status : null;
  const scheduleKind = value.scheduleKind === 'cron' || value.scheduleKind === 'every' || value.scheduleKind === 'at'
    ? value.scheduleKind
    : null;
  const scheduleValue = readString(value, 'scheduleValue')?.trim();
  const target = isRecord(value.target) ? value.target : {};
  const deliveryTargets = Array.isArray(value.deliveryTargets)
    ? value.deliveryTargets.map((target): RoutineScheduleReceiptDeliveryTarget | null => {
      if (!isRecord(target)) return null;
      const kind = target.kind === 'webhook' || target.kind === 'surface' || target.kind === 'integration' || target.kind === 'link'
        ? target.kind
        : null;
      if (!kind) return null;
      const surfaceKind = readString(target, 'surfaceKind') ?? undefined;
      return {
        kind,
        surfaceKind: surfaceKind && isRoutineScheduleDeliverySurfaceKind(surfaceKind) ? surfaceKind : undefined,
        address: readString(target, 'address') ?? undefined,
        routeId: readString(target, 'routeId') ?? undefined,
        label: readString(target, 'label') ?? undefined,
      };
    }).filter((target): target is RoutineScheduleReceiptDeliveryTarget => target !== null)
    : undefined;
  if (!id || !createdAt || !routineId || !routineName || !status || !scheduleKind || !scheduleValue) return null;
  return {
    id,
    createdAt,
    routineId,
    routineName,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status,
    connectedHostBaseUrl: readString(value, 'connectedHostBaseUrl') ?? readString(value, 'daemonBaseUrl') ?? '',
    scheduleId: readString(value, 'scheduleId') ?? undefined,
    scheduleStatus: readString(value, 'scheduleStatus') ?? undefined,
    scheduleName: readString(value, 'scheduleName') ?? routineName,
    scheduleKind,
    scheduleValue,
    timezone: readString(value, 'timezone') ?? undefined,
    provider: readString(value, 'provider') ?? undefined,
    model: readString(value, 'model') ?? undefined,
    enabled: value.enabled !== false,
    target: {
      kind: readString(target, 'kind') ?? undefined,
      surfaceKind: readString(target, 'surfaceKind') ?? undefined,
      preserveThread: readBoolean(target, 'preserveThread'),
      createIfMissing: readBoolean(target, 'createIfMissing'),
    },
    deliveryMode: readString(value, 'deliveryMode') ?? undefined,
    deliveryTargets,
    failureKind: normalizeFailureKind(value.failureKind),
    failureError: readString(value, 'failureError') ?? undefined,
  };
}

const RECEIPT_STORE: JsonStoreSpec<RoutineScheduleReceipt> = {
  label: 'routine schedule receipt store',
  entriesKey: 'receipts',
  version: RECEIPT_STORE_VERSION,
  parseEntry: readReceipt,
};

/** One spelling of a host address, so `http://Host:3421/` and `http://host:3421` compare equal. */
function normalizeHostUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function receiptId(createdAt: string, routineId: string, existing: readonly RoutineScheduleReceipt[]): string {
  const dayStamp = createdAt.slice(0, 10).replace(/-/g, '');
  const base = `routine-schedule-${routineId}-${dayStamp}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ids = new Set(existing.map((receipt) => receipt.id));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${existing.length + 1}`;
}

function scheduleValue(payload: ScheduleCreateInput): string {
  if (payload.kind === 'cron') return String(payload.cron ?? '');
  if (payload.kind === 'every') return String(payload.every ?? '');
  return String(payload.at ?? '');
}

function scheduleKind(payload: ScheduleCreateInput): RoutineScheduleKind {
  if (payload.kind === 'cron' || payload.kind === 'every' || payload.kind === 'at') return payload.kind;
  throw new Error('Routine schedule payload is missing a schedule kind.');
}

function targetSummary(payload: ScheduleCreateInput): RoutineScheduleReceipt['target'] {
  return isRecord(payload.target)
    ? {
      kind: typeof payload.target.kind === 'string' ? payload.target.kind : undefined,
      surfaceKind: typeof payload.target.surfaceKind === 'string' ? payload.target.surfaceKind : undefined,
      preserveThread: typeof payload.target.preserveThread === 'boolean' ? payload.target.preserveThread : undefined,
      createIfMissing: typeof payload.target.createIfMissing === 'boolean' ? payload.target.createIfMissing : undefined,
    }
    : {};
}

function deliveryMode(payload: ScheduleCreateInput): string | undefined {
  return isRecord(payload.delivery) && typeof payload.delivery.mode === 'string' ? payload.delivery.mode : undefined;
}

function resultScheduleRecord(result: RoutineSchedulePromotionResult): Record<string, unknown> {
  return result.ok && isRecord(result.schedule) ? result.schedule : {};
}

function buildReceipt(
  existing: readonly RoutineScheduleReceipt[],
  connection: AgentConnectedHostConnection,
  preview: RoutineSchedulePromotionPreview,
  result: RoutineSchedulePromotionResult,
): RoutineScheduleReceipt {
  const createdAt = nowIso();
  const kind = scheduleKind(preview.payload);
  const schedule = resultScheduleRecord(result);
  const scheduleId = readString(schedule, 'id') ?? undefined;
  const scheduleStatus = readString(schedule, 'status') ?? (schedule.enabled === false ? 'paused' : schedule.enabled === true ? 'enabled' : undefined);
  return {
    id: receiptId(createdAt, preview.routineId, existing),
    createdAt,
    routineId: preview.routineId,
    routineName: preview.routineName,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status: result.ok ? 'created' : 'failed',
    connectedHostBaseUrl: connection.baseUrl,
    scheduleId,
    scheduleStatus,
    scheduleName: String(preview.payload.name ?? `Agent routine: ${preview.routineName}`),
    scheduleKind: kind,
    scheduleValue: scheduleValue(preview.payload),
    timezone: kind === 'cron' ? preview.payload.timezone : undefined,
    provider: preview.payload.provider,
    model: preview.payload.model,
    enabled: preview.payload.enabled !== false,
    target: targetSummary(preview.payload),
    deliveryMode: deliveryMode(preview.payload),
    deliveryTargets: redactedDeliveryTargets(preview.payload.delivery),
    failureKind: result.ok ? undefined : result.kind,
    failureError: result.ok ? undefined : result.error,
  };
}

export function routineScheduleReceiptStorePath(shellPaths: ShellPathService): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'schedule-receipts.json');
}

export class RoutineScheduleReceiptStore {
  private lastMaintenanceSummary: RoutineScheduleReceiptMaintenance | null = null;

  public constructor(
    private readonly storePath: string,
    private readonly limit = ROUTINE_SCHEDULE_RECEIPT_LIMIT,
    private readonly maxAgeMs = ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS,
  ) {}

  public static fromShellPaths(shellPaths: ShellPathService): RoutineScheduleReceiptStore {
    return new RoutineScheduleReceiptStore(routineScheduleReceiptStorePath(shellPaths));
  }

  public get path(): string {
    return this.storePath;
  }

  /** The last read/prune's disclosure record, or null when the store has not been read yet. */
  public lastMaintenance(): RoutineScheduleReceiptMaintenance | null {
    return this.lastMaintenanceSummary;
  }

  public snapshot(): RoutineScheduleReceiptSnapshot {
    // Reading applies both bounds and writes the result only when something
    // was dropped; the write re-reads under the lock so a receipt another
    // process appended in between is kept. A second call drops nothing.
    const read = readJsonStore(this.storePath, RECEIPT_STORE);
    let prune = pruneReceipts(read.entries, Date.now(), this.limit, this.maxAgeMs);
    if ((prune.expired > 0 || prune.overflow > 0) && read.newerVersion === undefined) {
      prune = updateJsonStore(this.storePath, RECEIPT_STORE, (current) => {
        const pruned = pruneReceipts(current.entries, Date.now(), this.limit, this.maxAgeMs);
        return pruned.expired > 0 || pruned.overflow > 0 ? { value: pruned, entries: pruned.kept } : { value: pruned };
      }).value;
      if (prune.expired > 0 || prune.overflow > 0) {
        logger.info('Agent routine schedule receipts pruned', {
          path: this.storePath,
          expired: prune.expired,
          overflow: prune.overflow,
          kept: prune.kept.length,
        });
      }
    }
    this.lastMaintenanceSummary = {
      path: this.storePath,
      recovered: read.unreadable === undefined ? 'none' : 'unreadable',
      expired: prune.expired,
      overflow: prune.overflow,
      kept: prune.kept.length,
    };
    return {
      path: this.storePath,
      receipts: [...prune.kept].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }

  public get(id: string): RoutineScheduleReceipt | null {
    const normalized = id.trim().toLowerCase();
    if (!normalized) return null;
    return this.snapshot().receipts.find((receipt) => receipt.id.toLowerCase() === normalized) ?? null;
  }

  /**
   * Record one promotion attempt. Entries this build cannot read stay in the
   * file as they were; a file a newer build wrote is refused with a message;
   * a file that is not JSON is copied aside under a dated name, then replaced.
   */
  public append(connection: AgentConnectedHostConnection, preview: RoutineSchedulePromotionPreview, result: RoutineSchedulePromotionResult): RoutineScheduleReceipt {
    return updateJsonStore(this.storePath, RECEIPT_STORE, (read) => {
      const receipt = buildReceipt(read.entries, connection, preview, result);
      const prune = pruneReceipts([...read.entries, receipt], Date.now(), this.limit, this.maxAgeMs);
      if (prune.expired > 0 || prune.overflow > 0) {
        logger.info('Agent routine schedule receipts pruned on append', {
          path: this.storePath,
          expired: prune.expired,
          overflow: prune.overflow,
          kept: prune.kept.length,
        });
      }
      return { value: receipt, entries: prune.kept };
    }).value;
  }

  /**
   * Remove receipts by id. Returns how many were actually removed, so a repeat
   * call over the same ids removes nothing and rewrites nothing.
   */
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

/**
 * Reap receipts whose schedule the connected host authoritatively does not have.
 *
 * Only a successful `automation.schedules.list` is authoritative: when the host
 * is unreachable, unauthorized, or on an incompatible route, `result.ok` is false
 * and NOTHING is reaped, an absent list is not evidence of an absent schedule.
 * Receipts younger than the grace window are also left alone so a schedule created
 * moments ago is never mistaken for one that vanished. Idempotent: the second run
 * finds the receipts already gone and removes nothing.
 */
export function reapMissingRoutineScheduleReceipts(
  store: RoutineScheduleReceiptStore,
  result: RoutineScheduleCorrelationResult,
  now: number = Date.now(),
): RoutineScheduleReceiptReaping {
  if (!result.ok) return { authoritative: false, reaped: 0, reapedIds: [], withinGrace: 0 };
  const reapable: string[] = [];
  let withinGrace = 0;
  for (const correlation of result.correlations) {
    if (correlation.liveStatus !== 'missing') continue;
    const created = Date.parse(correlation.receipt.createdAt);
    if (Number.isFinite(created) && now - created < ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS) {
      withinGrace += 1;
      continue;
    }
    reapable.push(correlation.receipt.id);
  }
  const reaped = store.remove(reapable);
  if (reaped > 0) {
    logger.info('Agent routine schedule receipts reaped: the connected host no longer has these schedules', {
      path: store.path,
      reaped,
      withinGrace,
      scheduleCount: result.scheduleCount,
    });
  }
  return { authoritative: true, reaped, reapedIds: reaped > 0 ? reapable : [], withinGrace };
}

function normalizeForMatch(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isoTime(value: string): string | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function readLiveScheduleDefinition(value: unknown): {
  readonly kind?: RoutineScheduleKind;
  readonly value?: string;
  readonly timezone?: string;
} {
  if (!isRecord(value)) return {};
  if (value.kind === 'cron') {
    return {
      kind: 'cron',
      value: readString(value, 'expression') ?? undefined,
      timezone: readString(value, 'timezone') ?? undefined,
    };
  }
  if (value.kind === 'every') {
    const intervalMs = readNumber(value, 'intervalMs');
    return {
      kind: 'every',
      value: intervalMs === undefined ? undefined : formatEveryInterval(intervalMs),
    };
  }
  if (value.kind === 'at') {
    const at = readNumber(value, 'at');
    return {
      kind: 'at',
      value: at === undefined ? undefined : new Date(at).toISOString(),
    };
  }
  return {};
}

function readLiveScheduleRecord(value: unknown): RoutineScheduleLiveRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id')?.trim();
  const name = readString(value, 'name')?.trim();
  if (!id || !name) return null;
  const schedule = readLiveScheduleDefinition(value.schedule);
  return {
    id,
    name,
    status: readString(value, 'status') ?? undefined,
    enabled: readBoolean(value, 'enabled'),
    scheduleKind: schedule.kind,
    scheduleValue: schedule.value,
    timezone: schedule.timezone,
    nextRunAt: readNumber(value, 'nextRunAt'),
    lastRunAt: readNumber(value, 'lastRunAt'),
    runCount: readNumber(value, 'runCount'),
    successCount: readNumber(value, 'successCount'),
    failureCount: readNumber(value, 'failureCount'),
  };
}

function readLiveSchedules(output: ScheduleListOutput): readonly RoutineScheduleLiveRecord[] {
  const record: Record<string, unknown> = isRecord(output) ? output : {};
  const jobs: readonly unknown[] = Array.isArray(record.jobs) ? record.jobs : [];
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

function findScheduleForReceipt(
  receipt: RoutineScheduleReceipt,
  schedules: readonly RoutineScheduleLiveRecord[],
): { readonly reason: RoutineScheduleCorrelation['matchReason']; readonly schedule?: RoutineScheduleLiveRecord } {
  if (receipt.scheduleId) {
    const byId = schedules.find((schedule) => schedule.id === receipt.scheduleId);
    if (byId) return { reason: 'schedule-id', schedule: byId };
  }
  const byNameAndCadence = schedules.find((schedule) => (
    normalizeForMatch(schedule.name) === normalizeForMatch(receipt.scheduleName)
    && cadenceMatches(receipt, schedule)
  ));
  return byNameAndCadence
    ? { reason: 'name-and-cadence', schedule: byNameAndCadence }
    : { reason: 'not-found' };
}

function correlateReceipts(
  receipts: readonly RoutineScheduleReceipt[],
  schedules: readonly RoutineScheduleLiveRecord[],
): readonly RoutineScheduleCorrelation[] {
  return receipts.map((receipt) => {
    if (receipt.status === 'failed') {
      return {
        receipt,
        liveStatus: 'failed-receipt',
        matchReason: 'failed-receipt',
      };
    }
    const match = findScheduleForReceipt(receipt, schedules);
    return match.schedule
      ? {
        receipt,
        liveStatus: 'matched',
        matchReason: match.reason,
        schedule: match.schedule,
      }
      : {
        receipt,
        liveStatus: 'missing',
        matchReason: 'not-found',
      };
  });
}

/** The connected-host client over a connection the caller already resolved. */
function scheduleHost(connection: AgentConnectedHostConnection) {
  return createConnectedHost(() => ({ baseUrl: connection.baseUrl, token: connection.token, credential: connection.tokenPath }));
}

/** A failed list, from the client's own classification (status, errno, contract): no model reading, no extra probe. */
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
 * Correlate local receipts against the connected host's live schedules.
 *
 * Only receipts created on the host connected now are compared and may be
 * reaped; a receipt from another host (a laptop daemon and a home server, a
 * changed port) is listed as not checked, because this host's list says
 * nothing about it. A successful list drives reapMissingRoutineScheduleReceipts
 * over the compared receipts; a failed list reaps nothing. The store defaults
 * to the one the snapshot came from. Never rejects.
 */
export async function reconcileRoutineScheduleReceipts(
  connection: AgentConnectedHostConnection,
  snapshot: RoutineScheduleReceiptSnapshot,
  store?: RoutineScheduleReceiptStore,
): Promise<RoutineScheduleReconciliation> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      route: ROUTINE_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
    };
  }
  const here = normalizeHostUrl(connection.baseUrl);
  const ours = snapshot.receipts.filter((receipt) => receipt.connectedHostBaseUrl && normalizeHostUrl(receipt.connectedHostBaseUrl) === here);
  const notChecked = snapshot.receipts
    .filter((receipt) => !ours.includes(receipt))
    .map((receipt) => ({ receipt, host: receipt.connectedHostBaseUrl }));
  let result: RoutineScheduleCorrelationSuccess & { readonly notChecked: readonly RoutineScheduleReceiptOnOtherHost[] };
  try {
    const output = await scheduleHost(connection).invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    const schedules = readLiveSchedules(output);
    result = {
      ok: true,
      kind: ROUTINE_SCHEDULE_LIST_METHOD,
      route: ROUTINE_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
      scheduleCount: schedules.length,
      receiptCount: ours.length,
      correlations: correlateReceipts(ours, schedules),
      notChecked,
    };
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
    logger.warn('Agent routine schedule receipt reap failed; the reconciliation result is unaffected', {
      path: reapTarget.path,
      error: summarizeError(error),
    });
    return result;
  }
}

export interface LiveSchedulesFetch {
  readonly ok: boolean;
  readonly schedules: readonly RoutineScheduleLiveRecord[];
  readonly error?: string;
}

/**
 * Fetch every live schedule from the connected host, with no local-receipt
 * correlation attached, the plain list the /schedule list surface needs.
 * Never throws; connection/auth/host failures resolve to { ok: false }.
 */
export async function fetchLiveSchedules(connection: AgentConnectedHostConnection): Promise<LiveSchedulesFetch> {
  if (!connection.token) {
    return { ok: false, schedules: [], error: `No connected-host operator token found at ${connection.tokenPath}` };
  }
  try {
    const output = await scheduleHost(connection).invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    return { ok: true, schedules: readLiveSchedules(output) };
  } catch (error) {
    return { ok: false, schedules: [], error: summarizeError(error) };
  }
}
