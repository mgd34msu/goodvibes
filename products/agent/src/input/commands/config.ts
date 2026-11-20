import { createConfigCommand } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

/** `/config` is one description shared with the terminal app; the Agent changes a setting on its settings screen. */
export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register(createConfigCommand<CommandContext>({}));
}
