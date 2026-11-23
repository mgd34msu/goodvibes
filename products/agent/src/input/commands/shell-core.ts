import { createShellCoreActions } from '@goodvibes/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { createCompactCommand, refuseWhileTurnRuns } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { NOTHING_TO_COMPACT_YET, NothingToCompactError } from '@goodvibes/engine/platform/platform/core';
import { createHelpCommand } from '@goodvibes/engine/terminal-shell/help-command';
import { shortcutGroups } from '../../renderer/shortcut-groups.ts';
import { registerModelCommands } from '@goodvibes/engine/terminal-shell/model-command';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../core/notifications-feed.ts';

const coreActions = createShellCoreActions<CommandContext>(
  { startFreshConversation },
  {
    // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
    freshConversation: (_ctx, savedAs) =>
      void publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + savedAs + ': /session resume ' + savedAs + ' returns to it.'),
  },
);

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const basicCommands = createBasicShellCommands<CommandContext>();
  const navigation = createShellNavigationCommands<CommandContext>();

  // `/model` and `/effort` are one description each, shared with the other terminal app.
  registerModelCommands<CommandContext>(registry, {
    requireProviderApi,
    beforeSelection: (_ctx, _provider, complete) => complete(),
    daemon: (ctx) => createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  });

  registry.register(basicCommands.paste);

  registry.register(createHelpCommand<CommandContext>({
    commands: () => registry.getAll(),
    command: (name) => registry.get(name),
    keys: (ctx) => {
      const km = requireKeybindingsManager(ctx);
      return { lines: shortcutGroups(km).flatMap((group) => [group.title, ...group.items.map(([key, what]) => `  ${key.padEnd(20)}  ${what}`)]), file: km.getConfigPath() };
    },
  }));

  registry.register(coreActions.clear);

  registry.register(compactCommand);

  registry.register(navigation.quit);
}

/** `/compact` is a single-action command shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const compactCommand = createCompactCommand<CommandContext>(async (_values, ctx) => {
  refuseWhileTurnRuns(ctx, '/compact');
  if (ctx.session.conversationManager.getMessagesForLLM().length === 0) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
  ctx.print('Compacting conversation...');
  const receipt = await compactConversation(ctx);
  if (!receipt) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
  ctx.print(`Conversation compacted (${receipt.messagesBefore} to ${receipt.messagesAfter} messages).`);
  ctx.renderRequest();
});
