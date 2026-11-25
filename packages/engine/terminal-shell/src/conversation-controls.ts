/**
 * conversation-controls.ts, what a terminal program hands the controls on its
 * conversation (capabilities/builtin/conversation-controls.ts): the turn
 * (redo, the last message, sending, the title), the composer (the editor, its
 * pastes, the clipboard, an image) and the queue of messages typed while a
 * turn runs. Both programs build them from their command context here; each
 * says only what differs (whether sending again first takes back the turn,
 * how an image is attached).
 */
import type { ConversationComposer, ConversationQueue, ConversationTurns } from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from './command-actions/lists.js';

/** What the turn controls read from a program's command context. */
export interface TurnsContext {
  readonly session: {
    readonly conversationManager: {
      title: string;
      getLastUserMessage(): string | null | undefined;
      redo(): boolean;
    };
  };
  /** Sends a message as a turn exactly as given. */
  readonly submitTurn?: ((message: string) => void) | undefined;
  readonly renderRequest?: (() => void) | undefined;
}

/** The turn as the conversation's controls take it. */
export function turnsOf(ctx: TurnsContext, options: { readonly retryRemovesLastTurn: boolean }): ConversationTurns {
  const submit = ctx.submitTurn;
  return {
    redoTurn: () => {
      const redone = ctx.session.conversationManager.redo();
      if (redone) ctx.renderRequest?.();
      return redone;
    },
    lastUserMessage: () => ctx.session.conversationManager.getLastUserMessage() ?? null,
    send: submit ? (message) => submit(message) : undefined,
    retryRemovesLastTurn: options.retryRemovesLastTurn,
    title: () => ctx.session.conversationManager.title,
    setTitle: (text) => {
      ctx.session.conversationManager.title = text;
      ctx.renderRequest?.();
    },
  };
}

/** What the composer controls read from a program's command context. */
export interface ComposerContext {
  /** Opens the message being written in the person's editor; what happened, in words, once the editor closed. */
  readonly openComposerEditor?: (() => Promise<string>) | undefined;
  readonly getPendingPastes?: (() => ReadonlyMap<string, string>) | undefined;
  readonly pasteFromClipboard?: (() => { readonly pasted: boolean }) | undefined;
}

/** The composer as the conversation's controls take it; `attachImage` is the program's own (local-command-actions.ts). */
export function composerOf<Ctx extends ComposerContext>(ctx: Ctx, attachImage: (ctx: Ctx, path: string, message: string) => Promise<string>): ConversationComposer {
  const editor = ctx.openComposerEditor;
  const paste = ctx.pasteFromClipboard;
  return {
    openEditor: editor ? () => editor() : undefined,
    pastes: () => ctx.getPendingPastes?.(),
    pasteClipboard: paste ? () => paste().pasted : undefined,
    attachImage: (path, message) => attachImage(ctx, path, message),
  };
}

/** What the queue controls read from a program's command context (the terminal app's composer). */
export interface QueueContext {
  readonly listQueuedMessages?: (() => ReadonlyArray<{ readonly id: string; readonly text: string }>) | undefined;
  readonly editQueuedMessage?: ((id: string, text: string) => boolean) | undefined;
  readonly deleteQueuedMessage?: ((id: string) => boolean) | undefined;
}

/** The queue as the conversation's controls take it; undefined where the program queues no messages. */
export function queueOf(ctx: QueueContext): ConversationQueue | undefined {
  const list = ctx.listQueuedMessages;
  if (!list) return undefined;
  return {
    list: () => list().map((message) => ({ id: message.id, text: message.text })),
    edit: (id, text) => ctx.editQueuedMessage?.(id, text) ?? false,
    remove: (id) => ctx.deleteQueuedMessage?.(id) ?? false,
  };
}

/**
 * The messages waiting to be sent (`queue.messages`). The row's value is the message's id, so a pick stays on that
 * message when an earlier one is sent meanwhile.
 */
export const QUEUED_MESSAGES = defineList<QueueContext>({
  name: 'queue.messages',
  async read(ctx) {
    return (ctx.listQueuedMessages?.() ?? []).map((message, index): ListRow => ({ value: message.id, label: `${index + 1}. ${message.text}` }));
  },
  operator: { terminalOnly: 'The queue is the terminal app\'s composer.' },
});
