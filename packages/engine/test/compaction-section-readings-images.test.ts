/** One image in a conversation must not make the conversation uncompactable. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { compactMessages } from '../platform/src/platform/core/context-compaction.js';
import type { CompactionContext } from '../platform/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const providers = { getForModel() { throw new Error('Unexpected provider call'); }, listModels() { return []; } } as unknown as ProviderRegistry;

test('a message with an image part is compacted, quoting a marker where the image was', async () => {
  const { port } = fakePort(() => noulAnswer(0.95));
  installJudgmentPort(port);
  const context: CompactionContext = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Preserve the API, see the mockup.' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }] },
      { role: 'assistant', content: 'Understood; the parser is fixed.' },
    ],
    sessionMemories: [], agents: [], contracts: [], activePlan: null, lineageEntries: [], compactionCount: 0,
    contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model',
  };
  const result = await compactMessages(context, providers);
  const recent = result.sections.find((section) => section.id === 'recent-conversation')?.content ?? '';
  expect(recent).toContain('Preserve the API, see the mockup.');
  expect(recent).toContain('[image: not quoted in this text excerpt]');
  expect(recent).not.toContain('AAAA');
});
