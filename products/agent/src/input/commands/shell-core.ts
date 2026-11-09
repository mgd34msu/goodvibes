import { createShellCoreActions } from '@goodvibes-jev/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes-jev/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { publishActiveEffortOptions } from '../../providers/reasoning-effort-surface.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi } from './runtime-services.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/utils';

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
      'plan',
    ].includes(commandName)
  )
    return 'Agent Operator';
  if (['knowledge', 'memory', 'notes', 'vibe', 'vibes', 'personas', 'skills', 'routines'].includes(commandName))
    return 'Knowledge & Local Context';
  if (['channels', 'notify', 'qrcode', 'pair'].includes(commandName)) return 'Channels';
  if (
    ['model', 'provider', 'providers', 'effort', 'pin', 'unpin', 'refresh-models', 'mode', 'tts', 'voice', 'media', 'image'].includes(
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
      'reset',
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
 * Hidden commands (`SlashCommand.hidden`) still run when typed and stay
 * discoverable via `/commands`, which lists everything labeled "(hidden)".
 * `/help` (both the interactive picker and the plain-text fallback) filters
 * them out per the doc contract on `SlashCommand.hidden`.
 */
function listRegisteredCommandItems(registry: CommandRegistry, options: { includeHidden: boolean }): SelectionItem[] {
  return registry
    .list()
    .slice()
    .filter((command) => options.includeHidden || !command.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => ({
      id: `/${command.name}`,
      label: command.hidden ? `/${command.name} (hidden)` : `/${command.name}`,
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

function openRegisteredCommandSelection(registry: CommandRegistry, ctx: CommandContext, options: { includeHidden: boolean }): void {
  const items = listRegisteredCommandItems(registry, options);
  ctx.openSelection?.('Help  -  Commands', items, { allowSearch: true }, (result) => {
    if (!result) return;
    const command = result.item.id;
    if (command.startsWith('/')) {
      const parts = command.slice(1).trim().split(/\s+/);
      const name = parts[0];
      const cmdArgs = parts.slice(1);
      void (ctx.executeCommand?.(name, cmdArgs) ?? registry.execute(name, cmdArgs, ctx));
    }
  });
}

const coreActions = createShellCoreActions<CommandContext>(
  { requireProviderApi, requireKeybindingsManager, startFreshConversation },
  {
    hidden: true,
    modelHint: '[name]',
    choiceMarker: '◉',
    offeredIndent: '  ',
    shortcutOverlay: false,
    unsupportedEffortAdvice: false,
    beforeSelection: (_ctx, _provider, complete) => complete(),
    publishEffort: (ctx, model) => publishActiveEffortOptions(model, ctx.session.runtime.sessionId),
    modelSelected: (model, provider) => 'Switched model\n  model ' + model + '\n  provider ' + provider,
    effortMessage: (level, changed) => (changed ? 'Reasoning effort set' : 'Reasoning effort') + '\n  level ' + level,
    error: (detail) => 'Error\n  message ' + detail,
    freshConversation: (ctx, savedAs) =>
      ctx.print('Fresh conversation. The previous one is saved as ' + savedAs + ': /session resume ' + savedAs + ' returns to it.'),
  },
);

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const basicCommands = createBasicShellCommands<CommandContext>();
  const navigation = createShellNavigationCommands<CommandContext>({
    shortcutsHidden: true,
    shortcutsFallback: 'Use ? key or /help for shortcuts',
    quitAliases: [':q'],
    beforeCommands: (ctx) => {
      if (!ctx.openSelection) return false;
      openRegisteredCommandSelection(registry, ctx, { includeHidden: true });
      return true;
    },
  });

  registry.register(coreActions.model);

  registry.register(navigation.commands);

  registry.register(navigation.shortcuts);

  registry.register(coreActions.keybindings);

  registry.register(basicCommands.paste);

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    argsHint: '[command]',
    handler(_args, ctx) {
      if (ctx.openSelection) {
        openRegisteredCommandSelection(registry, ctx, { includeHidden: false });
        return;
      }
      ctx.print(registeredCommandListText(registry));
    },
  });

  registry.register(coreActions.clear);

  registry.register({ ...basicCommands.reset, hidden: true });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
      ctx.print('Compacting conversation...');
      await compactConversation(ctx);
      ctx.print('Conversation compacted.');
      ctx.renderRequest();
    },
  });

  registry.register(navigation.quit);

  registry.register(coreActions.effort);
}
