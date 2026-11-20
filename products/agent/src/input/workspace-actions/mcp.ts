import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's MCP rows open the actions of `/mcp` (terminal-shell/mcp-runtime-commands.ts). */
export const MCP_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'mcp-server': { command: 'mcp', action: 'add-server' },
  'mcp-tools-server': { command: 'mcp', action: 'see-tools' },
  'mcp-repair': { command: 'mcp', action: 'repair' },
};
