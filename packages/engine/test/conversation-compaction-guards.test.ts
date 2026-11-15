/**
 * Conversation compaction: Classic operation, bookkeeping failures after the
 * conversation was replaced, per-session compaction events, and the distiller's
 * transcript limits.
 */
import { describe, expect, test } from 'bun:test';
import { compactConversation, type ConversationCompactionHost } from '../platform/src/platform/core/conversation-compaction.js';
import { compactMessages, getLastCompactionEvent } from '../platform/src/platform/core/context-compaction.js';
import { distillConversation } from '../platform/src/platform/core/distiller-compaction.js';
import type { CompactionContext } from '../platform/src/platform/core/compaction-types.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';
import { useCompactionQuality } from './_helpers/compaction-quality.ts';

useCompactionQuality({ substance: 3, relation: 'supports', selectedPositions: [1] });

const noProvider = {
  getForModel() { throw new Error('no provider in test'); },
  listModels() { return []; },
} as unknown as ProviderRegistry;

function bigConversation(count = 60): ProviderMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message ${i} ` + 'lorem ipsum dolor sit amet '.repeat(12),
  }));
}

function makeHost(messages: ProviderMessage[], lineage: ConversationCompactionHost['getSessionLineageTracker'] = () => ({ addCompactionEntry: () => {} })) {
  let replaced: ProviderMessage[] | null = null;
  const host: ConversationCompactionHost = {
    getMessageCount: () => messages.length,
    getMessagesForLLM: () => messages,
    replaceMessagesForLLM: (next) => { replaced = next; },
    getSessionMemoryStore: () => null,
    getSessionLineageTracker: lineage,
  };
  return { host, replaced: () => replaced };
}

function context(messages: ProviderMessage[], extra: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messages, sessionMemories: [], agents: [], contracts: [], activePlan: null, lineageEntries: [],
    compactionCount: 0, contextWindow: 100_000, trigger: 'auto', extractionModelId: 'test/model', ...extra,
  };
}

describe('Classic operation', () => {
  test('compaction applies and the receipt carries no quality grade', async () => {
    const { host, replaced } = makeHost(bigConversation());
    const receipt = await withDecisionModelPolicy(() => 'Classic - Off', () => compactConversation(host, noProvider, 'test/model', 'auto'));

    expect(receipt?.outcome).toBe('applied');
    expect(replaced()).not.toBeNull();
    expect(receipt?.qualityGrade).toBe('');
    expect(receipt?.lowQuality).toBe(false);
    expect(receipt?.detail).toContain('no independent semantic quality score');
  });

  test('a compaction that bought nothing is still rejected', async () => {
    const { host, replaced } = makeHost([{ role: 'user', content: 'hi' }]);
    const run = withDecisionModelPolicy(() => 'Classic - Off', () => compactConversation(host, noProvider, 'test/model', 'auto'));

    await expect(run).rejects.toMatchObject({ name: 'CompactionQualityError' });
    expect(replaced()).toBeNull();
  });
});

describe('bookkeeping after the conversation was replaced', () => {
  test('a lineage failure still returns the applied receipt', async () => {
    const { host, replaced } = makeHost(bigConversation(), () => ({ addCompactionEntry: () => { throw new Error('lineage store is read-only'); } }));
    const receipt = await compactConversation(host, noProvider, 'test/model', 'auto');

    expect(replaced()).not.toBeNull();
    expect(receipt?.outcome).toBe('applied');
  });
});

describe('compaction events', () => {
  test('each session reads back its own latest event when compactions interleave', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const first = await compactMessages(context(bigConversation(), { sessionId: 'session-a' }), noProvider);
      const second = await compactMessages(context(bigConversation(), { sessionId: 'session-b' }), noProvider);

      expect(getLastCompactionEvent('session-a')).toBe(first.event);
      expect(getLastCompactionEvent('session-b')).toBe(second.event);
      expect(getLastCompactionEvent()).toBe(second.event);
      expect(getLastCompactionEvent('session-never-compacted')).toBeNull();
    });
  });
});

describe('distiller transcript', () => {
  function capturingRegistry(window: number | null) {
    const prompts: string[] = [];
    const registry = {
      getForModel: () => ({ chat: async (request: { messages: Array<{ content: string }> }) => { prompts.push(request.messages[0]!.content); return { content: '## Task State\nx' }; } }),
      listModels: () => [{ provider: 'test', id: 'model', registryKey: 'test/model' }],
      getKnownContextWindowForModel: () => window,
    } as unknown as ProviderRegistry;
    return { registry, prompts };
  }

  test('drops the oldest messages first when the extraction model window is smaller than the conversation', async () => {
    const { registry, prompts } = capturingRegistry(12_000);
    const messages = Array.from({ length: 40 }, (_, i): ProviderMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `unit-${i}-start ` + 'filler words '.repeat(120),
    }));

    await distillConversation(context(messages, { strategy: 'distiller' }), registry);

    const prompt = prompts[0]!;
    expect(prompt).toContain('unit-39-start');
    expect(prompt).not.toContain('unit-0-start');
    expect(prompt).toContain('earlier conversation omitted');
    // 12,000-token window, 4,000 held back: the transcript stays under 8,000 tokens of characters.
    expect(prompt.length).toBeLessThan(12_000 * 4);
  });

  test('sends the whole conversation when the window is unknown', async () => {
    const { registry, prompts } = capturingRegistry(null);
    const messages = Array.from({ length: 40 }, (_, i): ProviderMessage => ({ role: 'user', content: `unit-${i}-start ` + 'filler '.repeat(400) }));

    await distillConversation(context(messages, { strategy: 'distiller' }), registry);

    expect(prompts[0]).toContain('unit-0-start');
    expect(prompts[0]).not.toContain('earlier conversation omitted');
  });

  test('names the tools an assistant called even when the turn had no text', async () => {
    const { registry, prompts } = capturingRegistry(null);
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'open the config' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/config.ts' } }] },
    ];

    await distillConversation(context(messages, { strategy: 'distiller' }), registry);

    expect(prompts[0]).toContain('tool call read_file({"path":"src/config.ts"})');
  });
});
