import { registerServicesCommand } from '@goodvibes/engine/terminal-shell/services-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireServiceRegistry, requireShellPaths } from './runtime-services.ts';

/** `/services` is one description shared with the other terminal app (terminal-shell/services-command.ts). */
export function registerServicesRuntimeCommands(registry: CommandRegistry): void {
  registerServicesCommand<CommandContext>(registry, { requireServiceRegistry, requireShellPaths });
}
