/**
 * keys-capabilities.ts, the services the key capabilities run on in both
 * terminal programs (capabilities/builtin/keys.ts: keys.bind, keys.reset,
 * keys.reset-all, home `session`): the program's own key table. The Keys
 * place and the model's `capability_run` run the same definitions on it, so
 * what each says is the same. There is no slash command for them.
 */
import { KEY_ACTIONS_LIST, CapabilityRefusal, type KeysCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import { defineList } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { parseKeyText, type KeyCombo, type KeyContextEntry } from './keybindings.js';

/** The key table as the key capabilities use it (both programs' KeybindingsManager). */
export interface KeysTable {
  getAll(): ReadonlyArray<{ readonly action: string; readonly combos: readonly KeyCombo[]; readonly description: string }>;
  getContextActions(): readonly KeyContextEntry[];
  getComboLabel(action: string): string;
  setOverride(action: string, combos: readonly KeyCombo[]): readonly string[];
  clearOverride(action: string): readonly string[];
  clearAllOverrides(): readonly string[];
  formatCombo(combo: KeyCombo): string;
  getConfigPath(): string;
}

/** What a reload of the table said, in a sentence (the conflicts it found, or nothing). */
function saidOf(notices: readonly string[]): string {
  return notices.map((notice) => notice.replace(/^keybindings: /, '')).join(' ');
}

/** An action's words: the program's own, or a place's under its name. */
function describe(table: KeysTable, action: string): string | undefined {
  const own = table.getAll().find((entry) => entry.action === action);
  if (own) return own.description;
  const placed = table.getContextActions().find((entry) => entry.action === action);
  return placed ? `${placed.contextTitle}: ${placed.description}` : undefined;
}

/** The key capabilities' services over one program's key table. */
export function keysServices(table: KeysTable, changed: () => void = () => {}): NonNullable<KeysCapabilityServices['keys']> {
  const known = (action: string): string => {
    const words = describe(table, action);
    if (!words) throw new CapabilityRefusal(`No key action is named ${action}.`, 'The Keys place names every action', 'NOT_FOUND');
    return words;
  };
  return {
    bind(action, key) {
      const words = known(action);
      const combo = parseKeyText(key, table.getComboLabel('leader'));
      if (!combo) throw new CapabilityRefusal(`"${key}" is not a key this program reads.`, 'Write it as ctrl+k, f5, shift+tab, or leader m', 'INVALID_ARGUMENT');
      const said = saidOf(table.setOverride(action, [combo]));
      changed();
      return `${table.formatCombo(combo)} now does "${words}", kept in ${table.getConfigPath()}.${said ? ` ${said}` : ''}`;
    },
    reset(action) {
      const words = known(action);
      const said = saidOf(table.clearOverride(action));
      changed();
      const bound = table.getComboLabel(action);
      return `"${words}" is back on its default: ${bound === '(unbound)' ? 'no key' : bound}.${said ? ` ${said}` : ''}`;
    },
    resetAll() {
      const said = saidOf(table.clearAllOverrides());
      changed();
      // The file by its name: a place leaves out a line with a long run of characters (a path reads as an id there).
      return `Every key is back on its default; keybindings.json keeps no change.${said ? ` ${said}` : ''}`;
    },
  };
}

interface KeysListContext extends CommandActionContext {
  readonly workspace: { readonly keybindingsManager?: KeysTable | undefined };
}

/** The live list of key actions: the program's own, then each place's under its name. */
defineList<KeysListContext>({
  name: KEY_ACTIONS_LIST,
  async read(ctx) {
    const table = ctx.workspace.keybindingsManager;
    if (!table) return [];
    const label = (combos: readonly KeyCombo[]): string => combos.map((combo) => table.formatCombo(combo)).join(', ') || 'no key';
    return [
      ...table.getAll().map((entry) => ({ value: entry.action, label: entry.description, state: label(entry.combos) })),
      ...table.getContextActions().map((entry) => ({ value: entry.action, label: `${entry.contextTitle}: ${entry.description}`, state: label(entry.combos) })),
    ];
  },
  operator: { terminalOnly: 'Keys belong to the terminal program that reads them.' },
});
