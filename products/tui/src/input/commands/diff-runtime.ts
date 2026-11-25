import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { ChangesSource } from '../changes-git.ts';

/**
 * `/changes`, kept as a typed command (unlisted). Bare, it opens Code and
 * changes (`opens`), where the changed files are listed and Enter opens a
 * file's diff in the Changes view; the menu reaches the same place.
 * `/changes staged`, `working` or `head` opens the Changes view on that
 * source, as it always did (v cycles the sources inside the view).
 */
const CHANGES_COMMAND = defineCommand<CommandContext>({
  name: 'changes', title: 'Code and changes', summary: 'Opens Code and changes, or the Changes view on the staged, unstaged or all changes', group: 'Conversation',
  firstScreen: false,
  opens: 'code',
  actions: [doAction<CommandContext>({
    id: 'changes', label: 'See changed files and their diff', word: '', touches: 'reads',
    inputs: [choiceInput({ id: 'source', label: 'Which changes', help: 'The repository\'s changes to show', choices: [
      { value: 'staged', label: 'Staged' },
      { value: 'working', label: 'Not staged yet' },
      { value: 'head', label: 'Everything since the last commit' },
    ], typed: { position: 1 } })],
    sentence: 'Opens the Changes view with the changed files and their diff.',
    operator: { terminalOnly: 'It is a terminal screen.' }, example: { source: 'staged' },
    async run(values, ctx) {
      if (!ctx.openChanges) throw commandRefusal('The Changes view is not available in this session.');
      ctx.openChanges({ source: values.source as ChangesSource });
    },
  })],
});

export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register(CHANGES_COMMAND);
}
