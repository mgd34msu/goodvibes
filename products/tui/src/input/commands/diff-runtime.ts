import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction } from '@goodvibes/engine/terminal-shell/described-command-kit';

/**
 * `/changes`, kept as a typed command (unlisted): it opens Code and changes,
 * where the changed files are listed and Enter opens a file's diff in the
 * Changes view (stage hunks, comment for the model, mark reviewed); the menu
 * reaches the same place.
 */
const CHANGES_COMMAND = defineCommand<CommandContext>({
  name: 'changes', title: 'Code and changes', summary: 'Opens Code and changes: the changed files and their diff, commits, worktrees, the code index and code lookups', group: 'Conversation',
  firstScreen: false,
  bareOpens: 'open',
  report: 'open',
  actions: [doAction<CommandContext>({
    id: 'open', label: 'Open Code and changes', word: 'open', touches: 'reads',
    sentence: 'Opens Code and changes: the changed files and their diff, recent commits, worktrees, the code index and code lookups.',
    operator: { terminalOnly: 'It is a terminal screen.' },
    async run(_values, ctx) {
      if (!ctx.openPlace) throw commandRefusal('This program has no screens to open.');
      ctx.openPlace('code');
    },
  })],
});

export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register(CHANGES_COMMAND);
}
