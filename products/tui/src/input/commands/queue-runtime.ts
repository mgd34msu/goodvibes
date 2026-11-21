import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand, defineList, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';

// ---------------------------------------------------------------------------
// /queue, the mid-turn message queue as an editable list (command-actions/).
//
// Messages typed while a turn is streaming are QUEUED (they deliver after the
// turn). Until a message is delivered it stays editable and deletable via the
// platform's editQueuedMessage / deleteQueuedMessage verbs; a delivered message has
// left the queue and is no longer listed, delivery is immutability. This
// command is the editable interface over the same list the composer renders.
// ---------------------------------------------------------------------------

const QUEUED = defineList<CommandContext>({
  name: 'queue.messages',
  async read(ctx) {
    // The row's value is the message's id, so a pick stays on that message when an earlier one is sent meanwhile.
    return (ctx.listQueuedMessages?.() ?? []).map((message, index): ListRow => ({ value: message.id, label: `${index + 1}. ${message.text}` }));
  },
  operator: { terminalOnly: 'The queue is the terminal app\'s composer.' },
});

const LOCAL = { terminalOnly: 'The queue is the terminal app\'s composer.' } as const;

/** A queued message's text, shortened for a reply line. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`}"`;
}

/**
 * The queued message a picked id or a typed 1-based position names. A picked
 * id that is no longer queued was sent meanwhile and is refused as such; it is
 * never swapped for the message now at its old position.
 */
function queuedAt(ctx: CommandContext, choice: string): { readonly id: string; readonly text: string } {
  const list = ctx.listQueuedMessages?.() ?? [];
  const byId = list.find((message) => message.id === choice);
  if (byId) return { id: byId.id, text: byId.text };
  if (!/^\d+$/.test(choice)) throw commandRefusal('That message is no longer queued: it was sent when the turn before it ended, so nothing was changed.', '/queue list shows what is still waiting.');
  if (list.length === 0) throw commandRefusal('No message is queued.', 'Messages typed while a turn runs wait here until it finishes.');
  const n = Number.parseInt(choice, 10);
  if (n < 1 || n > list.length) throw commandRefusal(`No queued message #${choice}; they are numbered 1 to ${list.length}.`, '/queue list shows them.');
  const message = list[n - 1]!;
  return { id: message.id, text: message.text };
}

export function registerQueueRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'queue',
    leadingFlagsOnly: true,
    title: 'Queued messages',
    summary: 'The messages you typed while a turn runs: see, change or take back one before it is sent',
    group: 'Conversation',
    report: 'list',
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your queued messages', readsOnlyThisMachine: true, word: 'list', operator: LOCAL,
        sentence: 'Lists the messages waiting to be sent after the running turn, in the order they will go.',
        async rowValue(ctx) { const count = ctx.listQueuedMessages?.().length ?? 0; return count === 0 ? 'none waiting' : `${count} waiting`; },
        async run(_values, ctx) {
          const list = ctx.listQueuedMessages?.() ?? [];
          if (list.length === 0) return 'No queued messages. (Messages typed while a turn is streaming queue here until it finishes.)';
          return [`Queued messages (${list.length}), changeable until sent:`, ...list.map((message, index) => `  ${index + 1}. ${message.text}`)].join('\n');
        },
      }),
      doAction<CommandContext>({
        id: 'edit', label: 'Change a queued message', word: 'edit', operator: LOCAL,
        inputs: [
          listInput({ id: 'message', label: 'Message', help: 'The messages waiting, in order', list: QUEUED, other: 'its number in /queue list' }),
          textInput({ id: 'text', label: 'New text', help: 'What it says instead', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
        ],
        sentence: 'Queued message {message} is sent as {text} instead, when the running turn ends.', example: { message: '1', text: 'also check the tests' },
        async run(values, ctx) {
          const target = queuedAt(ctx, values.message!);
          if (!(ctx.editQueuedMessage?.(target.id, values.text!) ?? false)) throw commandRefusal(`The queued message ${quoted(target.text)} was already sent, so it was not changed.`);
          return `Changed the queued message ${quoted(target.text)}.`;
        },
      }),
      {
        id: 'delete', label: 'Take back a queued message', word: 'delete', operator: LOCAL,
        inputs: [listInput({ id: 'message', label: 'Message', help: 'The messages waiting, in order', list: QUEUED, other: 'its number in /queue list' })],
        sentence: 'Queued message {message} is taken back and never sent.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { message: '1' },
        async run(values, ctx) {
          const target = queuedAt(ctx, values.message!);
          if (!(ctx.deleteQueuedMessage?.(target.id) ?? false)) throw commandRefusal(`The queued message ${quoted(target.text)} was already sent, so it was not taken back.`);
          return `Took back the queued message ${quoted(target.text)}.`;
        },
      },
    ],
  }));
}
