import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { ChangesSource } from '../changes-git.ts';

/**
 * `/changes`, a single-action command (command-actions/): the Changes view
 * over this repository. With nothing chosen it shows the files this session
 * edited against HEAD (everything against HEAD when none are tracked yet);
 * `working`, `staged` and `head` pick the other views, which v also cycles
 * inside the view.
 */
const CHANGES_COMMAND = defineCommand<CommandContext>({
  name: 'changes', title: 'Changes', summary: 'Changed files with their diff: stage hunks, comment for the model, mark reviewed', group: 'Conversation',
  actions: [doAction<CommandContext>({
    id: 'changes', label: 'See changed files and their diff', word: '', touches: 'reads',
    inputs: [choiceInput({ id: 'source', label: 'Which changes', help: 'This session\'s edits, or the repository\'s', choices: [
      { value: 'session', label: 'This session\'s edits' },
      { value: 'working', label: 'Not staged yet' },
      { value: 'staged', label: 'Staged' },
      { value: 'head', label: 'Everything since the last commit' },
    ], typed: { position: 1 }, optional: { default: 'session', means: 'this session\'s edits' } })],
    sentence: 'Opens the Changes view with the changed files and their diff.',
    operator: { terminalOnly: 'It is a terminal screen.' }, example: { source: 'staged' },
    async run(values, ctx) {
      if (!ctx.openChanges) throw commandRefusal('The Changes view is not available in this session.');
      ctx.openChanges({ source: (values.source || 'session') as ChangesSource });
    },
  })],
});

export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register(CHANGES_COMMAND);
}
