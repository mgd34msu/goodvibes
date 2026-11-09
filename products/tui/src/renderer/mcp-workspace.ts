import { createMcpWorkspaceRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/mcp-workspace';
export const { renderMcpWorkspace } = createMcpWorkspaceRenderer({
  formWriteHelp: 'Writes a server through the platform MCP config manager, then reloads the live runtime without restarting the TUI.',
  configHelp:
    'Project scope writes to this workspace. Global scope writes to your user MCP config. External Claude/Desktop config files are shown but not edited here.',
  removeHelp: 'Press y to remove, n or Esc to cancel.',
  reloadHelp: '',
  browseEnter: 'edit or run',
  freshnessLabel: 'schema',
  semanticStatus: false,
  originLabel: (source) => source,
});
