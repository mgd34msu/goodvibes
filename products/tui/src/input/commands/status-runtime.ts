import { createStatusCommand } from '@goodvibes-jev/engine/terminal-shell/health-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

/** `/status`, one description shared with the Agent: everything the footer used to carry, in one report (shell/status-report.ts). */
export function registerStatusRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createStatusCommand<CommandContext>((ctx) => {
    if (!ctx.describeStatus) throw commandRefusal('Status is not available in this session.');
    return ctx.describeStatus();
  }));
}
