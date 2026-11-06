/** Shared shortcut defaults. Products supply their action order and deliberate overrides. */
import type { KeyCombo } from './keybindings.js';
export const COMMON_ACTION_DESCRIPTIONS = {
  'copy-selection':        'Copy selected text to clipboard',
  'clear-cancel':          'Clear input / cancel generation / exit (double)',
  'screen-clear':          'Repaint the screen',
  'history-search':        'Reverse input history search',
  'search':                'Toggle conversation search',
  'block-copy':            'Copy nearest block to clipboard',
  'bookmark':              'Bookmark / unbookmark nearest block',
  'delete-word':           'Delete word backward',
  'next-error-line-end':   'Navigate to next error / move to line end',
  'kill-line':             'Kill to end of line',
  'undo':                  'Undo last prompt edit',
  'redo':                  'Redo last undone edit',
  'paste':                 'Paste from clipboard (image priority)',
  'focus-work-tree':       'Move the keyboard onto the conversation work tree (arrows move and fold, Enter opens, y copies, Esc returns)',
};
const COMMON_DEFAULT_KEYBINDINGS = {
  'copy-selection':        [{ key: 'c', ctrl: true, shift: true }],
  'clear-cancel':          [{ key: 'c', ctrl: true }],
  'screen-clear':          [{ key: 'l', ctrl: true }],
  'history-search':        [{ key: 'r', ctrl: true }],
  'search':                [{ key: 'f', ctrl: true }],
  'block-copy':            [{ key: 'y', ctrl: true }],
  'bookmark':              [{ key: 'b', ctrl: true }],
  'block-save':            [{ key: 's', ctrl: true }],
  'delete-word':           [{ key: 'w', ctrl: true }],
  'next-error-line-end':   [{ key: 'e', ctrl: true }],
  'undo':                  [{ key: 'z', ctrl: true }],
  'redo':                  [{ key: 'z', ctrl: true, shift: true }],
  'paste':                 [{ key: 'v', ctrl: true }],
  'focus-work-tree':       [{ key: 'up', alt: true }, { key: 'up', ctrl: true }],
} satisfies Record<string, KeyCombo[]>;
type CommonKeyAction = keyof typeof COMMON_DEFAULT_KEYBINDINGS;
function isCommonAction(action: string): action is CommonKeyAction {
  return Object.hasOwn(COMMON_DEFAULT_KEYBINDINGS, action);
}
/** Catalog order is explicit because duplicate chords resolve to the last action. */
export function createKeybindingDefaults<Action extends string>(order: readonly Action[], overrides: Record<Exclude<Action, CommonKeyAction>, KeyCombo[]> & Partial<Record<Action, KeyCombo[]>>): Record<Action, KeyCombo[]> {
  const result = {} as Record<Action, KeyCombo[]>;
  for (const action of order) {
    const override = overrides[action];
    const common = isCommonAction(action) ? COMMON_DEFAULT_KEYBINDINGS[action] : undefined;
    const combos = override ?? common;
    if (!combos) throw new Error('Keybinding catalog has no default for an action.');
    result[action] = combos.map(combo => ({ ...combo }));
  }
  return result;
}
