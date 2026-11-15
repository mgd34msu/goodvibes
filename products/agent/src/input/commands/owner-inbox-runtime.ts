import { createOwnerInboxCommands } from '@goodvibes-jev/engine/terminal-shell/owner-inbox-command';
import { createOwnerInboxClient } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { createConnectedHost } from '../../agent/connected-host-client.ts';
import { requireShellPaths } from './runtime-services.ts';

/** /questions and /decisions over the connected host's owner inbox. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  const commands = createOwnerInboxCommands<CommandContext>({
    inbox: (ctx) => {
      const host = createConnectedHost({
        configManager: ctx.platform.configManager,
        homeDirectory: () => requireShellPaths(ctx).homeDirectory,
      });
      return createOwnerInboxClient({
        probe: () => {
          const connection = host.connection();
          return connection.token !== null
            ? { available: true }
            : { available: false, reason: connection.unavailable?.reason ?? `no credential for the host at ${connection.baseUrl}` };
        },
        invoke: <T = unknown>(methodId: string, input?: unknown) =>
          host.invoke(methodId as OperatorMethodId, (input ?? {}) as OperatorMethodInput<OperatorMethodId>) as Promise<T>,
      });
    },
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  });
  for (const command of commands) registry.register(command);
}
