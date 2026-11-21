import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { settingsCommandDescription } from '@goodvibes/engine/terminal-shell/settings-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { ConfigSetting } from '@goodvibes/engine/platform/platform/config';
import {
  createContextInspectionCommand,
} from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { registerInteractionModeCommand } from '@goodvibes/engine/terminal-shell/interaction-mode-command';
import { settingsTargetNotFoundMessage } from '@goodvibes/engine/terminal-shell/settings-navigation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { estimateConversationTokens } from '@goodvibes/engine/platform/platform/core';
import { handleContextWindowSubcommand } from './context-window.ts';
import { setSettingValue } from './setting-write.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETTINGS_COMMAND);

  registry.register(contextInspectionCommand);




  registerInteractionModeCommand<CommandContext>(registry);

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
    // One value stored everywhere it is read; a credential key goes to the secret store (setting-write.ts).
    await setSettingValue(key, value, ctx);
  },
  async reset(key, ctx) {
    const setting = findSetting(ctx, key);
    ctx.platform.configManager.reset(setting.key);
    return `${setting.label} (${setting.key}) is back to its default: ${JSON.stringify(ctx.platform.configManager.get(setting.key))}.`;
  },
}));
