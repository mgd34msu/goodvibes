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
  /** Empty the focused text field, so a saved value that stays masked is replaced by typing a new one. */
  clearFormText?(): void;
  confirmDelete(): Promise<void>;
  reloadRuntime(): Promise<void>;
  cancelForm(): void;
  activateSelected(): Promise<void>;
  setQuery(query: string): void;
  adjustFormEnum(direction: 1 | -1): void;
}
/**
 * Keys in the MCP workspace have one meaning each. In the browser every letter
 * types into the search row; actions are chords that cannot be text (Ctrl+N
 * add, Ctrl+E edit, Ctrl+R reload, Ctrl+T tools) and Delete, which only asks.
 * A removal is confirmed by y or Enter typed after that question is shown;
 * `confirmDelete` leaves the confirmation before it awaits, so a repeated key
 * cannot start a second removal.
 */
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
  const browseChord = (key: string): void => {
    if (key === 'n') workspace.openAddForm();
    else if (key === 'e' && workspace.selectedServer) workspace.openEditForm(workspace.selectedServer.name);
    else if (key === 'r') workspace.requestReload();
    else if (key === 't') void workspace.refreshTools();
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
      workspace.setQuery(workspace.query + token.value);
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
  else if (token.logicalName === 'enter') {
    if (workspace.mode === 'delete-confirm') void workspace.confirmDelete();
    else void workspace.activateSelected();
  }
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
  } else if (workspace.mode === 'form' && token.ctrl && token.logicalName?.toLowerCase() === 'u') {
    workspace.clearFormText?.();
  } else if (workspace.mode === 'browse' && (token.ctrl || token.meta) && token.logicalName) {
    browseChord(token.logicalName.toLowerCase());
  }
  requestRender();
  return true;
}
