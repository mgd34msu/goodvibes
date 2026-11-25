/**
 * reminder-schedule.ts, a reminder created on this Agent's connected host by
 * the /schedule command. Parsing the arguments and building the request is the
 * shared Agent turn's (`@goodvibes/engine/terminal-shell/agent-turn`),
 * re-exported here for this file's importers.
 */
import { REMINDER_SCHEDULE_METHOD, REMINDER_SCHEDULE_ROUTE, type ReminderSchedulePreview, type ReminderScheduleResult } from '@goodvibes/engine/terminal-shell/agent-turn/reminder-schedule';
import {
  createConnectedSchedule,
  resolveAgentConnectedHostConnection,
  type AgentConnectedHostConfigReader,
  type AgentConnectedHostConnection,
} from '@goodvibes/engine/terminal-shell/agent-turn/routine-schedules';

export { REMINDER_SCHEDULE_METHOD, REMINDER_SCHEDULE_ROUTE, buildReminderSchedulePayload, buildReminderSchedulePreview, buildReminderSchedulePrompt, parseReminderScheduleArgs, type ParsedReminderScheduleArgs, type ReminderScheduleFailure, type ReminderSchedulePreview, type ReminderScheduleResult, type ReminderScheduleSuccess } from '@goodvibes/engine/terminal-shell/agent-turn/reminder-schedule';

/**
 * Create the reminder on the connected host, within the connected-host
 * client's write deadline. A retry after a lost answer returns the reminder the
 * first attempt made instead of adding a second one.
 */
export async function createReminderSchedule(
  connection: AgentConnectedHostConnection,
  preview: ReminderSchedulePreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ReminderScheduleResult> {
  const created = await createConnectedSchedule(connection, preview.payload, options);
  if (!created.ok) {
    return { ok: false, kind: created.kind, error: created.error, route: REMINDER_SCHEDULE_ROUTE, baseUrl: created.baseUrl };
  }
  return {
    ok: true,
    kind: REMINDER_SCHEDULE_METHOD,
    route: REMINDER_SCHEDULE_ROUTE,
    message: preview.message,
    schedule: created.schedule,
    request: preview.payload,
    ...(created.alreadyExisted ? { alreadyExisted: true as const } : {}),
  };
}

export function resolveReminderConnectedHostConnection(configManager: AgentConnectedHostConfigReader, homeDirectory: string): AgentConnectedHostConnection {
  return resolveAgentConnectedHostConnection(configManager, homeDirectory);
}
