import { createShellCoreActions } from '@goodvibes/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { requireKeybindingsManager, requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
import { createCompactCommand } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { conversationOf } from './session-capabilities.ts';
import { createHelpCommand } from '@goodvibes/engine/terminal-shell/help-command';
import { shortcutGroups } from '../../renderer/shortcut-groups.ts';
import { registerModelCommands } from '@goodvibes/engine/terminal-shell/model-command';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';

const coreActions = createShellCoreActions<CommandContext>(
  { startFreshConversation },
  {
    // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
    freshConversation: (_ctx, savedAs) =>
      publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + savedAs + ': /session resume ' + savedAs + ' returns to it.'),
  },
);

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const basicCommands = createBasicShellCommands<CommandContext>();
  const navigation = createShellNavigationCommands<CommandContext>();

  // `/model` and `/effort` are one description each, shared with the other terminal app; a missing key is asked for before a switch lands.
  registerModelCommands<CommandContext>(registry, {
    requireProviderApi,
    beforeSelection: ensureProviderKeyThenSelect,
    daemon: (ctx) => createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
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

/**
 * `/compact` is a single-action command shared with the other terminal app (terminal-shell/everyday-commands.ts),
 * the capability conversation.compact run on this app's conversation (session-capabilities.ts).
 */
const compactCommand = createCompactCommand<CommandContext>((ctx) => conversationOf(ctx));
