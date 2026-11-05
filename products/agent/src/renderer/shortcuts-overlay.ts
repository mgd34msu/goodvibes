/**
 * renderShortcutsOverlay, the keyboard shortcuts modal (/shortcuts), drawn
 * like the concept's "keys" screen: columns of key / action pairs, keys bold,
 * actions muted, grouped under ✦ headers, with the always-live search row
 * filtering by key or action. Reflects the live keybindings labels (user
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
/** The static strings this surface can show (checked by package verification through help-overlay.ts). */
export const SHORTCUT_OVERLAY_STATIC_TEXT = [
  'Keyboard shortcuts',
  'customize with /keybindings',
  'Filter shortcuts',
  'No shortcuts match "<query>".',
  'Navigation',
  'Scroll / history recall',
  'Scroll by full page',
  'Jump to start / end of line',
  'Search conversation',
  'Scroll conversation or hovered panel',
  'Editing',
  'Submit message',
  'Insert newline',
  'Open file picker',
  'Slash command mode',
  'Paste (image priority)',
  'Undo / redo',
  'Clear prompt',
  'Delete word backward',
  'Kill to end of line',
  'Move to start of line',
  'Next error / line end',
  'Actions',
  'Collapse/expand block',
  'Bookmark block',
  'Copy block to clipboard',
  'Block file save disabled; copy or export',
  'Copy selection',
  'Process monitor',
  'Help overlay',
  'Exit',
  'Workspace',
  'Swap focus between input and active Agent workspace',
  'Open the Agent operator workspace',
  'Cycle Agent workspace category forward',
  'Cycle Agent workspace category backward',
  'Config: /keybindings to list and customize',
  'Sessions',
  'Open that agent; typing steers it',
  "Open that process's live output",
  'Next / prev session (empty composer)',
  'Go up one level; stops nothing',
  'Stop what the view shows (twice)',
] as const;

/** Every shortcut group, from the live keybindings table (user overrides included). */
function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);
  return [
    {
      title: 'Navigation',
      items: [
        ['Up / Down', 'Scroll / history recall'],
        ['PageUp / PageDn', 'Scroll by full page'],
        ['Home / End', 'Jump to start / end of line'],
        [kb('search'), 'Search conversation'],
        ['Mouse wheel', 'Scroll conversation or hovered panel'],
      ],
    },
    {
      title: 'Editing',
      items: [
        ['Enter', 'Submit message'],
        ['Shift+Enter', 'Insert newline'],
        ['@', 'Open file picker'],
        ['/', 'Slash command mode'],
        [kb('paste'), 'Paste (image priority)'],
        [`${kb('undo')} / ${kb('redo')}`, 'Undo / redo'],
        [kb('clear-prompt'), 'Clear prompt'],
        [kb('delete-word'), 'Delete word backward'],
        [kb('kill-line'), 'Kill to end of line'],
        [kb('line-start'), 'Move to start of line'],
        [kb('next-error-line-end'), 'Next error / line end'],
      ],
    },
    {
      title: 'Actions',
      items: [
        ['Tab', 'Collapse/expand block'],
        [kb('bookmark'), 'Bookmark block'],
        [kb('block-copy'), 'Copy block to clipboard'],
        [kb('block-save'), 'Block file save disabled; copy or export'],
        [kb('copy-selection'), 'Copy selection'],
        ['F2', 'Process monitor'],
        ['?', 'Help overlay'],
        [`${kb('clear-cancel')} x2`, 'Exit'],
      ],
    },
    {
      title: 'Workspace',
      items: [
        ['Tab', 'Swap focus between input and active Agent workspace'],
        [kb('workspace-picker'), 'Open the Agent operator workspace'],
        [kb('workspace-tab-next'), 'Cycle Agent workspace category forward'],
        [kb('workspace-tab-prev'), 'Cycle Agent workspace category backward'],
      ],
    },
    {
      // Agent and process views (shell/session-views.ts); these keys are fixed.
      title: 'Sessions',
      items: [
        ['Enter on lane', 'Open that agent; typing steers it'],
        ['Enter on ▶ bead', "Open that process's live output"],
        ['Tab / Shift+Tab', 'Next / prev session (empty composer)'],
        ['Esc in a view', 'Go up one level; stops nothing'],
        ['ctrl+x in view', 'Stop what the view shows (twice)'],
      ],
    },
  ];
}

export function renderShortcutsOverlay(screenWidth: number, screenHeight: number, keybindingsManager: KeybindingsManager, scrollOffset = 0, filter?: OverlayFilter) {
  return render(screenWidth, screenHeight, shortcutGroups(keybindingsManager), scrollOffset, filter);
}
