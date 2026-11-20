/**
 * The keyboard shortcuts, grouped, from the live key table (user overrides
 * included) and the keys that are not key-table actions. The help palette
 * lists them as its last group and `/help keys` prints them.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { ShortcutGroup } from '@goodvibes/engine/terminal-shell/command-palette';
/** Keys that are real but are not KeyAction entries (context chords, literal characters). */
const HARDCODED_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Up / Down', 'Recall input history; Down at bottom focuses the process indicator'],
  ['PageUp / PageDn', 'Scroll by full page'],
  ['Home / End', 'Jump to start / end of line'],
  ['n / N (search)', 'Next / previous match'],
  ['Mouse wheel', 'Scroll the conversation (or the open modal)'],
  ['Enter', 'Submit message (composer empty: open the block-actions menu)'],
  ['Shift+Enter', 'Insert newline'],
  ['@', 'Open file picker'],
  ['/', 'Slash command mode'],
  ['Esc', 'Close overlay / clear prompt / leave an agent or process view / interrupt main'],
  ['Shift+Tab', 'Cycle permission mode; with session chips showing and an empty composer, the previous session'],
  ['F2', 'Open Agents'],
  ['?  or  /help', 'Help: every command and key'],
  // Precedence: a partial path under the cursor claims Tab for completion,
  // otherwise it collapses or expands the nearest block.
  ['Tab', 'Path-complete, else collapse/expand block; with session chips showing and an empty composer, the next session'],
];

/** Where the views live now (they open as modals over the conversation). */
const VIEW_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['/usage', 'Usage: context, tokens and cost'],
  ['/changes', 'Changes: files, diff, review'],
  ['/notifications', 'Notification history'],
  ['Esc', 'Close the top modal (one level)'],
  ['Enter on lane', 'Open that agent full screen; typing there steers it'],
  ['Enter on ▶ bead', 'Open that background process\'s live output'],
  ['ctrl+x in view', 'Stop the agent or process shown (press twice)'],
];

/** Every shortcut group, generated from the live keybindings table where it can be; the help palette lists them last. */
export function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  return [
    { title: 'Navigation & editing', items: HARDCODED_ROWS },
    { title: 'Actions', items: all.map((e) => [combos(e), e.description] as const) },
    { title: 'Views', items: VIEW_ROWS },
  ];
}
