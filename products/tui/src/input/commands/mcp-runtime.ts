import { createMcpRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireMcpApi, requireShellPaths } from './runtime-services.ts';
export const { registerMcpRuntimeCommands } = createMcpRuntimeCommands<CommandContext>(requireMcpApi, requireShellPaths, {
  hidden: false,
  confirmMutations: false,
  allowAllOnAdd: true,
  wording: {
    host: 'the TUI',
    flagOwner: 'client',
    addServerPointer: 'the MCP workspace',
    authReviewCommand: '/services auth-review',
    confirmedActions: 'add/remove/reload actions',
    commandPolicy: 'trust, role, and quarantine actions use the current workspace policy.',
  },
});
