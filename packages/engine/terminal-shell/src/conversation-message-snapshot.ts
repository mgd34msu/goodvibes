import type { ConversationMessageSnapshot, NoticeMeta, TokenUsage } from '@goodvibes-jev/engine/platform/platform/core';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ToolCall } from '@goodvibes-jev/engine/platform/platform/types';
type ToolHostEvidence = NonNullable<Extract<ConversationMessageSnapshot, { role: 'tool' }>['hostEvidence']>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function readContentPart(value: unknown): ContentPart | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text };
  }
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mediaType === 'string') {
    return { type: 'image', data: value.data, mediaType: value.mediaType };
  }
  return null;
}
function readContent(value: unknown): string | ContentPart[] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: ContentPart[] = [];
  for (const entry of value) {
    const part = readContentPart(entry);
    if (!part) return null;
    parts.push(part);
  }
  return parts;
}
/** A saved notice declaration; an unknown or malformed one is dropped, never guessed. */
function readNoticeMeta(value: unknown): NoticeMeta | undefined {
  if (!isRecord(value)) return undefined;
  const level = value.level;
  if (level !== 'info' && level !== 'success' && level !== 'warning' && level !== 'error') return undefined;
  const kind = value.kind === 'system' || value.kind === 'operational' || value.kind === 'contract' ? value.kind : undefined;
  const priority = value.priority === 'high' || value.priority === 'low' ? value.priority : undefined;
  return { level, ...(kind ? { kind } : {}), ...(priority ? { priority } : {}) };
}
function readTokenUsage(value: unknown): TokenUsage | undefined {
  // Preserve untrusted usage verbatim for the platform fold's strict validation.
  // Dropping malformed fields would turn unknown billing into known zero.
  return value as TokenUsage;
}
function readToolCalls(value: unknown): ToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !isRecord(entry.arguments)) return null;
    calls.push({ id: entry.id, name: entry.name, arguments: entry.arguments });
  }
  return calls;
}
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function readConversationMessageSnapshot(value: unknown): ConversationMessageSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.role === 'user') {
    const content = readContent(value.content);
    if (content === null) return null;
    const cancelled = hasOwn(value, 'cancelled') ? readBoolean(value.cancelled) : undefined;
    if (hasOwn(value, 'cancelled') && cancelled === undefined) return null;
    return {
      role: 'user',
      content,
      ...(cancelled !== undefined ? { cancelled } : {}),
    };
  }
  if (value.role === 'assistant') {
    const content = readString(value.content);
    if (content === undefined) return null;
    const toolCalls = hasOwn(value, 'toolCalls') ? readToolCalls(value.toolCalls) : undefined;
    if (toolCalls === null) return null;
    const reasoningContent = hasOwn(value, 'reasoningContent') ? readString(value.reasoningContent) : undefined;
    if (hasOwn(value, 'reasoningContent') && reasoningContent === undefined) return null;
    const reasoningSummary = hasOwn(value, 'reasoningSummary') ? readString(value.reasoningSummary) : undefined;
    if (hasOwn(value, 'reasoningSummary') && reasoningSummary === undefined) return null;
    const usage = hasOwn(value, 'usage') ? readTokenUsage(value.usage) : undefined;
    const model = hasOwn(value, 'model') ? readString(value.model) : undefined;
    if (hasOwn(value, 'model') && model === undefined) return null;
    const provider = hasOwn(value, 'provider') ? readString(value.provider) : undefined;
    if (hasOwn(value, 'provider') && provider === undefined) return null;
    return {
      role: 'assistant',
      content,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
      ...(reasoningSummary !== undefined ? { reasoningSummary } : {}),
      ...(hasOwn(value, 'usage') ? { usage } : {}),
      ...(value.followUp === true ? { followUp: true as const } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
  }
  if (value.role === 'system' && typeof value.content === 'string') {
    const notice = readNoticeMeta(value.notice);
    if (!hasOwn(value, 'runtimeEvent')) return { role: 'system', content: value.content, ...(notice ? { notice } : {}) };
    const event = value.runtimeEvent;
    if (!isRecord(event) || typeof event.type !== 'string') return null;
    if (hasOwn(event, 'occurrenceId') && event.occurrenceId !== undefined && typeof event.occurrenceId !== 'string') return null;
    return {
      role: 'system',
      content: value.content,
      runtimeEvent: { type: event.type, ...(typeof event.occurrenceId === 'string' ? { occurrenceId: event.occurrenceId } : {}) },
      ...(notice ? { notice } : {}),
    };
  }
  if (value.role === 'tool' && typeof value.callId === 'string' && typeof value.content === 'string') {
    const toolName = hasOwn(value, 'toolName') ? readString(value.toolName) : undefined;
    if (hasOwn(value, 'toolName') && toolName === undefined) return null;
    // An absent outcome means "unknown" (legacy results); a present one must be a known state.
    const rawOutcome = hasOwn(value, 'outcome') ? value.outcome : undefined;
    const outcome = rawOutcome === 'ok' || rawOutcome === 'error' || rawOutcome === 'cancelled' ? rawOutcome : undefined;
    if (hasOwn(value, 'outcome') && outcome === undefined) return null;
    return {
      role: 'tool',
      callId: value.callId,
      content: value.content,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      // Passed through for the platform fold to validate, like usage.
      ...(hasOwn(value, 'hostEvidence') && value.hostEvidence !== undefined ? { hostEvidence: value.hostEvidence as ToolHostEvidence } : {}),
    };
  }
  return null;
}
export function readConversationMessageSnapshots(messages: readonly object[]): ConversationMessageSnapshot[] {
  const snapshots: ConversationMessageSnapshot[] = [];
  for (const [index, message] of messages.entries()) {
    const snapshot = readConversationMessageSnapshot(message);
    if (!snapshot) throw new Error(`Invalid saved conversation message at index ${index}.`);
    snapshots.push(snapshot);
  }
  return snapshots;
}
export function conversationMessagesAsSessionRecords(messages: readonly ConversationMessageSnapshot[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({ ...message }));
}
