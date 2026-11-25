/**
 * CommandProvider
 *
 * Mounts the CommandPalette and ShortcutCheatsheet, wires ⌘K / ? hotkeys,
 * and registers the default navigation commands.
 *
 * Integration phase usage:
 *   import CommandProvider from './components/command/CommandProvider';
 *   // In App.tsx (or shell wrapper), wrap children:
 *   <CommandProvider onNavigate={setActiveView}>
 *     {children}
 *   </CommandProvider>
 *
 * Or, if you just want to mount the command system at root without wrapping:
 *   <CommandProvider onNavigate={setActiveView} />
 *
 * onNavigate receives a view id ('chat', 'work', 'library', 'personal'), an
 * optional tab of that destination, and an optional newChat boolean for the
 * "New chat" command. onOpenSettings opens the
 * settings dialog, on a section when one is named ('models' for the old
 * "Go to Providers", 'account' for the old "Go to Admin").
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import '../../styles/components/command.css';
import { registerCommand, setPaletteOpener, unregisterCommand, type CommandDef } from '../../lib/commands';
import type { ViewId } from '../../lib/router';
import { useCommandCatalog } from '../../lib/command-catalog';
import { useHotkeys } from '../../hooks/useHotkeys';
import { NEW_CHAT_KEYS } from '../../lib/shortcut-keys';
import { CommandPalette } from './CommandPalette';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';
import { COMMAND_SCREEN_LIST } from './screens/command-screen-list';
import { daemonCapabilities, useCapabilityIndex } from '../../lib/place-capabilities';

// An action's sheet and a command's screen load when one is opened.
const ActionSheet = lazy(() => import('./ActionSheet').then((module) => ({ default: module.ActionSheet })));
const CommandScreenDrawer = lazy(() => import('./screens/CommandScreens').then((module) => ({ default: module.CommandScreenDrawer })));
// A capability opened from the palette (listed, or found by what it does) runs as a place runs it (views/places).
const CapabilityRunner = lazy(() => import('../../views/places/CapabilityRunner').then((module) => ({ default: module.CapabilityRunner })));

export type { ViewId };

/** A command plus how its shortcut is bound as a global hotkey. */
type ShortcutCommand = CommandDef & {
  /** `false` when another component owns the hotkey; a function when the key does something other than `run`. */
  hotkey?: false | (() => void);
  allowInInput?: boolean;
};

interface CommandProviderProps {
  /**
   * Called when a navigation command fires.
   * Integration phase wires this to App's setActiveView.
   */
  onNavigate?: (view: ViewId, options?: { newChat?: boolean; tab?: string }) => void;
  /** Open the settings dialog, on a section when one is named. */
  onOpenSettings?: (section?: string) => void;
  children?: React.ReactNode;
}

export default function CommandProvider({ onNavigate, onOpenSettings, children }: CommandProviderProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The search the palette opens on (a slash command with several actions opens it on `/<command>`).
  const [paletteQuery, setPaletteQuery] = useState('');
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  useEffect(() => {
    setPaletteOpener((query) => { setPaletteQuery(query); setPaletteOpen(true); });
    return () => setPaletteOpener(null);
  }, []);
  /** The slash-command action whose sheet is open from the palette. */
  const [sheet, setSheet] = useState<{ readonly command: string; readonly action: string } | null>(null);
  /** The screen drawn from a command's description (schedules, MCP servers ...) open in a panel. */
  const [screen, setScreen] = useState<string | null>(null);
  /** A capability opened from the palette: its form, then `capabilities.run`. */
  const [capability, setCapability] = useState<string | null>(null);
  // The slash commands' actions and the settings sections: loaded the first time the palette opens.
  const catalog = useCommandCatalog(paletteOpen);
  // Every capability the daemon can run, read from it when the palette first opens.
  const capabilities = useCapabilityIndex(paletteOpen);

  const openPalette = useCallback(() => { setPaletteQuery(''); setPaletteOpen(true); }, []);
  const closePalette = useCallback(() => { setPaletteOpen(false); setPaletteQuery(''); }, []);
  const openCheatsheet = useCallback(() => setCheatsheetOpen(true), []);
  const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), []);

  // One table owns every shortcut: the palette and cheatsheet read `shortcut` off the
  // registered command, and the hotkeys below are built from the same entries, so a
  // combo cannot change in one place and stay stale in the other.
  const definitions = useMemo<readonly ShortcutCommand[]>(() => {
    const defs: ShortcutCommand[] = [
      {
        id: 'nav.chat',
        title: 'Go to Chat',
        group: 'navigation',
        keywords: ['chat', 'messages', 'live'],
        shortcut: 'g c',
        run: () => onNavigate?.('chat'),
      },
      {
        id: 'nav.knowledge',
        title: 'Go to Knowledge',
        group: 'navigation',
        keywords: ['knowledge', 'wiki', 'docs'],
        shortcut: 'g k',
        run: () => onNavigate?.('library', { tab: 'knowledge' }),
      },
      {
        id: 'nav.work',
        title: 'Go to Work',
        group: 'navigation',
        keywords: ['work', 'sessions', 'agents', 'processes', 'fleet', 'approvals', 'needs you', 'checkpoints', 'ci'],
        shortcut: 'g w',
        run: () => onNavigate?.('work'),
      },
      {
        id: 'nav.library',
        title: 'Go to Library',
        group: 'navigation',
        keywords: ['library', 'memory', 'knowledge', 'review'],
        shortcut: 'g l',
        run: () => onNavigate?.('library'),
      },
      {
        id: 'nav.personal',
        title: 'Go to Personal',
        group: 'navigation',
        keywords: ['personal', 'calendar', 'mail', 'occasions', 'dates'],
        shortcut: 'g o',
        run: () => onNavigate?.('personal'),
      },
      {
        id: 'nav.providers',
        title: 'Go to Models and providers',
        group: 'navigation',
        keywords: ['models and providers', 'providers', 'models', 'llm', 'ai'],
        shortcut: 'g p',
        // The Models and providers place (its lists and controls); the place links to its settings section.
        run: () => onNavigate?.('places', { tab: 'models' }),
      },
      {
        id: 'nav.admin',
        title: 'Open settings',
        group: 'settings',
        keywords: ['admin', 'settings', 'auth', 'account', 'preferences'],
        shortcut: 'mod+,',
        run: () => onOpenSettings?.(),
        // ShellLayout binds this combo itself, where it can also stop the browser's own handling.
        hotkey: false,
      },
      {
        id: 'chat.new',
        title: 'New Chat',
        group: 'chat',
        keywords: ['new', 'create', 'session'],
        // A sequence (lib/shortcut-keys.ts): the browsers keep the Ctrl+Shift letters for themselves.
        shortcut: NEW_CHAT_KEYS,
        run: () => onNavigate?.('chat', { newChat: true }),
      },
      {
        id: 'system.palette',
        title: 'Open Command Palette',
        group: 'system',
        keywords: ['command', 'palette', 'search'],
        shortcut: 'mod+k',
        run: openPalette,
        // The key toggles; the palette command only opens.
        hotkey: () => { setPaletteQuery(''); setPaletteOpen((open) => !open); },
        // Must fire even when the palette's own search input is focused (toggle/close)
        allowInInput: true,
      },
      {
        id: 'system.shortcuts',
        title: 'Show Keyboard Shortcuts',
        group: 'system',
        keywords: ['shortcuts', 'hotkeys', 'help', 'cheatsheet'],
        shortcut: '?',
        run: openCheatsheet,
        hotkey: () => setCheatsheetOpen((open) => !open),
      },
    ];
    // Every slash-command action the daemon can run is one palette entry; it opens the action's sheet.
    // They come with the command catalog, loaded when the palette first opens (or anything else asks for it).
    for (const command of catalog?.actions.commands ?? []) {
      for (const action of command.actions) {
        if (!('method' in action.operator) || action.touches === 'reads') continue;
        defs.push({
          id: `action.${command.name}.${action.id}`,
          title: action.label,
          group: 'system',
          keywords: [command.title, `/${command.name}`, action.word],
          run: () => setSheet({ command: command.name, action: action.id }),
        });
      }
    }
    // Every other capability the daemon can run (one moved beside its handler and run through capabilities.run, a
    // read, one no slash command carries) is one entry too; it opens its form and runs as a place runs it. The
    // palette's search also asks capabilities.find for what does a need in words (CommandPalette, onRunCapability).
    if (capabilities) {
      // The ones a slash command's sheet already offers (above) are not listed twice.
      const sheeted = new Set((catalog?.actions.commands ?? []).flatMap((command) => command.actions
        .filter((action) => 'method' in action.operator && action.touches !== 'reads').map((action) => `${command.name} ${action.id}`)));
      for (const found of daemonCapabilities(capabilities)) {
        if (sheeted.has(`${found.command.name} ${found.action.id}`)) continue;
        defs.push({
          id: `capability.${found.id}`,
          title: found.action.label,
          group: 'system',
          keywords: [found.command.title, found.id, found.action.word],
          run: () => setCapability(found.id),
        });
      }
    }
    // Every place, in the fourteen groups (views/places).
    defs.push({
      id: 'nav.places',
      title: 'Go to Places',
      group: 'navigation',
      keywords: ['places', 'automation', 'waiting', 'devices', 'money', 'tools', 'models', 'safety', 'system', 'memory', 'sessions', 'work'],
      run: () => onNavigate?.('places'),
    });
    // Each screen drawn from a command's description (its rows carry the command's actions) opens in a panel.
    // A screen that is a place's (Automation, Money, ...) opens that place: the renderer is the one web view of a group.
    for (const entry of COMMAND_SCREEN_LIST) {
      const place = entry.place;
      defs.push({
        id: `screen.${entry.id}`,
        title: entry.title,
        group: 'settings',
        keywords: [`/${entry.command}`, ...entry.keywords],
        run: place ? () => onNavigate?.('places', { tab: place }) : () => setScreen(entry.id),
      });
    }
    // Every settings section is one command in the palette's Settings group ("Models and providers" itself opens the
    // place, nav.providers above, so its settings section is named as settings).
    for (const section of catalog?.settingsSections ?? []) {
      defs.push({
        id: `settings.${section.id}`,
        title: section.id === 'models' ? `${section.label} settings` : section.label,
        group: 'settings',
        keywords: ['settings', ...section.keywords],
        ...(section.id === 'account' ? { shortcut: 'g a' } : {}),
        run: () => onOpenSettings?.(section.id),
      });
    }
    return defs;
  }, [onNavigate, onOpenSettings, openPalette, openCheatsheet, catalog, capabilities]);

  // Registered before any passive effect of the same render runs, so a slash command that
  // waited for the catalog (ChatView) finds its palette command when it runs.
  useLayoutEffect(() => {
    for (const { hotkey: _hotkey, allowInInput: _allowInInput, ...command } of definitions) registerCommand(command);
    return () => {
      for (const { id } of definitions) unregisterCommand(id);
    };
  }, [definitions]);

  // NOTE: Escape is intentionally NOT registered here globally.
  // Each overlay (CommandPalette, ShortcutCheatsheet) owns its own Escape
  // handler via onKeyDown so dismiss logic stays within the overlay's
  // event chain and does not interfere with other Escape consumers.
  useHotkeys(
    definitions.flatMap((def) => {
      if (!def.shortcut || def.hotkey === false) return [];
      const handler = typeof def.hotkey === 'function' ? def.hotkey : def.run;
      return [{ combo: def.shortcut, handler: () => handler(), ...(def.allowInInput ? { allowInInput: true } : {}) }];
    }),
  );

  return (
    <>
      {children}
      <CommandPalette open={paletteOpen} onClose={closePalette} initialQuery={paletteQuery} onRunCapability={setCapability} />
      <ShortcutCheatsheet open={cheatsheetOpen} onClose={closeCheatsheet} />
      <Suspense fallback={null}>
        {screen ? <CommandScreenDrawer screen={screen} onClose={() => setScreen(null)} /> : null}
        {sheet ? <ActionSheet key={`${sheet.command}.${sheet.action}`} open command={sheet.command} action={sheet.action} onClose={() => setSheet(null)} /> : null}
        {capability ? <CapabilityRunner key={capability} id={capability} onClose={() => setCapability(null)} /> : null}
      </Suspense>
    </>
  );
}
