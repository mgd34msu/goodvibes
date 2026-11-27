/**
 * The one reading of a settings call's `action` (or `mode`). The settings
 * tool and its input projector both ask this module, so a word that one of
 * them reads as a write is a write for both: a write that reached `execute`
 * without its admission capture would be refused.
 */

export type SettingsAction = 'list' | 'get' | 'set' | 'reset' | 'import';

export const SETTINGS_ACTION_WORDS: readonly SettingsAction[] = ['list', 'get', 'set', 'reset', 'import'];

const SETTINGS_ACTION_ALIASES: ReadonlyMap<string, SettingsAction> = new Map<string, SettingsAction>([
  ...['list', 'status', 'settings', 'catalog', 'search', 'find', 'browse'].map(word => [word, 'list'] as const),
  ...['get', 'show', 'inspect', 'read', 'setting', 'get_setting'].map(word => [word, 'get'] as const),
  ...['set', 'update', 'change', 'configure', 'set_setting'].map(word => [word, 'set'] as const),
  ...['reset', 'clear', 'default', 'restore', 'reset_setting'].map(word => [word, 'reset'] as const),
  ...['import', 'import_settings', 'settings_import', 'import_goodvibes', 'goodvibes_import', 'apply_import'].map(word => [word, 'import'] as const),
]);

/** Lower case, trimmed, `-` read as `_`; anything that is not a string is no word. */
export function settingsActionWord(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : '';
}

function aliasOf(value: unknown): SettingsAction | undefined {
  return SETTINGS_ACTION_ALIASES.get(settingsActionWord(value));
}

/**
 * The settings tool's action. A word in `action` wins, then one in `mode`;
 * with neither, a named key reads that setting and nothing lists. null when a
 * word was sent that is no action: reading it as a read would answer a
 * different question than the one asked.
 */
export function readSettingsAction(args: Readonly<Record<string, unknown>>): SettingsAction | null {
  if (settingsActionWord(args.action) || settingsActionWord(args.mode)) return aliasOf(args.action) ?? aliasOf(args.mode) ?? null;
  const named = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  return named(args.key) || named(args.setting) ? 'get' : 'list';
}
