import { findSessionCandidates } from '@goodvibes-jev/engine/platform/platform/sessions';
import { exportToMarkdown, type ExportMessage, type ExportMetadata } from '@goodvibes-jev/engine/platform/platform/export';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ToolCall } from '@goodvibes-jev/engine/platform/platform/types';
import { commandRefusal } from './command-confirmation.js';

/** The two transcript forms every export command writes. */
export type TranscriptFormat = 'markdown' | 'text';

const FORMAT_WORDS: Readonly<Record<string, TranscriptFormat>> = { markdown: 'markdown', md: 'markdown', text: 'text', txt: 'text' };

/** `markdown`/`md` or `text`/`txt` (any case); undefined for any other word. */
export function parseTranscriptFormat(word: string): TranscriptFormat | undefined {
  return Object.hasOwn(FORMAT_WORDS, word.toLowerCase()) ? FORMAT_WORDS[word.toLowerCase()] : undefined;
}

/**
 * One transcript renderer for `/export`, `/session export` and anything else
 * that writes a conversation out: markdown is the platform's `exportToMarkdown`
 * (tool calls, reasoning summaries, token totals), text is one `[ROLE]` block
 * per message with text in it.
 */
export function formatTranscript<Message>(
  messages: readonly Message[],
  format: TranscriptFormat,
  view: {
    readonly markdown: (messages: readonly Message[]) => ExportMessage[];
    readonly text: (message: Message) => string;
    readonly role: (message: Message) => string;
  },
  metadata: ExportMetadata,
): string {
  if (format === 'markdown') return exportToMarkdown(view.markdown(messages), metadata);
  const lines: string[] = [];
  for (const message of messages) {
    const content = view.text(message);
    if (!content.trim()) continue;
    lines.push(`[${view.role(message).toUpperCase()}]`, content, '');
  }
  return lines.join('\n');
}

/** A stored conversation message (`toJSON().messages`, a saved session's `messages`) as the markdown exporter reads it. */
export function exportMessageFromRecord(message: Readonly<Record<string, unknown>>): ExportMessage {
  return {
    role: String(message['role'] ?? 'user') as ExportMessage['role'],
    content: Array.isArray(message['content']) ? (message['content'] as ContentPart[]) : String(message['content'] ?? ''),
    toolCalls: message['toolCalls'] as ToolCall[] | undefined,
    callId: message['callId'] as string | undefined,
    toolName: message['toolName'] as string | undefined,
    reasoningContent: message['reasoningContent'] as string | undefined,
    reasoningSummary: message['reasoningSummary'] as string | undefined,
    cancelled: message['cancelled'] as boolean | undefined,
    ...(message['usage'] !== undefined ? { usage: message['usage'] as NonNullable<ExportMessage['usage']> } : {}),
  };
}

/** The saved session a file is written for (`.` is this session), resolved against the saved list. */
export function resolveSessionExportRequest<Session extends { readonly name: string; readonly title: string }>(
  request: { readonly target: string; readonly format: TranscriptFormat },
  currentId: string,
  list: () => readonly Session[],
) {
  const { target, format } = request;
  const sessionId = target === '.' ? currentId : target;
  // The current session is matched by its exact id only: a prefix or title
  // match could pick another session's transcript for `.`.
  const sessions = list();
  const candidates = target === '.' ? sessions.filter((session) => session.name === sessionId) : findSessionCandidates(sessions, sessionId);
  if (candidates.length > 1) {
    throw commandRefusal(`Ambiguous session: ${sessionId}.`, `Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
  }
  const found = candidates[0];
  return { target, format, sessionId, found };
}
