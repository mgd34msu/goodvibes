/** A streaming client that disconnects must never turn into an unhandled
 * rejection, which ends the whole daemon process. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { dispatchOpenAICompatibleRoutes } from '../platform/src/platform/daemon/http/openai-compatible-routes.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';

const model: ModelDefinition = {
  id: 'gpt-test',
  provider: 'openai',
  registryKey: 'openai:gpt-test',
  displayName: 'openai gpt-test',
  description: 'test model',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 8192,
  selectable: true,
  tier: 'standard',
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

const settleMacrotasks = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function route(provider: LLMProvider): Promise<Response | null> {
  const registry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'> = {
    listModels: () => [model],
    getCurrentModel: () => model,
    getForModel: () => provider,
  };
  return dispatchOpenAICompatibleRoutes(new Request('http://127.0.0.1:3421/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'goodvibes/current', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  }), {
    providerRegistry: registry,
    parseJsonBody: async (request) => await request.json() as Record<string, unknown>,
    recordApiResponse: (_request, _path, response) => response,
  });
}

const completed: ChatResponse = { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };

test('a provider that finishes after the client cancelled raises nothing', async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const provider: LLMProvider = {
    name: 'openai',
    models: ['gpt-test'],
    async chat(params: ChatRequest) {
      params.onDelta?.({ content: 'partial' });
      started.resolve();
      await release.promise;
      params.onDelta?.({ content: ' late' });
      return completed;
    },
  };
  const response = await route(provider);
  const reader = response!.body!.getReader();
  await started.promise;
  await reader.cancel();
  release.resolve();
  await settleMacrotasks();
  expect(unhandled).toEqual([]);
});

test('a provider that fails after the client cancelled raises nothing', async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const provider: LLMProvider = {
    name: 'openai',
    models: ['gpt-test'],
    async chat() {
      started.resolve();
      await release.promise;
      throw new DOMException('aborted', 'AbortError');
    },
  };
  const response = await route(provider);
  const reader = response!.body!.getReader();
  await started.promise;
  await reader.cancel();
  release.resolve();
  await settleMacrotasks();
  expect(unhandled).toEqual([]);
});
