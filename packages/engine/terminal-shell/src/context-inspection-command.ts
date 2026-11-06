import type { TerminalConversationManager } from './terminal-conversation.js';
import type { TerminalSlashCommand } from './command-registry.js';
type ContextMessages = ReturnType<TerminalConversationManager['getMessagesForLLM']>;
interface ContextInspectionContext {
  readonly session: {
    readonly conversationManager: Pick<TerminalConversationManager, 'getMessagesForLLM' | 'nextErrorLine' | 'prevErrorLine'>;
  };
  readonly openContextInspector?: (() => void) | undefined;
  readonly getScrollTop?: (() => number) | undefined;
  readonly scrollToLine?: ((line: number) => void) | undefined;
  print(message: string): void;
}
export function createContextInspectionCommand<Context extends ContextInspectionContext>(policy: {
  readonly description: string;
  readonly hidden?: boolean | undefined;
  readonly window: (args: string[], context: Context) => void;
  readonly estimate: (message: ContextMessages[number]) => number;
  readonly total: (messages: ContextMessages, estimates: number[]) => number;
}): TerminalSlashCommand<Context> {
  return {
    name: 'context',
    aliases: ['ctx'],
    description: policy.description,
    hidden: policy.hidden,
    usage: '[window [<size>|clear]]',
    argsHint: '[window <size|clear>]',
    handler(args, context) {
      if (args[0]?.toLowerCase() === 'window') {
        policy.window(args.slice(1), context);
        return;
      }
      if (context.openContextInspector) {
        context.openContextInspector();
        return;
      }
      const messages = context.session.conversationManager.getMessagesForLLM();
      if (!messages.length) {
        context.print('[context] No messages in conversation.');
        return;
      }
      const measured = messages.map((message) => ({ message, tokens: policy.estimate(message) }));
      const total = policy.total(
        messages,
        measured.map((entry) => entry.tokens),
      );
      const lines = ['Context breakdown:'];
      for (const { message, tokens } of measured) lines.push(`  ${message.role.padEnd(12)} ~${tokens.toLocaleString()} tokens`);
      lines.push(`  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${messages.length} messages)`);
      context.print(lines.join('\n'));
    },
  };
}
export function createErrorNavigationCommands<Context extends ContextInspectionContext>(hidden?: boolean) {
  const command = (direction: 'next' | 'prev'): TerminalSlashCommand<Context> => ({
    name: direction + '-error',
    aliases: [direction === 'next' ? 'ne' : 'pe'],
    hidden,
    description: 'Jump to the ' + (direction === 'next' ? 'next' : 'previous') + ' error message in the conversation',
    handler(_args, context) {
      const conversation = context.session.conversationManager;
      const line =
        direction === 'next'
          ? conversation.nextErrorLine(context.getScrollTop?.() ?? 0)
          : conversation.prevErrorLine(context.getScrollTop?.() ?? 0);
      if (line < 0) context.print('[No error messages found in conversation]');
      else context.scrollToLine?.(line);
    },
  });
  return { nextError: command('next'), prevError: command('prev') };
}
