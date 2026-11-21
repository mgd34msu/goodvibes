/**
 * calendar-oauth-service.ts, the Agent's bridge to the platform calendar OAuth
 * connector. It is defined with the Agent turn tools in the engine
 * (`terminal-shell/agent-turn/calendar-oauth-service.ts`) because a turn the
 * daemon hosts for the Agent creates events through it too; this module is the
 * Agent's import path for it.
 */

export {
  CalendarCreateUnconfirmedError,
  CalendarOAuthService,
  daemonScopedSecrets,
} from '@goodvibes/engine/terminal-shell/agent-turn/calendar-oauth-service';

export type {
  AccountStatus,
  CalendarConfigReader,
  CalendarOAuthServiceOptions,
  CalendarSecretSlice,
  ConnectedCalendar,
  ConnectedEventsRead,
  ConnectResult,
  ConnectStage,
  CreateEventOutcome,
} from '@goodvibes/engine/terminal-shell/agent-turn/calendar-oauth-service';
