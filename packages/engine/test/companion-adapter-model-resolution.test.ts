import { DecisionRouterProvider } from '../platform/src/platform/providers/decision-router.js';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
/**
 * companion-adapter-model-resolution.test.ts
 *
 * Verifies that the companion adapter resolves a registry key to the
 * provider-local model id before calling provider.chat().
 */

import { describe, expect, test } from 'bun:test';
import { createCompanionProviderAdapter } from '../platform/src/platform/daemon/facade-composition.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from '../platform/src/platform/providers/builtin-registry.js';
import { findModelDefinition, findModelDefinitionForProvider } from '../platform/src/platform/providers/registry-models.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../platform/src/platform/providers/interface.js';
import type { ToolDefinition } from '../platform/src/platform/types/tools.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Records the model field received by provider.chat() for assertion. */
function makeRecordingProvider(name: string): LLMProvider & { recordedModel: string | null; recordedTools: ToolDefinition[] | undefined } {
  const stub = {
    name,
    models: [],
    recordedModel: null as string | null,
    recordedTools: undefined as ToolDefinition[] | undefined,
    isConfigured() { return true; },
    async chat(params: ChatRequest): Promise<ChatResponse> {
      stub.recordedModel = params.model;
      stub.recordedTools = params.tools;
      return { content: 'ok', stopReason: 'completed', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  return stub;
}

function makeModelDef(id: string, provider: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: '',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  };
}

function makeModelDefWithRegistryKey(id: string, provider: string, registryKey: string): ModelDefinition {
  return {
    ...makeModelDef(id, provider),
    registryKey,
  };
}

/**
 * Minimal ProviderRegistry implementation that knows about a single model.
 */
function makeStubRegistry(
  modelDef: ModelDefinition,
  provider: LLMProvider,
): ProviderRegistry {
  return {
    getForModel(_modelId: string, _provider?: string): LLMProvider {
      return provider;
    },
    listModels(): ModelDefinition[] {
      return [modelDef];
    },
    getCurrentModel(): ModelDefinition {
      return modelDef;
    },
    // Other ProviderRegistry methods not used by the adapter under test
  } as unknown as ProviderRegistry;
}

function makeMultiModelRegistry(
  modelDefs: readonly ModelDefinition[],
  providers: Readonly<Record<string, LLMProvider>>,
): ProviderRegistry {
  return {
    getForModel(modelId: string, provider?: string): LLMProvider {
      const def = provider
        ? findModelDefinitionForProvider(modelId, provider, modelDefs, CATALOG_PROVIDER_NAME_ALIASES)
        : findModelDefinition(modelId, modelDefs);
      const resolvedProvider = def?.provider ?? provider;
      const selectedProvider = resolvedProvider ? providers[resolvedProvider] : undefined;
      if (!selectedProvider) throw new Error('provider not found');
      return selectedProvider;
    },
    listModels(): ModelDefinition[] {
      return [...modelDefs];
    },
    getCurrentModel(): ModelDefinition {
      return modelDefs[0]!;
    },
  } as unknown as ProviderRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompanionProviderAdapter: model id resolution', () => {
  test('passes provider-local model id to provider.chat() when options.model is a registry key', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inceptionlabs:mercury-2', provider: 'inceptionlabs' },
    );

    // Drain stream
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    // The adapter must pass provider-local "mercury-2", NOT "inceptionlabs:mercury-2"
    expect(recordingProvider.recordedModel).toBe('mercury-2');
    expect(recordingProvider.recordedModel).not.toBe('inceptionlabs:mercury-2');
  });

  test('passes provider-local model id when options.provider is not supplied by registryKey lookup', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inceptionlabs:mercury-2' },  // no options.provider
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('mercury-2');
  });

  test('unknown registry key returns an error instead of guessing from the prefix', async () => {
    // Registry that returns no model definitions (unknown model)
    const unexpectedProvider = makeRecordingProvider('unknown-provider');
    const modelDef = makeModelDef('unknown-model', 'unknown-provider');
    const emptyRegistry: ProviderRegistry = {
      getForModel(): LLMProvider { return unexpectedProvider; },
      listModels(): ModelDefinition[] { return []; },  // empty, no def found
      getCurrentModel(): ModelDefinition { return modelDef; },
    } as unknown as ProviderRegistry;

    const adapter = createCompanionProviderAdapter(emptyRegistry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'someprovider:some-model-id' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(unexpectedProvider.recordedModel).toBeNull();
    expect(chunks).toContainEqual({
      type: 'error',
      error: "Model 'someprovider:some-model-id' is not in the provider registry.",
    });
  });

  test('provider-qualified registryKey disambiguates duplicate model ids', async () => {
    const openaiModel = makeModelDef('gpt-4o', 'openai');
    const azureModel = makeModelDef('gpt-4o', 'azure-openai');
    const openaiProvider = makeRecordingProvider('openai');
    const azureProvider = makeRecordingProvider('azure-openai');
    const registry = makeMultiModelRegistry(
      [openaiModel, azureModel],
      { openai: openaiProvider, 'azure-openai': azureProvider },
    );

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'azure-openai:gpt-4o' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(azureProvider.recordedModel).toBe('gpt-4o');
    expect(openaiProvider.recordedModel).toBeNull();
  });

  test('openai-subscriber provider route resolves through the openai catalog model', async () => {
    const openaiModel = makeModelDef('gpt-5.5', 'openai');
    const subscriberProvider = makeRecordingProvider('openai-subscriber');
    const registry = makeMultiModelRegistry(
      [openaiModel],
      { openai: subscriberProvider },
    );

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { provider: 'openai-subscriber', model: 'openai:gpt-5.5' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(subscriberProvider.recordedModel).toBe('gpt-5.5');
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  test('openai-subscriber provider route also accepts provider-local model id', async () => {
    const openaiModel = makeModelDef('gpt-5.5', 'openai');
    const subscriberProvider = makeRecordingProvider('openai-subscriber');
    const registry = makeMultiModelRegistry(
      [openaiModel],
      { openai: subscriberProvider },
    );

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { provider: 'openai-subscriber', model: 'gpt-5.5' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(subscriberProvider.recordedModel).toBe('gpt-5.5');
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  test('openai catalog route resolves subscription-backed model definitions', async () => {
    const openaiSubscriberModel = makeModelDefWithRegistryKey('gpt-5.5', 'openai-subscriber', 'openai:gpt-5.5');
    const subscriberProvider = makeRecordingProvider('openai-subscriber');
    const registry = makeMultiModelRegistry(
      [openaiSubscriberModel],
      { 'openai-subscriber': subscriberProvider },
    );

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { provider: 'openai', model: 'openai:gpt-5.5' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(subscriberProvider.recordedModel).toBe('gpt-5.5');
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  test('no options.model selects the current provider-qualified registry key', async () => {
    const modelDef = makeModelDef('claude-sonnet', 'anthropic');
    const recordingProvider = makeRecordingProvider('anthropic');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      {},  // no model specified
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('claude-sonnet');
  });

  test('forwards companion remote-session tools to provider.chat()', async () => {
    const modelDef = makeModelDef('gpt-5.4', 'openai');
    const recordingProvider = makeRecordingProvider('openai');
    const registry = makeStubRegistry(modelDef, recordingProvider);
    const tools: ToolDefinition[] = [
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'what tools do you have?' }],
      { model: 'openai:gpt-5.4', provider: 'openai', tools },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedTools?.map((tool) => tool.name)).toEqual(['read']);
  });
});

test('companion tool rounds share one Decision Router selection and expose actual route usage', async () => {
  const readings = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'general', 0.97) : noulAnswer(0.97));
  const answer = makeRecordingProvider('answer');
  const router = new DecisionRouterProvider({ settings: () => ({ categories: { general: { target: { provider: 'answer', model: 'target' } } } }),
    resolveTarget: () => ({ provider: answer, model: makeModelDef('target', 'answer') }), capturePort: () => ({ port: readings.port, assertCurrent() {} }) });
  const adapter = createCompanionProviderAdapter(makeStubRegistry(makeModelDef('auto', 'decision-router'), router));
  const signal = new AbortController().signal;
  const options = { model: 'decision-router:auto', provider: 'decision-router', abortSignal: signal, routingContext: { sessionId: 'session', turnId: 'one' } };
  const messages: Parameters<typeof adapter.chatStream>[0] = [{ role: 'user', content: 'hello' }];
  let terminal: unknown;
  for await (const chunk of adapter.chatStream(messages, options)) if (chunk.type === 'done') terminal = chunk;
  messages.push({ role: 'tool', callId: 'tool', content: 'complete tool evidence' });
  for await (const _chunk of adapter.chatStream(messages, options)) { /* consume stream */ }
  expect(readings.requests).toHaveLength(1);
  expect(answer.recordedModel).toBe('target');
  expect(terminal).toMatchObject({ decisionRoute: { provider: 'answer', model: 'target' }, usage: { inputTokens: 0, outputTokens: 0 } });
});


test('ordinary companion adapter forwards requested xhigh/max with the actual selected model spec and null omits override', async () => {
  const calls: ChatRequest[] = [];
  const provider: LLMProvider = { name: 'synthetic-sol', models: ['gpt-6.1-sol'], isConfigured: () => true,
    async chat(request) { calls.push(request); return { content: 'synthetic ordinary answer', toolCalls: [], stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const model: ModelDefinition = { ...makeModelDef('gpt-6.1-sol', provider.name),
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    reasoningEffort: { kind: 'effort', source: 'declared', values: ['high', 'xhigh', 'max'], defaultValue: 'high' } };
  const adapter = createCompanionProviderAdapter(makeStubRegistry(model, provider));
  const messages = [{ role: 'user' as const, content: 'Retain this whole authorized original message.' }];
  for (const reasoningEffort of ['xhigh', 'max', null]) {
    for await (const _chunk of adapter.chatStream(messages, { provider: provider.name, model: model.registryKey, reasoningEffort })) { /* drain actual bridge */ }
  }
  expect(calls.map(call => call.reasoningEffort)).toEqual(['xhigh', 'max', undefined]);
  expect(calls.map(call => call.reasoningEffortSpec?.values)).toEqual([['high', 'xhigh', 'max'], ['high', 'xhigh', 'max'], ['high', 'xhigh', 'max']]);
  expect(calls.every(call => call.messages[0]?.content === messages[0]?.content)).toBe(true);
});
