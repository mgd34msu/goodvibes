/**
 * The keyboard shortcuts, grouped, from the live key table (user overrides
 * included) and the keys that are not key-table actions. The help palette
 * lists them as its last group and `/help keys` prints them. Tab, Enter, Esc
 * and the arrows are actions of the table too, so their rows name the keys
 * actually bound.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { ShortcutGroup } from '@goodvibes/engine/terminal-shell/command-palette';

/** Every shortcut group, generated from the live keybindings table where it can be; the help palette lists them last. */
export function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  const bound = (action: string): string => {
    const entry = all.find((candidate) => candidate.action === action);
    return entry && entry.combos.length > 0 ? combos(entry) : '(unbound)';
  };
  // Keys that are real but are not KeyAction entries (context chords, literal characters), named as bound where they are one.
  const navigation: ReadonlyArray<readonly [string, string]> = [
    [`${bound('move-up')} / ${bound('move-down')}`, 'Recall input history; Down at bottom focuses the process indicator'],
    [`${bound('scroll-page-up')} / ${bound('scroll-page-down')}`, 'Scroll by full page'],
    ['Home / End', 'Jump to start / end of line'],
    ['n / N (search)', 'Next / previous match'],
    ['Mouse wheel', 'Scroll the conversation (or the open modal)'],
    [bound('choose'), 'Submit message (composer empty: open the block-actions menu)'],
    ['Shift+Enter', 'Insert newline'],
    ['@', 'Open file picker'],
    ['/', 'Slash command mode'],
    // One step per press, the first that applies; the status line names what the
    // next Esc does (`esc clear input`, `esc back`, `esc interrupt`).
    [bound('back'), 'One step back: close the top overlay, else clear the prompt, else leave an agent or process view, else stop the running turn'],
    [bound('cycle-permission-mode'), 'Change when GoodVibes asks, for this session (always; never switches sessions)'],
    [bound('open-agents'), 'Open Agents'],
    ['?  or  /help', 'Help: every command and key'],
    // Precedence: a partial path under the cursor claims Tab for completion,
    // otherwise it collapses or expands the nearest block.
    [bound('next-field'), 'Path-complete, else collapse/expand the nearest block'],
    [bound('leader'), 'Starts a two-key shortcut: the screen shows every key that can follow'],
  ];
  // Where the views live now (they open as modals over the conversation).
  const views: ReadonlyArray<readonly [string, string]> = [
    ['/usage', 'Usage: context, tokens and cost'],
    ['/changes', 'Changes: files, diff, review'],
    ['/notifications', 'Notification history'],
    [bound('back'), 'Close the top modal (one level)'],
    ['Enter on lane', 'Open that agent full screen; typing there steers it'],
    ['Enter on ▶ bead', 'Open that background process\'s live output'],
    [`${bound('next-session')} / ${bound('previous-session')}`, 'Next / previous session in the session row'],
    ['ctrl+x in view', 'Stop the agent or process shown (press twice)'],
  ];
  return [
    { title: 'Navigation & editing', items: navigation },
    { title: 'Actions', items: all.map((e) => [combos(e), e.description] as const) },
    { title: 'Views', items: views },
  ];
}
