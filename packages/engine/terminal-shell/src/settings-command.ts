/**
 * settings-command.ts, `/settings` in both terminal programs: one description,
 * each program running its actions with its own settings store. Every setting
 * is named by its plain name (`CONFIG_SCHEMA` `label`), the key shown beside it.
 */
import { CONFIG_SCHEMA } from '@goodvibes/engine/platform/platform/config/schema';
import { topicOf } from '@goodvibes/engine/platform/platform/config/setting-topics';
import { defineList } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

const SETTINGS = defineList<CommandActionContext>({
  name: 'settings',
  async read() {
    return CONFIG_SCHEMA.filter((setting) => !setting.deprecated).map((setting) => ({
      value: setting.key,
      label: setting.label,
      detail: `${topicOf(setting.key).section} · ${setting.key}`,
    }));
  },
  operator: { terminalOnly: 'The web UI lists every setting in its settings dialog.' },
});

/** What each program does for `/settings`'s actions; each returns the line to print, if any. */
export interface SettingsCommandRuns<Ctx> {
  /** Open the settings screen, at a topic or setting, or searching for the words. */
  readonly open: (where: string, ctx: Ctx) => Promise<string | void>;
  /** Every setting, or those matching the words, as text. */
  readonly list: (words: string, ctx: Ctx) => Promise<string | void>;
  /** One setting: its value, where it is set, and what it does. */
  readonly get: (key: string, ctx: Ctx) => Promise<string | void>;
  /** Change a setting. */
  readonly set: (key: string, value: string, ctx: Ctx) => Promise<string | void>;
  /** Put a setting back to its default. */
  readonly reset: (key: string, ctx: Ctx) => Promise<string | void>;
}

/** A setting can loosen a protection, so a model changes one through the settings tool, which asks the owner. */
const OWNER_ONLY = { reason: 'a setting can loosen a protection', instead: 'Use the settings tool, which asks the owner for a loosening change.' };

const SETTING = listInput({ id: 'key', label: 'Setting', help: 'The setting, by its name', list: SETTINGS, other: 'A setting this build has added beyond the list, typed as its key.' });

/** `/settings`'s description, the same in both programs. */
export function settingsCommandDescription<Ctx>(runs: SettingsCommandRuns<Ctx>): CommandDescription<Ctx> {
  return {
    name: 'settings',
    title: 'Settings',
    summary: 'See and change every setting',
    group: 'Settings',
    report: 'open',
    actions: [
      doAction<Ctx>({
        id: 'open', label: 'Open settings', word: 'open', touches: 'reads',
        inputs: [textInput({
          id: 'where', label: 'Where', help: 'A topic, a setting, or words to search for', why: 'Any words: a topic, a setting\'s name or key, or what it does.',
          typed: { tail: true }, optional: { default: '', means: 'the first topic' },
        })],
        sentence: 'Opens settings at {where}.',
        example: { where: 'permissions.mode' },
        // The settings screen has its own topics and search, so choosing this opens it at once.
        blanksTypedOnly: true,
        run: (values: ActionValues, ctx: Ctx) => runs.open(values.where ?? '', ctx),
      }),
      readAction<Ctx>({
        id: 'list', label: 'List settings as text', word: 'list',
        inputs: [textInput({
          id: 'words', label: 'Matching', help: 'Words a setting\'s name, key or description must hold', why: 'Any words to narrow the list.',
          typed: { tail: true }, optional: { default: '', means: 'every setting' },
        })],
        sentence: 'Shows every setting matching {words}, with its value.',
        example: { words: 'sandbox' },
        run: (values: ActionValues, ctx: Ctx) => runs.list(values.words ?? '', ctx),
      }),
      readAction<Ctx>({
        id: 'get', label: 'See one setting', word: 'get', inputs: [SETTING],
        sentence: 'Shows {key}: its value, where it is set, and what it does.',
        example: { key: 'display.showThinking' },
        run: (values: ActionValues, ctx: Ctx) => runs.get(values.key!, ctx),
      }),
      {
        id: 'set', label: 'Change a setting', word: 'set',
        inputs: [SETTING, { id: 'value', label: 'Value', help: 'Hidden as you type: a setting may hold a password or key', kind: 'secret', required: true, typed: { tail: true } }],
        sentence: '{key} will hold the value given {lasts}; a password or key goes to the secret store, never into a settings file.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'reset', ownerOnly: OWNER_ONLY,
        example: { key: 'display.themeMode', value: 'light' },
        run: (values: ActionValues, ctx: Ctx) => runs.set(values.key!, values.value!, ctx),
      },
      {
        id: 'reset', label: 'Put a setting back to its default', word: 'reset', inputs: [SETTING],
        sentence: '{key} goes back to its default {lasts}.', done: 'Put {key} back to its default {lasts}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_ONLY,
        example: { key: 'display.showThinking' },
        run: (values: ActionValues, ctx: Ctx) => runs.reset(values.key!, ctx),
      },
    ],
  };
}
