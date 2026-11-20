import {
  createContextInspectionCommand,
} from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { registerInteractionModeCommand } from '@goodvibes/engine/terminal-shell/interaction-mode-command';
import { settingsTargetNotFoundMessage } from '@goodvibes/engine/terminal-shell/settings-navigation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { settingsCommandDescription } from '@goodvibes/engine/terminal-shell/settings-command';
import { agentResearchSourceOwner } from '@goodvibes/engine/terminal-shell/agent-turn/protected-research-report';
import { captureTranscriptSource } from './transcript-reading.ts';
import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import '@goodvibes/engine/platform/platform/utils';
import '@goodvibes/engine/platform/platform/utils';
import { commandRefusal, stripYesFlag } from './confirmation.ts';
import { handleContextWindowSubcommand } from './context-window.ts';
import { isAgentHostSettingKey } from '../../config/host-settings.ts';
import {
  formatHarnessError,
  formatHarnessMutation,
  formatHarnessSetting,
  formatHarnessSettingList,
  getEffectiveHarnessSetting,
  listEffectiveHarnessSettingsPage,
  resetHarnessSetting,
  setHarnessSetting,
} from '../../agent/harness-control.ts';
import { readRefusal } from '@goodvibes/engine/errors';
import { instructionFilesReport, lastTurnsReport } from './agent-context-reports.ts';

function readValuedFlag(args: readonly string[], flag: string): string | undefined {
  const assignmentPrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (arg?.startsWith(assignmentPrefix)) return arg.slice(assignmentPrefix.length);
  }
  return undefined;
}

function stripValuedFlag(args: readonly string[], flag: string): readonly string[] {
  const next: string[] = [];
  const assignmentPrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) index += 1;
      continue;
    }
    if (arg?.startsWith(assignmentPrefix)) {
      continue;
    }
    next.push(arg!);
  }
  return next;
}

function parseSettingListArgs(args: readonly string[]): {
  readonly category?: string;
  readonly prefix?: string;
  readonly query?: string;
  readonly includeHidden: boolean;
  readonly limit?: number;
} {
  const category = readValuedFlag(args, '--category');
  const prefix = readValuedFlag(args, '--prefix');
  const limitText = readValuedFlag(args, '--limit');
  const remaining = stripValuedFlag(stripValuedFlag(stripValuedFlag(args, '--category'), '--prefix'), '--limit').filter(
    (arg) => arg !== '--include-hidden',
  );
  const query = remaining.join(' ').trim();
  return {
    ...(category ? { category } : {}),
    ...(prefix ? { prefix } : {}),
    ...(query ? { query } : {}),
    includeHidden: args.includes('--include-hidden'),
    ...(limitText ? { limit: Number(limitText) } : {}),
  };
}

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

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  const settingsCommand: SlashCommand = defineCommand<CommandContext>(settingsCommandDescription<CommandContext>({
    async open(where, ctx) {
      if (!ctx.openSettingsModal) throw commandRefusal('The settings screen cannot be shown here.', 'See them as text: /settings list.');
      const landed: unknown = ctx.openSettingsModal(where || undefined);
      if (where && landed === 'not-found') return settingsTargetNotFoundMessage(where);
    },
    async list(words, ctx) {
      // `total` is what matched, not what fits on the page: the formatter needs both.
      const listFilters = parseSettingListArgs(words.split(/\s+/).filter(Boolean));
      const config = ctx.platform.configManager;
      const owner = agentResearchSourceOwner(ctx.extensions.toolRegistry);
      const source = listFilters.query ? captureTranscriptSource(ctx) : undefined;
      const guards: (() => void)[] = [];
      const assertCurrent = () => {
        source?.assertPublishable();
        if (ctx.platform.configManager !== config || agentResearchSourceOwner(ctx.extensions.toolRegistry) !== owner)
          throw new Error('Settings source changed.');
      };
      const page = await listEffectiveHarnessSettingsPage(config, listFilters, {
        sourceOwner: owner,
        assertCurrent,
        retainCurrent: (guard) => { guards.push(guard); },
      });
      assertCurrent();
      for (const guard of guards) guard();
      return formatHarnessSettingList(page.settings, page.matched);
    },
    async get(key, ctx) {
      return formatHarnessSetting(await getEffectiveHarnessSetting(ctx.platform.configManager, key));
    },
    // Owner-typed: the owner's own write; the line prints the previous value, so it
    // can be put back. A model-run /settings line goes through the settings tool's
    // admission instead (nativeSettingsCommandMutation), where a security-bearing key
    // is put to the owner.
    async set(key, rawValue, ctx) {
      try {
        // Only the exact host boolean literals become booleans.
        const value = isAgentHostSettingKey(key) && (rawValue === 'true' || rawValue === 'false') ? rawValue === 'true' : rawValue;
        const result = await setHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key, value);
        ctx.renderRequest();
        return formatHarnessMutation(result);
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(formatHarnessError(error));
      }
    },
    async reset(key, ctx) {
      try {
        const result = await resetHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key);
        ctx.renderRequest();
        return formatHarnessMutation(result);
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(formatHarnessError(error));
      }
    },
  }));
  nativeSettingsCommands.set(settingsCommand, settingsCommand.handler);
  registry.register(settingsCommand);

  registry.register(contextInspectionCommand);


  registerInteractionModeCommand<CommandContext>(registry);
}


const contextInspectionCommand = createContextInspectionCommand<CommandContext>({
  window: handleContextWindowSubcommand,
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
});
