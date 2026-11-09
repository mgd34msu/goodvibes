import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
export interface McpWorkspaceControls {
  readonly active: boolean;
  mode: 'browse' | 'form' | 'delete-confirm' | 'reload-confirm';
  readonly query: string;
  readonly selectedServer: {
    readonly name: string;
  } | null;
  moveSelection(delta: number): void;
  openAddForm(): void;
  openEditForm(name: string): void;
  requestDelete(name: string): void;
  requestReload(): void;
  refreshTools(): Promise<void>;
  appendFormText(text: string): void;
  backspaceFormText(): void;
  confirmDelete(): Promise<void>;
  reloadRuntime(): Promise<void>;
  cancelForm(): void;
  activateSelected(): Promise<void>;
  setQuery(query: string): void;
  adjustFormEnum(direction: 1 | -1): void;
}
export function handleMcpWorkspaceToken(
  workspace: McpWorkspaceControls,
  token: InputToken,
  handleEscape: () => void,
  requestRender: () => void,
): boolean {
  if (!workspace.active) return false;
  if (token.type === 'mouse') {
    if (token.action === 'press' && token.button === 64) workspace.moveSelection(-3);
    else if (token.action === 'press' && token.button === 65) workspace.moveSelection(3);
    else return true;
    requestRender();
    return true;
  }
  const browseAction = (key: string): boolean => {
    if (key === 'a') workspace.openAddForm();
    else if (key === 'e' && workspace.selectedServer) workspace.openEditForm(workspace.selectedServer.name);
    else if (key === 'd' && workspace.selectedServer) workspace.requestDelete(workspace.selectedServer.name);
    else if (key === 'r') workspace.requestReload();
    else if (key === 't') void workspace.refreshTools();
    else return false;
    return true;
  };
  if (token.type === 'text') {
    if (workspace.mode === 'form') {
      workspace.appendFormText(token.value);
    } else if (workspace.mode === 'delete-confirm') {
      if (token.value.toLowerCase() === 'y') void workspace.confirmDelete();
      else if (token.value.toLowerCase() === 'n') workspace.cancelForm();
    } else if (workspace.mode === 'reload-confirm') {
      if (token.value.toLowerCase() === 'y') {
        workspace.mode = 'browse';
        void workspace.reloadRuntime();
      } else if (token.value.toLowerCase() === 'n') workspace.cancelForm();
    } else {
      // Browse: the search row is always live. An action letter fires while
      // the query is empty; everything else is typed into the query.
      const value = token.value.toLowerCase();
      const claimed = workspace.query.length === 0 && [...token.value].length === 1 && 'aedrt'.includes(value);
      if (!claimed || !browseAction(value)) workspace.setQuery(workspace.query + token.value);
    }
    requestRender();
    return true;
  }
  if (token.type !== 'key') return true;
  if (token.logicalName === 'escape') {
    // One level per Esc: the form or a confirmation returns to the browser;
    // the browser closes the workspace.
    if (workspace.mode === 'form' || workspace.mode === 'delete-confirm' || workspace.mode === 'reload-confirm') {
      workspace.cancelForm();
      requestRender();
    } else {
      handleEscape();
    }
    return true;
  }
  if (token.logicalName === 'up') workspace.moveSelection(token.shift ? -5 : -1);
  else if (token.logicalName === 'down') workspace.moveSelection(token.shift ? 5 : 1);
  else if (token.logicalName === 'pageup') workspace.moveSelection(-10);
  else if (token.logicalName === 'pagedown') workspace.moveSelection(10);
  else if (token.logicalName === 'enter') void workspace.activateSelected();
  else if (token.logicalName === 'backspace') {
    if (workspace.mode === 'form') workspace.backspaceFormText();
    else if (workspace.mode === 'browse' && workspace.query.length > 0) workspace.setQuery(workspace.query.slice(0, -1));
  } else if (token.logicalName === 'delete') {
    if (workspace.mode === 'form') workspace.backspaceFormText();
    else if (workspace.mode === 'browse' && workspace.selectedServer) workspace.requestDelete(workspace.selectedServer.name);
  } else if (token.logicalName === 'left') {
    if (workspace.mode === 'form') workspace.adjustFormEnum(-1);
  } else if (token.logicalName === 'right') {
    if (workspace.mode === 'form') workspace.adjustFormEnum(1);
  } else if (token.logicalName === 'space') {
    if (workspace.mode === 'form') workspace.appendFormText(' ');
    else if (workspace.mode === 'browse') workspace.setQuery(workspace.query + ' ');
  } else if (workspace.mode === 'browse' && token.logicalName) {
    // Modified letters (CSI-u chords) fire their action whatever the query holds.
    browseAction(token.logicalName);
  }
  requestRender();
  return true;
}
