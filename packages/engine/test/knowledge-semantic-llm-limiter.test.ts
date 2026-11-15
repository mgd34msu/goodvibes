import { expect, test } from 'bun:test';
import { createProviderBackedKnowledgeSemanticLlm } from '../platform/src/platform/knowledge/semantic/llm.js';

test('the concurrency limit holds when new requests arrive while a slot is being handed to a waiter', async () => {
  let inFlight = 0;
  let peak = 0;
  const llm = createProviderBackedKnowledgeSemanticLlm({
    getCurrentModel: () => ({ id: 'model', provider: 'test', registryKey: 'test:model' }),
    getForModel: () => ({
      name: 'test',
      models: ['model'],
      chat: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        for (let tick = 0; tick < 8; tick++) await Promise.resolve();
        inFlight -= 1;
        return { content: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
      },
    }),
  } as never, { maxConcurrent: 1 });
  const ask = () => llm.completeText({ purpose: 'limiter', systemPrompt: 's', prompt: 'p' });
  const requests = [ask(), ask()];
  // A new request every microtask tick lands in the window between a release and the waiter resuming.
  for (let tick = 0; tick < 60; tick++) {
    await Promise.resolve();
    requests.push(ask());
  }
  expect(await Promise.all(requests)).toEqual(requests.map(() => 'ok'));
  expect(peak).toBe(1);
});
