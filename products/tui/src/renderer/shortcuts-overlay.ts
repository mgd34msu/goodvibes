/**
 * renderShortcutsOverlay, the keyboard shortcuts modal (/shortcuts), drawn
 * like the concept's "keys" screen: columns of key / action pairs, keys bold,
 * actions muted, grouped under ✦ headers, with the always-live search row
 * filtering by key or action. Reflects the live keybindings table (user
 * overrides included).
 *
 * Two columns below a 170-column screen, three from 170 up (one on a narrow
 * modal). The modal takes 86% of the screen without the usual 124-column cap,
 * so each description gets room to stay on one line; the key column is as wide
 * as the longest key (up to 18). Keys and actions that still do not fit wrap
 * inside their column; the grid scrolls when it is taller than the modal.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { OverlayFilter } from '../input/overlay-filter.ts';
import { renderShortcutsOverlay as render, type ShortcutGroup } from '@goodvibes-jev/engine/terminal-shell/shortcuts-overlay';
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
  ['?  or  /help', 'Open the command browser (search & run any command)'],
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

/** Every shortcut group, generated from the live keybindings table where it can be. */
function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  return [
    { title: 'Navigation & editing', items: HARDCODED_ROWS },
    { title: 'Actions', items: all.map((e) => [combos(e), e.description] as const) },
    { title: 'Views', items: VIEW_ROWS },
  ];
}

export function renderShortcutsOverlay(screenWidth: number, screenHeight: number, keybindingsManager: KeybindingsManager, scrollOffset = 0, filter?: OverlayFilter) {
  return render(screenWidth, screenHeight, shortcutGroups(keybindingsManager), scrollOffset, filter);
}
