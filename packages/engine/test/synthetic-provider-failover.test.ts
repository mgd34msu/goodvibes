import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../platform/src/platform/types/errors.ts';
import { SyntheticProvider, boundedCooldownMs, type CanonicalModel } from '../platform/src/platform/providers/synthetic.ts';
import type { ChatRequest, ChatResponse, LLMProvider, StreamDelta } from '../platform/src/platform/providers/interface.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

useFailureReadings([]);

const MODEL: CanonicalModel = {
  id: 'router-model',
  tier: 'paid',
  backendCount: 2,
  keyedBackendCount: 2,
  backends: [
    { providerName: 'a', modelId: 'a-1', contextWindow: 2000 },
    { providerName: 'b', modelId: 'b-1', contextWindow: 1000 },
  ],
};

const RESPONSE = { content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' } as unknown as ChatResponse;

function fake(name: string, chat: (params: ChatRequest) => Promise<ChatResponse>): LLMProvider {
  return { name, models: [], chat } as unknown as LLMProvider;
}

function router(providers: Record<string, LLMProvider>): SyntheticProvider {
  return new SyntheticProvider({
    resolveProvider: (name) => providers[name]!,
    getCatalogModels: () => [MODEL],
    getBenchmarks: () => undefined,
  });
}

function request(extra: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'router-model', messages: [{ role: 'user', content: 'hi' }], ...extra } as ChatRequest;
}

describe('SyntheticProvider streaming failover', () => {
  test('a backend that failed after streaming is not followed by a second answer', async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const providers = {
      a: fake('a', async (params) => {
        calls.push('a');
        params.onDelta?.({ content: 'partial ' } as StreamDelta);
        throw new Error('socket hang up');
      }),
      b: fake('b', async (params) => {
        calls.push('b');
        params.onDelta?.({ content: 'full answer' } as StreamDelta);
        return RESPONSE;
      }),
    };
    await expect(router(providers).chat(request({ onDelta: (d) => { seen.push(String((d as { content?: string }).content)); } }))).rejects.toThrow('socket hang up');
    expect(calls).toEqual(['a']);
    expect(seen).toEqual(['partial ']);
  });

  test('a backend that failed before streaming still rotates to the next', async () => {
    const providers = {
      a: fake('a', async () => { throw new Error('socket hang up'); }),
      b: fake('b', async (params) => {
        params.onDelta?.({ content: 'full answer' } as StreamDelta);
        return RESPONSE;
      }),
    };
    const seen: string[] = [];
    const response = await router(providers).chat(request({ onDelta: (d) => { seen.push(String((d as { content?: string }).content)); } }));
    expect(response).toBe(RESPONSE);
    expect(seen).toEqual(['full answer']);
  });
});

describe('SyntheticProvider auto-wait retry', () => {
  test('a retry that streamed and then dropped is not followed by a fallback model answer', async () => {
    const FREE: CanonicalModel = { ...MODEL, tier: 'free', backendCount: 1, keyedBackendCount: 1, backends: [{ providerName: 'a', modelId: 'a-1', contextWindow: 2000 }] };
    const OTHER: CanonicalModel = { id: 'other-free', tier: 'free', backendCount: 1, keyedBackendCount: 1, backends: [{ providerName: 'c', modelId: 'c-1', contextWindow: 2000 }] };
    const seen: string[] = [];
    const calls: string[] = [];
    let aCalls = 0;
    const providers = {
      a: fake('a', async (params) => {
        calls.push('a');
        aCalls++;
        if (aCalls === 1) throw new ProviderError('rate limited', { statusCode: 429, provider: 'a', operation: 'chat', phase: 'request', retryAfterMs: 1000 });
        params.onDelta?.({ content: 'partial ' } as StreamDelta);
        throw new Error('socket hang up');
      }),
      c: fake('c', async (params) => {
        calls.push('c');
        params.onDelta?.({ content: 'second answer' } as StreamDelta);
        return RESPONSE;
      }),
    };
    const synthetic = new SyntheticProvider({
      resolveProvider: (name) => providers[name as 'a' | 'c'],
      getCatalogModels: () => [FREE, OTHER],
      getBenchmarks: () => undefined,
    });
    // The cooldown wait is a timer; run it at once so the test does not sit through it.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    try {
      await expect(synthetic.chat(request({ onDelta: (d) => { seen.push(String((d as { content?: string }).content)); } }))).rejects.toThrow('socket hang up');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(calls).toEqual(['a', 'a']);
    expect(seen).toEqual(['partial ']);
  });
});

describe('SyntheticProvider cancel', () => {
  test('a cancelled call rethrows the abort and leaves the backend usable', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const providers = {
      a: fake('a', async () => {
        attempts++;
        if (attempts === 1) {
          controller.abort();
          throw new ProviderError('aborted', { statusCode: 499, provider: 'a', operation: 'chat', phase: 'request' });
        }
        return RESPONSE;
      }),
      b: fake('b', async () => { throw new Error('b must not be tried after a cancel'); }),
    };
    const synthetic = router(providers);
    await expect(synthetic.chat(request({ signal: controller.signal }))).rejects.toThrow('aborted');
    // The cancelled backend carries no cooldown: the next request goes straight to it.
    await expect(synthetic.chat(request())).resolves.toBe(RESPONSE);
    expect(attempts).toBe(2);
  });
});

describe('SyntheticProvider auth failures', () => {
  test('a rejected key fails at once, naming the status, instead of waiting out a cooldown', async () => {
    const reject = (name: string) => fake(name, async () => {
      throw new ProviderError('invalid api key', { statusCode: 401, provider: name, operation: 'chat', phase: 'request' });
    });
    const synthetic = router({ a: reject('a'), b: reject('b') });
    const message = async () => {
      const failure = await synthetic.chat(request()).then(() => undefined, (e: Error) => e);
      expect(failure).toBeInstanceOf(Error);
      return failure?.message ?? '';
    };
    expect(await message()).toContain('401 invalid api key');
    // The second request meets the backends in cooldown and must not auto-wait for it.
    expect(await message()).toContain('401 invalid api key');
  });
});

describe('a provider-stated cooldown', () => {
  test('is bounded, and a missing wait uses the default', () => {
    expect(boundedCooldownMs(999_999_999_000)).toBe(3_600_000);
    expect(boundedCooldownMs(5_000)).toBe(5_000);
    expect(boundedCooldownMs(undefined)).toBe(60_000);
    expect(boundedCooldownMs(0)).toBe(60_000);
  });
});
