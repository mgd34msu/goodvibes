import { createMcpRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireMcpApi, requireShellPaths } from './runtime-services.ts';
export const { registerMcpRuntimeCommands } = createMcpRuntimeCommands<CommandContext>(requireMcpApi, requireShellPaths, {
  hidden: false,
  confirmMutations: false,
  allowAllOnAdd: true,
  present: (message) =>
    message
      .replaceAll(' --yes', '')
      .replaceAll('Agent Workspace -> Tools & MCP -> Add MCP server', 'the MCP workspace')
      .replaceAll('inside Agent', 'inside the TUI')
      .replaceAll('Agent flags', 'client flags')
      .replaceAll('confirmed add/remove/reload actions', 'add/remove/reload actions')
      .replaceAll(
        'trust, role, and quarantine command actions still require explicit confirmation.',
        'trust, role, and quarantine actions use the current workspace policy.',
      )
      .replaceAll('/auth review', '/services auth-review'),
});
