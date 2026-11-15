/**
 * anthropic-compat-wire.test.ts
 *
 * What the Anthropic-compatible adapter sends: operator-set beta features
 * survive the thinking beta, and the adapter claims no prompt caching because
 * it sends no cache_control.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicCompatProvider } from '../platform/src/platform/providers/anthropic-compat.js';
import { AmazonBedrockProvider } from '../platform/src/platform/providers/amazon-bedrock.js';
import type { ProviderRuntimeMetadataDeps } from '../platform/src/platform/providers/interface.js';
import { getCacheCapability } from '../platform/src/platform/providers/cache-capability.js';
import type { ReasoningEffortSpec } from '../platform/src/platform/providers/reasoning-effort.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BUDGET_SPEC: ReasoningEffortSpec = { kind: 'budget_tokens', values: ['low', 'high'], source: 'family', minBudgetTokens: 1024, canDisableReasoning: true };

function sse(): Response {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function send(defaultHeaders: Record<string, string> | undefined, withThinking: boolean) {
  let captured: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = { headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return sse();
  }) as typeof globalThis.fetch;
  const provider = new AnthropicCompatProvider({
    name: 'compat-fixture',
    baseURL: 'https://compat.example.test/v1',
    apiKey: 'k',
    defaultModel: 'fixture-model',
    models: ['fixture-model'],
    authEnvVars: [],
    serviceNames: [],
    aliases: [],
    modelListing: 'none',
    ...(defaultHeaders ? { defaultHeaders } : {}),
  } as ConstructorParameters<typeof AnthropicCompatProvider>[0]);
  await provider.chat({
    messages: [{ role: 'user', content: 'x'.repeat(8000) }],
    model: 'fixture-model',
    systemPrompt: 'system '.repeat(2000),
    maxTokens: 8192,
    ...(withThinking ? { reasoningEffort: 'high', reasoningEffortSpec: BUDGET_SPEC } : {}),
  });
  return captured!;
}

describe('anthropic-beta header', () => {
  test('thinking adds its beta next to the operator-set ones, whatever the header casing', async () => {
    const request = await send({ 'Anthropic-Beta': 'files-api-2025-04-14' }, true);
    expect(request.body['thinking']).toBeDefined();
    const names = Object.keys(request.headers).filter((name) => name.toLowerCase() === 'anthropic-beta');
    expect(names).toHaveLength(1);
    expect(request.headers[names[0]!]!.split(',').sort()).toEqual(['files-api-2025-04-14', 'interleaved-thinking-2025-05-14']);
  });

  test('without thinking the operator value is left alone', async () => {
    const request = await send({ 'anthropic-beta': 'files-api-2025-04-14' }, false);
    expect(request.headers['anthropic-beta']).toBe('files-api-2025-04-14');
  });
});

describe('prompt caching claim', () => {
  test('the adapter sends no cache_control and the capability table does not claim explicit caching for it', async () => {
    const request = await send(undefined, false);
    expect(JSON.stringify(request.body)).not.toContain('cache_control');
    expect(getCacheCapability('compat-fixture')).toEqual({ type: 'none' });
  });

  test('the runtime metadata of both Anthropic wire wrappers agrees: no prompt caching, no cache strategy', async () => {
    const deps: ProviderRuntimeMetadataDeps = {
      secretsManager: { get: async () => null, listDetailed: async () => [] },
      serviceRegistry: { getAll: () => ({}), inspect: async () => null },
      subscriptionManager: { get: () => null, getPending: () => null },
    };
    const compat = new AnthropicCompatProvider({
      name: 'compat-fixture',
      baseURL: 'https://compat.example.test/v1',
      apiKey: 'k',
      defaultModel: 'fixture-model',
      models: ['fixture-model'],
      authEnvVars: [],
      serviceNames: [],
      aliases: [],
      modelListing: 'none',
    } as ConstructorParameters<typeof AnthropicCompatProvider>[0]);
    for (const provider of [compat, new AmazonBedrockProvider()]) {
      const runtime = await provider.describeRuntime(deps);
      expect(runtime.usage?.promptCaching).toBe(false);
      expect(runtime.policy).toBeDefined();
      expect(runtime.policy?.cacheStrategy).toBeUndefined();
    }
  });
});
