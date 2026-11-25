/**
 * keys-place.ts, the Keys place (under System): every key the program acts
 * on, as bound now, with what it does, and each place's own keys under the
 * place's name; change one by pressing the new key (the leader then a key
 * makes a sequence), put one back on its default, or put every key back.
 * Each change is a key capability (capabilities/builtin/keys.ts: keys.bind,
 * keys.reset, keys.reset-all), the same the model runs; what they
 * write is the keybindings.json a person can edit by hand. Two actions on one
 * key are reported in plain words, naming both.
 */
import type { KeyCombo } from '../keybindings.js';
import type { PlaceKeyTable, PlacePrograms, PlaceProgramSource } from './place-host.js';
import { definePlace, type PlaceItem } from './place-types.js';

interface KeyItem extends PlaceItem {
  readonly state: 'default' | 'changed' | 'conflict' | 'unbound';
  readonly description: string;
  /** The place the key belongs to, for a place's own key. */
  readonly place?: string | undefined;
  readonly bound: readonly string[];
  readonly defaults: readonly string[];
  readonly conflicts: readonly string[];
}

function same(left: readonly KeyCombo[], right: readonly KeyCombo[]): boolean {
  const print = (combo: KeyCombo): string => `${combo.leader ? 'L' : ''}${combo.key}:${combo.ctrl ? 1 : 0}${combo.shift ? 1 : 0}${combo.alt ? 1 : 0}`;
  return left.length === right.length && left.every((combo, index) => print(combo) === print(right[index]!));
}

/** The key table as the place's items: the program's own keys, then each place's. */
export function readKeys(keys: PlaceKeyTable): readonly KeyItem[] {
  const conflicts = keys.getConflicts();
  const item = (action: string, combos: readonly KeyCombo[], description: string, place?: string): KeyItem => {
    const defaults = keys.getDefaults(action);
    const mine = conflicts.filter((conflict) => conflict.actions.includes(action)).map((conflict) => conflict.sentence);
    return {
      id: action,
      state: mine.length > 0 ? 'conflict' : combos.length === 0 ? 'unbound' : same(combos, defaults) ? 'default' : 'changed',
      description,
      ...(place ? { place } : {}),
      bound: combos.map((combo) => keys.formatCombo(combo)),
      defaults: defaults.map((combo) => keys.formatCombo(combo)),
      conflicts: mine,
    };
  };
  return [
    ...keys.getAll().map(({ action, combos, description }) => item(action, combos, description)),
    ...keys.getContextActions().map(({ action, combos, description, contextTitle }) => item(action, combos, description, contextTitle)),
  ];
}

/** The program source the Keys place reads, told of every change to the table (here, the model, a reload). */
export function keysSource(keys: PlaceKeyTable & { subscribe(listener: () => void): () => void }): PlaceProgramSource {
  return {
    read: () => readKeys(keys),
    subscribe: (onChange) => keys.subscribe(onChange),
  };
}

/** The Keys place's one program action: read the new key as pressed, then bind it (keys.bind). */
export function keysProgramActions(keys: PlaceKeyTable): Readonly<Record<string, (itemId: string, place: PlacePrograms) => Promise<string | undefined>>> {
  const describe = (action: string): string => keys.getAll().find((entry) => entry.action === action)?.description
    ?? keys.getContextActions().find((entry) => entry.action === action)?.description ?? action;
  return {
    async 'keys.change'(action, place) {
      const combo = await place.captureKey(`Press the new key for "${describe(action)}" (the leader first for a two-key shortcut).`);
      if (!combo) return 'The key was kept as it was.';
      const key = combo.leader ? `leader ${keys.formatCombo({ ...combo, leader: false })}` : keys.formatCombo(combo);
      const outcome = await place.run('keys.bind', { action, key });
      if (!outcome.ok) throw new Error(outcome.reason);
      return `${outcome.lines.join(' ')} To undo: d puts back the default.`;
    },
  };
}

export const KEYS_PLACE = definePlace<KeyItem>({
  id: 'keys',
  group: 'system',
  title: 'Keys',
  lists: [
    {
      id: 'keys',
      label: 'Keys',
      noun: 'the keys',
      source: { kind: 'program', name: 'keys', items: (raw) => (Array.isArray(raw) ? raw as KeyItem[] : []) },
      empty: 'No keys are bound.',
      row: (item) => ({
        title: item.place ? `${item.place}: ${item.description}` : item.description,
        right: item.bound.join(', ') || 'no key',
        mark: item.state === 'conflict' ? 'attention' : item.state === 'changed' ? 'running' : item.state === 'unbound' ? 'paused' : 'ok',
      }),
      detail: (item) => [
        ...(item.place ? [{ label: 'In', text: `${item.place}, while it is open` }] : []),
        { label: 'Bound to', text: item.bound.join(', ') || 'no key' },
        { label: 'Default', text: item.defaults.join(', ') || 'no key' },
        { label: 'Its name in keybindings.json', text: item.id, tone: 'muted' },
        ...item.conflicts.map((sentence) => ({ text: sentence, tone: 'warning' as const })),
      ],
    },
  ],
  actions: [
    { kind: 'program', key: 'enter', list: 'keys', label: 'change key', run: 'keys.change' },
    { key: 'd', id: 'default', list: 'keys', states: ['changed', 'conflict', 'unbound'], capability: 'keys.reset', label: 'put back the default', fill: { action: 'id' } },
    { key: 'D', id: 'every-default', capability: 'keys.reset-all', label: 'put back every default' },
  ],
  count: (lists) => {
    const conflicts = (lists.keys ?? []).filter((item) => item.state === 'conflict').length;
    // The rows are actions: a conflict is two or more of them on one key.
    return conflicts > 0 ? { count: conflicts, words: `${conflicts} actions share ${conflicts > 2 ? 'keys' : 'a key'}`, tone: 'wrong' } : undefined;
  },
});
