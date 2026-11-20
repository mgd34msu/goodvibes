import { registerMcpCommand } from '@goodvibes/engine/terminal-shell/mcp-runtime-commands';
import type { CommandRegistry } from '../command-registry.ts';
/** `/mcp` is one description shared with the other terminal app (terminal-shell/mcp-runtime-commands.ts). */
export function registerMcpRuntimeCommands(registry: CommandRegistry): void {
  registerMcpCommand(registry);
}
