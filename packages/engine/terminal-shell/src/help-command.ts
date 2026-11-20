/**
 * help-command.ts, `/help` in both terminal programs: one list of every command
 * and every key (the command palette, also `?` and Ctrl+P). With a command's
 * name it prints that command's actions and typed lines; with `keys` it prints
 * every key and the file that changes them. Where no list can be shown (a model,
 * a script) bare `/help` prints every command as text.
 */
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { helpForCommand } from './command-actions/catalog.js';
import type { CommandActionContext } from './command-actions/types.js';
import { readAction, textInput } from './described-command-kit.js';
import type { TerminalSlashCommand } from './command-registry.js';

interface HelpContext extends CommandActionContext {
  readonly openCommandPalette?: (() => void) | undefined;
}

/** What `/help` reads from the program: its commands and its keys. */
export interface HelpSources<Context> {
  readonly commands: () => readonly TerminalSlashCommand<Context>[];
  readonly command: (name: string) => TerminalSlashCommand<Context> | undefined;
  /** Every key, as `key  what it does` lines, and the file that changes them. */
  readonly keys: (context: Context) => { readonly lines: readonly string[]; readonly file: string };
}

function commandListText<Context>(commands: readonly TerminalSlashCommand<Context>[]): string {
  return [
    'Commands:',
    ...[...commands].sort((a, b) => a.name.localeCompare(b.name)).map((command) => {
      const hint = command.argsHint ?? command.usage;
      return `  /${command.name}${hint ? ` ${hint}` : ''} - ${command.description}`;
    }),
    '',
    'Every key: /help keys. One command\'s actions and lines: /help <command>.',
  ].join('\n');
}

export function createHelpCommand<Context extends HelpContext>(sources: HelpSources<Context>): DescribedCommand<Context> {
  return defineCommand<Context>({
    name: 'help',
    title: 'Help',
    summary: 'Every command and every key in one searchable list',
    group: 'Shell',
    actions: [
      readAction<Context>({
        id: 'help', label: 'See every command and every key', word: '',
        inputs: [textInput({
          id: 'about', label: 'About', help: 'A command\'s name to see its actions and lines, or keys for every key',
          why: 'A command name as you type it, without the slash; or keys.', typed: { position: 1 },
          optional: { default: '', means: 'every command and every key' },
        })],
        sentence: 'Shows every command and every key, or one command\'s actions and lines.',
        example: { about: 'mcp' },
        async run(values, context) {
          const about = (values.about ?? '').replace(/^\//, '').trim();
          if (about === 'keys') {
            const keys = sources.keys(context);
            return [...keys.lines, '', `Change any key in ${keys.file}: { "action": { "key": "x", "ctrl": true } }.`].join('\n');
          }
          if (about) {
            const command = sources.command(about);
            if (!command) throw commandRefusal(`No command named /${about}.`, '/help lists every command.');
            return helpForCommand(command);
          }
          if (context.openCommandPalette && context.invokedByModel !== true) {
            context.openCommandPalette();
            return;
          }
          return commandListText(sources.commands());
        },
      }),
    ],
  });
}
