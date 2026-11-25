/**
 * The terminal program's keys: bind a key to an action, put one back on its
 * default, put every key back. They act on the program's own key table (its
 * keybindings.json), so they run in the program (home `session`), with the
 * program's table handed in; the Keys place and the model's `capability_run`
 * run these (there is no slash command for them).
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** The program's key table, as the key capabilities take it. */
export interface KeysCapabilityServices {
  /** Absent where no terminal program holds a key table (a headless run). */
  readonly keys?: {
    /** Bind `action` to the key written in `key` (`ctrl+k`, `f5`, `leader m`); what changed, in words. */
    bind(action: string, key: string): string;
    /** Put `action` back on its default; what it is bound to now, in words. */
    reset(action: string): string;
    /** Put every key back on its default; what happened, in words. */
    resetAll(): string;
  } | undefined;
}

/** Every action of the program's key table and of its places' key contexts (the terminal's list reads the table). */
export const KEY_ACTIONS_LIST = 'keys.actions' as ListName;

const ACTION: InputDescription = {
  id: 'action', label: 'Action', help: 'What the key does, by its name in keybindings.json', kind: 'choice',
  choices: { list: KEY_ACTIONS_LIST }, required: true, typed: { position: 1 },
};

const KEY: InputDescription = {
  id: 'key', label: 'Key', help: 'The key: ctrl+k, f5, shift+tab, or the leader then a key (leader m)', kind: 'text',
  freeTextReason: 'a key as it is pressed', required: true, typed: { tail: true },
};

function keysOf(services: KeysCapabilityServices): NonNullable<KeysCapabilityServices['keys']> {
  if (!services.keys) throw new CapabilityRefusal('No key table is open here: keys belong to a terminal program.', 'Run it from the terminal app or the Agent', 'UNAVAILABLE');
  return services.keys;
}

export const KEYS_BIND: CapabilityDefinition<KeysCapabilityServices> = {
  capability: { id: 'keys.bind', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'bind', label: 'Bind a key to an action', word: 'bind',
  inputs: [ACTION, KEY],
  sentence: '{key} does {action} from now on, kept in keybindings.json, {lasts}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'reset', example: { action: 'open-menu', key: 'f1' },
  async run(values, services) {
    return { text: keysOf(services).bind(values.action!, values.key!), data: { action: values.action, key: values.key } };
  },
};

export const KEYS_RESET: CapabilityDefinition<KeysCapabilityServices> = {
  capability: { id: 'keys.reset', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'reset', label: 'Put a key back on its default', word: 'reset',
  inputs: [ACTION],
  sentence: '{action} is bound to its default key again, {lasts}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { action: 'open-menu' },
  async run(values, services) {
    return { text: keysOf(services).reset(values.action!), data: { action: values.action } };
  },
};

export const KEYS_RESET_ALL: CapabilityDefinition<KeysCapabilityServices> = {
  capability: { id: 'keys.reset-all', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'reset-all', label: 'Put every key back on its default', word: 'reset-all',
  inputs: [],
  sentence: 'Every key you changed goes back to its default; keybindings.json keeps no change.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', button: 'Put them back', example: {},
  async run(_values, services) {
    return { text: keysOf(services).resetAll() };
  },
};
