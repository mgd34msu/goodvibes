export { handleHistorySearchToken } from '@goodvibes/engine/terminal-shell/overlay-input-routes';
import { handleSearchModeToken as search } from '@goodvibes/engine/terminal-shell/overlay-input-routes';
export const handleSearchModeToken = (...args: Parameters<typeof search>) => search(args[0], args[1], args[2], args[3], false);

/**
 * Keys shared by the help and shortcuts overlays: ↑↓ and PgUp/PgDn scroll
 * (never past the end the renderer recorded), printable text goes into the
 * always-live search row (the offset returns to the top as the list
 * narrows), Backspace edits it, Esc closes. Returns the new scroll offset.
 */
