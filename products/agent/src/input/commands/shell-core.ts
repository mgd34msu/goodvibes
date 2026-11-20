import { createShellCoreActions } from '@goodvibes-jev/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes-jev/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi } from './runtime-services.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/utils';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { createCompactCommand, refuseWhileTurnRuns } from '@goodvibes-jev/engine/terminal-shell/everyday-commands';
import { helpForCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { registerModelCommands } from '@goodvibes-jev/engine/terminal-shell/model-command';

function commandCategory(commandName: string): string {
  if (
    [
      'agent',
      'agent-profile',
      'brief',
      'health',
      'welcome',
      'setup',
      'tasks',
      'approval',
      'automation',
      'delegate',
      'schedule',
      'workplan',
    ].includes(commandName)
  )
    return 'Agent Operator';
  if (['knowledge', 'memory', 'notes', 'vibe', 'vibes', 'personas', 'skills', 'routines'].includes(commandName))
    return 'Knowledge & Local Context';
  if (['channels', 'notify', 'qrcode', 'pair'].includes(commandName)) return 'Channels';
  if (
    ['model', 'provider', 'providers', 'effort', 'pin', 'unpin', 'refresh-models', 'verbosity', 'tts', 'voice', 'media', 'image'].includes(
      commandName,
    )
  )
    return 'Model, Voice & Media';
  if (
    [
      'settings',
      'config',
      'keybindings',
      'shortcuts',
      'mcp',
      'secrets',
      'auth',
      'accounts',
      'subscription',
      'compat',
      'security',
      'trust',
      'bundle',
    ].includes(commandName)
  )
    return 'Setup & Security';
  if (
    [
      'save',
      'load',
      'sessions',
      'session',
      'conversation',
      'export',
      'title',
      'clear',
      'compact',
      'undo',
      'redo',
      'retry',
      'expand',
      'collapse',
      'context',
      'bookmarks',
      'paste',
      'next-error',
      'prev-error',
    ].includes(commandName)
  )
    return 'Conversation';
  return 'Tools & System';
}

function commandDetail(command: SlashCommand): string {
  const parts = [command.description];
  if (command.usage) parts.push(`usage: /${command.name} ${command.usage}`);
  if (command.aliases?.length) parts.push(`aliases: ${command.aliases.map((alias) => `/${alias}`).join(', ')}`);
  return parts.join(' | ');
}

/**
 * List registered commands as selection items.
 *
 * Commands off the first screen (`firstScreen: false`) still run when typed
 * and are found as soon as their name is typed; `/commands` lists everything,
 * marking those "(not on the first screen)". `/help`'s first screen leaves
 * them out.
 */
function listRegisteredCommandItems(registry: CommandRegistry, options: { includeHidden: boolean }): SelectionItem[] {
  return registry
    .list()
    .slice()
    .filter((command) => options.includeHidden || command.firstScreen !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => ({
      id: `/${command.name}`,
      label: command.firstScreen === false ? `/${command.name} (not on the first screen)` : `/${command.name}`,
      detail: commandDetail(command),
      category: commandCategory(command.name),
      primaryAction: 'select',
      actions: '[Enter] run command',
    }));
}

function registeredCommandListText(registry: CommandRegistry): string {
  const commands = listRegisteredCommandItems(registry, { includeHidden: false });
  return [
    'Open the Agent workspace first, then press / inside it to search every product action.',
    '',
    'Registered slash commands:',
    ...commands.map((item) => `  ${item.label} - ${item.detail}`),
  ].join('\n');
}

const coreActions = createShellCoreActions<CommandContext>(
  { requireKeybindingsManager, startFreshConversation },
  {
    hidden: true,
    shortcutOverlay: false,
    freshConversation: (ctx, savedAs) =>
      ctx.print('Fresh conversation. The previous one is saved as ' + savedAs + ': /session resume ' + savedAs + ' returns to it.'),
  },
);

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const basicCommands = createBasicShellCommands<CommandContext>();
  const navigation = createShellNavigationCommands<CommandContext>({
    shortcutsHidden: true,
    shortcutsFallback: 'Press ? for every command and keyboard shortcut.',
  });

  // `/model` and `/effort` are one description each, shared with the other terminal app.
  registerModelCommands<CommandContext>(registry, { requireProviderApi, beforeSelection: (_ctx, _provider, complete) => complete() });

  registry.register(navigation.shortcuts);

  registry.register(coreActions.keybindings);

  registry.register(basicCommands.paste);

  registry.register({
    name: 'help',
    effect: 'ui-navigation',
    aliases: ['h', '?'],
    description: 'Open help: every command and keyboard shortcut in one searchable list; picking a command runs it. /help <command> shows one command\'s actions and lines',
    argsHint: '[command]',
    handler(args, ctx) {
      const named = args[0]?.replace(/^\//, '');
      if (named) {
        const command = registry.get(named);
        if (!command) throw commandRefusal(`No command named /${named}.`, '/help lists every command.');
        ctx.print(helpForCommand(command));
        return;
      }
      // `?`, /help, /commands and Ctrl+P open the same palette, built live from
      // the registry and the key table (terminal-shell/command-palette.ts).
      if (ctx.openCommandPalette) {
        ctx.openCommandPalette();
        return;
      }
      ctx.print(registeredCommandListText(registry));
    },
  });

  registry.register(coreActions.clear);

  registry.register(compactCommand);

  registry.register(navigation.quit);
}

/** `/compact` is a single-action command shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const compactCommand = createCompactCommand<CommandContext>(async (_values, ctx) => {
  refuseWhileTurnRuns(ctx, '/compact');
  ctx.print('Compacting conversation...');
  const receipt = await compactConversation(ctx);
  ctx.print(
    receipt
      ? `Conversation compacted (${receipt.messagesBefore} to ${receipt.messagesAfter} messages).`
      : 'Nothing was compacted: the conversation is already short enough or compaction was declined.',
  );
  ctx.renderRequest();
});
