/**
 * reminder-schedule.ts, a reminder created on this Agent's connected host by
 * the /schedule command. Parsing the arguments and building the request is the
 * shared Agent turn's (`@goodvibes-jev/engine/terminal-shell/agent-turn`),
 * re-exported here for this file's importers.
 */
import { parseEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { REMINDER_SCHEDULE_METHOD, REMINDER_SCHEDULE_ROUTE, type ReminderSchedulePreview, type ReminderScheduleResult } from '@goodvibes-jev/engine/terminal-shell/agent-turn/reminder-schedule';
import { ROUTINE_SCHEDULE_LIST_METHOD } from '@goodvibes-jev/engine/terminal-shell/agent-turn/schedule-delivery-targets';
import {
  classifyConnectedHostScheduleError,
  resolveAgentConnectedHostConnection,
  type AgentConnectedHostConfigReader,
  type AgentConnectedHostConnection,
} from './routine-schedule-promotion.ts';

export { REMINDER_SCHEDULE_METHOD, REMINDER_SCHEDULE_ROUTE, buildReminderSchedulePayload, buildReminderSchedulePreview, buildReminderSchedulePrompt, parseReminderScheduleArgs, type ParsedReminderScheduleArgs, type ReminderScheduleFailure, type ReminderSchedulePreview, type ReminderScheduleResult, type ReminderScheduleSuccess } from '@goodvibes-jev/engine/terminal-shell/agent-turn/reminder-schedule';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

const INCOMPATIBLE_MESSAGE =
  'Connected GoodVibes host compatibility does not satisfy Agent schedule requirements; automation.schedules.create is unavailable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The host's schedule with the same name, kind and time as `payload`, or null.
 * Cron expressions, one-shot times and intervals (compared in milliseconds, as
 * the host stores them) are matched; the create payload carries no idempotency
 * key, so this lookup is what keeps a retry from adding a second reminder.
 * A host that cannot list schedules simply yields no match.
 */
async function findExistingSchedule(
  platformClient: ReturnType<typeof createBrowserGoodVibesPlatform>,
  payload: ScheduleCreateInput,
): Promise<ScheduleCreateOutput | null> {
  let intervalMs: number | undefined;
  if (payload.kind === 'every') {
    try {
      intervalMs = parseEveryInterval(String(payload.every));
    } catch {
      return null;
    }
  } else if (payload.kind !== 'cron' && payload.kind !== 'at') {
    return null;
  }
  let listed: unknown;
  try {
    listed = await platformClient.operator.invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
  } catch {
    return null;
  }
  const jobs: readonly unknown[] = isRecord(listed) && Array.isArray(listed['jobs']) ? listed['jobs'] : [];
  for (const job of jobs) {
    if (!isRecord(job) || job['name'] !== payload.name) continue;
    const schedule = job['schedule'];
    if (!isRecord(schedule) || schedule['kind'] !== payload.kind) continue;
    if (payload.kind === 'cron') {
      const zone = typeof schedule['timezone'] === 'string' ? schedule['timezone'] : undefined;
      // Without --timezone the host stores its own local zone, so only an explicit zone is compared.
      if (schedule['expression'] === payload.cron && (!payload.timezone || zone === payload.timezone)) return job as unknown as ScheduleCreateOutput;
    } else if (payload.kind === 'every') {
      if (schedule['intervalMs'] === intervalMs) return job as unknown as ScheduleCreateOutput;
    } else if (typeof schedule['at'] === 'number' && schedule['at'] === Date.parse(String(payload.at))) {
      return job as unknown as ScheduleCreateOutput;
    }
  }
  return null;
}

export async function createReminderSchedule(
  connection: AgentConnectedHostConnection,
  preview: ReminderSchedulePreview,
): Promise<ReminderScheduleResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      route: REMINDER_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
    };
  }
  try {
    const platformClient = createBrowserGoodVibesPlatform({ baseUrl: connection.baseUrl, authToken: connection.token });
    // A create that dropped after the host committed reads as "unavailable" and
    // invites a retry, which would add a second reminder. Look first.
    const existing = await findExistingSchedule(platformClient, preview.payload);
    if (existing) {
      return {
        ok: true,
        kind: REMINDER_SCHEDULE_METHOD,
        route: REMINDER_SCHEDULE_ROUTE,
        message: preview.message,
        schedule: existing,
        request: preview.payload,
        alreadyExisted: true,
      };
    }
    const schedule = await platformClient.operator.invoke(REMINDER_SCHEDULE_METHOD, preview.payload);
    return {
      ok: true,
      kind: REMINDER_SCHEDULE_METHOD,
      route: REMINDER_SCHEDULE_ROUTE,
      message: preview.message,
      schedule,
      request: preview.payload,
    };
  } catch (error) {
    return classifyConnectedHostScheduleError(error, connection, {
      route: REMINDER_SCHEDULE_ROUTE,
      incompatibleMessage: INCOMPATIBLE_MESSAGE,
    });
  }
}

export function resolveReminderConnectedHostConnection(configManager: AgentConnectedHostConfigReader, homeDirectory: string): AgentConnectedHostConnection {
  return resolveAgentConnectedHostConnection(configManager, homeDirectory);
}
