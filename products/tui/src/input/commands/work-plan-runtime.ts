import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerTodoCommand } from '@goodvibes/engine/terminal-shell/todo-command';
import { openModalCommand } from './runtime-services.ts';

/** `/todo` is one description shared with the Agent (terminal-shell/todo-command.ts); here it also opens the to-do panel. */
export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registerTodoCommand<CommandContext>(registry, (ctx) => openModalCommand(ctx, 'work-plan-modal'));
}
