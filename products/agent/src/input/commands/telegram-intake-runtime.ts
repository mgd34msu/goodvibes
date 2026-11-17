import { createTelegramIntakeCommand } from '@goodvibes-jev/engine/terminal-shell/telegram-intake-command';
import { createConnectedHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-client';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { OUTWARD_VERB, READ_VERB, ownerOnlyVerb, withCommandVerbs } from './command-verbs.ts';

const OWNER_DECIDES = ownerOnlyVerb('outward', 'decides what happens to messages sent to the owner\'s Telegram chat');

/** /telegram: delegated Telegram intake on the connected host. */
export function registerTelegramIntakeCommands(registry: CommandRegistry): void {
  const command = createTelegramIntakeCommand<CommandContext>({
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
  registry.register(withCommandVerbs(command, {
    defaultVerb: 'list',
    verbs: {
      list: READ_VERB, status: READ_VERB, help: READ_VERB,
      configure: OWNER_DECIDES, approve: OWNER_DECIDES, deny: OWNER_DECIDES, read: OWNER_DECIDES,
      cancel: OWNER_DECIDES, revoke: OWNER_DECIDES, release: OWNER_DECIDES,
    },
    otherwise: OUTWARD_VERB,
  }));
}
