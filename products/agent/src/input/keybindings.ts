import { COMMON_ACTION_DESCRIPTIONS, createKeybindingDefaults } from '@goodvibes/engine/terminal-shell/keybinding-catalog';
import { KeybindingsManager as PlatformKeybindingsManager, type KeyCombo, type KeybindingsManagerOptions } from '@goodvibes/engine/terminal-shell/keybindings';
export type { KeyCombo, KeybindingsManagerOptions };
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/** Product action vocabulary and defaults; loading, validation and matching are platform owned. */
export type KeyAction =
  | 'leader'
  | 'open-menu'
  | 'next-field'
  | 'choose'
  | 'back'
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'copy-selection'
  | 'clear-cancel'
  | 'screen-clear'
  | 'command-palette'
  | 'open-agents'
  | 'history-search'
  | 'search'
  | 'block-copy'
  | 'bookmark'
  | 'block-save'
  | 'delete-word'
  | 'line-start'
  | 'next-error-line-end'
  | 'kill-line'
  | 'clear-prompt'
  | 'undo'
  | 'redo'
  | 'paste'
  | 'focus-work-tree'
  | 'cycle-permission-mode'
  | 'open-notifications'
  | 'failure-other-model'
  | 'failure-details'
  | 'failure-retry'
  | 'failure-sign-in'
  | 'next-session'
  | 'previous-session'
  | 'scroll-page-up'
  | 'scroll-page-down'
  | 'model-picker-group';

export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = { ...COMMON_ACTION_DESCRIPTIONS,
  'command-palette':       'Open help: every command and keyboard shortcut in one searchable list',
  'open-agents':           'Open Your agents: what is running, what waits for you, what is scheduled',
  'block-save':            'Save nearest block to file',
  'line-start':            'Move to start of line',
  'clear-prompt':          'Clear the prompt',
  'cycle-permission-mode': 'Change when GoodVibes asks, for this session (asks before YOLO; the saved default is set in /settings)',
  'open-notifications':    'Open the notices (the status bar counts the unread ones)',
  'failure-other-model':   'After a failed turn: choose another model and send the prompt again',
  'failure-details':       'After a failed turn: show what the provider said',
  'failure-retry':         'After a failed turn: send the prompt again',
  'failure-sign-in':       'After a provider refused its key: open the provider sign-ins',
};

export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = createKeybindingDefaults<KeyAction>([
  'leader', 'open-menu', 'next-field', 'choose', 'back',
  'move-up', 'move-down', 'move-left', 'move-right',
  'copy-selection', 'clear-cancel', 'screen-clear', 'command-palette',
  'open-agents', 'history-search', 'search', 'block-copy',
  'bookmark', 'block-save', 'delete-word', 'line-start',
  'next-error-line-end', 'kill-line', 'clear-prompt', 'undo',
  'redo', 'paste', 'focus-work-tree', 'cycle-permission-mode',
  'open-notifications', 'failure-other-model', 'failure-details', 'failure-retry', 'failure-sign-in',
  'next-session', 'previous-session', 'scroll-page-up', 'scroll-page-down',
  'model-picker-group',
], {
  // Ctrl+P: the same help list as ? and /help, in both terminal programs.
  'command-palette':       [{ key: 'p', ctrl: true }],
  // F2 and Ctrl+O: Your agents.
  'open-agents':           [{ key: 'f2' }, { key: 'o', ctrl: true }],
  // The Agent's conversation scrolls a page with PageUp and PageDown, with or without Ctrl.
  'scroll-page-up':        [{ key: 'pageup' }, { key: 'pageup', ctrl: true }],
  'scroll-page-down':      [{ key: 'pagedown' }, { key: 'pagedown', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  'clear-prompt':          [{ key: 'u', ctrl: true }],
  // Shift+Tab: this session's permission mode (the tokenizer reads the xterm back-tab, CSI Z, as this chord).
  'cycle-permission-mode': [{ key: 'tab', shift: true }],
  // Ctrl+N: the notices the status bar counts.
  'open-notifications':    [{ key: 'n', ctrl: true }],
  // The failed turn's row: Ctrl+G then o (another model), i (details), r (try again), s (sign in again).
  'failure-other-model':   [{ key: 'o', leader: true }, { key: 'f9' }],
  'failure-details':       [{ key: 'i', leader: true }, { key: 'f3' }],
  'failure-retry':         [{ key: 'r', leader: true }, { key: 'f12' }],
  'failure-sign-in':       [{ key: 's', leader: true }, { key: 'f4' }],
});

const KEY_ACTION_ALIASES: Readonly<Record<string, KeyAction>> = {
        'sidebar-toggle': 'open-agents',
      };

export class KeybindingsManager extends PlatformKeybindingsManager<KeyAction> {
  constructor(options: KeybindingsManagerOptions) {
    super(options, { surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, defaults: DEFAULT_KEYBINDINGS, descriptions: ACTION_DESCRIPTIONS, aliases: KEY_ACTION_ALIASES });
  }
}
