import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { settingsCommandDescription } from '@goodvibes/engine/terminal-shell/settings-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { ContextInspectionPolicy } from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { settingsTargetNotFoundMessage } from '@goodvibes/engine/terminal-shell/settings-navigation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { estimateConversationTokens } from '@goodvibes/engine/platform/platform/core';
import { capabilityBinding } from './capability-binding.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETTINGS_COMMAND);

  // How much the app prints is in the System place, This session (capabilities/builtin/system-session.ts verbosity.*).

}


/** How this app measures its context, for the conversation's context controls (session-capabilities.ts). */
export const contextInspectionPolicy: ContextInspectionPolicy<CommandContext> = {
  estimate: (message) => estimateConversationTokens([message]),
  total: (messages) => estimateConversationTokens(messages),
};

/**
 * `/settings`: the description both programs share (terminal-shell/settings-command.ts). The screen opens here; a
 * setting is listed, read, changed and put back by the daemon, on this app's own settings (capabilities/builtin/system-settings.ts).
 */
const SETTINGS_COMMAND = defineCommand<CommandContext>(settingsCommandDescription<CommandContext>({
  async open(where, ctx) {
    if (!ctx.openSettingsModal) throw commandRefusal('The settings screen cannot be shown here.');
    const landed: unknown = ctx.openSettingsModal(where || undefined);
    if (where && landed === 'not-found') return settingsTargetNotFoundMessage(where);
  },
}, capabilityBinding));
