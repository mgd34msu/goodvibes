import { createHandlerContentBindings, applyEscapeResult } from '@goodvibes-jev/engine/terminal-shell/handler-content-bindings';
import '@goodvibes-jev/engine/terminal-shell/input-content';
import {
  expandPrompt,
  handleBlockCopy,
  handleBlockRerun,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleCopy,
} from './handler-content-actions.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';

import { missingClipboardReaderHint } from '../utils/clipboard.ts';
import type { InputHandler } from './handler.ts';
import '../renderer/theme.ts';

/**
 * handlePasteForHandler - Shared paste path for Ctrl+V and middle-click.
 *
 * Tries the clipboard's image first, then its text. The clipboard itself is
 * taken from `handler.clipboardSource`, so tests can hand in a clipboard
 * without touching the real one.
 *
 * Returns where the prompt landed. That return value is load-bearing: the
 * shortcut route snapshots the prompt before dispatching and copies its own
 * copy back afterwards, so an edit made only on the handler was written over
 * and the paste vanished. See PromptEdit in handler-shortcuts.ts.
 */

/**
 * expandPrompt - Replaces paste markers with actual content.
 * If image markers are present, returns ContentPart[] for multimodal delivery.
 * Otherwise returns a plain string.
 */

/**
 * getImageAttachments - Returns a copy of the current image registry.
 * Callers can use this to attach images when building LLM messages.
 */

/**
 * findMarkerAtPos - Returns the start/end of an atomic marker if pos is inside one.
 * Used to make backspace/delete/arrow treat markers as single units.
 */
/**
 * cleanupMarkerRegistry - If the given marker text is an IMAGE marker,
 * parses its ID and removes it from imageRegistry.
 */

/**
 * handleBlockCopy - Ctrl+Y: Copy the content of the nearest code/tool block.
 */

/**
 * handleBookmark - Ctrl+B: Toggle bookmark on the nearest block.
 */

/**
 * handleBlockSave - Ctrl+S: Explain that implicit block file saves are blocked.
 */

/**
 * executeBlockAction - Execute a block action ID on the nearest block.
 * Called when the user selects an action from the BlockActionsMenu.
 */
export function executeBlockActionForHandler(handler: InputHandler, actionId: string): void {
  switch (actionId) {
    case 'copy':
      handler.handleBlockCopy();
      break;
    case 'bookmark':
      handler.handleBookmark();
      break;
    case 'toggle':
      handler.handleBlockToggle();
      break;
    case 'rerun':
      handler.handleBlockRerun();
      break;
  }
}

/**
 * handleBlockRerun - Re-run the tool call for the nearest tool block.
 * Emits a tool-rerun event for the orchestrator to handle.
 */
export function handleBlockRerunForHandler(handler: InputHandler): void {
  handleBlockRerun(handler.conversationManager, handler.getScrollTop, handler.requestRender);
}

/**
 * handleBlockToggle - Tab (non-command mode): Toggle collapse of nearest block.
 */

/**
 * Handle Ctrl+C:
 * - If prompt has text: clear it
 * - If prompt is empty and LLM is thinking: cancel generation
 * - If prompt is empty and idle: show exit notice (double = exit)
 */

/**
 * Handle Escape:
 * - If prompt has text: clear it
 * - If prompt is empty: cancel generation (double-tap not needed)
 */
/**
 * Record that a modal has been opened and push it onto the navigation stack.
 * Call this EVERY time a modal opens (except inside openModal()).
 *
 * @param name - The modal identifier (e.g. 'settings', 'help', 'process').
 */
export function modalOpenedForHandler(handler: InputHandler, name: string): void {
  modalOpened(handler, name);
}

/**
 * Clear the modal navigation stack on non-modal user input (e.g. submit).
 */
export function clearModalStackForHandler(handler: InputHandler): void {
  clearModalStack(handler.modalStack);
}

export function handleEscapeForHandler(handler: InputHandler): void {
  const result = handleEscape({
    helpOverlayActive: handler.helpOverlayActive,
    shortcutsOverlayActive: handler.shortcutsOverlayActive,
    bookmarkModal: handler.bookmarkModal,
    liveTailModal: handler.liveTailModal,
    settingsModal: handler.settingsModal,
    mcpWorkspace: handler.mcpWorkspace,
    agentWorkspace: handler.agentWorkspace,
    sessionPickerModal: handler.sessionPickerModal,
    profilePickerModal: handler.profilePickerModal,
    contextInspectorModal: handler.contextInspectorModal,
    processModal: handler.processModal,
    modelPicker: handler.modelPicker,
    filePicker: handler.filePicker,
    blockActionsMenu: handler.blockActionsMenu,
    surfaceModals: handler.surfaceModals,
    sessionView: handler.sessionView ?? undefined,
    transcriptScroll: handler.transcriptScroll ?? undefined,
    selectionModal: handler.selectionModal,
    commandMode: handler.commandMode,
    modalStack: handler.modalStack,
    modalReturnFocus: handler.modalReturnFocus,
    indicatorFocused: handler.indicatorFocused,
    prompt: handler.prompt,
    cursorPos: handler.cursorPos,
    requestRender: handler.requestRender,
    saveUndoState: () => handler.saveUndoState(),
    cancelGeneration: handler.commandContext?.cancelGeneration,
    selectionCallback: handler.selectionCallback,
    autocompleteReset: () => handler.autocomplete?.reset(),
    autocompleteUpdate: (query: string) => handler.autocomplete?.update(query),
    helpScrollOffset: handler.helpScrollOffset,
    shortcutsScrollOffset: handler.shortcutsScrollOffset,
  });
  applyEscapeResult(handler, result);
}

export const {
  handlePasteForHandler,
  registerPasteForHandler,
  expandPromptForHandler,
  getImageAttachmentsForHandler,
  cleanupMarkerRegistryForHandler,
  findMarkerAtPosForHandler,
  handleCopyForHandler,
  handleBlockCopyForHandler,
  handleBookmarkForHandler,
  handleBlockSaveForHandler,
  handleBlockToggleForHandler,
  handleCtrlCForHandler,
} = createHandlerContentBindings<InputHandler>({
  anchor: (host) => host.getScrollTop,
  emptyClipboard: () => {
    const hint = missingClipboardReaderHint();
    return hint ? '[Paste] ' + hint : '[Paste: clipboard does not contain supported text or image data]';
  },
  ownCtrlCTimeout: false,
  expandPrompt,
  actions: { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle },
});
