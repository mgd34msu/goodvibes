import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { isTextBackspace } from '@goodvibes-jev/engine/terminal-shell';
import type { AgentWorkspace } from './agent-workspace.ts';

/** Lines per PageUp/PageDown in the action-result block. */
const RESULT_SCROLL_STEP = 5;

export function handleAgentWorkspaceToken(
  workspace: AgentWorkspace,
  token: InputToken,
  handleEscape: () => void,
  requestRender: () => void,
): boolean {
  if (!workspace.active) return false;

  if (workspace.localEditor) {
    if (token.type === 'text') {
      workspace.appendEditorText(token.value);
    } else if (token.type === 'key') {
      if (token.logicalName === 'escape') workspace.cancelLocalEditor();
      else if (token.logicalName === 'enter') workspace.submitEditorFieldOrForm(requestRender);
      else if (token.logicalName === 'tab' || token.logicalName === 'down') workspace.moveEditorField(1);
      else if (token.logicalName === 'up') workspace.moveEditorField(-1);
      else if (isTextBackspace(token.logicalName)) workspace.editorBackspace();
      else if (token.logicalName === 'j' && token.ctrl === true) workspace.appendEditorNewline();
    }
    requestRender();
    return true;
  }

  if (token.type === 'key') {
    if (workspace.actionSearchActive) {
      if (token.logicalName === 'escape') workspace.clearActionSearch();
      else if (token.logicalName === 'enter') workspace.activateSelected(requestRender);
      else if (token.logicalName === 'up') workspace.moveUp();
      else if (token.logicalName === 'down') workspace.moveDown();
      else if (token.logicalName === 'home') workspace.jumpHome();
      else if (token.logicalName === 'end') workspace.jumpEnd();
      else if (isTextBackspace(token.logicalName)) workspace.actionSearchBackspace();
      else if (token.logicalName === 'space') workspace.appendActionSearchText(' ');
      requestRender();
      return true;
    }
    if (token.logicalName === 'escape') {
      handleEscape();
      return true;
    }
    // PgUp/PgDn scroll the selected area's context; while a result is shown
    // the plain keys scroll the result and Ctrl+PgUp/PgDn scroll the context.
    // A long action result scrolls rather than being cut off. These keys reach
    // the workspace already, they were consumed and did nothing, so binding
    // them here takes nothing away from the transcript scroll behind the modal.
    if ((!workspace.lastActionResult || token.ctrl === true) && (token.logicalName === 'pageup' || token.logicalName === 'pagedown')) workspace.workContextScroll = Math.max(0, workspace.workContextScroll + (token.logicalName === 'pageup' ? -RESULT_SCROLL_STEP : RESULT_SCROLL_STEP));
    else if (token.logicalName === 'pageup') workspace.scrollActionResult(-RESULT_SCROLL_STEP);
    else if (token.logicalName === 'pagedown') workspace.scrollActionResult(RESULT_SCROLL_STEP);
    else if (token.ctrl === true && token.logicalName === 'r') workspace.refreshRuntimeSnapshot();
    else if (token.ctrl === true && token.logicalName === ']') workspace.cycleCategory('next');
    else if (token.ctrl === true && token.logicalName === '[') workspace.cycleCategory('prev');
    // Enter activates; Space does nothing here, so a stray space never runs a
    // row or flips a setting.
    else if (token.logicalName === 'enter') workspace.activateSelected(requestRender);
    else if (token.logicalName === 'left') workspace.focusCategories();
    else if (token.logicalName === 'right') workspace.focusActions();
    else if (token.logicalName === 'up') workspace.moveUp();
    else if (token.logicalName === 'down') workspace.moveDown();
    else if (token.logicalName === 'tab') workspace.toggleFocusPane();
    else if (token.logicalName === 'home') workspace.jumpHome();
    else if (token.logicalName === 'end') workspace.jumpEnd();
  } else if (token.type === 'text') {
    if (workspace.actionSearchActive) workspace.appendActionSearchText(token.value);
    else if (token.value === '/') workspace.beginActionSearch();
    else if (token.value.trim().length > 0) {
      // "Just start typing" is literal: the first printable character closes
      // the workspace and is not consumed, so it lands in the composer.
      workspace.closeToComposer();
      requestRender();
      return false;
    }
  }

  requestRender();
  return true;
}
