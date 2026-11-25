import { createStatusCommand } from '@goodvibes/engine/terminal-shell/health-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { systemSessionOf } from './session-capabilities.ts';

/** `/status`, one description shared with the Agent: everything the footer used to carry, in one report (shell/status-report.ts). */
export function registerStatusRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createStatusCommand<CommandContext>((ctx) => ({ systemSession: systemSessionOf(ctx) })));
}
