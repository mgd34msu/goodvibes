/**
 * The mechanical compaction only drops messages. What they tell the model
 * must say so, so it re-reads what it still needs instead of trusting a summary that does not exist.
 */
import { describe, expect, test } from 'bun:test';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';
import { compactSmallWindow } from '../platform/src/platform/core/context-compaction.js';

const conversation = (count: number): ProviderMessage[] =>
  Array.from({ length: count }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}` }) as ProviderMessage);

const text = (message: ProviderMessage | undefined): string => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content));

describe('a small-window compaction', () => {
  test('says how many messages were dropped and that nothing summarises them', () => {
    const compacted = compactSmallWindow(conversation(14), 4);
    expect(compacted).toHaveLength(6);
    expect(text(compacted[0])).toContain('10 earlier messages were dropped, not summarised');
    expect(text(compacted[0])).not.toContain('summarized');
    expect(compacted.slice(2).map(text)).toEqual(['message 10', 'message 11', 'message 12', 'message 13']);
  });
});
