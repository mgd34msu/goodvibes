export { closeModalByName, getActiveModalName, reopenModalByName, type ActiveModalState, type ModalCloseOps, type ModalOpenOps } from '@goodvibes-jev/engine/terminal-shell/modal-state';
export { handleOverlayToken, handleHistorySearchToken } from '@goodvibes-jev/engine/terminal-shell/overlay-input-routes';
import { handleSearchModeToken as search } from '@goodvibes-jev/engine/terminal-shell/overlay-input-routes';
export const handleSearchModeToken = (...args: Parameters<typeof search>) => search(args[0], args[1], args[2], args[3], false);

/**
 * Reopen the modal that was previously on top of the stack after it has been
 * popped (so the one beneath it can resurface).
 *
 * INVARIANT: modals omitted from this switch are intentionally absent because
 * they remain `.active` as underlays when something stacks above them, they
 * never close themselves on stack push, so they need no explicit reopen.
 * Only the self-closing set (help, shortcuts, bookmark, process,
 * contextInspector, mcpWorkspace, agentWorkspace, command) is handled here.
 *
 * NOTE: any future modal that closes itself on overlay push MUST be added to
 * this switch, or it will silently fail to reopen when the stack unwinds.
 */

/**
 * Keys shared by the help and shortcuts overlays: ↑↓ and PgUp/PgDn scroll
 * (never past the end the renderer recorded), printable text goes into the
 * always-live search row (the offset returns to the top as the list
 * narrows), Backspace edits it, Esc closes. Returns the new scroll offset.
 */
