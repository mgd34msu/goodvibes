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

import { useCallback, useEffect, useMemo, useState } from 'react';
import '../../styles/components/command.css';
import { registerCommand, unregisterCommand, type CommandDef } from '../../lib/commands';
import type { ViewId } from '../../lib/router';
import { SETTINGS_SECTIONS } from '../settings/dialog/sections';
import { useHotkeys } from '../../hooks/useHotkeys';
import { CommandPalette } from './CommandPalette';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';

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
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
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
        title: 'Models and providers',
        group: 'settings',
        keywords: ['providers', 'models', 'llm', 'ai', 'settings'],
        shortcut: 'g p',
        run: () => onOpenSettings?.('models'),
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
        shortcut: 'mod+shift+n',
        run: () => onNavigate?.('chat', { newChat: true }),
        allowInInput: true,
      },
      {
        id: 'system.palette',
        title: 'Open Command Palette',
        group: 'system',
        keywords: ['command', 'palette', 'search'],
        shortcut: 'mod+k',
        run: openPalette,
        // The key toggles; the palette command only opens.
        hotkey: () => setPaletteOpen((open) => !open),
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
    // Every other settings section is one command in the palette's Settings group
    // ("Models and providers" is nav.providers above).
    for (const section of SETTINGS_SECTIONS) {
      if (section.id === 'models') continue;
      defs.push({
        id: `settings.${section.id}`,
        title: section.label,
        group: 'settings',
        keywords: ['settings', ...section.keywords],
        ...(section.id === 'account' ? { shortcut: 'g a' } : {}),
        run: () => onOpenSettings?.(section.id),
      });
    }
    return defs;
  }, [onNavigate, onOpenSettings, openPalette, openCheatsheet]);

  useEffect(() => {
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
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <ShortcutCheatsheet open={cheatsheetOpen} onClose={closeCheatsheet} />
    </>
  );
}
