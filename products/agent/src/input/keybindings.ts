import { COMMON_ACTION_DESCRIPTIONS, createKeybindingDefaults } from '@goodvibes-jev/engine/terminal-shell/keybinding-catalog';
import { KeybindingsManager as PlatformKeybindingsManager, type KeyCombo, type KeybindingsManagerOptions } from '@goodvibes-jev/engine/terminal-shell/keybindings';
export type { KeyCombo, KeybindingsManagerOptions };
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/** Product action vocabulary and defaults; loading, validation and matching are platform owned. */
export type KeyAction =
  | 'copy-selection'
  | 'clear-cancel'
  | 'screen-clear'
  | 'workspace-picker'
  | 'workspace-close'
  | 'workspace-close-all'
  | 'workspace-tab-next'
  | 'workspace-tab-prev'
  | 'activity-open'
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
  | 'focus-work-tree';

export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = { ...COMMON_ACTION_DESCRIPTIONS,
  'workspace-picker':      'Open the Agent operator workspace',
  'workspace-close':       'Close the Agent workspace',
  'workspace-close-all':   'Close the Agent workspace (alias: also bound to Ctrl+Shift+X)',
  'workspace-tab-next':    'Cycle Agent workspace category forward',
  'workspace-tab-prev':    'Cycle Agent workspace category backward',
  'activity-open':         'Open the Activity modal (running work, needs you, recent)',
  'block-save':            'Block file save disabled; copy block or export conversation',
  'line-start':            'Move to start of line',
  'clear-prompt':          'Clear the prompt',
};

export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = createKeybindingDefaults<KeyAction>([
  'copy-selection', 'clear-cancel', 'screen-clear', 'workspace-picker',
  'workspace-close', 'workspace-close-all', 'workspace-tab-next', 'workspace-tab-prev',
  'activity-open', 'history-search', 'search', 'block-copy',
  'bookmark', 'block-save', 'delete-word', 'line-start',
  'next-error-line-end', 'kill-line', 'clear-prompt', 'undo',
  'redo', 'paste', 'focus-work-tree',
], {
  'workspace-picker':      [{ key: 'p', ctrl: true }],
  'workspace-close':       [{ key: 'x', ctrl: true }],
  'workspace-close-all':   [{ key: 'x', ctrl: true, shift: true }],
  'workspace-tab-next':    [{ key: ']', ctrl: true }],
  'workspace-tab-prev':    [{ key: '[', ctrl: true }],
  'activity-open':         [{ key: 'o', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  'clear-prompt':          [{ key: 'u', ctrl: true }],
});

const KEY_ACTION_ALIASES: Readonly<Record<string, KeyAction>> = {
        'panel-picker': 'workspace-picker',
        'panel-close': 'workspace-close',
        'panel-close-all': 'workspace-close-all',
        'panel-tab-next': 'workspace-tab-next',
        'panel-tab-prev': 'workspace-tab-prev',
        'sidebar-toggle': 'activity-open',
      };

export class KeybindingsManager extends PlatformKeybindingsManager<KeyAction> {
  constructor(options: KeybindingsManagerOptions) {
    super(options, { surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, defaults: DEFAULT_KEYBINDINGS, descriptions: ACTION_DESCRIPTIONS, aliases: KEY_ACTION_ALIASES });
  }
}
