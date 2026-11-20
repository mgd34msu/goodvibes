/**
 * connected-schedule.ts, creating a standing schedule on the connected host.
 *
 * The one create path for the Agent's own schedule commands (reminders and
 * promoted routines, from the slash commands and the CLI). The host does not
 * take an idempotency key on `automation.schedules.create`, so the create first
 * looks for the schedule a lost earlier answer already made (`findSameSchedule`,
 * the matcher the model's schedule tools use too).
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { createConnectedHost, isHostFailure, type HostFailureKind } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { findSameSchedule } from '@goodvibes/engine/terminal-shell/agent-turn/schedule-delivery-targets';
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
  // The connection's own reason (dial turned off, no credential, host too old) reaches the failure through the client.
  const host = createConnectedHost(() => ({
    baseUrl: connection.baseUrl,
    token: connection.token,
    credential: connection.tokenPath,
    ...(connection.source === undefined ? {} : { source: connection.source }),
    ...(connection.unavailable === undefined ? {} : { unavailable: connection.unavailable }),
  }));
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
