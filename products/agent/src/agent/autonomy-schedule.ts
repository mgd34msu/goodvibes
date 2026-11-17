/**
 * autonomy-schedule.ts, an autonomous schedule created on this Agent's
 * connected host. Parsing the arguments and building the request is the shared
 * Agent turn's (`@goodvibes-jev/engine/terminal-shell/agent-turn`), re-exported
 * here for this file's importers.
 */
import {
  AUTONOMY_SCHEDULE_METHOD,
  AUTONOMY_SCHEDULE_ROUTE,
  type AutonomySchedulePreview,
  type AutonomyScheduleResult,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { createConnectedSchedule } from './connected-schedule.ts';
import {
  resolveAgentConnectedHostConnection,
  type AgentConnectedHostConfigReader,
  type AgentConnectedHostConnection,
} from './routine-schedule-promotion.ts';

export {
  AUTONOMY_SCHEDULE_METHOD,
  AUTONOMY_SCHEDULE_ROUTE,
  buildAutonomySchedulePayload,
  buildAutonomySchedulePreview,
  buildAutonomySchedulePrompt,
  parseAutonomyScheduleArgs,
  type AutonomyScheduleFailure,
  type AutonomySchedulePreview,
  type AutonomyScheduleResult,
  type AutonomyScheduleSuccess,
  type ParsedAutonomyScheduleArgs,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/**
 * Create the autonomous schedule on the connected host. A retry after a lost
 * answer returns the schedule the first attempt made instead of adding a second
 * one that would run the same task twice on every tick.
 */
export async function createAutonomySchedule(
  connection: AgentConnectedHostConnection,
  preview: AutonomySchedulePreview,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<AutonomyScheduleResult> {
  const created = await createConnectedSchedule(connection, preview.payload, options);
  if (!created.ok) {
    return { ok: false, kind: created.kind, error: created.error, route: AUTONOMY_SCHEDULE_ROUTE, baseUrl: created.baseUrl };
  }
  return {
    ok: true,
    kind: AUTONOMY_SCHEDULE_METHOD,
    route: AUTONOMY_SCHEDULE_ROUTE,
    task: preview.task,
    successCriteria: preview.successCriteria,
    schedule: created.schedule,
    request: preview.payload,
    ...(created.alreadyExisted ? { alreadyExisted: true } : {}),
  };
}

export function resolveAutonomyConnectedHostConnection(configManager: AgentConnectedHostConfigReader, homeDirectory: string): AgentConnectedHostConnection {
  return resolveAgentConnectedHostConnection(configManager, homeDirectory);
}
