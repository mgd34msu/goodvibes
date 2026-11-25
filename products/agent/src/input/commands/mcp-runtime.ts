import { registerMcpCommand } from '@goodvibes/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';
/** `/mcp` is one description shared with the other terminal app (terminal-shell/mcp-runtime-commands.ts); the daemon writes the config files. */
export function registerMcpRuntimeCommands(registry: CommandRegistry): void {
  registerMcpCommand<CommandContext>(registry, capabilityBinding);
}
