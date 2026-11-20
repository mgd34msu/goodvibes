import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { settingsCommandDescription } from '@goodvibes-jev/engine/terminal-shell/settings-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
import {
  createContextInspectionCommand,
} from '@goodvibes-jev/engine/terminal-shell/context-inspection-command';
import { registerInteractionModeCommand } from '@goodvibes-jev/engine/terminal-shell/interaction-mode-command';
import { settingsTargetNotFoundMessage } from '@goodvibes-jev/engine/terminal-shell/settings-navigation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { ToolContractVerifier } from '@/runtime/index.ts';
import '@goodvibes-jev/engine/platform/platform/utils';
import { requireProfileManager } from './runtime-services.ts';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { handleContextWindowSubcommand } from './context-window.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETTINGS_COMMAND);

  registry.register(contextInspectionCommand);


  registry.register({
    name: 'profiles',
    // The singular `profile` alias was given up to /profile, the owner profile
    // (docs/owner-profile.md). These are two unrelated things, this command
    // loads saved display/provider settings presets, and the other one is what
    // the platform knows about the person who owns it, and the singular word
    // now belongs to the second. `/profiles` is unchanged; only the abbreviation
    // moved. See the naming note in docs/owner-profile.md §3.
    description: 'Browse and load config profiles',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        const profiles = requireProfileManager(ctx).list();
        if (profiles.length === 0) ctx.print('No profiles saved. Open /profiles and press s to save the current settings as a profile.');
        else ctx.print(['Saved profiles:', ...profiles.map((p) => `  ${p.name}`)].join('\n'));
      }
    },
  });


  registerInteractionModeCommand<CommandContext>(registry);

  registry.register({
    name: 'tool',
    description: 'Verify registered tool contracts',
    usage: 'verify <name> | verify-all | contract show <name>',
    argsHint: 'verify <name> | verify-all | contract show <name>',
    async handler(args, ctx) {
      const sub = args[0];
      if (sub === 'verify' && args[1]) {
        const result = await ctx.extensions.toolRegistry.verifyContract(args[1]);
        if (!result) {
          ctx.print(`[tool verify] Tool '${args[1]}' is not registered.`);
          return;
        }
        ctx.print(ToolContractVerifier.formatResult(result));
        return;
      }
      if (sub === 'verify-all') {
        ctx.print(ToolContractVerifier.formatAllResults(await ctx.extensions.toolRegistry.verifyAllContracts()));
        return;
      }
      if (sub === 'contract' && args[1] === 'show' && args[2]) {
        const toolName = args[2];
        const result = await ctx.extensions.toolRegistry.verifyContract(toolName);
        if (!result) {
          ctx.print(`[tool contract show] Tool '${toolName}' is not registered.`);
          return;
        }
        const lines: string[] = [ToolContractVerifier.formatResult(result)];
        const tool = ctx.extensions.toolRegistry.list().find((t) => t.definition.name === toolName);
        if (tool) {
          lines.push('');
          lines.push('Tool Definition:');
          lines.push(`  Name:        ${tool.definition.name}`);
          lines.push(`  Description: ${tool.definition.description}`);
          lines.push(`  Parameters:  ${JSON.stringify(tool.definition.parameters, null, 2).replace(/\n/g, '\n               ')}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print(
        'Usage: /tool <subcommand>\n' +
          '  /tool verify <name>             — verify contract for a specific registered tool\n' +
          '  /tool verify-all                — verify contracts for all registered tools\n' +
          '  /tool contract show <name>      — show full contract details for a tool',
      );
    },
  });
}


const contextInspectionCommand = createContextInspectionCommand<CommandContext>({
  window: handleContextWindowSubcommand,
  estimate: (message) => estimateConversationTokens([message]),
  total: (messages) => estimateConversationTokens(messages),
});

/** One line per setting: its name, the key small beside it, and its value. */
function settingLine(setting: ConfigSetting, value: unknown): string {
  return `  ${setting.label} · ${setting.key} = ${JSON.stringify(value) ?? String(value)}`;
}

function findSetting(ctx: CommandContext, key: string): ConfigSetting {
  const setting = ctx.platform.configManager.getSchema().find((candidate) => candidate.key === key);
  if (!setting) throw commandRefusal(`No setting named ${key}.`, '/settings list <words> finds one.');
  return setting;
}

/** `/settings`: the description both programs share (terminal-shell/settings-command.ts), with the terminal app's store. */
const SETTINGS_COMMAND = defineCommand<CommandContext>(settingsCommandDescription<CommandContext>({
  async open(where, ctx) {
    if (!ctx.openSettingsModal) throw commandRefusal('The settings screen cannot be shown here.', 'See them as text: /settings list.');
    const landed: unknown = ctx.openSettingsModal(where || undefined);
    if (where && landed === 'not-found') return settingsTargetNotFoundMessage(where);
  },
  async list(words, ctx) {
    const config = ctx.platform.configManager;
    const q = words.trim().toLowerCase();
    const rows = config.getSchema().filter((setting) => !setting.deprecated
      && (!q || `${setting.label} ${setting.key} ${setting.description}`.toLowerCase().includes(q)));
    if (rows.length === 0) return `No setting matches "${words}".`;
    return [`${rows.length} setting(s)${q ? ` matching "${words}"` : ''}:`, ...rows.map((setting) => settingLine(setting, config.get(setting.key)))].join('\n');
  },
  async get(key, ctx) {
    const setting = findSetting(ctx, key);
    const config = ctx.platform.configManager;
    return [setting.label, settingLine(setting, config.get(setting.key)), `  set in: ${config.sourceOf(setting.key)}`, `  ${setting.description}`].join('\n');
  },
  async set(key, value, ctx) {
    // The one line that stores a value everywhere, a credential key going to the secret store (/config set).
    await ctx.executeCommand?.('config', ['set', key, value]);
  },
  async reset(key, ctx) {
    const setting = findSetting(ctx, key);
    ctx.platform.configManager.reset(setting.key);
    return `${setting.label} (${setting.key}) is back to its default: ${JSON.stringify(ctx.platform.configManager.get(setting.key))}.`;
  },
}));
