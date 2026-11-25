/**
 * `/principals` on the connected host: one description shared with the
 * terminal app (terminal-shell/principals-command.ts), its methods called on
 * the connected host. CI watches are the daemon's Automation capabilities
 * (platform capabilities/builtin/automation.ts), reached from the Automation
 * place. Channel profiles are actions of `/channels`
 * (terminal-shell/channels-command.ts).
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerPrincipalsCommand } from '@goodvibes/engine/terminal-shell/principals-command';
import { capabilityBinding } from './capability-binding.ts';

export function registerConnectedHostAdminCommands(registry: CommandRegistry): void {
  // Each act is a capability the connected host's daemon runs (capabilities/builtin/safety-methods.ts).
  registerPrincipalsCommand<CommandContext>(registry, capabilityBinding);
}
