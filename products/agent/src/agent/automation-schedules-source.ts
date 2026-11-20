/**
 * Connected-host schedules for the Activity view's "Coming up".
 *
 * Schedules a person creates (`/schedule add`, a promoted routine, the
 * schedule tools) live on the connected host, the same place the away digest
 * reads their run outcomes from (automation-runs-source.ts). This reads the
 * host's `automation.schedules.list` and keeps only what "Coming up" shows:
 * enabled schedules with a next run. Like the runs source it never throws: a
 * failure resolves to a result naming why, so the caller can say "schedules
 * unavailable" instead of showing an empty list as if nothing were planned.
 */
import { isHostFailure, type ConnectedHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-client';

export const AUTOMATION_SCHEDULES_LIST_METHOD = 'automation.schedules.list';

export interface UpcomingSchedule {
  readonly name: string;
  readonly nextRunAt: number;
}

export interface UpcomingSchedulesResult {
  readonly schedules: readonly UpcomingSchedule[];
  /** Why the host could not be read, when it could not. Absent when it answered. */
  readonly unavailable?: string;
  /** `not_configured`: no host to ask, which is not news. `no_answer`: a configured host did not answer. */
  readonly unavailableKind?: 'not_configured' | 'no_answer';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Enabled schedules on the connected host whose next run is after `now`, soonest first. */
export async function listUpcomingSchedules(
  host: ConnectedHost,
  now: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<UpcomingSchedulesResult> {
  try {
    const output: unknown = await host.invoke(AUTOMATION_SCHEDULES_LIST_METHOD, {}, { signal: options.signal });
    const jobs: readonly unknown[] = isRecord(output) && Array.isArray(output.jobs) ? output.jobs : [];
    const schedules: UpcomingSchedule[] = [];
    for (const job of jobs) {
      if (!isRecord(job) || job.enabled !== true) continue;
      const name = typeof job.name === 'string' && job.name.trim() ? job.name : typeof job.id === 'string' ? job.id : null;
      const nextRunAt = job.nextRunAt;
      if (!name || typeof nextRunAt !== 'number' || !Number.isFinite(nextRunAt) || nextRunAt <= now) continue;
      schedules.push({ name, nextRunAt });
    }
    schedules.sort((a, b) => a.nextRunAt - b.nextRunAt);
    return { schedules };
  } catch (error) {
    if (!isHostFailure(error)) {
      return { schedules: [], unavailable: error instanceof Error ? error.message : String(error), unavailableKind: 'no_answer' };
    }
    const notConfigured = error.kind === 'auth_required'
      && (error.refusal.code === 'no_credential' || error.refusal.code === 'dial_disabled');
    return { schedules: [], unavailable: error.refusal.reason, unavailableKind: notConfigured ? 'not_configured' : 'no_answer' };
  }
}
