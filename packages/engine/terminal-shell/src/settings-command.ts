/**
 * settings-command.ts, `/settings` in both terminal programs: one description,
 * each program running its actions with its own settings store. Every setting
 * is named by its plain name (`CONFIG_SCHEMA` `label`), the key shown beside it.
 */
import { CONFIG_SCHEMA } from '@goodvibes/engine/platform/platform/config/schema';
import { topicOf } from '@goodvibes/engine/platform/platform/config/setting-topics';
import { defineList } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription } from './command-actions/types.js';
import { doAction, textInput } from './described-command-kit.js';
import { daemonCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { SETTINGS_GET, SETTINGS_LIST, SETTINGS_RESET, SETTINGS_SET, type CapabilityDefinition } from '@goodvibes/engine/platform/platform/capabilities';

// Every setting, the list `settings` a capability's setting input chooses from (capabilities/builtin/system-settings.ts).
defineList<CommandActionContext>({
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

/** What each program does for `/settings`'s one screen action; the rest are the daemon's capabilities. */
export interface SettingsCommandRuns<Ctx> {
  /** Open the settings screen, at a topic or setting, or searching for the words. */
  readonly open: (where: string, ctx: Ctx) => Promise<string | void>;
}

/**
 * `/settings`'s description, the same in both programs: open the settings screen here; list, see, change and put
 * back a setting through the daemon (capabilities/builtin/system-settings.ts), for this program's own settings
 * (its name goes with every call as the caller's program).
 */
export function settingsCommandDescription<Ctx extends CommandActionContext>(runs: SettingsCommandRuns<Ctx>, binding: DaemonCapabilityBinding<Ctx>): CommandDescription<Ctx> {
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
      ...[SETTINGS_LIST, SETTINGS_GET, SETTINGS_SET, SETTINGS_RESET].map((definition) => daemonCapabilityAction<Ctx>(definition as CapabilityDefinition<never>, binding)),
    ],
  };
}
