import { createMcpWorkspaceRenderer } from '@goodvibes/engine/terminal-shell/renderer/mcp-workspace';
export const { renderMcpWorkspace, renderMcpWorkspacePackageText } = createMcpWorkspaceRenderer({
  formWriteHelp: 'Writes a server through the platform MCP config manager, then reloads the live runtime without restarting the Agent.',
  configHelp:
    'Project scope writes to this workspace. Global scope writes to your user MCP config. External Claude/Desktop config files are shown but not edited here.',
  removeHelp: 'Press y to remove, n or Esc to cancel.',
  reloadHelp: '',
  browseEnter: 'edit or run',
  freshnessLabel: 'config',
  originLabel: (source) => (source === 'runtime' ? source : source + ' config'),
});
