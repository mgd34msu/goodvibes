/**
 * `/context`, described once (command-actions/): what fills the context, and
 * the context window size of the current model. Both terminal apps register
 * this one description; how tokens are estimated is each app's policy.
 * Jumping between errors is `/session next error` and `/session prev error`.
 */
import type { TerminalConversationManager } from './terminal-conversation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { readAction, textInput } from './described-command-kit.js';
import type { CommandActionContext } from './command-actions/types.js';

type ContextMessages = ReturnType<TerminalConversationManager['getMessagesForLLM']>;
interface ContextInspectionContext extends CommandActionContext {
  readonly session: { readonly conversationManager: Pick<TerminalConversationManager, 'getMessagesForLLM'> };
  readonly openContextInspector?: (() => void) | undefined;
}

export function createContextInspectionCommand<Context extends ContextInspectionContext>(policy: {
  /** Shows, sets (a size) or clears ('clear') the window; '' shows it. */
  readonly window: (args: string[], context: Context) => void;
  readonly estimate: (message: ContextMessages[number]) => number;
  readonly total: (messages: ContextMessages, estimates: number[]) => number;
}): DescribedCommand<Context> {
  return defineCommand<Context>({
    name: 'context',
    title: 'Context',
    summary: 'What fills the model\'s context, and how large its window is',
    group: 'Conversation',
    report: 'see',
    actions: [
      readAction<Context>({
        id: 'see', label: 'See what fills the context', word: 'show',
        sentence: 'Shows how many tokens each message of this conversation takes, and the total.',
        operator: { terminalOnly: 'It is the terminal app\'s open conversation.' },
        async run(_values, context) {
          if (context.openContextInspector) { context.openContextInspector(); return; }
          const messages = context.session.conversationManager.getMessagesForLLM();
          if (!messages.length) return 'The conversation has no messages yet.';
          const measured = messages.map((message) => ({ message, tokens: policy.estimate(message) }));
          const total = policy.total(messages, measured.map((entry) => entry.tokens));
          return ['What fills the context:', ...measured.map(({ message, tokens }) => `  ${message.role.padEnd(12)} ~${tokens.toLocaleString()} tokens`), `  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${messages.length} messages)`].join('\n');
        },
      }),
      readAction<Context>({
        id: 'see-window', label: 'See the context window size', word: 'window',
        sentence: 'Shows the current model\'s context window: what it says, any size you set and any limit learned from the provider.',
        operator: { terminalOnly: 'It is the terminal app\'s model.' },
        async run(_values, context) { policy.window([], context); },
      }),
      {
        id: 'set-window', label: 'Set the context window size', word: 'set-window',
        inputs: [textInput({ id: 'size', label: 'Size', help: 'Tokens, such as 120000, 200k or 1m', why: 'a token count', kind: 'number', typed: { position: 1 } })],
        sentence: 'The current model\'s context window will be taken as {size} tokens until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'clear-window',
        operator: { terminalOnly: 'It is the terminal app\'s model.' }, example: { size: '200k' },
        async run(values, context) {
          policy.window([values.size!], context);
        },
      },
      {
        id: 'clear-window', label: 'Go back to the automatic window size', word: 'clear-window', inputs: [],
        sentence: 'The size you set and any limit learned for the current model are cleared, and its own window size applies until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'set-window',
        operator: { terminalOnly: 'It is the terminal app\'s model.' }, example: {},
        async run(_values, context) { policy.window(['clear'], context); },
      },
    ],
  });
}
