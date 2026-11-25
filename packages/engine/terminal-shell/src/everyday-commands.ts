/**
 * The everyday conversation commands, each a single-action command
 * (command-actions/) whose line is its name and, where it takes one, a word:
 * `/undo`, `/redo`, `/retry`, `/compact`. Both terminal apps register these
 * descriptions; each action is a capability on the conversation
 * (capabilities/builtin/conversation.ts and conversation-controls.ts) run with
 * the app's own conversation, the same the conversation's list and the
 * model's capability_run reach.
 */
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import {
  CONVERSATION_COMPACT, CONVERSATION_REDO, CONVERSATION_RETRY, CONVERSATION_UNDO,
  type CompactServices, type RedoServices, type TurnServices, type UndoServices,
} from '@goodvibes/engine/platform/platform/capabilities';

const TERMINAL = { terminalOnly: 'It is the terminal program\'s open conversation.' } as const;

/** `/undo` and `/redo` for one app, each its capability run on this app's conversation, file undo stack and rewind. */
export function createUndoCommands<Ctx extends CommandActionContext>(policy: {
  /** The live conversation, file undo stack and rewind `/undo` acts on (the capability conversation.undo runs with them). */
  readonly undo: (ctx: Ctx) => UndoServices;
  /** The same for `/redo` (conversation.redo). */
  readonly redo: (ctx: Ctx) => RedoServices;
}): { readonly undo: DescribedCommand<Ctx>; readonly redo: DescribedCommand<Ctx> } {
  return {
    undo: defineCommand<Ctx>({
      name: 'undo', title: 'Undo', summary: 'Take back the last turn, file change or /checkpoint rewind', group: 'Conversation',
      actions: [sessionCapabilityAction<Ctx, UndoServices>(CONVERSATION_UNDO, policy.undo, TERMINAL)],
    }),
    redo: defineCommand<Ctx>({
      name: 'redo', title: 'Redo', summary: 'Bring back what was undone last', group: 'Conversation',
      actions: [sessionCapabilityAction<Ctx, RedoServices>(CONVERSATION_REDO, policy.redo, TERMINAL)],
    }),
  };
}

/** `/retry [changed message]`: send the last message again, as it was or changed (conversation.retry). */
export function createRetryCommand<Ctx extends CommandActionContext>(services: (ctx: Ctx) => TurnServices): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'retry', leadingFlagsOnly: true, title: 'Ask again', summary: 'Send your last message again, as it was or changed', group: 'Conversation',
    actions: [sessionCapabilityAction<Ctx, TurnServices>(CONVERSATION_RETRY, services, TERMINAL)],
  });
}

/**
 * `/compact`: summarise the older part of the conversation to free the
 * context window. The capability conversation.compact runs here with this
 * program's own compaction (`compact` answers what happened, in words).
 */
export function createCompactCommand<Ctx extends CommandActionContext>(conversation: (ctx: Ctx) => CompactServices['conversation'], after?: (ctx: Ctx) => void): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'compact', title: 'Compact the conversation', summary: 'Summarise the older part of the conversation to free the context window', group: 'Conversation',
    actions: [sessionCapabilityAction<Ctx, CompactServices>(CONVERSATION_COMPACT, (ctx) => ({ conversation: conversation(ctx) }), {
      ...TERMINAL, ...(after ? { after: (ctx: Ctx) => after(ctx) } : {}),
    })],
  });
}

/** The refusal an everyday command gives while a turn runs. */
export function refuseWhileTurnRuns(ctx: { readonly isGenerating?: (() => boolean) | undefined }, command: string): void {
  if (ctx.isGenerating?.()) throw commandRefusal(`A turn is still running, so ${command} did nothing.`, `Stop it with Esc or let it finish, then ${command}.`);
}
