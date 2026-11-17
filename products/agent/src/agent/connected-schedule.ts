/**
 * connected-schedule.ts, creating a standing schedule on the connected host.
 *
 * One create path for every kind of Agent schedule (autonomous work,
 * reminders, promoted routines). The host does not yet take an idempotency key
 * on `automation.schedules.create`, so a create whose answer was lost (a daemon
 * restart, a laptop asleep mid-request) would add a second standing schedule on
 * the natural retry. The create therefore looks first for a schedule that is the
 * same one: same name, same kind and time, and the same prompt. Matching the
 * prompt too keeps two different schedules that share a name and a time from
 * being reported as one.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { parseEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { createConnectedHost, isHostFailure, type HostFailureKind } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

export type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
export type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

export type ConnectedScheduleCreateResult =
  | { readonly ok: true; readonly schedule: ScheduleCreateOutput; readonly alreadyExisted: boolean }
  | {
    readonly ok: false;
    readonly kind: Exclude<HostFailureKind, 'cancelled'>;
    /** `<what failed>: <cause>; <next step>`. */
    readonly error: string;
    readonly baseUrl: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a listed job is the schedule `payload` would create. */
function isSameSchedule(job: Record<string, unknown>, payload: ScheduleCreateInput, intervalMs: number | undefined): boolean {
  if (job.name !== payload.name) return false;
  const execution = job.execution;
  if (isRecord(execution) && typeof execution.prompt === 'string' && execution.prompt !== payload.prompt) return false;
  const schedule = job.schedule;
  if (!isRecord(schedule) || schedule.kind !== payload.kind) return false;
  if (payload.kind === 'cron') {
    const zone = typeof schedule.timezone === 'string' ? schedule.timezone : undefined;
    // Without a timezone the host stores its own local zone, so only an explicit zone is compared.
    return schedule.expression === payload.cron && (!payload.timezone || zone === payload.timezone);
  }
  if (payload.kind === 'every') return schedule.intervalMs === intervalMs;
  return typeof schedule.at === 'number' && schedule.at === Date.parse(String(payload.at));
}

/**
 * Create `payload` on the connected host, or return the schedule a lost
 * earlier answer already created. A host that cannot list schedules yields no
 * match and the create goes ahead.
 */
export async function createConnectedSchedule(
  connection: AgentConnectedHostConnection,
  payload: ScheduleCreateInput,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ConnectedScheduleCreateResult> {
  const host = createConnectedHost(() => ({ baseUrl: connection.baseUrl, token: connection.token, credential: connection.tokenPath }));
  let intervalMs: number | undefined;
  if (payload.kind === 'every') {
    try { intervalMs = parseEveryInterval(String(payload.every)); } catch { intervalMs = undefined; }
  }
  try {
    if (payload.kind !== 'every' || intervalMs !== undefined) {
      const listed: unknown = await host.invoke('automation.schedules.list', {}, { signal: options.signal }).catch((error: unknown) => {
        // An unusable credential or a cancelled call fails the create the same way; anything else only skips the lookup.
        if (isHostFailure(error) && (error.kind === 'auth_required' || error.kind === 'cancelled')) throw error;
        return null;
      });
      const jobs: readonly unknown[] = isRecord(listed) && Array.isArray(listed.jobs) ? listed.jobs : [];
      const existing = jobs.find((job): job is Record<string, unknown> => isRecord(job) && isSameSchedule(job, payload, intervalMs));
      if (existing) return { ok: true, schedule: existing as unknown as ScheduleCreateOutput, alreadyExisted: true };
    }
    const schedule = await host.invoke('automation.schedules.create', payload, { signal: options.signal });
    return { ok: true, schedule, alreadyExisted: false };
  } catch (error) {
    if (isHostFailure(error)) {
      return { ok: false, kind: error.kind === 'cancelled' ? 'connected_host_error' : error.kind, error: error.message, baseUrl: connection.baseUrl };
    }
    return { ok: false, kind: 'connected_host_error', error: `automation.schedules.create on the connected host failed: ${error instanceof Error ? error.message : String(error)}`, baseUrl: connection.baseUrl };
  }
}
