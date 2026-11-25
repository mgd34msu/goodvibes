/**
 * Who is who is the daemon's (capabilities/builtin/safety-methods.ts), shown and changed in Permissions and safety;
 * no slash command carries it. The "Who" list a form chooses from reads the daemon through this app's binding
 * (terminal-shell/principals-command.ts).
 */
import { wirePrincipalsList } from '@goodvibes/engine/terminal-shell/principals-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';

export function registerPrincipalsRuntimeCommands(_registry: CommandRegistry): void {
  wirePrincipalsList<CommandContext>(capabilityBinding);
}
