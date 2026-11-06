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

/**
 * The bytes main.ts writes to enter terminal mode: alt screen (unless
 * disabled), clear + home (no 3J), cursor hidden, then the input modes.
 */
export function buildEnterSequence(noAltScreen: boolean): string {
  return (noAltScreen ? '' : ALT_SCREEN_ENTER)
    + CLEAR_VIEWPORT_HOME
    + CURSOR_HIDE
    + MOUSE_ENABLE
    + KEYBOARD_EXT_ENABLE
    + PASTE_ENABLE
    + FOCUS_ENABLE;
}

/**
 * The bytes main.ts writes to restore the terminal on exit: input modes off,
 * then the screen switch, then cursor-show LAST so visibility applies to the
 * screen the shell prompt actually lands on.
 *
 * Alt-screen path: just leave the alt screen, 1049l restores the primary
 * screen and cursor exactly as they were at launch. Clearing first is
 * pointless (the alt screen is discarded) and actively harmful (3J wipes the
 * primary scrollback even when issued from the alt screen).
 *
 * No-alt path: the compositor painted over the primary screen, so clear the
 * viewport and home the cursor, but WITHOUT 3J, the user's scrollback is
 * theirs.
 */
export function buildExitSequence(noAltScreen: boolean): string {
  const exitScreen = noAltScreen ? CLEAR_VIEWPORT_HOME : ALT_SCREEN_EXIT;
  return PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + FOCUS_DISABLE
    + exitScreen + CURSOR_SHOW;
}

/** Historical name; clearing a viewport must preserve the owner's scrollback. */
export const CLEAR_SCREEN = CLEAR_VIEWPORT_HOME;
