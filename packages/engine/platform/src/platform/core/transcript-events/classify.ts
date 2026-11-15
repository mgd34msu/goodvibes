import { declaredNoticePresentation } from '../../runtime/runtime-event-notices.js';
import type { ToolCall } from '../../types/tools.js';
import type { TranscriptEvent, TranscriptEventKind } from './types.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

function summarizeText(text: string, max = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function toolCallEvents(messageIndex: number, toolCalls: readonly ToolCall[]): TranscriptEvent[] {
  return toolCalls.map((call, index) => ({
    id: `msg-${messageIndex}-tool-call-${index}`,
    kind: 'tool_call',
    messageIndex,
    groupKey: `tool:${call.id}`,
    title: call.name,
    detail: summarizeText(JSON.stringify(call.arguments ?? {})),
    relatedCallId: call.id,
  }));
}

/** The history changed (or the session was replaced) between reading the index and showing it. */
export class TranscriptSourceChangedError extends Error {
  constructor() { super('Transcript source changed.'); this.name = 'TranscriptSourceChangedError'; }
}
/** Kept for callers that still name it; the index no longer has an unsettled state. */
export class TranscriptReadingUnsettledError extends Error {
  constructor() { super('Transcript presentation reading is unsettled.'); this.name = 'TranscriptReadingUnsettledError'; }
}
/**
 * The caller's own "is this still the transcript I asked about" checks (its
 * session and conversation identity), carried to where the result is shown.
 * The index adds nothing to it: the conversation's revision is the one owner
 * of "the history changed".
 */
export class TranscriptReadingLifetime {
  private readonly checks = new Set<() => void>();
  public retain(check: () => void): void { this.checks.add(check); }
  public assertCurrent(): void { for (const check of this.checks) check(); }
}
export interface TranscriptReadingOptions {
  readonly signal?: AbortSignal | undefined;
  /** The caller's synchronous check, run once before the index is returned. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly lifetime?: TranscriptReadingLifetime | undefined;
}

/**
 * The category of a system line, from what its writer stored: a declared
 * runtime event, the presentation saved with the line, or the notice kind.
 * Anything else is a plain system notice. No model reads a line for this.
 */
function systemEventKind(message: Extract<ConversationMessageSnapshot, { role: 'system' }>): TranscriptEventKind {
  const declared = declaredNoticePresentation(message.content, message.runtimeEvent)?.event
    ?? message.presentation?.event;
  if (declared) return declared;
  if (message.notice?.kind === 'contract') return 'contract_state';
  return 'system_notice';
}

/** One record per message, built in one pass over the messages; nothing is copied or asked. */
export function transcriptEventsOf(messages: readonly ConversationMessageSnapshot[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    switch (message.role) {
      case 'user': {
        const content = typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.type === 'text' ? part.text : '[image]').join(' ');
        events.push({
          id: `msg-${messageIndex}-user`,
          kind: 'user_input',
          messageIndex,
          groupKey: `user:${messageIndex}`,
          title: 'User input',
          detail: summarizeText(content),
        });
        break;
      }
      case 'assistant': {
        if (message.content.trim()) {
          events.push({
            id: `msg-${messageIndex}-assistant`,
            kind: 'assistant_output',
            messageIndex,
            groupKey: `assistant:${messageIndex}`,
            title: 'Assistant output',
            detail: summarizeText(message.content),
          });
        }
        if (message.toolCalls?.length) {
          events.push(...toolCallEvents(messageIndex, message.toolCalls));
        }
        break;
      }
      case 'tool':
        events.push({
          id: `msg-${messageIndex}-tool-result`,
          kind: 'tool_result',
          messageIndex,
          groupKey: `tool:${message.callId}`,
          title: message.toolName ?? 'Tool result',
          detail: summarizeText(message.content),
          relatedCallId: message.callId,
        });
        break;
      case 'system': {
        const kind = systemEventKind(message);
        events.push({
          id: `msg-${messageIndex}-system`,
          kind,
          messageIndex,
          groupKey: `${kind}:${messageIndex}`,
          title: kind.replace(/_/g, ' '),
          detail: summarizeText(message.content),
        });
        break;
      }
    }
  }
  return events;
}

export async function classifyTranscriptMessages(messages: readonly ConversationMessageSnapshot[], options: TranscriptReadingOptions = {}): Promise<TranscriptEvent[]> {
  options.signal?.throwIfAborted();
  const events = transcriptEventsOf(messages);
  options.assertCurrent?.();
  return events;
}
