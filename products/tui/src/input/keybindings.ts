import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { COMMON_ACTION_DESCRIPTIONS, createKeybindingDefaults } from '@goodvibes/engine/terminal-shell/keybinding-catalog';
import { KeybindingsManager as PlatformKeybindingsManager, type KeyCombo, type KeybindingsManagerOptions } from '@goodvibes/engine/terminal-shell/keybindings';
export type { KeyCombo, KeybindingsManagerOptions };

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
  | 'word-back'
  | 'word-forward'
  | 'kill-to-start'
  | 'kill-word-forward'
  | 'yank'
  | 'yank-pop'
  | 'cancel-tool-call'
  | 'toggle-keep-awake'
  | 'toggle-memory-provenance'
  | 'voice-input'
  | 'focus-work-tree'
  | 'cycle-permission-mode'
  | 'open-notifications'
  | 'failure-other-model'
  | 'failure-details'
  | 'failure-sign-in'
  | 'failure-retry'
  | 'open-fix-session'
  | 'next-session'
  | 'previous-session'
  | 'scroll-page-up'
  | 'scroll-page-down'
  | 'model-picker-group';

export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = { ...COMMON_ACTION_DESCRIPTIONS,
  'command-palette':       'Open the command palette (search & run any command)',
  'open-agents':           'Open Your agents: what is running, what waits for you, what is scheduled',
  'block-save':            'Save nearest block to file',
  'line-start':            'Move to start of line',
  'clear-prompt':          'Clear the entire prompt',
  'word-back':             'Move cursor to start of previous word',
  'word-forward':          'Move cursor to end of next word',
  'kill-to-start':         'Kill from cursor to start of line into kill ring',
  'kill-word-forward':     'Kill word forward into kill ring',
  'yank':                  'Yank (paste) from kill ring',
  'yank-pop':              'Rotate kill ring and yank next entry',
  'cancel-tool-call':      'Cancel the running tool call (the turn continues)',
  'toggle-keep-awake':     'Toggle keep-awake (the "sleep disabled" chip)',
  'toggle-memory-provenance': 'List/hide the memories a turn used (provenance chip drill-in)',
// Named for what it actually does. A terminal delivers key EVENTS, not held-key
  // state, there is no release event to watch, so this is two discrete presses,
  // and the description says so instead of implying a hold that cannot exist.
  'voice-input':           'Voice input: press to start recording, press again to stop and transcribe into the composer',
  'cycle-permission-mode': 'Change when GoodVibes asks, for this session (asks before YOLO; the saved default is set in /settings)',
  'open-notifications':    'Open the notices (the status bar counts the unread ones)',
  'failure-other-model':   'After a failed turn: choose another model and send the prompt again',
  'failure-details':       'After a failed turn: show what the provider said',
  'failure-sign-in':       'After a provider refused its key: open the provider sign-ins',
  'failure-retry':         'After a failed turn: send the prompt again',
  'open-fix-session':      'Open the fix session that was just started (a CI fix, a conflict resolution)',
};

export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = createKeybindingDefaults<KeyAction>([
  'leader', 'open-menu', 'next-field', 'choose', 'back',
  'move-up', 'move-down', 'move-left', 'move-right',
  'copy-selection', 'clear-cancel', 'screen-clear', 'command-palette',
  'open-agents', 'history-search', 'search', 'block-copy',
  'bookmark', 'block-save', 'delete-word', 'line-start',
  'next-error-line-end', 'kill-line', 'clear-prompt', 'undo',
  'redo', 'paste', 'word-back', 'word-forward',
  'kill-to-start', 'kill-word-forward', 'yank', 'yank-pop',
  'cancel-tool-call', 'toggle-keep-awake', 'toggle-memory-provenance', 'voice-input',
  'focus-work-tree', 'cycle-permission-mode', 'open-notifications', 'failure-other-model',
  'failure-details', 'failure-sign-in', 'failure-retry', 'open-fix-session',
  'next-session', 'previous-session', 'scroll-page-up', 'scroll-page-down',
  'model-picker-group',
], {
// Ctrl+P opens the command palette, the one entry point for every command,
  // view and setting; Ctrl+K (the other common palette chord) opens it too. The
  // readline kill-to-end-of-line that historically owned Ctrl+K is repointed to
  // Alt+K below so the capability is kept, not lost.
  'command-palette':       [{ key: 'p', ctrl: true }, { key: 'k', ctrl: true }],
// F2 and Ctrl+O: Your agents, where the old Fleet and Ops consoles' content
  // lives now. Routed globally in handleGlobalShortcutToken.
  'open-agents':           [{ key: 'f2' }, { key: 'o', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
// The actions that sat on an Alt or Ctrl+Shift chord (which tmux, screen and
  // macOS Terminal swallow) are a leader sequence by default: Ctrl+G, then the
  // letter the chord had. Each keeps a second key every terminal sends
  // (keybinding-catalog.ts): a function key, a free Ctrl chord, or Ctrl with an
  // arrow or Delete. A person can bind the chord back in keybindings.json.
  // Ctrl+G then k: kill to end of line (Ctrl+K is the command palette).
  'kill-line':             [{ key: 'k', leader: true }, { key: 'x', ctrl: true }],
// Ctrl+G then u: clear the entire prompt. Ctrl+U is kill-to-start (readline
  // convention); Ctrl+G itself is the leader now.
  'clear-prompt':          [{ key: 'u', leader: true }],
// Word navigation: Ctrl+G then b / f (the emacs letters); Ctrl+Left / Ctrl+Right as most editors.
  'word-back':             [{ key: 'b', leader: true }, { key: 'left', ctrl: true }],
  'word-forward':          [{ key: 'f', leader: true }, { key: 'right', ctrl: true }],
// Kill-ring operations: 'kill-line' kills to end; 'kill-to-start' (Ctrl+U) kills to start.
  'kill-to-start':         [{ key: 'u', ctrl: true }],
  'kill-word-forward':     [{ key: 'd', leader: true }, { key: 'delete', ctrl: true }],
// Ctrl+G then y: yank from the kill ring (Ctrl+Y is block-copy); Ctrl+G then Y rotates it.
  'yank':                  [{ key: 'y', leader: true }, { key: '\\', ctrl: true }],
  'yank-pop':              [{ key: 'y', shift: true, leader: true }, { key: ']', ctrl: true }],
// Ctrl+G then t: cancel the running tool call (the turn continues). Ctrl+C stays
  // whole-input clear/cancel; this is the narrower per-tool stop.
  'cancel-tool-call':      [{ key: 't', leader: true }, { key: 't', ctrl: true }],
// Ctrl+G then a: toggle keep-awake; the always-visible chip confirms the state.
  'toggle-keep-awake':     [{ key: 'a', leader: true }, { key: 'f6' }],
// Ctrl+G then e: expand/collapse the "used N memories" chip (m is the menu).
  'toggle-memory-provenance': [{ key: 'e', leader: true }, { key: 'f7' }],
// Ctrl+G then v: start/stop voice input. Two presses rather than a hold: a
  // terminal has no key-release event to hold against.
  'voice-input':           [{ key: 'v', leader: true }, { key: 'f8' }],
// Shift+Tab: cycle this session's permission mode. The tokenizer reads the
  // xterm back-tab (CSI Z) as this chord.
  'cycle-permission-mode': [{ key: 'tab', shift: true }],
// Ctrl+N: the notices the status bar counts. Unused by any other default.
  'open-notifications':    [{ key: 'n', ctrl: true }],
// The failed turn's row: Ctrl+G then o (another model), i (details), s (sign in
  // again), r (send it again); Ctrl+G then j opens a fix session just started.
  'failure-other-model':   [{ key: 'o', leader: true }, { key: 'f9' }],
  'failure-details':       [{ key: 'i', leader: true }, { key: 'f3' }],
  'failure-sign-in':       [{ key: 's', leader: true }, { key: 'f4' }],
  'failure-retry':         [{ key: 'r', leader: true }, { key: 'f12' }],
  'open-fix-session':      [{ key: 'j', leader: true }, { key: 'f10' }],
});

export class KeybindingsManager extends PlatformKeybindingsManager<KeyAction> {
  constructor(options: KeybindingsManagerOptions) {
    // A file written before Ctrl+A had one meaning still names it by the old action.
    super(options, { surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, defaults: DEFAULT_KEYBINDINGS, descriptions: ACTION_DESCRIPTIONS, aliases: { 'apply-diff-line-start': 'line-start' }, abbreviateNamedKeys: true });
  }
}
