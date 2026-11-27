import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';

/**
 * `/changes`, kept as a typed command (unlisted). Typed, it opens Code and
 * changes (`opens`), where the changed files are listed and Enter opens a
 * file's diff in the Changes view; the menu reaches the same place. The
 * command has no action of its own: the Changes view is opened from that
 * place (`git.unstaged` opens it on the changes not staged yet), and v
 * cycles its sources (staged, not staged, everything since the last commit).
 */
const CHANGES_COMMAND = defineCommand<CommandContext>({
  name: 'changes', title: 'Code and changes', summary: 'Opens Code and changes: changed files, git, worktrees and code lookups', group: 'Conversation',
  firstScreen: false,
  opens: 'code',
  actions: [],
});

export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register(CHANGES_COMMAND);
}
