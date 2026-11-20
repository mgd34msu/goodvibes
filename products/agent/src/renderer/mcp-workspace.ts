import { createMcpWorkspaceRenderer } from '@goodvibes/engine/terminal-shell/renderer/mcp-workspace';
export const { renderMcpWorkspace, renderMcpWorkspacePackageText } = createMcpWorkspaceRenderer({
  formWriteHelp: 'Workspace writes require explicit confirmation. Type yes on the Confirm field, then save from here.',
  configHelp:
    'Project/global config locations are shown for review. The workspace dispatches confirmed MCP changes through the shell-owned command router.',
  removeHelp: 'Press y to remove through the shell-owned command router, n or Esc to cancel.',
  reloadHelp: 'Press y to reload the MCP runtime from the current config through the shell-owned command router, n or Esc to cancel.',
  browseEnter: 'view or run',
  freshnessLabel: 'config',
  originLabel: (source) => (source === 'runtime' ? source : source + ' config'),
});
