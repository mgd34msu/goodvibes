/**
 * Who is who on the connected host is its daemon's (capabilities/builtin/safety-methods.ts), shown and changed in
 * Permissions and safety; no slash command carries it. The "Who" list a form chooses from reads the connected host
 * through the Agent's binding (terminal-shell/principals-command.ts). CI watches are the daemon's Automation
 * capabilities (platform capabilities/builtin/automation.ts), reached from the Automation place. Channel profiles
 * are actions of `/channels` (terminal-shell/channels-command.ts).
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { wirePrincipalsList } from '@goodvibes/engine/terminal-shell/principals-command';
import { capabilityBinding } from './capability-binding.ts';

export function registerConnectedHostAdminCommands(_registry: CommandRegistry): void {
  wirePrincipalsList<CommandContext>(capabilityBinding);
}
