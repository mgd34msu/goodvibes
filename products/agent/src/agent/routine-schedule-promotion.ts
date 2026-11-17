import { resolveConnectedHost, type ConnectedHostConnection, type ConnectedHostSource, type ConnectedHostUnavailable } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-client';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { createConnectedSchedule } from './connected-schedule.ts';
import { formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import { evaluateAgentRoutineReadiness, type AgentRoutineRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { formatAgentSkillRequirement } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import { deliveryModeFromTargets, normalizeProviderModel, toDeliveryTargetInput, type RoutineScheduleDeliveryKind, type RoutineScheduleDeliverySurfaceKind, type RoutineScheduleDeliveryTargetSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn/schedule-delivery-targets';

import { ROUTINE_SCHEDULE_LIST_METHOD, ROUTINE_SCHEDULE_METHOD, ROUTINE_SCHEDULE_ROUTE, type RoutineScheduleKind, type RoutineScheduleSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn/schedule-delivery-targets';

// The schedule vocabulary is owned by the shared Agent turn; re-exported for this file's importers.
export { ROUTINE_SCHEDULE_LIST_METHOD, ROUTINE_SCHEDULE_METHOD, ROUTINE_SCHEDULE_ROUTE, type RoutineScheduleKind, type RoutineScheduleSpec };

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

export interface AgentConnectedHostConfigReader {
  get(key: string): unknown;
}

export interface AgentConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for, safe to show: a file path, a store name or a setting. */
  readonly tokenPath: string;
  /** Which source the credential came from. */
  readonly source?: ConnectedHostSource;
  /** Present when `token` is null: why (dial turned off, no credential, host too old) and the next step. */
  readonly unavailable?: ConnectedHostUnavailable;
}

// The delivery-target vocabulary is owned by schedule-delivery-targets.ts and
// re-exported here so existing importers keep one import site.
export type { RoutineScheduleDeliveryKind, RoutineScheduleDeliverySurfaceKind, RoutineScheduleDeliveryTargetSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn/schedule-delivery-targets';

export interface RoutineScheduleReceiptDeliveryTarget {
  readonly kind: RoutineScheduleDeliveryKind;
  readonly surfaceKind?: RoutineScheduleDeliverySurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export interface ParsedRoutineSchedulePromotionArgs {
  readonly routineId: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly deliveryTargets: readonly RoutineScheduleDeliveryTargetSpec[];
  readonly name?: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
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
  readonly kind:
    | 'confirmation_required'
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string;
}

export type RoutineSchedulePromotionResult =
  | RoutineSchedulePromotionSuccess
  | RoutineSchedulePromotionFailure;

export interface RoutineScheduleReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly method: typeof ROUTINE_SCHEDULE_METHOD;
  readonly status: 'created' | 'failed';
  readonly connectedHostBaseUrl: string;
  readonly scheduleId?: string;
  readonly scheduleStatus?: string;
  readonly scheduleName: string;
  readonly scheduleKind: RoutineScheduleKind;
  readonly scheduleValue: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly target: {
    readonly kind?: string;
    readonly surfaceKind?: string;
    readonly preserveThread?: boolean;
    readonly createIfMissing?: boolean;
  };
  readonly deliveryMode?: string;
  readonly deliveryTargets?: readonly RoutineScheduleReceiptDeliveryTarget[];
  readonly failureKind?: RoutineSchedulePromotionFailure['kind'];
  readonly failureError?: string;
}

export interface RoutineScheduleReceiptSnapshot {
  readonly path: string;
  readonly receipts: readonly RoutineScheduleReceipt[];
}

export interface RoutineScheduleLiveRecord {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly enabled?: boolean;
  readonly scheduleKind?: RoutineScheduleKind;
  readonly scheduleValue?: string;
  readonly timezone?: string;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly runCount?: number;
  readonly successCount?: number;
  readonly failureCount?: number;
}

export interface RoutineScheduleCorrelation {
  readonly receipt: RoutineScheduleReceipt;
  readonly liveStatus: 'matched' | 'missing' | 'failed-receipt';
  readonly matchReason: 'schedule-id' | 'name-and-cadence' | 'failed-receipt' | 'not-found';
  readonly schedule?: RoutineScheduleLiveRecord;
}

export interface RoutineScheduleCorrelationSuccess {
  readonly ok: true;
  readonly kind: typeof ROUTINE_SCHEDULE_LIST_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl: string;
  readonly scheduleCount: number;
  readonly receiptCount: number;
  readonly correlations: readonly RoutineScheduleCorrelation[];
  /**
   * What this reconciliation retired from the local receipt store. Receipts
   * whose schedule the host no longer lists are removed, so the caller can name
   * them. Absent when no store was reaped.
   */
  readonly reaping?: {
    readonly reaped: number;
    readonly withinGrace: number;
    readonly reapedIds: readonly string[];
  };
}

export interface RoutineScheduleCorrelationFailure {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string;
}

export type RoutineScheduleCorrelationResult =
  | RoutineScheduleCorrelationSuccess
  | RoutineScheduleCorrelationFailure;


/**
 * The connected host and credential, through the Agent's one resolution
 * (`resolveConnectedHost`): one precedence, `daemon.connectedHost.enabled` and
 * the host build check honoured, and the reason carried when there is no token.
 */
export function resolveAgentConnectedHostConnection(
  configManager: AgentConnectedHostConfigReader,
  homeDirectory: string,
): AgentConnectedHostConnection {
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

export function buildRoutineSchedulePayload(
  routine: AgentRoutineRecord,
  parsed: ParsedRoutineSchedulePromotionArgs,
): ScheduleCreateInput {
  if (!parsed.schedule) throw new Error('Schedule is required.');
  const modelRoute = normalizeProviderModel(parsed.provider, parsed.model);
  const payload: ScheduleCreateInput = {
    name: parsed.name ?? `Agent routine: ${routine.name}`,
    prompt: buildRoutineSchedulePrompt(routine),
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
      timezone: parsed.timezone,
    };
  }
  if (parsed.schedule.kind === 'every') {
    return { ...payload, every: parsed.schedule.value };
  }
  return { ...payload, at: parsed.schedule.value };
}

export function buildRoutineSchedulePreview(
  routine: AgentRoutineRecord,
  parsed: ParsedRoutineSchedulePromotionArgs,
): RoutineSchedulePromotionPreview {
  return {
    routineId: routine.id,
    routineName: routine.name,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    payload: buildRoutineSchedulePayload(routine, parsed),
  };
}

/**
 * What stands between a routine and an unattended, recurring connected schedule. The workspace
 * shows the same gate ("needs setup / review before it can be trusted for schedule promotion"):
 * a routine imported from a project file starts disabled and unreviewed, and its steps become a
 * standing scheduled prompt, so the review has to have happened.
 */
export function routinePromotionBlockers(routine: AgentRoutineRecord, surface: 'slash' | 'cli' = 'slash'): readonly string[] {
  // Each blocker names the command that clears it in the program the refusal is read in.
  const command = surface === 'cli' ? 'goodvibes-agent routines' : '/routines';
  const blockers: string[] = [];
  if (!routine.enabled) blockers.push(`it is disabled (run ${command} enable ${routine.id})`);
  if (routine.reviewState !== 'reviewed') blockers.push(`it has not been reviewed (read its steps with ${command} show ${routine.id}, then run ${command} review ${routine.id})`);
  const readiness = evaluateAgentRoutineReadiness(routine);
  if (!readiness.ready) blockers.push(`setup is missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`);
  return blockers;
}

/**
 * Create the routine's standing schedule on the connected host, within the
 * connected-host client's write deadline. A retry after a lost answer returns
 * the schedule the first attempt made instead of adding a second one that runs
 * the routine twice on every tick.
 */
export async function promoteRoutineToConnectedSchedule(
  connection: AgentConnectedHostConnection,
  preview: RoutineSchedulePromotionPreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<RoutineSchedulePromotionResult> {
  const created = await createConnectedSchedule(connection, preview.payload, options);
  if (!created.ok) {
    return { ok: false, kind: created.kind, error: created.error, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: created.baseUrl };
  }
  return {
    ok: true,
    kind: ROUTINE_SCHEDULE_METHOD,
    route: ROUTINE_SCHEDULE_ROUTE,
    routineId: preview.routineId,
    routineName: preview.routineName,
    schedule: created.schedule,
    request: preview.payload,
    ...(created.alreadyExisted ? { alreadyExisted: true as const } : {}),
  };
}
