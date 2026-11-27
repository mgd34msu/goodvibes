/**
 * session-capability-slots.ts, the three services the session capabilities and the commands that use them hand each
 * other, bound when their modules load instead of imported both ways (which made a runtime import cycle among
 * session-capabilities.ts, session.ts, session-content.ts, shell-core.ts and onboarding-runtime.ts):
 *  - the session's services and the System place's session (given by session-capabilities.ts), read by
 *    session-content.ts and onboarding-runtime.ts;
 *  - this app's help (given by shell-core.ts), read by session-capabilities.ts.
 * Each is read when a command runs, never at load. The app loads all of them at its start (the command registry).
 */
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import type { CommandContext } from '../command-registry.ts';

type Of<T> = (ctx: CommandContext) => T;
type SystemSession = NonNullable<SessionCapabilityServices['systemSession']>;
type Help = ((about: string) => Promise<string>) | undefined;

let sessionServices: Of<SessionCapabilityServices> | undefined;
let systemSession: Of<SystemSession> | undefined;
let help: Of<Help> | undefined;

function given<T>(slot: Of<T> | undefined, what: string): Of<T> {
  if (!slot) throw new Error(`${what} is not loaded yet (the terminal app loads it at its start).`);
  return slot;
}

/** Given by session-capabilities.ts. */
export function provideSessionCapabilities(services: Of<SessionCapabilityServices>, system: Of<SystemSession>): void {
  sessionServices = services;
  systemSession = system;
}

/** Given by shell-core.ts. */
export function provideHelp(source: Of<Help>): void {
  help = source;
}

export function sessionServicesOf(ctx: CommandContext): SessionCapabilityServices {
  return given(sessionServices, 'The session capabilities')(ctx);
}

export function systemSessionOfSlot(ctx: CommandContext): SystemSession {
  return given(systemSession, 'The System session')(ctx);
}

/** This app's help; undefined until shell-core.ts registered its help sources. */
export function helpOfSlot(ctx: CommandContext): Help {
  return help ? help(ctx) : undefined;
}
