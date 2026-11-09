import { registerTriggerSupervisorCommand } from '@goodvibes-jev/engine/terminal-shell/trigger-supervisor-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
export function registerTriggerCommands(registry: CommandRegistry): void {
  registerTriggerSupervisorCommand<CommandContext>(registry, { isOwner: context => isDirectOwnerCommandContext(context, 'triggers') });
}
