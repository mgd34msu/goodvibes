/**
 * The Agent's host for `/agents` (terminal-shell/agents-command.ts). Handing
 * build, fix and review work to the terminal app is a daemon capability
 * (builtin/handed-off.ts): the daemon makes the shared session and keeps the
 * record. Team modes and work contracts belong to the terminal app and are
 * refused here with the reason.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerAgentsCommand } from '@goodvibes/engine/terminal-shell/agents-command';
import { capabilityBinding } from './capability-binding.ts';

const TERMINAL_APP_ONLY = 'This belongs to the terminal app, which runs the agents and keeps their contracts; run it there.';

export function registerDelegationRuntimeCommands(registry: CommandRegistry): void {
  registerAgentsCommand<CommandContext>(registry, {
    contracts: { unavailable: TERMINAL_APP_ONLY },
    team: { unavailable: TERMINAL_APP_ONLY },
  }, capabilityBinding);
}
