import { createOwnerInboxCommands } from '@goodvibes-jev/engine/terminal-shell/owner-inbox-command';
import { createOwnerInboxClient } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { requireShellPaths } from './runtime-services.ts';

/** /questions and /decisions over the daemon's owner inbox. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  const commands = createOwnerInboxCommands<CommandContext>({
    inbox: (ctx) => createOwnerInboxClient(createDaemonVerbCaller({
      configManager: ctx.platform.configManager,
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    })),
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  });
  for (const command of commands) registry.register(command);
}
