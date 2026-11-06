import { createConfigWorkspaceCommand } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register(configWorkspaceCommand);
}

const configWorkspaceCommand = createConfigWorkspaceCommand<CommandContext>({
  description: 'Open the fullscreen configuration workspace',
  hidden: true,
  usage: '[category|key]',
  argsHint: '[category|key]',
});
