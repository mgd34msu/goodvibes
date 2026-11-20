import { registerOwnerInboxCommands as registerSharedOwnerInboxCommands } from '@goodvibes/engine/terminal-shell/owner-inbox-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { terminalOwnerInbox } from '../../runtime/client/owner-questions.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { requireShellPaths } from './runtime-services.ts';
import type { OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';

/** /questions and /decisions over the daemon's owner inbox, or this terminal's own when no daemon is reachable. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  registerSharedOwnerInboxCommands<CommandContext>(registry, {
    inbox: (ctx) => {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) return { unavailable: 'This terminal has no workspace paths wired, so it has no inbox to read.' };
      return terminalOwnerInbox({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory, shellPaths });
    },
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
    async withdraw(ctx, input) {
      const verbs = createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory });
      const probe = verbs.probe();
      if (!probe.available) throw new Error(`a request for approval is withdrawn on the daemon, which is not reachable: ${probe.reason}`);
      return verbs.invoke<OperatorMethodOutput<'approvals.cancel'>>('approvals.cancel', input);
    },
  });
}
