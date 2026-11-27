/**
 * help-command.ts, `/help` in both terminal programs: one list of every command
 * and every key (the command palette, also `?` and Ctrl+P). With a command's
 * name it prints that command's actions and typed lines; with `keys` it prints
 * every key and the file that changes them. Where no list can be shown (a model,
 * a script) bare `/help` prints every command as text.
 */
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { helpForCommand } from './command-actions/catalog.js';
import type { CommandActionContext } from './command-actions/types.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { CapabilityRefusal, SYSTEM_HELP, type SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalSlashCommand } from './command-registry.js';

export interface HelpContext extends CommandActionContext {
  readonly openCommandPalette?: (() => void) | undefined;
}

/** What `/help` reads from the program: its commands and its keys. */
export interface HelpSources<Context> {
  readonly commands: () => readonly TerminalSlashCommand<Context>[];
  readonly command: (name: string) => TerminalSlashCommand<Context> | undefined;
  /** Every key, as `key  what it does` lines, and the file that changes them. */
  readonly keys: (context: Context) => { readonly lines: readonly string[]; readonly file: string };
}

/** How everything else is reached: no command is typed for it. */
const MENU_LINE = 'Everything else is a control in a place: the leader key (Ctrl+G unless you changed it), then m, opens the menu of every place.';

function commandListText<Context>(commands: readonly TerminalSlashCommand<Context>[]): string {
  return [
    'Commands:',
    ...[...commands].sort((a, b) => a.name.localeCompare(b.name)).map((command) => {
      const hint = command.argsHint ?? command.usage;
      return `  /${command.name}${hint ? ` ${hint}` : ''} - ${command.description}`;
    }),
    '',
    MENU_LINE,
    'Every key: /help keys. One command\'s actions and lines: /help <command>.',
  ].join('\n');
}

/**
 * This program's help as the capability `system.help` takes it (capabilities/builtin/system-program.ts): the keys,
 * one command's actions and lines, or, for a person where the palette can open, the palette; else every command.
 */
export function helpOf<Context extends HelpContext>(sources: HelpSources<Context>, context: Context): (about: string) => Promise<string> {
  return async (about) => {
    if (about === 'keys') {
      const keys = sources.keys(context);
      return [...keys.lines, '', `Every key can be changed in the System place, on its Keys tab (they are kept in ${keys.file}).`].join('\n');
    }
    if (about) {
      const command = sources.command(about);
      if (!command) throw new CapabilityRefusal(`No command named /${about}.`, MENU_LINE);
      return helpForCommand(command);
    }
    if (context.openCommandPalette && context.invokedByModel !== true) {
      context.openCommandPalette();
      // Typed, the list is on screen and nothing is printed under the conversation; pressed in a place (System's
      // help row), the line under its list says it (SYSTEM_HELP `doneInPlace`).
      return '';
    }
    return commandListText(sources.commands());
  };
}

/** `/help`: the capability `system.help`, run with this program's services. */
export function createHelpCommand<Context extends HelpContext>(services: (context: Context) => SystemSessionServices): DescribedCommand<Context> {
  return defineCommand<Context>({
    name: 'help',
    title: 'Help',
    summary: 'The commands that remain and every key in one searchable list; everything else is in the menu',
    group: 'Shell',
    actions: [sessionCapabilityAction<Context, SystemSessionServices>(SYSTEM_HELP, services, { terminalOnly: 'It lists the commands and keys of the terminal program you are using.' })],
  });
}
