/** Shared shortcut defaults. Products supply their action order and deliberate overrides. */
import type { KeyCombo } from './keybindings.js';
export const COMMON_ACTION_DESCRIPTIONS = {
  'leader':                'Start a two-key shortcut: the next key says which',
  'open-menu':             'Open the menu of every place',
  'next-field':            'Tab: complete, or go to the next field, list or pane',
  'choose':                'Enter: send, choose, open',
  'back':                  'Esc: go back one level, close, interrupt',
  'move-up':               'Up: move up',
  'move-down':             'Down: move down',
  'move-left':             'Left: move left, the previous tab',
  'move-right':            'Right: move right, the next tab',
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
  'next-session':          'Show the next session (agent or process) in the session row above the conversation',
  'previous-session':      'Show the previous session (agent or process) in the session row above the conversation',
  'scroll-page-up':        'Scroll the conversation up a page',
  'scroll-page-down':      'Scroll the conversation down a page',
  'model-picker-group':    'In the model list: group it another way (provider, price, none)',
};
/**
 * The leader (Ctrl+G) starts a two-key shortcut: tmux, screen and macOS
 * Terminal swallow Alt and Ctrl+Shift chords, so every action that sat on one
 * has a leader sequence as its default instead, beside a second key every
 * terminal sends (a function key, a plain Ctrl chord on a free letter or
 * symbol, or Ctrl with an arrow or Delete). A person can bind a chord back.
 */
const COMMON_DEFAULT_KEYBINDINGS = {
  'leader':                [{ key: 'g', ctrl: true }],
  'open-menu':             [{ key: 'm', leader: true }],
  'next-field':            [{ key: 'tab' }],
  'choose':                [{ key: 'enter' }],
  'back':                  [{ key: 'escape' }],
  'move-up':               [{ key: 'up' }],
  'move-down':             [{ key: 'down' }],
  'move-left':             [{ key: 'left' }],
  'move-right':            [{ key: 'right' }],
  // Ctrl+Shift+C is the terminal's own copy chord: where the terminal passes it on, it copies here too.
  'copy-selection':        [{ key: 'c', leader: true }, { key: 'f5' }, { key: 'c', ctrl: true, shift: true }],
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
  'redo':                  [{ key: 'z', leader: true }, { key: '^', ctrl: true }],
  'paste':                 [{ key: 'v', ctrl: true }],
  'focus-work-tree':       [{ key: 'up', leader: true }, { key: 'up', ctrl: true }],
  // Session switching has its own keys, so Tab stays completion/fold and
  // Shift+Tab stays the permission mode in every state.
  'next-session':          [{ key: 'n', leader: true }, { key: 'q', ctrl: true }],
  'previous-session':      [{ key: 'p', leader: true }, { key: '_', ctrl: true }],
  'scroll-page-up':        [{ key: 'pageup' }],
  'scroll-page-down':      [{ key: 'pagedown' }],
  // The model list's grouping (it was the list's own Ctrl+G, which is the leader everywhere now).
  'model-picker-group':    [{ key: 'g', leader: true }],
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
