import { describe, expect, test } from 'bun:test';
import {
  HelperModel,
  HelperRouter,
  resolveToolLLM,
  ToolLLM,
  ToolLLMUnavailableError,
} from '../platform/src/platform/config/index.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { ResolvedModelPricing } from '../platform/src/platform/providers/model-pricing.js';

/** None of these tests exercise cost attribution, every route reports unpriced. */
function resolveModelPricingStub(): ResolvedModelPricing {
  return { status: 'unknown' };
}

function model(provider = 'openai', id = 'gpt-4.1-mini'): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: id,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: false,
      multimodal: false,
    },
    contextWindow: 128_000,
    selectable: true,
  };
}

function provider(name: string, content = 'ok'): LLMProvider {
  return {
    name,
    models: [],
    async chat() {
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed',
      };
    },
  };
}

describe('tool LLM routing', () => {
  test('disabled tool LLM chat throws instead of returning an empty string', async () => {
    const toolLLM = new ToolLLM({
      configManager: { get: (() => false) as ConfigManager['get'] },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(toolLLM.chat('summarize')).rejects.toThrow(ToolLLMUnavailableError);
  });

  test('explicit tool route validates provider-qualified model ownership', () => {
    const deps = {
      configManager: {
        get: ((key: string) => {
          if (key === 'tools.llmEnabled') return true;
          if (key === 'tools.llmProvider') return 'openai';
          if (key === 'tools.llmModel') return 'anthropic:claude-3-5-haiku';
          return '';
        }) as ConfigManager['get'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
        resolveModelPricing: resolveModelPricingStub,
      },
    };

    expect(() => resolveToolLLM(deps)).toThrow("conflicts with provider 'openai'");
  });

  test('explicit tool route uses registry lookup and provider-local model id', async () => {
    let lookup: { modelId: string; provider?: string | undefined } | undefined;
    let requestedModel: string | undefined;
    const routedProvider: LLMProvider = {
      ...provider('openai', 'tool response'),
      async chat(params) {
        requestedModel = params.model;
        return {
          content: 'tool response',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const toolLLM = new ToolLLM({
      configManager: {
        get: ((key: string) => {
          if (key === 'tools.llmEnabled') return true;
          if (key === 'tools.llmProvider') return 'openai';
          if (key === 'tools.llmModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: (modelId, providerId) => {
          lookup = { modelId, provider: providerId };
          return routedProvider;
        },
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(toolLLM.chat('summarize')).resolves.toBe('tool response');
    expect(lookup).toEqual({ modelId: 'openai:gpt-4.1-mini', provider: 'openai' });
    expect(requestedModel).toBe('gpt-4.1-mini');
  });

  test('missing tool response content is not converted to an empty string', async () => {
    const badProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        return {
          content: undefined as unknown as string,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const toolLLM = new ToolLLM({
      configManager: {
        get: ((key: string) => key === 'tools.llmEnabled') as ConfigManager['get'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => badProvider,
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(toolLLM.chat('summarize')).rejects.toThrow('did not include string content');
  });
});

describe('helper model routing', () => {
  test('helperOnly returns null when no dedicated route exists', async () => {
    const helper = new HelperModel({
      configManager: {
        get: (() => false) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(helper.chat('resume_summary', 'summarize', { helperOnly: true })).resolves.toBeNull();
  });

  for (const enabled of [false, true]) {
    test(`with helper.enabled ${enabled} and no route, supporting work inherits the main model`, async () => {
      const used: string[] = [];
      const helper = new HelperModel({
        configManager: {
          get: ((key: string) => key === 'helper.enabled' ? enabled : undefined) as ConfigManager['get'],
          getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
        },
        providerRegistry: {
          getCurrentModel: () => model('openai', 'main-model'),
          getForModel: (key: string) => { used.push(key); return provider('openai', 'from main'); },
          resolveModelPricing: resolveModelPricingStub,
        },
      });

      await expect(helper.chat('compaction', 'plan')).resolves.toBe('from main');
      expect(used).toEqual(['openai:main-model']);
    });
  }

  test('per-provider helper route rejects provider/model conflicts without trying later routes', () => {
    const router = new HelperRouter({
      configManager: {
        get: ((key: string) => {
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
        getCategory: (() => ({
          providers: {
            openai: { provider: 'openai', model: 'anthropic:claude-3-5-haiku' },
          },
        })) as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model('openai', 'gpt-4.1'),
        getForModel: () => provider('openai'),
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    expect(() => router.resolve('compaction')).toThrow("conflicts with provider 'openai'");
  });

  test('helper provider request failures are observable', async () => {
    const failingProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        throw new Error('provider unavailable');
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: ((key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => failingProvider,
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(helper.chat('compaction', 'plan')).rejects.toThrow('provider unavailable');
  });

  test('a provider that never answers rejects after the timeout and was told to stop', async () => {
    let seen: AbortSignal | undefined;
    const hangingProvider: LLMProvider = {
      ...provider('openai'),
      chat(params) {
        seen = params.signal;
        return new Promise(() => {});
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: ((key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => hangingProvider,
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(helper.chat('compaction', 'plan', { timeoutMs: 5 })).rejects.toThrow('timed out after 5 ms');
    expect(seen?.aborted).toBe(true);
  });

  test('a provider whose chat throws synchronously leaves no timeout timer armed', async () => {
    const throwingProvider: LLMProvider = {
      ...provider('openai'),
      chat() {
        throw new Error('invalid request');
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: ((key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => throwingProvider,
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    const realSetTimeout = globalThis.setTimeout;
    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      armed.push(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      return realClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      await expect(helper.chat('compaction', 'plan', { timeoutMs: 60_000 })).rejects.toThrow('invalid request');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    // Every timer armed during the call (if any) was cleared.
    for (const handle of armed) expect(cleared).toContain(handle);
  });

  test('missing helper response content is not converted to an empty string', async () => {
    const badProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        return {
          content: undefined as unknown as string,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: ((key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        }) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => badProvider,
        resolveModelPricing: resolveModelPricingStub,
      },
    });

    await expect(helper.chat('compaction', 'plan')).rejects.toThrow('did not include string content');
  });
});

test('ToolLLM carries live authority admission to each provider retry', async () => {
  let allowed = true;
  let admitted = 0;
  let transmissions = 0;
  const signal = new AbortController().signal;
  const guardedProvider: LLMProvider = {
    ...provider('fixture'),
    async chat(request) {
      expect(request.signal).toBe(signal);
      await request.beforeAttempt?.();
      transmissions++;
      allowed = false;
      await request.beforeAttempt?.();
      transmissions++;
      throw Error('unauthorized retry reached dispatch');
    },
  };
  const toolLLM = new ToolLLM({
    configManager: { get: ((key: string) => key === 'tools.llmEnabled' ? true : '') as ConfigManager['get'] },
    providerRegistry: {
      getCurrentModel: () => model('fixture', 'fixture'),
      getForModel: () => guardedProvider,
      resolveModelPricing: resolveModelPricingStub,
    },
  });
  await expect(toolLLM.chat('repair synthetic content', { signal, beforeAttempt: async () => {
    admitted++; await Promise.resolve(); if (!allowed) throw Error('current owner denied repair');
  } })).rejects.toThrow('current owner denied repair');
  expect(admitted).toBe(2); expect(transmissions).toBe(1);
});
