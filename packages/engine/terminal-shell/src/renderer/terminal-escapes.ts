import { TERMINAL_ESCAPES } from '../terminal-lifecycle.js';

export const ALT_SCREEN_ENTER = TERMINAL_ESCAPES.ALT_SCREEN_ENTER;
export const ALT_SCREEN_EXIT = TERMINAL_ESCAPES.ALT_SCREEN_EXIT;
export const MOUSE_ENABLE = TERMINAL_ESCAPES.MOUSE_ENABLE;
export const MOUSE_DISABLE = TERMINAL_ESCAPES.MOUSE_DISABLE;
export const CURSOR_HIDE = TERMINAL_ESCAPES.CURSOR_HIDE;
export const CURSOR_SHOW = TERMINAL_ESCAPES.CURSOR_SHOW;
export const KEYBOARD_EXT_ENABLE = TERMINAL_ESCAPES.KEYBOARD_EXT_ENABLE;
export const KEYBOARD_EXT_DISABLE = TERMINAL_ESCAPES.KEYBOARD_EXT_DISABLE;
export const PASTE_ENABLE = TERMINAL_ESCAPES.PASTE_ENABLE;
export const PASTE_DISABLE = TERMINAL_ESCAPES.PASTE_DISABLE;
/** Clear viewport + home the cursor, WITHOUT ESC[3J. Never wipes scrollback. */
export const CLEAR_VIEWPORT_HOME = TERMINAL_ESCAPES.CLEAR_VIEWPORT_HOME;

export const FOCUS_ENABLE = TERMINAL_ESCAPES.FOCUS_ENABLE;
export const FOCUS_DISABLE = TERMINAL_ESCAPES.FOCUS_DISABLE;

// The enter and exit bytes are composed once, by the lifecycle both apps run.
export { buildEnterSequence, buildExitSequence } from '../terminal-lifecycle.js';

/** Historical name; clearing a viewport must preserve the owner's scrollback. */
export const CLEAR_SCREEN = CLEAR_VIEWPORT_HOME;
