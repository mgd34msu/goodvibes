/**
 * The keyboard shortcuts, grouped, from the live key table (user overrides
 * included) and the keys that are not key-table actions. The help palette
 * lists them as its last group and `/help keys` prints them.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { ShortcutGroup } from '@goodvibes/engine/terminal-shell/command-palette';
/** Keys that are real but are not key-table actions (context chords, literal characters). */
const FIXED_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Up / Down', 'Scroll / history recall'],
  ['PageUp / PageDn', 'Scroll by full page'],
  ['Home / End', 'Jump to start / end of line'],
  ['Mouse wheel', 'Scroll conversation or hovered panel'],
  ['Enter', 'Submit message'],
  ['Shift+Enter', 'Insert newline'],
  ['@', 'Open file picker'],
  ['/', 'Slash command mode'],
  ['?', 'Help: every command and keyboard shortcut'],
  ['Tab', 'Collapse/expand the nearest block; inside the Agent workspace, move between its area list and its action list'],
  ['Shift+Tab', 'Change when GoodVibes asks, for this session (always; never switches sessions)'],
  // One step per press; the status line names what the next Esc does. Each step
  // also has a key of its own: Ctrl+U clears the prompt, Ctrl+C interrupts.
  ['Esc', 'One step back: close the top overlay, else clear the prompt, else leave an agent or process view, else stop the running turn'],
  ['F2', 'Open Your agents'],
];

/** Agent and process views (shell/session-views.ts); these keys are fixed. */
const SESSION_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Enter on lane', 'Open that agent; typing steers it'],
  ['Enter on ▶ bead', "Open that process's live output"],
  ['Alt+N / Alt+P', 'Next / previous session in the session row (rebindable: next-session, previous-session)'],
  ['Esc in a view', 'Go up one level; stops nothing'],
  ['ctrl+x in view', 'Stop what the view shows (twice)'],
];

/**
 * Every shortcut group, from the live keybindings table (user overrides
 * included). The help palette lists the same groups as its last section.
 */
export function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  return [
    { title: 'Navigation & editing', items: FIXED_ROWS },
    { title: 'Actions', items: all.filter((e) => e.combos.length > 0).map((e) => [combos(e), e.description] as const) },
    { title: 'Sessions', items: SESSION_ROWS },
  ];
}
