/**
 * The keyboard shortcuts, grouped, from the live key table (user overrides
 * included) and the keys that are not key-table actions. The help palette
 * lists them as its last group and `/help keys` prints them. Tab, Enter, Esc
 * and the arrows are actions of the table too, so their rows name the keys
 * actually bound.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { ShortcutGroup } from '@goodvibes/engine/terminal-shell/command-palette';

/**
 * Every shortcut group, from the live keybindings table (user overrides
 * included). The help palette lists the same groups as its last section.
 */
export function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  const bound = (action: string): string => {
    const entry = all.find((candidate) => candidate.action === action);
    return entry && entry.combos.length > 0 ? combos(entry) : '(unbound)';
  };
  // Keys that are real but are not key-table actions (context chords, literal characters), named as bound where they are one.
  const navigation: ReadonlyArray<readonly [string, string]> = [
    [`${bound('move-up')} / ${bound('move-down')}`, 'Scroll / history recall'],
    [`${bound('scroll-page-up')} / ${bound('scroll-page-down')}`, 'Scroll by full page'],
    ['Home / End', 'Jump to start / end of line'],
    ['Mouse wheel', 'Scroll conversation or hovered panel'],
    [bound('choose'), 'Submit message'],
    ['Shift+Enter', 'Insert newline'],
    ['@', 'Open file picker'],
    ['/', 'Slash command mode'],
    ['?', 'Help: every command and keyboard shortcut'],
    [bound('next-field'), 'Collapse/expand the nearest block; inside the Agent workspace, move between its area list and its action list'],
    [bound('cycle-permission-mode'), 'Change when GoodVibes asks, for this session (always; never switches sessions)'],
    // One step per press; the status line names what the next Esc does.
    [bound('back'), 'One step back: close the top overlay, else clear the prompt, else leave an agent or process view, else stop the running turn'],
    [bound('open-agents'), 'Open Your agents'],
    [bound('leader'), 'Starts a two-key shortcut: the screen shows every key that can follow'],
  ];
  // Agent and process views (shell/session-views.ts).
  const sessions: ReadonlyArray<readonly [string, string]> = [
    ['Enter on lane', 'Open that agent; typing steers it'],
    ['Enter on ▶ bead', "Open that process's live output"],
    [`${bound('next-session')} / ${bound('previous-session')}`, 'Next / previous session in the session row'],
    ['Esc in a view', 'Go up one level; stops nothing'],
    ['ctrl+x in view', 'Stop what the view shows (twice)'],
  ];
  return [
    { title: 'Navigation & editing', items: navigation },
    { title: 'Actions', items: all.filter((e) => e.combos.length > 0).map((e) => [combos(e), e.description] as const) },
    { title: 'Sessions', items: sessions },
  ];
}
