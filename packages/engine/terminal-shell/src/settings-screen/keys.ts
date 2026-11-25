/**
 * settings-screen/keys.ts, the settings screen's keys in the program's key
 * table: one context (`settings`), each entry rebindable in the Keys place
 * under "Settings" and checked for conflicts like a place's. Moving, Enter,
 * Esc, Tab and the page keys are the table's own navigation and scrolling
 * actions wherever they are bound. Letters are left free for the search: typing
 * filters every setting; an entry here defaults to a key that types nothing.
 */
import type { KeyContext } from '../keybindings.js';

export const SETTINGS_KEY_CONTEXT_ID = 'settings';

/** The entries of the settings context, by name. */
export const SETTINGS_KEYS = {
  reset: 'reset',
  otherProgram: 'other-program',
  readAgain: 'read-again',
  adjustDown: 'adjust-down',
  adjustUp: 'adjust-up',
  act: 'act',
  erase: 'erase',
} as const;

export function settingsKeyContext(): KeyContext {
  return {
    id: SETTINGS_KEY_CONTEXT_ID,
    title: 'Settings',
    actions: [
      { name: SETTINGS_KEYS.reset, description: 'put the selected setting, its topic or every setting back to the default', defaults: [{ key: 'r', ctrl: true }] },
      { name: SETTINGS_KEYS.otherProgram, description: 'show the other program\'s own settings (the daemon\'s stay as they are)', defaults: [{ key: 'o', ctrl: true }] },
      { name: SETTINGS_KEYS.readAgain, description: 'read every value again', defaults: [{ key: 'l', ctrl: true }] },
      { name: SETTINGS_KEYS.adjustDown, description: 'the previous choice, a smaller number, or off', defaults: [{ key: 'left', shift: true }] },
      { name: SETTINGS_KEYS.adjustUp, description: 'the next choice, a larger number, or on', defaults: [{ key: 'right', shift: true }] },
      { name: SETTINGS_KEYS.act, description: 'turn the selected switch over or open the selected row, when no filter is typed (with a filter it types a space)', defaults: [{ key: 'space' }] },
      { name: SETTINGS_KEYS.erase, description: 'take the last letter off the filter, or off the value being typed', defaults: [{ key: 'backspace' }] },
    ],
  };
}
