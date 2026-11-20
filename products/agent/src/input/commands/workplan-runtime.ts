import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerTodoCommand } from '@goodvibes-jev/engine/terminal-shell/todo-command';
import { commandRefusal } from './confirmation.ts';

/**
 * `/todo` is one description shared with the terminal app
 * (terminal-shell/todo-command.ts). The Agent has no to-do panel: the list is
 * shown in the conversation and in the workspace's Work page.
 */
export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registerTodoCommand<CommandContext>(registry, () => {
    throw commandRefusal('The Agent has no to-do panel.', '/todo list shows the list here.');
  });
}
