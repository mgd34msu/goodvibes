import type { TerminalSlashCommand } from './command-registry.js';
import type { CommandSubcommandHints } from './command-args-hint.js';
import { settingsTargetNotFoundMessage, type SettingsTargetOutcome } from './settings-navigation.js';
interface EntryContext {
  print(message: string): void;
  readonly openSettingsModal?: ((target?: string) => SettingsTargetOutcome | 'unreported' | void) | undefined;
}
export function createWelcomeCommand<Context extends EntryContext>(policy: {
  readonly description: string;
  readonly open: (context: Context) => void | Promise<void>;
  readonly lines: readonly string[];
}): TerminalSlashCommand<Context> {
  return {
    name: 'welcome',
    effect: 'ui-navigation',
    aliases: ['guide'],
    description: policy.description,
    usage: '[open|print]',
    async handler(args, context) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        await policy.open(context);
        return;
      }
      if (sub === 'print') {
        context.print(policy.lines.join('\n'));
        return;
      }
      context.print('Usage: /welcome [open|print]');
    },
  };
}
export function createConfigWorkspaceCommand<Context extends EntryContext>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly argsHint: string;
  readonly hidden?: boolean | undefined;
  readonly set?: ((args: string[], context: Context) => void | Promise<void>) | undefined;
}): TerminalSlashCommand<Context> & CommandSubcommandHints {
  return {
    name: 'config',
    effect: 'mixed',
    aliases: ['cfg'],
    description: policy.description,
    usage: policy.usage,
    argsHint: policy.argsHint,
    firstScreen: !policy.hidden,
    // Any other word opens the settings workspace filtered by it, so only `set` takes arguments.
    subcommands: policy.set ? { set: '<key> <value>' } : undefined,
    // `set`'s value is taken as typed: a string setting may hold quotes and spaces.
    rawRest: policy.set ? (args) => (args[0] === 'set' ? 2 : undefined) : undefined,
    async handler(args, context) {
      if (args[0] === 'set' && policy.set) {
        await policy.set(args, context);
        return;
      }
      if (!context.openSettingsModal) {
        context.print('Fullscreen config workspace is not available in this runtime.');
        return;
      }
      const target = args[0];
      const landed = context.openSettingsModal(target);
      if (target && landed === 'not-found') context.print(settingsTargetNotFoundMessage(target));
    },
  };
}
