import { createMcpRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireMcpApi, requireShellPaths } from './runtime-services.ts';
export const { registerMcpRuntimeCommands } = createMcpRuntimeCommands<CommandContext>(requireMcpApi, requireShellPaths, {
  hidden: true,
  confirmMutations: true,
  allowAllOnAdd: false,
  present: (message) => message,
});
