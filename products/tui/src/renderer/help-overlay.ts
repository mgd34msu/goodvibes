import { commandHelpGroups } from '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
import { createHelpBrowser } from '@goodvibes-jev/engine/terminal-shell/renderer/help-browser';
import '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
import { type HelpGroup } from '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
/**
 * renderHelpOverlay, the /commands reference: keyboard shortcuts plus the
 * full slash-command list, drawn with the modal surface kit as one grouped,
 * filterable kit list (✦ group headers, each entry's description on the left
 * and its key or command right-aligned, muted). The search row is always
 * live; ↑↓ scroll.
 *
 * `?` and `/help` open the searchable command browser (a selection modal that
 * runs the picked command) instead; that is a different, complementary
 * surface, not this one.
 */

import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';

import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import './theme.ts';
import './surface-kit.ts';
import './surface-kit-list.ts';
import './surface-kit-extra.ts';

export { renderShortcutsOverlay } from './shortcuts-overlay.ts';

/**
 * The row strings ("  Title", "  ────", "  key\tdescription", "") become
 * groups: a title row opens a group, rule rows are dropped, entry rows split
 * at the tab into key (right-aligned) and description (the row's label).
 */
function groupsFromRows(rows: readonly string[]): HelpGroup[] {
  const groups: HelpGroup[] = [];
  for (const row of rows) {
    const text = row.trim();
    if (!text || text.startsWith('\u2500')) continue;
    const tab = text.indexOf('\t');
    if (tab < 0) {
      groups.push({ title: text, entries: [] });
      continue;
    }
    if (groups.length === 0) groups.push({ title: 'Commands', entries: [] });
    groups[groups.length - 1]!.entries.push({ right: text.slice(0, tab).trim(), label: text.slice(tab + 1).trim() });
  }
  return groups.filter((g) => g.entries.length > 0);
}

/** Every help group for the live keybindings and registry. */
function helpGroups(keybindingsManager: KeybindingsManager, commands?: SlashCommand[]): HelpGroup[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);

  const shortcutLine = (label: string, desc: string): string => `  ${label}\t${desc}`;

  // Keyboard shortcut sections
  const shortcutRows: string[] = [
    '  Core Navigation',
    '  ' + '\u2500'.repeat(40),
    `  ${'Up / Down'}\tRecall input history; Down at bottom focuses the process indicator`,
    `  ${'PageUp / PageDn'}\tScroll by full page`,
    `  ${kb('search')}\tSearch conversation (Ctrl+F)`,
    '',
    '  Prompt And Editing',
    '  ' + '\u2500'.repeat(40),
    `  ${'Enter'}\tSubmit message (composer empty: open the block-actions menu)`,
    `  ${'Shift+Enter'}\tInsert newline`,
    `  ${kb('paste')}\tPaste (image priority)`,
    `  ${kb('undo') + ' / ' + kb('redo')}\tUndo / redo`,
    shortcutLine('(paste >8 lines)', 'Folds to [TEXT: pN, M lines]; /pastes previews it before you submit'),
    '',
    '  Overlays And Views',
    '  ' + '\u2500'.repeat(40),
    shortcutLine('?  or  /help', 'Open the command browser (search & run any command)'),
    shortcutLine('/commands', 'This reference: keyboard shortcuts + full command list'),
    shortcutLine('/shortcuts', 'Keyboard-shortcuts-only reference (a separate, generated overlay)'),
    shortcutLine(kb('command-palette'), 'Command palette: every command and view'),
    shortcutLine(`F2 / ${kb('open-agents')}`, 'Agents: running agents, chains and hosted sessions'),
    shortcutLine('/usage', 'Usage: context, tokens and cost'),
    shortcutLine('/changes', 'Changes: files, diff, review'),
    shortcutLine('/notifications', 'Notification history'),
    shortcutLine('Esc', 'Close the top modal (one level)'),
    // A partial path under the cursor claims Tab for completion; otherwise it
    // collapses or expands the nearest block.
    shortcutLine('Tab', 'Path-complete, else collapse/expand block'),
    '',
  ];

  // Featured commands shown in the Quick Start section.
  // Each entry is [commandName, subcommandOrArgHint, description].
  // Commands not registered in the live registry are omitted at render time.
  const FEATURED_COMMANDS: Array<[name: string, argHint: string, desc: string]> = [
    ['onboarding', '', 'Open the onboarding wizard with current settings preloaded'],
    ['agents', '', 'Agents: running agents, chains and hosted sessions'],
    ['usage', '', 'Usage: context, tokens and cost'],
    ['changes', '', 'Changes: files, tinted diff, review and staging'],
    ['notifications', '', 'Notification history'],
    ['settings', '', 'Settings and config browser'],
    ['provider', '', 'Choose provider or model family'],
    ['subscription', '', 'Review provider logins and subscriptions'],
    ['marketplace', 'open', 'Browse plugins, skills, and packs'],
    ['remote', 'setup', 'Review remote, bridge, and tunnel flows'],
    ['sandbox', 'review', 'Inspect secure execution posture'],
    ['security', '', 'Security review workspace'],
    ['policy', '', 'Simulation, lint, and preflight review'],
    ['incident', '', 'Incident workspace and export flows'],
    ['knowledge', '', 'Durable knowledge and review queue'],
    ['hooks', '', 'Hook workbench and runtime activity'],
    ['tasks', '', 'Task surface for list/show/pause/resume/output'],
  ];

  const ESSENTIAL_COMMANDS: Array<[name: string, desc: string]> = [
    ['model', 'Select provider or model'],
    ['sessions', 'Browse and resume saved sessions'],
    ['save', 'Save the current session'],
    ['compact', 'Compact the conversation history'],
    ['clear', 'Start a fresh conversation (current one saved)'],
    ['keybindings', 'List and customize key bindings'],
    ['panel', 'Open a view by its old pane name'],
  ];
  return [
    ...groupsFromRows(shortcutRows),
    ...commandHelpGroups(commands, {
      featured: FEATURED_COMMANDS,
      preferred: [
        'setup',
        'cockpit',
        'settings',
        'provider',
        'subscription',
        'marketplace',
        'remote',
        'sandbox',
        'security',
        'policy',
        'incident',
        'knowledge',
        'hooks',
        'orchestration',
        'communication',
        'tasks',
      ],
      essentials: ESSENTIAL_COMMANDS,
      fallback: [
        { right: '/commands', label: 'Show this help overlay' },
        { right: '/help', label: 'Browse & run any command' },
        { right: '/shortcuts', label: 'Keyboard shortcut reference' },
        { right: '/model', label: 'Select LLM model' },
        { right: '/clear', label: 'Start a fresh conversation (current one saved)' },
      ],
      onTraversalError: (error) =>
        logger.warn(`[help-overlay] registry traversal error during command filter; using unfiltered list: ${error}`),
    }),
  ];
}

/**
 * Render the help overlay as a SurfaceLayer in screen coordinates.
 *
 * @param scrollOffset  Rows scrolled past the top of the list.
 * @param filter        The search row's query; the renderer records how far the list can scroll in it.
 */
export const { renderHelpOverlay } = createHelpBrowser(helpGroups);
