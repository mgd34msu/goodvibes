/**
 * The `connected_calendar` tool is an Agent turn tool defined in the engine
 * (`terminal-shell/agent-turn/connected-calendar-tool.ts`) and registered by
 * `registerAgentTurnTools`, so the Agent's own process and a turn the daemon
 * hosts for it both offer it. This module is the Agent's import path for it.
 */

export {
  createAgentCalendarTool,
  registerAgentCalendarTool,
  type AgentCalendarToolOptions,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-calendar-tool';
