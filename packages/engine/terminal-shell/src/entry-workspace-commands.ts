import type { TerminalSlashCommand } from './command-registry.js';
interface EntryContext {
  print(message: string): void;
  readonly openSettingsModal?: ((target?: string) => void) | undefined;
}
export function createWelcomeCommand<Context extends EntryContext>(policy: {
  readonly description: string;
  readonly open: (context: Context) => void | Promise<void>;
  readonly lines: readonly string[];
}): TerminalSlashCommand<Context> {
  return {
    name: 'welcome',
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
}): TerminalSlashCommand<Context> {
  return {
    name: 'config',
    aliases: ['cfg'],
    description: policy.description,
    usage: policy.usage,
    argsHint: policy.argsHint,
    hidden: policy.hidden,
    async handler(args, context) {
      if (args[0] === 'set' && policy.set) {
        await policy.set(args, context);
        return;
      }
      if (context.openSettingsModal) context.openSettingsModal(args[0]);
      else context.print('Fullscreen config workspace is not available in this runtime.');
    },
  };
}
