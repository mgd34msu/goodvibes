import { registerOwnerInboxCommands as registerSharedOwnerInboxCommands } from '@goodvibes/engine/terminal-shell/owner-inbox-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { agentOwnerInbox } from '../../runtime/client/owner-questions.ts';
import { createConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';

/** /questions and /decisions over the connected host's owner inbox, or the Agent's own when it has no host. */
export function registerOwnerInboxCommands(registry: CommandRegistry): void {
  registerSharedOwnerInboxCommands<CommandContext>(registry, {
    inbox: (ctx) => {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) return { unavailable: 'This terminal has no workspace paths wired, so it has no inbox to read.' };
      return agentOwnerInbox({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory, shellPaths });
    },
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
    async withdraw(ctx, input) {
      const shellPaths = ctx.workspace.shellPaths;
      if (!shellPaths) throw new Error('this terminal has no workspace paths wired, so it has no host to reach');
      const host = createConnectedHost({ configManager: ctx.platform.configManager, homeDirectory: shellPaths.homeDirectory });
      const connection = host.connection();
      if (connection.token === null) throw new Error(`a request for approval is withdrawn on the connected host, and there is no credential for ${connection.baseUrl}`);
      return host.invoke('approvals.cancel', input);
    },
  });
}
