/**
 * terminal-program-registration.ts, whether a call's registration (daemon-api control-routes.ts
 * `readProgramRegistration`) is one of the terminal programs: the terminal app or the Agent. A registration is set on a
 * call only when the daemon checked the secret it issued that program (`programs.register`,
 * daemon/program-registrations.ts) against the call's own principal and credential kind; a header naming a program, or
 * a key a script made up, names nothing. Pure.
 */

/** The terminal programs a checked registration names. */
const TERMINAL_PROGRAMS: ReadonlySet<string> = new Set(['tui', 'agent']);

/** Whether `registration` is the checked registration of the terminal app or the Agent. `_homeDirectory` is unused. */
export function isTerminalProgramRegistration(_homeDirectory: string, registration: string | undefined): boolean {
  return registration !== undefined && TERMINAL_PROGRAMS.has(registration);
}
