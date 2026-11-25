/**
 * What fills a terminal program's context, as the conversation's controls take it
 * (capabilities/builtin/conversation-controls.ts): the messages and their tokens,
 * the project instruction files read into each turn, what the last turns were
 * given, and how hard the model thinks. How tokens are estimated, and which of
 * these a program keeps, is each program's policy. These are controls of This
 * conversation (the place), run by the model's capability_run too; the context
 * window size is the daemon's (capabilities/builtin/context-windows.ts). No slash
 * command carries them.
 */
import type { ConversationContext } from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalConversationManager } from './terminal-conversation.js';

type ContextMessages = ReturnType<TerminalConversationManager['getMessagesForLLM']>;
interface ContextInspectionContext {
  readonly session: { readonly conversationManager: Pick<TerminalConversationManager, 'getMessagesForLLM'> };
  readonly openContextInspector?: (() => void) | undefined;
}

export interface ContextInspectionPolicy<Context> {
  readonly estimate: (message: ContextMessages[number]) => number;
  readonly total: (messages: ContextMessages, estimates: number[]) => number;
  /** The project instruction files read into each turn, and any held back with why (the Agent only). */
  readonly instructionFiles?: ((context: Context) => string) | undefined;
  /** What the last turns were given: memories, persona, skills and routines, and what was left out (the Agent only). */
  readonly lastTurns?: ((context: Context) => string) | undefined;
}

/** What fills this app's context and which instruction files it reads, as the conversation's controls take them; how hard its model thinks comes from `effort`. */
export function conversationContextOf<Context extends ContextInspectionContext>(
  policy: ContextInspectionPolicy<Context>,
  context: Context,
  effort: Pick<ConversationContext, 'effort' | 'setEffort'>,
): ConversationContext {
  const files = policy.instructionFiles;
  const given = policy.lastTurns;
  return {
    async show(options) {
      // Its own screen only for the person's press (a model's call opens nothing on his display).
      if (options?.opensScreen !== false && context.openContextInspector) { context.openContextInspector(); return 'The context is shown on its own screen.'; }
      const messages = context.session.conversationManager.getMessagesForLLM();
      if (!messages.length) return 'The conversation has no messages yet.';
      const measured = messages.map((message) => ({ message, tokens: policy.estimate(message) }));
      const total = policy.total(messages, measured.map((entry) => entry.tokens));
      return ['What fills the context:', ...measured.map(({ message, tokens }) => `  ${message.role.padEnd(12)} ~${tokens.toLocaleString()} tokens`), `  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${messages.length} messages)`].join('\n');
    },
    instructionFiles: files ? async () => files(context) : undefined,
    given: given ? async () => given(context) : undefined,
    effort: effort.effort,
    setEffort: effort.setEffort,
  };
}
