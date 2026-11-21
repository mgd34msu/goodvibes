import { createHandlerContentBindings } from '@goodvibes/engine/terminal-shell/handler-content-bindings';
import {
  expandPrompt,
  handleBlockCopy,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleCopy,
} from './handler-content-actions.ts';
import { handleEscape } from './handler-modal-stack.ts';

import { missingClipboardReaderHint } from '../utils/clipboard.ts';
import type { InputHandler } from './handler.ts';

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
 * handleBlockSave - Ctrl+S: Save the nearest block to a new file in the bookmarks folder.
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
  }
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
export function handleEscapeForHandler(handler: InputHandler): void {
  handleEscape(handler, handler.commandContext?.cancelGeneration);
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
