import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';

/**
 * `/changes` in the Agent, kept as a typed command (unlisted, as in the terminal app): typed, it opens Code and
 * changes (`opens`), where the changed files and the repository's state are listed; the menu reaches the same place.
 * The Agent has no Changes view (code-runtime.ts), so the command has no action of its own: everything in the place is
 * a capability with its control there.
 */
const CHANGES_COMMAND = defineCommand<CommandContext>({
  name: 'changes', title: 'Code and changes', summary: 'Opens Code and changes: changed files, git, worktrees and code lookups', group: 'Conversation',
  firstScreen: false,
  opens: 'code',
  actions: [],
});

export function registerChangesCommand(registry: CommandRegistry): void {
  registry.register(CHANGES_COMMAND);
}
