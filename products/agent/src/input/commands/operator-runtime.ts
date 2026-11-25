import type { ContextInspectionPolicy } from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { settingsTargetNotFoundMessage } from '@goodvibes/engine/terminal-shell/settings-navigation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { settingsCommandDescription } from '@goodvibes/engine/terminal-shell/settings-command';
import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import { commandRefusal, stripYesFlag } from './confirmation.ts';
import { isAgentHostSettingKey } from '../../config/host-settings.ts';
import { instructionFilesReport, lastTurnsReport } from './agent-context-reports.ts';
import { capabilityBinding } from './capability-binding.ts';

const nativeSettingsCommands = new WeakMap<SlashCommand, SlashCommand['handler']>();

/** Only the actual registered settings command has this typed mutation route. */
export function nativeSettingsCommandMutation(
  command: SlashCommand,
  args: readonly string[],
):
  | { readonly action: 'set'; readonly key: string; readonly value: string | boolean }
  | { readonly action: 'reset'; readonly key: string }
  | undefined {
  const handler = nativeSettingsCommands.get(command);
  if (!handler) return undefined;
  if (command.handler !== handler) throw new ToolInputProjectionError('binding-changed');
  const tokens = stripYesFlag(args).rest;
  const key = tokens[1];
  if (!key) return undefined;
  if (tokens[0] === 'reset') return { action: 'reset', key };
  if (tokens[0] !== 'set') return undefined;
  const rawValue = tokens.slice(2).join(' ');
  if (!rawValue) return undefined;
  const value = isAgentHostSettingKey(key) && (rawValue === 'true' || rawValue === 'false') ? rawValue === 'true' : rawValue;
  return { action: 'set', key, value };
}

/**
 * `/settings`: the description both programs share (terminal-shell/settings-command.ts). The screen opens here; a
 * setting is listed, read, changed and put back by the daemon, on the Agent's own settings
 * (capabilities/builtin/system-settings.ts). A model-run `/settings set|reset` line still goes through the settings
 * tool's admission (nativeSettingsCommandMutation), where a security-bearing key is put to the owner.
 */
export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  const settingsCommand: SlashCommand = defineCommand<CommandContext>(settingsCommandDescription<CommandContext>({
    async open(where, ctx) {
      if (!ctx.openSettingsModal) throw commandRefusal('The settings screen cannot be shown here.');
      const landed: unknown = ctx.openSettingsModal(where || undefined);
      if (where && landed === 'not-found') return settingsTargetNotFoundMessage(where);
    },
  }, capabilityBinding));
  nativeSettingsCommands.set(settingsCommand, settingsCommand.handler);
  registry.register(settingsCommand);
  // How much the Agent prints is in the System place, This session (capabilities/builtin/system-session.ts verbosity.*).
}


/** How the Agent measures its context, for the conversation's context controls (session-capabilities.ts). */
export const contextInspectionPolicy: ContextInspectionPolicy<CommandContext> = {
  estimate: (message) => {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('');
    return Math.ceil(text.length / 4);
  },
  total: (_messages, estimates) => estimates.reduce((sum, value) => sum + value, 0),
  instructionFiles: instructionFilesReport,
  lastTurns: lastTurnsReport,
};
