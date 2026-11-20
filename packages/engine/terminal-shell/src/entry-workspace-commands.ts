import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { doAction, textInput } from './described-command-kit.js';
import { settingsTargetNotFoundMessage, type SettingsTargetOutcome } from './settings-navigation.js';
import { configKeyFacts } from '@goodvibes-jev/engine/platform/platform/config';

/**
 * Where a `/config set <key> <value>` or `/settings set <key> <value>` line
 * holds a credential: every word of the value when the key is declared
 * secret-bearing (`configKeyFacts(key).secret`), else none. The input history
 * masks these positions and the handler reads them with `secretArg`.
 */
export function settingSetSecretPositions(args: readonly string[], skip: (token: string) => boolean = () => false): number[] {
  const words = args.map((token, index) => ({ token, index })).filter((entry) => !skip(entry.token));
  if (words[0]?.token !== 'set' || words[1] === undefined || !configKeyFacts(words[1].token).secret) return [];
  return words.slice(2).map((entry) => entry.index);
}
interface EntryContext extends CommandActionContext {
  print(message: string): void;
  readonly openSettingsModal?: ((target?: string) => SettingsTargetOutcome | 'unreported' | void) | undefined;
}

/**
 * `/config`, described once (command-actions/): open the settings screen at a
 * setting or topic, or change one setting from the line. Both terminal apps
 * register this description; `set` is the app's own write (the terminal app
 * routes a credential key to the secret store), and an app without one says
 * where the setting is changed instead.
 */
export function createConfigCommand<Context extends EntryContext>(policy: {
  readonly set?: ((key: string, value: string, context: Context) => Promise<string | void>) | undefined;
}): DescribedCommand<Context> {
  return defineCommand<Context>({
    name: 'config',
    title: 'Settings',
    summary: 'Open the settings screen at a setting, or change one setting',
    group: 'Configuration',
    report: 'open',
    actions: [
      doAction<Context>({
        id: 'open', label: 'Open the settings screen', word: 'open',
        inputs: [textInput({
          id: 'target', label: 'Setting or topic', help: 'A setting such as display.theme, or words to search for',
          why: 'a setting\'s name or words in it', typed: { position: 1 },
          optional: { default: '', means: 'the first page' },
        })],
        sentence: 'Opens the settings screen at the setting or topic given.',
        touches: 'reads', example: { target: 'display.theme' },
        operator: { terminalOnly: 'It opens the terminal app\'s settings screen.' },
        async run(values, context) {
          if (!context.openSettingsModal) throw commandRefusal('The settings screen cannot be shown here.', 'Change one setting from the line: /config set <setting> <value>.');
          const target = values.target || undefined;
          const landed = context.openSettingsModal(target);
          if (target && landed === 'not-found') return settingsTargetNotFoundMessage(target);
        },
      }),
      {
        id: 'set', label: 'Change one setting', word: 'set',
        inputs: [
          textInput({ id: 'key', label: 'Setting', help: 'Its name, such as display.theme', why: 'a setting\'s name; the settings screen lists them', typed: { position: 1 } }),
          { id: 'value', label: 'Value', help: 'Hidden as you type: a setting may hold a password or key', kind: 'secret', required: true, typed: { tail: true } },
        ],
        sentence: '{key} will hold the value given until you change it; a password or key goes to the secret store, never into a settings file.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        ownerOnly: { reason: 'a setting can loosen a protection', instead: 'Ask the owner to change it, or use the settings tool, which asks the owner for a loosening change.' },
        operator: { terminalOnly: 'A password or key given here goes to the terminal app\'s secret store; the web UI changes settings on its own settings screen.' },
        example: { key: 'display.themeMode', value: 'light' },
        async run(values, context) {
          if (!policy.set) throw commandRefusal('This program changes settings on its settings screen, not from the line; nothing was changed.', `Open it there: /config open ${values.key}`);
          return policy.set(values.key!, values.value!, context);
        },
      },
    ],
  });
}
