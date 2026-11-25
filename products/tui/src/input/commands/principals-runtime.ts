/**
 * `/principals` is one description shared with the Agent
 * (terminal-shell/principals-command.ts); the daemon does each act.
 */
import { registerPrincipalsCommand } from '@goodvibes/engine/terminal-shell/principals-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';

export function registerPrincipalsRuntimeCommands(registry: CommandRegistry): void {
  registerPrincipalsCommand<CommandContext>(registry, capabilityBinding);
}
