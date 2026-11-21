import type { ChatStopReason, StreamDelta } from './interface.js';
import type { OpenAIToolCall } from './tool-formats.js';
import { fromOpenAIToolCalls, extractTextToolCalls } from './tool-formats.js';

/** Accumulated state for one streaming tool-call slot. */
export interface OpenAIToolCallSlot {
  id: string;
  name: string;
  args: string;
}

/** Usage fields found on OpenAI streaming chunks. */
export interface OpenAIChunkUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  prompt_tokens_details?: { cached_tokens?: number } | undefined;
}

/**
 * Some OpenAI-compatible servers omit `index` on tool-call deltas. Keying on
 * `undefined` would fold every parallel call into one slot and concatenate
 * their arguments, so without an index a delta with a known id continues that
 * call, a delta with a new id opens the next slot, and an id-less delta
 * continues the latest call unless it carries a name the latest call already has.
 */
function resolveToolCallSlot(
  acc: Map<number, OpenAIToolCallSlot>,
  tc: { index?: number | undefined; id?: string | undefined; function?: { name?: string | undefined } | undefined },
): number {
  if (typeof tc.index === 'number') return tc.index;
  const last = acc.size > 0 ? Math.max(...acc.keys()) : -1;
  if (!tc.id) {
    // A name-bearing delta with neither index nor id, arriving after the latest
    // call already has its name, starts the next call; args-only deltas continue.
    if (tc.function?.name && last >= 0 && acc.get(last)?.name) return last + 1;
    return Math.max(last, 0);
  }
  for (const [slot, entry] of acc) {
    if (entry.id === tc.id) return slot;
  }
  return last + 1;
}

/**
 * Update the tool-call accumulator map with one streaming tool_call delta.
 * Fires onDelta if provided.
 */
export function accumOpenAIToolCall(
  acc: Map<number, OpenAIToolCallSlot>,
  tc: {
    index?: number | undefined;
    id?: string | undefined;
    function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
  },
  onDelta: ((delta: StreamDelta) => void) | undefined,
): void {
  const idx = resolveToolCallSlot(acc, tc);
  if (!acc.has(idx)) {
    acc.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
  }
  const entry = acc.get(idx)!;
  if (tc.id) entry.id = tc.id;
  if (tc.function?.name) entry.name = tc.function.name;
  if (tc.function?.arguments) entry.args += tc.function.arguments;
  if (onDelta) {
    onDelta({
      toolCalls: [{ index: idx, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments }],
    });
  }
}

/**
 * Finalise accumulated tool-call slots into the raw OpenAI wire format,
 * sorted by stream index.
 */
export function finalizeOpenAIToolCalls(acc: Map<number, OpenAIToolCallSlot>): OpenAIToolCall[] {
  const result: OpenAIToolCall[] = [];
  for (const [, tc] of [...acc.entries()].sort(([a], [b]) => a - b)) {
    result.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.args },
    });
  }
  return result;
}

/**
 * Apply token counts from a streaming chunk's usage field.
 * Absent fields keep the value from current (so initial 0 stays 0
 * if the provider never sends those fields).
 *
 * `prompt_tokens` counts the cached prompt tokens too; the returned
 * `inputTokens` is the fresh input only (`prompt_tokens` minus
 * `cached_tokens`), the meaning `ChatResponse.usage.inputTokens` has for
 * every provider.
 */
export function applyOpenAIChunkUsage(
  usage: OpenAIChunkUsage | null | undefined,
  current: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  if (!usage) return current;
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? current.cacheReadTokens;
  const promptTokens = usage.prompt_tokens ?? current.inputTokens + current.cacheReadTokens;
  return {
    inputTokens: freshInputTokens(promptTokens, cacheReadTokens),
    outputTokens: usage.completion_tokens ?? current.outputTokens,
    cacheReadTokens,
  };
}

/** The fresh input in a prompt count that includes its cached tokens. */
export function freshInputTokens(promptTokens: number, cachedTokens: number | undefined): number {
  return Math.max(0, promptTokens - (cachedTokens ?? 0));
}

/**
 * Convert finalized raw tool-calls to canonical form and apply the text-based
 * tool-call fallback for models that emit tool calls as raw text tokens.
 *
 * Returns the final toolCalls list plus (possibly mutated) response text,
 * stop reason, and raw stop reason.
 */
export function resolveOpenAIToolCallsAndFallback(
  rawToolCalls: OpenAIToolCall[],
  responseText: string,
  stopReason: ChatStopReason,
  rawStopReason: string | undefined,
): {
  toolCalls: ReturnType<typeof fromOpenAIToolCalls>;
  responseText: string;
  stopReason: ChatStopReason;
  rawStopReason: string | undefined;
} {
  let toolCalls = rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [];
  if (
    toolCalls.length === 0 &&
    (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))
  ) {
    const extracted = extractTextToolCalls(responseText);
    if (extracted.toolCalls.length > 0) {
      toolCalls = extracted.toolCalls;
      responseText = extracted.cleanedContent;
      stopReason = 'tool_call';
      rawStopReason = rawStopReason ?? 'tool_calls';
    }
  }
  return { toolCalls, responseText, stopReason, rawStopReason };
}
