import { COMMON_ACTION_DESCRIPTIONS, createKeybindingDefaults } from '@goodvibes/engine/terminal-shell/keybinding-catalog';
import { KeybindingsManager as PlatformKeybindingsManager, type KeyCombo, type KeybindingsManagerOptions } from '@goodvibes/engine/terminal-shell/keybindings';
export type { KeyCombo, KeybindingsManagerOptions };
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/** Product action vocabulary and defaults; loading, validation and matching are platform owned. */
export type KeyAction =
  | 'copy-selection'
  | 'clear-cancel'
  | 'screen-clear'
  | 'command-palette'
  | 'workspace-picker'
  | 'workspace-close'
  | 'workspace-close-all'
  | 'workspace-tab-next'
  | 'workspace-tab-prev'
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
  | 'failure-sign-in';

export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = { ...COMMON_ACTION_DESCRIPTIONS,
  'command-palette':       'Open help: every command and keyboard shortcut in one searchable list',
  'workspace-picker':      'Open the Agent operator workspace',
  'workspace-close':       'Close the Agent workspace',
  'workspace-close-all':   'Close the Agent workspace',
  'workspace-tab-next':    'Cycle Agent workspace category forward',
  'workspace-tab-prev':    'Cycle Agent workspace category backward',
  'open-agents':           'Open Your agents: what is running, what waits for you, what is scheduled',
  'block-save':            'Save nearest block to file',
  'line-start':            'Move to start of line',
  'clear-prompt':          'Clear the prompt',
  'cycle-permission-mode': 'Change how often it asks, for this session (asks before YOLO; the saved default is set in /settings)',
  'open-notifications':    'Open the notices (the status bar counts the unread ones)',
  'failure-other-model':   'After a failed turn: choose another model and send the prompt again',
  'failure-details':       'After a failed turn: show what the provider said',
  'failure-retry':         'After a failed turn: send the prompt again',
  'failure-sign-in':       'After a provider refused its key: open the provider sign-ins',
};

export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = createKeybindingDefaults<KeyAction>([
  'copy-selection', 'clear-cancel', 'screen-clear', 'command-palette', 'workspace-picker',
  'workspace-close', 'workspace-close-all', 'workspace-tab-next', 'workspace-tab-prev',
  'open-agents', 'history-search', 'search', 'block-copy',
  'bookmark', 'block-save', 'delete-word', 'line-start',
  'next-error-line-end', 'kill-line', 'clear-prompt', 'undo',
  'redo', 'paste', 'focus-work-tree', 'cycle-permission-mode',
  'open-notifications', 'failure-other-model', 'failure-details', 'failure-retry', 'failure-sign-in',
], {
  // Ctrl+P: the same help list as ? and /help, in both terminal programs.
  'command-palette':       [{ key: 'p', ctrl: true }],
  'workspace-picker':      [{ key: 'g', ctrl: true }],
  'workspace-close':       [{ key: 'x', ctrl: true }],
  'workspace-close-all':   [{ key: 'x', ctrl: true, shift: true }],
  'workspace-tab-next':    [{ key: ']', ctrl: true }],
  'workspace-tab-prev':    [{ key: '[', ctrl: true }],
  'open-agents':           [{ key: 'o', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  'clear-prompt':          [{ key: 'u', ctrl: true }],
  // Shift+Tab: this session's permission mode (the tokenizer reads the xterm back-tab, CSI Z, as this chord).
  'cycle-permission-mode': [{ key: 'tab', shift: true }],
  // Ctrl+N: the notices the status bar counts.
  'open-notifications':    [{ key: 'n', ctrl: true }],
  // Alt+O and Alt+I: the failed turn's "use another model" and "details"; chords that can never be typed text.
  'failure-other-model':   [{ key: 'o', alt: true }],
  'failure-details':       [{ key: 'i', alt: true }],
  // Alt+R and Alt+S: the failed turn's "try again" and "sign in again".
  'failure-retry':         [{ key: 'r', alt: true }],
  'failure-sign-in':       [{ key: 's', alt: true }],
});

const KEY_ACTION_ALIASES: Readonly<Record<string, KeyAction>> = {
        'panel-picker': 'workspace-picker',
        'panel-close': 'workspace-close',
        'panel-close-all': 'workspace-close-all',
        'panel-tab-next': 'workspace-tab-next',
        'panel-tab-prev': 'workspace-tab-prev',
        'sidebar-toggle': 'open-agents',
      };

export class KeybindingsManager extends PlatformKeybindingsManager<KeyAction> {
  constructor(options: KeybindingsManagerOptions) {
    super(options, { surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, defaults: DEFAULT_KEYBINDINGS, descriptions: ACTION_DESCRIPTIONS, aliases: KEY_ACTION_ALIASES });
  }
}
