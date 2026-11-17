import { createOwnerInboxCommands } from '@goodvibes-jev/engine/terminal-shell/owner-inbox-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { terminalOwnerInbox } from '../../runtime/client/owner-questions.ts';

/** /questions and /decisions over the daemon's owner inbox, or this terminal's own when no daemon is reachable. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  const commands = createOwnerInboxCommands<CommandContext>({
    inbox: (ctx) => {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) return { unavailable: 'This terminal has no workspace paths wired, so it has no inbox to read.' };
      return terminalOwnerInbox({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory, shellPaths });
    },
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  });
  for (const command of commands) registry.register(command);
}
