/**
 * companion-chat-history.ts
 *
 * The model-facing history of a companion chat: how a turn writes to it and
 * how it is rebuilt from the saved transcript.
 *
 * One rebuild function serves every case where the history is not in memory:
 * a chat loaded after a daemon restart, a chat whose history was evicted while
 * idle, a reopened chat, and the branch an edit or regenerate starts. It gives
 * the model what it had when the turns ran: only the active chain, each reply
 * after the message it answers, attachments read in again (with the same
 * "Not included" wording when one cannot be), interrupted and failed replies
 * with their note, and the tool rounds a reply made.
 */

import { ConversationManager } from '../core/conversation.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { buildProviderUserContent, type CompanionChatArtifactStore } from './companion-chat-attachments.js';
import { activeMessages } from './companion-chat-branching.js';
import { TURN_INTERRUPTION_NOTE } from './companion-chat-turn-control.js';
import type {
  CompanionChatHistoryEntry,
  CompanionChatHistoryToolResult,
  CompanionChatMessage,
} from './companion-chat-types.js';

/** Appended (model-facing only) to a reply that ended in an error, so the next turn knows the last answer is incomplete. */
export function turnFailureNote(reason: string): string {
  return `\n\n[This reply failed before it was complete: ${reason}]`;
}

/** Said in a failed reply recorded for a turn the daemon stopped in. */
export const DAEMON_STOPPED_REASON = 'The daemon stopped before this reply finished. Regenerate to try again.';

function historyResult(result: ToolResult): CompanionChatHistoryToolResult {
  return {
    callId: result.callId,
    success: result.success,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
  };
}

/**
 * The turn's writer to the model-facing history. An assistant message that
 * asks for tools is held until its results arrive and both are committed
 * together, so the history can never keep a tool call without its result (a
 * provider rejects every later request that carries one). Everything committed
 * is also recorded, so the reply can be saved with it.
 */
export class TurnHistoryWriter {
  private pending: { content: string; toolCalls: ToolCall[] } | null = null;
  private readonly recorded: CompanionChatHistoryEntry[] = [];
  private usedTools = false;

  constructor(private readonly conversation: ConversationManager) {}

  /** Text waiting in a held tool-calling message, for a turn that ends before its results. */
  heldText(): string { return this.pending?.content ?? ''; }

  addAssistantMessage(content: string, options?: { toolCalls?: ToolCall[] }): void {
    if (options?.toolCalls?.length) {
      this.pending = { content, toolCalls: options.toolCalls };
      return;
    }
    this.conversation.addAssistantMessage(content);
    this.recorded.push({ role: 'assistant', content });
  }

  addToolResults(results: ToolResult[]): void {
    const held = this.pending;
    this.pending = null;
    if (held) {
      this.conversation.addAssistantMessage(held.content, { toolCalls: held.toolCalls });
      this.recorded.push({ role: 'assistant', content: held.content, toolCalls: held.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) });
      this.usedTools = true;
    }
    this.conversation.addToolResults(results);
    this.recorded.push({ role: 'tool-results', results: results.map(historyResult) });
  }

  /** Drop a held tool-calling message whose results will never come; its text is returned for the closing note. */
  dropHeld(): string {
    const text = this.heldText();
    this.pending = null;
    return text;
  }

  /** What to save with the reply: the recorded entries when the turn used tools, else nothing (the reply text says it all). */
  entriesToSave(): readonly CompanionChatHistoryEntry[] | undefined {
    return this.usedTools ? [...this.recorded] : undefined;
  }
}

/** Add one saved reply to a history being rebuilt. */
function replayReply(conversation: ConversationManager, reply: CompanionChatMessage): void {
  if (reply.modelHistory?.length) {
    for (const entry of reply.modelHistory) {
      if (entry.role === 'assistant') {
        conversation.addAssistantMessage(entry.content, entry.toolCalls?.length
          ? { toolCalls: entry.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: { ...args } })) }
          : undefined);
      } else {
        conversation.addToolResults(entry.results.map((result) => ({ ...result })));
      }
    }
    return;
  }
  if (reply.deliveryState === 'failed') {
    conversation.addAssistantMessage(reply.content + turnFailureNote(reply.failureReason ?? 'unknown error'));
  } else if (reply.deliveryState === 'cancelled') {
    if (reply.content.trim()) conversation.addAssistantMessage(reply.content + TURN_INTERRUPTION_NOTE);
  } else {
    conversation.addAssistantMessage(reply.content);
  }
}

/**
 * Rebuild the model-facing history from a transcript. `exclude` is the user
 * message the coming turn answers (it is added by the turn itself). User
 * messages whose turn never ran (queued, unanswered) are left out, as they
 * were never sent to the model.
 */
export async function rebuildConversation(
  messages: readonly CompanionChatMessage[],
  exclude: string | undefined,
  artifactStore: CompanionChatArtifactStore | null,
): Promise<ConversationManager> {
  const conversation = new ConversationManager();
  const active = activeMessages(messages);
  const userIds = new Set(active.filter((m) => m.role === 'user').map((m) => m.id));
  const replies = new Map<string, CompanionChatMessage[]>();
  for (const message of active) {
    if (message.role !== 'assistant' || message.inReplyTo === undefined || !userIds.has(message.inReplyTo)) continue;
    const list = replies.get(message.inReplyTo) ?? [];
    list.push(message);
    replies.set(message.inReplyTo, list);
  }
  for (const message of active) {
    if (message.role === 'assistant') {
      // A reply is placed after the message it answers; one without that link stays where it is.
      if (message.inReplyTo === undefined || !userIds.has(message.inReplyTo)) replayReply(conversation, message);
      continue;
    }
    if (message.id === exclude || message.deliveryState === 'queued' || message.deliveryState === 'unanswered') continue;
    conversation.addUserMessage(await buildProviderUserContent(message.content, message.attachments ?? [], artifactStore));
    for (const reply of replies.get(message.id) ?? []) replayReply(conversation, reply);
  }
  return conversation;
}
