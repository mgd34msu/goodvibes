import { registerRemoteTriggerSupervisorCommand } from '@goodvibes-jev/engine/terminal-shell/trigger-supervisor-command';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
export function registerTriggerCommands(registry: CommandRegistry): void {
  registerRemoteTriggerSupervisorCommand<CommandContext>(registry, { ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'triggers') });
}
