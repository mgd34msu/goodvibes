import { commandHelpGroups } from '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
import { createHelpBrowser } from '@goodvibes-jev/engine/terminal-shell/renderer/help-browser';
import '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
import { type HelpGroup } from '@goodvibes-jev/engine/terminal-shell/renderer/help-groups';
/**
 * renderHelpOverlay, the help modal (`?` or /help): keyboard shortcuts plus
 * the slash-command list, drawn with the modal surface kit as one grouped,
 * filterable kit list (✦ group headers, each entry's description on the left
 * and its key or command right-aligned, muted). The search row is always
 * live; ↑↓ and PgUp/PgDn scroll.
 *
 * The keyboard shortcuts modal (/shortcuts) lives in shortcuts-overlay.ts.
 */

import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';

import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import './theme.ts';
import './surface-kit.ts';
import './surface-kit-list.ts';
import './surface-kit-extra.ts';
import { SHORTCUT_OVERLAY_STATIC_TEXT } from './shortcuts-overlay.ts';

export { renderShortcutsOverlay } from './shortcuts-overlay.ts';

const FEATURED_HELP_COMMANDS: Array<[name: string, argHint: string, desc: string]> = [
  ['agent', '', 'Open workspace; press / there to search every action'],
  ['agent', 'knowledge', 'Open isolated Agent Knowledge workspace actions'],
  ['agent', 'voice', 'Open voice, image, and media workspace actions'],
  ['setup', '', 'Open the Agent workspace'],
  ['knowledge', 'status', 'Inspect isolated Agent Knowledge readiness'],
  ['memory', '', 'Manage Agent-local memory records'],
  ['personas', '', 'Manage serial Agent operating personas'],
  ['skills', '', 'Manage Agent-local skills and bundles'],
  ['routines', '', 'Manage reusable main-conversation routines'],
  ['approval', '', 'Review and explicitly act on approvals'],
  ['automation', '', 'Run confirmed connected-host automation actions'],
  ['schedule', 'remind', 'Create confirmed reminders or inspect schedules'],
  ['delegate', '', 'Explicitly hand build/fix/review work to GoodVibes TUI'],
  ['mcp', '', 'Inspect MCP servers and tool readiness'],
  ['provider', '', 'Choose provider or model family'],
  ['model', '', 'Select the active model route'],
  ['subscription', '', 'Review provider logins and subscriptions'],
  ['secrets', '', 'Manage secret references without printing values'],
  ['bundle', 'inspect', 'Inspect Agent support bundles from the TUI'],
  ['compat', '', 'Inspect connected-host and Agent Knowledge compatibility'],
  ['health', '', 'Run Agent runtime and setup diagnostics'],
];

const HELP_OVERLAY_STATIC_TEXT = [
  'Core Navigation',
  'Scroll / history recall',
  'Scroll by full page',
  'Search conversation (Ctrl+F)',
  'Prompt And Editing',
  'Submit message',
  'Insert newline',
  'Paste (image priority)',
  'Undo / redo',
  'Overlays And Workspace',
  'Toggle help',
  'Full keyboard shortcuts',
  'Open the Agent operator workspace',
  'Search all Agent workspace actions',
  'Open selected action or form',
  'Quick Start',
  'Available Slash Commands',
  'More Commands',
  'Hidden power commands still work, run /commands for the full catalog.',
  'Essentials',
  'Show this help overlay',
  'Keyboard shortcut reference',
  'Select LLM model',
  'Clear conversation',
] as const;

export function renderHelpOverlayPackageText(): string {
  return [
    ...HELP_OVERLAY_STATIC_TEXT,
    'Help',
    'Filter commands and shortcuts',
    'Nothing matches "<query>".',
    'scroll',
    'close',
    ...FEATURED_HELP_COMMANDS.flatMap(([name, argHint, desc]) => [argHint ? `/${name} ${argHint}` : `/${name}`, desc]),
    ...SHORTCUT_OVERLAY_STATIC_TEXT,
  ].join('\n');
}

/** The preferred order of the "Available Slash Commands" group. */
const PREFERRED_COMMANDS = [
  'agent',
  'setup',
  'knowledge',
  'memory',
  'personas',
  'skills',
  'routines',
  'approval',
  'schedule',
  'delegate',
  'mcp',
  'provider',
  'model',
  'subscription',
  'secrets',
  'health',
  'settings',
  'security',
  'policy',
  'tasks',
] as const;

/** Every help group for the live keybindings and registry. */
function helpGroups(keybindingsManager: KeybindingsManager, commands?: SlashCommand[]): HelpGroup[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);

  const groups: HelpGroup[] = [
    {
      title: 'Core Navigation',
      entries: [
        { right: 'Up / Down', label: 'Scroll / history recall' },
        { right: 'PageUp / PageDn', label: 'Scroll by full page' },
        { right: kb('search'), label: 'Search conversation (Ctrl+F)' },
      ],
    },
    {
      title: 'Prompt And Editing',
      entries: [
        { right: 'Enter', label: 'Submit message' },
        { right: 'Shift+Enter', label: 'Insert newline' },
        { right: kb('paste'), label: 'Paste (image priority)' },
        { right: `${kb('undo')} / ${kb('redo')}`, label: 'Undo / redo' },
      ],
    },
    {
      title: 'Overlays And Workspace',
      entries: [
        { right: '?', label: 'Toggle help' },
        { right: '/shortcuts', label: 'Full keyboard shortcuts' },
        { right: kb('workspace-picker'), label: 'Open the Agent operator workspace' },
        { right: 'Workspace /', label: 'Search all Agent workspace actions' },
        { right: 'Workspace Enter', label: 'Open selected action or form' },
      ],
    },
  ];

  return [
    ...groups,
    ...commandHelpGroups(commands, {
      featured: FEATURED_HELP_COMMANDS,
      preferred: PREFERRED_COMMANDS,
      fallback: [
        { right: '/help', label: 'Show this help overlay' },
        { right: '/shortcuts', label: 'Keyboard shortcut reference' },
        { right: '/model', label: 'Select LLM model' },
        { right: '/clear', label: 'Clear conversation' },
      ],
      onTraversalError: (error) =>
        logger.warn(`[help-overlay] registry traversal error during command filter; using unfiltered list: ${error}`),
    }),
  ].filter((group) => group.entries.length > 0);
}

const NOTE = 'Hidden power commands still work, run /commands for the full catalog.';

/**
 * Render the help modal as a SurfaceLayer in screen coordinates.
 *
 * @param scrollOffset  Rows scrolled past the top of the list.
 * @param filter        The search row's query; the renderer records how far the list can scroll in it.
 */
export const { renderHelpOverlay } = createHelpBrowser(helpGroups, NOTE);
