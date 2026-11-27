/**
 * command-line-ask.ts, how a call typed as a command (`goodvibes do`, held for the owner: capabilities/command-line-hold.ts)
 * is told on its card: the capability gate adds `askedAs: command-line` to the call it decides (daemon/capability-owner-gate.ts),
 * and the card reads "Typed as a command on this machine: <the capability's question>" (ask-presentation.ts). Read only
 * from a record the gate raised as the owner's own act (`ownerOnly: owner-act`), which a wire raise never carries, so no
 * other caller can word a card this way.
 */
import type { PermissionPromptRequest } from './prompt.js';

/** The argument the capability gate adds to a command line's call. */
export const COMMAND_LINE_ASK_ARG = 'askedAs';
/** Its value. */
export const COMMAND_LINE_ASK = 'command-line';

/** Whether an ask is a command line's call the capability gate held for the owner. */
export function isCommandLineAsk(request: Pick<PermissionPromptRequest, 'tool' | 'args' | 'ownerOnly' | 'attribution'>): boolean {
  return request.tool === 'capability_run' && request.args[COMMAND_LINE_ASK_ARG] === COMMAND_LINE_ASK
    && request.ownerOnly === 'owner-act' && request.attribution?.kind === 'outside-caller';
}
