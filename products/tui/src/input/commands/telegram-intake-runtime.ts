import { createTelegramIntakeCommand } from '@goodvibes-jev/engine/terminal-shell/telegram-intake-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

/** /telegram: delegated Telegram intake on the daemon this terminal talks to. */
export function registerTelegramIntakeCommands(registry: CommandRegistry): void {
  registry.register(createTelegramIntakeCommand<CommandContext>({
    verbs: (ctx) => {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) return { unavailable: 'This terminal has no workspace paths wired, so it cannot find its daemon.' };
      return createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory });
    },
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  }));
}
