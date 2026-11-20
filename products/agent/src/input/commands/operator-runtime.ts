import {
  createContextInspectionCommand,
  createErrorNavigationCommands,
} from '@goodvibes-jev/engine/terminal-shell/context-inspection-command';
import { registerInteractionModeCommand } from '@goodvibes-jev/engine/terminal-shell/interaction-mode-command';
import { settingsTargetNotFoundMessage } from '@goodvibes-jev/engine/terminal-shell/settings-navigation';
import { settingSetSecretPositions } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
import { secretArg } from '@goodvibes-jev/engine/terminal-shell/command-registry';
import { agentResearchSourceOwner } from '@goodvibes-jev/engine/terminal-shell/agent-turn/protected-research-report';
import { captureTranscriptSource } from './transcript-reading.ts';
import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/utils';
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
import { readRefusal } from '@goodvibes-jev/engine/errors';

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
  const settingsCommand: SlashCommand = {
    name: 'settings',
    effect: 'mixed',
    aliases: ['cfg-ui'],
    description: 'Open, inspect, or update Agent settings',
    usage: '[category|key|list|get <key>|set <key> <value>|reset <key>]',
    argsHint: '[list|get|set|reset]',
    // `set <key> <value>` for a credential key: the value is masked in the input
    // history and read with `secretArg`, so it reaches the secret store without
    // ever being kept as typed. `--yes` is not a word of the line.
    secretArgs: { select: (args) => settingSetSecretPositions(args, (token) => token === '--yes') },
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = commandArgs[0];

      if (!sub) {
        if (ctx.openSettingsModal) ctx.openSettingsModal();
        else ctx.print('Configuration workspace is not available in this runtime.');
        return;
      }

      if (sub === 'list' || sub === 'schema') {
        // `total` is what matched, not what fits on the page, the formatter
        // needs both so a short page can name itself as short.
        const listFilters = parseSettingListArgs(commandArgs.slice(1));
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
          retainCurrent: (guard) => {
            guards.push(guard);
          },
        });
        assertCurrent();
        for (const guard of guards) guard();
        ctx.print(formatHarnessSettingList(page.settings, page.matched));
        return;
      }

      if (sub === 'get' || sub === 'show') {
        const key = commandArgs[1];
        if (!key) {
          throw commandRefusal('Usage: /settings get <key>');
        }
        ctx.print(formatHarnessSetting(await getEffectiveHarnessSetting(ctx.platform.configManager, key)));
        return;
      }

      // Owner-typed: the owner's own write; the line prints the previous value, so
      // it can be put back. A model-run /settings line goes through the settings
      // tool's admission instead (nativeSettingsCommandMutation), where a
      // security-bearing key is put to the owner.
      if (sub === 'set') {
        const key = commandArgs[1];
        const secretPositions = settingSetSecretPositions(args, (token) => token === '--yes');
        const rawValue = secretPositions.length > 0
          ? secretPositions.map((position) => secretArg(position).reveal('store-write')).join(' ')
          : commandArgs.slice(2).join(' ');
        if (!key || rawValue.length === 0) {
          throw commandRefusal('Usage: /settings set <key> <value>');
        }
        try {
          // Text commands supply tokens; only the exact host boolean literals
          // become booleans. JSON-string values and friendly aliases are not
          // permission to include private notification details or screen raw research.
          const value = isAgentHostSettingKey(key) && (rawValue === 'true' || rawValue === 'false') ? rawValue === 'true' : rawValue;
          const result = await setHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key, value);
          ctx.print(formatHarnessMutation(result));
          ctx.renderRequest();
        } catch (error) {
          if (readRefusal(error)) throw error;
          throw commandRefusal(formatHarnessError(error));
        }
        return;
      }

      if (sub === 'reset') {
        const key = commandArgs[1];
        if (!key) {
          throw commandRefusal('Usage: /settings reset <key>');
        }
        try {
          const result = await resetHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key);
          ctx.print(formatHarnessMutation(result));
          ctx.renderRequest();
        } catch (error) {
          if (readRefusal(error)) throw error;
          throw commandRefusal(formatHarnessError(error));
        }
        return;
      }

      if (sub.includes('.')) {
        ctx.print(formatHarnessSetting(await getEffectiveHarnessSetting(ctx.platform.configManager, sub)));
        return;
      }

      if (!ctx.openSettingsModal) {
        ctx.print('Configuration workspace is not available in this runtime.');
        return;
      }
      const landed: unknown = ctx.openSettingsModal(sub);
      if (landed === 'not-found') ctx.print(settingsTargetNotFoundMessage(sub));
    },
  };
  nativeSettingsCommands.set(settingsCommand, settingsCommand.handler);
  registry.register(settingsCommand);

  registry.register(contextInspectionCommand);

  registry.register(errorNavigationCommands.nextError);
  registry.register(errorNavigationCommands.prevError);

  registerInteractionModeCommand<CommandContext>(registry);
}


const contextInspectionCommand = createContextInspectionCommand<CommandContext>({
  description: "Inspect context window usage (token breakdown per message), or show, set or clear the current model's context window",
  hidden: true,
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
});
const errorNavigationCommands = createErrorNavigationCommands<CommandContext>(true);
