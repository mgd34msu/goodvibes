import { registerTelegramIntakeCommand } from '@goodvibes/engine/terminal-shell/telegram-intake-command';
import { createConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes/engine/platform/contracts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';

/** /telegram (one description shared with the terminal app): delegated Telegram intake on the connected host. */
export function registerTelegramIntakeCommands(registry: CommandRegistry): void {
  registerTelegramIntakeCommand<CommandContext>(registry, {
    verbs: (ctx) => {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) return { unavailable: 'This Agent has no workspace paths wired, so it cannot find its host.' };
      const host = createConnectedHost({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory });
      return {
        probe: () => {
          const connection = host.connection();
          return connection.token !== null
            ? { available: true }
            : { available: false, reason: connection.unavailable?.reason ?? `no credential for the host at ${connection.baseUrl}` };
        },
        invoke: <T = unknown>(methodId: string, input?: unknown) =>
          host.invoke(methodId as OperatorMethodId, (input ?? {}) as OperatorMethodInput<OperatorMethodId>) as Promise<T>,
      };
    },
    isOwner: (ctx, name) => isDirectOwnerCommandContext(ctx, name),
  });
}
