import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { COMMON_ACTION_DESCRIPTIONS, createKeybindingDefaults } from '@goodvibes/engine/terminal-shell/keybinding-catalog';
import { KeybindingsManager as PlatformKeybindingsManager, type KeyCombo, type KeybindingsManagerOptions } from '@goodvibes/engine/terminal-shell/keybindings';
export type { KeyCombo, KeybindingsManagerOptions };

/** Product action vocabulary and defaults; loading, validation and matching are platform owned. */
export type KeyAction =
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
  | 'next-session'
  | 'previous-session';

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
};

export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = createKeybindingDefaults<KeyAction>([
  'copy-selection', 'clear-cancel', 'screen-clear', 'command-palette',
  'open-agents', 'history-search', 'search', 'block-copy',
  'bookmark', 'block-save', 'delete-word', 'line-start',
  'next-error-line-end', 'kill-line', 'clear-prompt', 'undo',
  'redo', 'paste', 'word-back', 'word-forward',
  'kill-to-start', 'kill-word-forward', 'yank', 'yank-pop',
  'cancel-tool-call', 'toggle-keep-awake', 'toggle-memory-provenance', 'voice-input',
  'focus-work-tree', 'cycle-permission-mode', 'open-notifications', 'failure-other-model',
  'failure-details', 'failure-sign-in', 'next-session', 'previous-session',
], {
// Ctrl+P opens the command palette, the one entry point for every command,
  // view and setting; Ctrl+K (the other common palette chord) opens it too. The
  // readline kill-to-end-of-line that historically owned Ctrl+K is repointed to
  // Alt+K below so the capability is kept, not lost.
  'command-palette':       [{ key: 'p', ctrl: true }, { key: 'k', ctrl: true }],
// Ctrl+O: Your agents (same as F2), where the old Fleet and Ops
  // consoles' content lives now. Routed globally in handleGlobalShortcutToken.
  'open-agents':           [{ key: 'o', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
// Alt+K: kill to end of line. Ctrl+K was reassigned to the command palette
  // (the standard palette chord); Alt+K keeps kill-to-end available and is
  // otherwise unused in the default table.
  'kill-line':             [{ key: 'k', alt: true }],
// Alt+U: clear entire prompt. Ctrl+U is owned by kill-to-start (readline
  // convention). Alt+U is unused by any other default and is representable by
  // the tokenizer's { key, alt } combo form.
  'clear-prompt':          [{ key: 'u', alt: true }],
// Word navigation (Alt+B / Alt+F, emacs readline standard)
  'word-back':             [{ key: 'b', alt: true }],
  'word-forward':          [{ key: 'f', alt: true }],
// Kill-ring operations.
  // Note: 'kill-line' (Alt+K) kills to end; 'kill-to-start' (Ctrl+U) kills to start.
  // 'clear-prompt' (Alt+U) clears the entire buffer regardless of cursor position.
  // kill-to-start owns Ctrl+U (readline convention); clear-prompt uses Alt+U.
  'kill-to-start':         [{ key: 'u', ctrl: true }],
// Alt+D: kill word forward (no prior conflict)
  'kill-word-forward':     [{ key: 'd', alt: true }],
// Ctrl+Shift+Y: yank from kill ring.
  // CONFLICT RESOLVED: Ctrl+Y was 'block-copy'; yank moved to Ctrl+Shift+Y.
  'yank':                  [{ key: 'y', ctrl: true, shift: true }],
// Alt+Y: yank-pop (rotate ring after yank)
  'yank-pop':              [{ key: 'y', alt: true }],
// Alt+C: cancel the currently-running tool call (the turn continues). Alt+C
  // is unused by any other default and representable by the tokenizer's
  // { key, alt } combo form. Ctrl+C stays whole-input clear/cancel; this is the
  // narrower per-tool stop.
  'cancel-tool-call':      [{ key: 'c', alt: true }],
// Alt+A: toggle keep-awake (the one-key affordance for the "sleep disabled"
  // chip). Alt+A is unused by any other default. The always-visible chip is the
  // confirmation of the toggle's state.
  'toggle-keep-awake':     [{ key: 'a', alt: true }],
// Alt+M: expand/collapse the "used N memories" provenance chip's drill-in.
  // Alt+M is unused by any other default. A no-op when the chip is not showing.
  'toggle-memory-provenance': [{ key: 'm', alt: true }],
// Alt+V: start/stop voice input. Alt+V is unused by any other default (Ctrl+V
  // is paste and stays paste). Two presses rather than a hold: see the action's
  // description, a terminal has no key-release event to hold against.
  'voice-input':           [{ key: 'v', alt: true }],
// Shift+Tab: cycle this session's permission mode. The tokenizer reads the
  // xterm back-tab (CSI Z) as this chord.
  'cycle-permission-mode': [{ key: 'tab', shift: true }],
// Ctrl+N: the notices the status bar counts. Unused by any other default.
  'open-notifications':    [{ key: 'n', ctrl: true }],
// Alt+O and Alt+I: the failed turn's "use another model" and "details". Chords
  // that can never be typed text (like Alt+R retry), unused by any other default.
  'failure-other-model':   [{ key: 'o', alt: true }],
  'failure-details':       [{ key: 'i', alt: true }],
  // Alt+S: the row of a turn whose provider refused its key, "sign in again".
  'failure-sign-in':       [{ key: 's', alt: true }],
});

export class KeybindingsManager extends PlatformKeybindingsManager<KeyAction> {
  constructor(options: KeybindingsManagerOptions) {
    // A file written before Ctrl+A had one meaning still names it by the old action.
    super(options, { surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, defaults: DEFAULT_KEYBINDINGS, descriptions: ACTION_DESCRIPTIONS, aliases: { 'apply-diff-line-start': 'line-start' }, abbreviateNamedKeys: true });
  }
}
