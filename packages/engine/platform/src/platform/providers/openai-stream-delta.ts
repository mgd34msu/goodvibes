/** Platform module maintained in the GoodVibes engine. */

import { knownContentPartIsReasoning } from '../routing/provider-readings.js';

/**
 * The documented content-part type labels of OpenAI-compatible streams, an
 * exact wire table: these carry reasoning, these carry the answer. A label
 * outside the table is answer text unless a reading taken off the request path
 * already said otherwise; nothing waits on a model mid-stream and nothing is
 * decided by a substring of the label.
 */
const REASONING_PART_TYPES: ReadonlySet<string> = new Set([
  'reasoning', 'reasoning_text', 'reasoning_content', 'reasoning_summary', 'thinking', 'thinking_delta', 'redacted_thinking',
]);
const ANSWER_PART_TYPES: ReadonlySet<string> = new Set(['text', 'output_text', 'input_text', 'refusal']);

/** Whether a typed content part carries reasoning: the wire table, a remembered reading, else answer text. */
function partIsReasoning(type: string): boolean {
  if (REASONING_PART_TYPES.has(type)) return true;
  if (ANSWER_PART_TYPES.has(type)) return false;
  return knownContentPartIsReasoning(type) ?? false;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function collectTextFragments(value: unknown, keys: string[]): string[] {
  if (!Array.isArray(value)) return [];

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.length > 0) fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.type === 'string') continue;
    for (const key of keys) {
      const found = asString(record[key]);
      if (found) {
        fragments.push(found);
        break;
      }
    }
  }
  return fragments;
}

function collectContentFragments(
  value: unknown,
  options: { includeTypedReasoning: boolean },
): string[] {
  if (!Array.isArray(value)) return [];

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.length > 0) fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const text = asString(record.text)
      ?? asString(record.content)
      ?? asString(record.reasoning)
      ?? asString(record.thinking)
      ?? asString(record.delta);
    if (!text) continue;

    if (!type) {
      fragments.push(text);
      continue;
    }

    const isReasoning = partIsReasoning(type);
    if (!isReasoning || options.includeTypedReasoning) {
      fragments.push(text);
    }
  }
  return fragments;
}

function collectTypedContentFragments(value: unknown, kind: 'content' | 'reasoning'): string[] {
  if (!Array.isArray(value)) return [];
  const fragments: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (!type) continue;
    const text = asString(record.text)
      ?? asString(record.content)
      ?? asString(record.reasoning)
      ?? asString(record.thinking)
      ?? asString(record.delta);
    if (!text) continue;

    const isReasoning = partIsReasoning(type);
    if (kind === 'reasoning' && isReasoning) fragments.push(text);
    if (kind === 'content' && !isReasoning) fragments.push(text);
  }
  return fragments;
}

export interface OpenAIStreamTextDelta {
  content: string[];
  reasoning: string[];
}

export interface OpenAIStreamTextDeltaOptions {
  allowReasoning?: boolean | undefined;
}

/**
 * Normalize the wide variety of OpenAI-compatible streaming delta shapes into
 * plain content/reasoning text fragments.
 */
export function extractOpenAIStreamTextDelta(
  rawChunk: unknown,
  options: OpenAIStreamTextDeltaOptions = {},
): OpenAIStreamTextDelta {
  const allowReasoning = options.allowReasoning ?? true;
  const raw = rawChunk as {
    choices?: Array<{
      delta?: Record<string, unknown> | undefined;
    }>;
    reasoning_summary?: string | undefined;
  };

  const delta = raw.choices?.[0]?.delta ?? {};
  const deltaContent = delta.content;
  const deltaReasoningContent = delta.reasoning_content;
  const stringContent = asString(deltaContent);
  const stringReasoning = asString(delta.reasoning);
  const stringReasoningContent = asString(deltaReasoningContent);
  const stringReasoningSummary = asString(raw.reasoning_summary);
  const content = [
    ...(stringContent ? [stringContent] : []),
    ...collectContentFragments(deltaContent, { includeTypedReasoning: !allowReasoning }),
    ...(!allowReasoning
      ? [
          ...(stringReasoning ? [stringReasoning] : []),
          ...(stringReasoningContent ? [stringReasoningContent] : []),
          ...(stringReasoningSummary ? [stringReasoningSummary] : []),
          ...collectTextFragments(deltaReasoningContent, ['text', 'content', 'reasoning', 'thinking', 'delta']),
        ]
      : []),
  ];
  const reasoning = allowReasoning
    ? [
        ...(stringReasoning ? [stringReasoning] : []),
        ...(stringReasoningContent ? [stringReasoningContent] : []),
        ...(stringReasoningSummary ? [stringReasoningSummary] : []),
        ...collectTypedContentFragments(deltaContent, 'reasoning'),
        ...collectTextFragments(deltaReasoningContent, ['text', 'content', 'reasoning', 'thinking', 'delta']),
      ]
    : [];

  return { content, reasoning };
}
