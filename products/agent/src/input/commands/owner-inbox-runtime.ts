import { createOwnerInboxCommands } from '@goodvibes-jev/engine/terminal-shell/owner-inbox-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { connectedHostOwnerInbox } from '../../runtime/client/owner-questions.ts';
import { requireShellPaths } from './runtime-services.ts';

/** /questions and /decisions over the connected host's owner inbox. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  const commands = createOwnerInboxCommands<CommandContext>({
    inbox: (ctx) => connectedHostOwnerInbox({
      configManager: ctx.platform.configManager,
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    }),
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  });
  for (const command of commands) registry.register(command);
}
