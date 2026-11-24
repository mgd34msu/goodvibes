/**
 * The slash commands' actions (lib/generated/command-actions.ts, over a megabyte
 * of descriptions) and the settings sections, loaded when something first needs
 * them instead of with the chat: the palette opening, a `/` typed in the
 * composer, a slash command sent, Settings or a sheet opening. One load per tab;
 * every later caller gets the loaded copy at once.
 *
 * A load that fails (the network dropped while the file came) is tried again by
 * the next caller; a page built before the daemon's current one reloads itself
 * (hooks/usePreloadErrorReload).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CommandActionsSnapshot } from './command-actions-types';
import type { SettingsSectionDef } from '../components/settings/dialog/sections';

export interface CommandCatalog {
  readonly actions: CommandActionsSnapshot;
  readonly settingsSections: readonly SettingsSectionDef[];
}

let catalog: CommandCatalog | null = null;
let loading: Promise<CommandCatalog> | null = null;
const listeners = new Set<() => void>();

/** The catalog once loaded, else null. */
export function commandCatalog(): CommandCatalog | null {
  return catalog;
}

/** Load the catalog (once); resolves with it. */
export function loadCommandCatalog(): Promise<CommandCatalog> {
  if (catalog) return Promise.resolve(catalog);
  loading ??= Promise.all([import('./generated/command-actions'), import('../components/settings/dialog/sections')])
    .then(([actions, sections]) => {
      catalog = { actions: actions.COMMAND_ACTIONS, settingsSections: sections.SETTINGS_SECTIONS };
      for (const listener of [...listeners]) listener();
      return catalog;
    }, (error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The catalog, or null until it has loaded; with `load`, this mount asks for it. */
export function useCommandCatalog(load: boolean): CommandCatalog | null {
  const current = useSyncExternalStore(subscribe, commandCatalog, commandCatalog);
  useEffect(() => {
    if (load && !current) void loadCommandCatalog().catch(() => undefined);
  }, [load, current]);
  return current;
}
