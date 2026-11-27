import { createShellCoreActions } from '@goodvibes/engine/terminal-shell/shell-core-actions';
import { createShellNavigationCommands } from '@goodvibes/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireKeybindingsManager, requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { createCompactCommand } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { conversationOf, systemSessionOf } from './session-capabilities.ts';
import { createHelpCommand, helpOf, type HelpSources } from '@goodvibes/engine/terminal-shell/help-command';
import { shortcutGroups } from '../../renderer/shortcut-groups.ts';
import { registerModelCommands } from '@goodvibes/engine/terminal-shell/model-command';
import { capabilityBinding } from './capability-binding.ts';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../core/notifications-feed.ts';

const coreActions = createShellCoreActions<CommandContext>(
  { startFreshConversation },
  {
    // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
    freshConversation: (_ctx, savedAs) =>
      void publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + savedAs + ': /resume ' + savedAs + ' returns to it.'),
  },
);

/** This Agent's commands and keys, as help reads them; set when the commands are registered. */
let helpSources: HelpSources<CommandContext> | undefined;

/** This Agent's help, as the capability `system.help` takes it (session-capabilities.ts `systemSessionOf`). */
export function helpServicesOf(ctx: CommandContext): ((about: string) => Promise<string>) | undefined {
  return helpSources ? helpOf(helpSources, ctx) : undefined;
}

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const navigation = createShellNavigationCommands<CommandContext>((ctx) => ({ systemSession: systemSessionOf(ctx) }));

  // `/model` is one description shared with the other terminal app.
  registerModelCommands<CommandContext>(registry, {
    requireProviderApi,
    beforeSelection: (_ctx, _provider, complete) => complete(),
    daemon: (ctx) => createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
    binding: capabilityBinding,
  });

  helpSources = {
    // The listed commands; an unlisted one (it opens its place) is typed, never listed.
    commands: () => registry.getVisible(),
    command: (name) => registry.get(name),
    keys: (ctx) => {
      const km = requireKeybindingsManager(ctx);
      return { lines: shortcutGroups(km).flatMap((group) => [group.title, ...group.items.map(([key, what]) => `  ${key.padEnd(20)}  ${what}`)]), file: km.getConfigPath() };
    },
  };
  registry.register(createHelpCommand<CommandContext>((ctx) => ({ systemSession: systemSessionOf(ctx) })));

  registry.register(coreActions.clear);

  registry.register(compactCommand);

  registry.register(navigation.quit);
}

/**
 * `/compact` is a single-action command shared with the other terminal app (terminal-shell/everyday-commands.ts),
 * the capability conversation.compact run on the Agent's conversation (session-capabilities.ts).
 */
const compactCommand = createCompactCommand<CommandContext>((ctx) => conversationOf(ctx));
