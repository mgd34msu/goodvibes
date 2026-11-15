/**
 * Chaos: provider failures through the real provider transport.
 *
 * A provider that answers 429, 5xx, or never answers must be retried a bounded
 * number of times and then fail with the status the caller can act on; one that
 * recovers part way through must deliver its answer. The provider's own `chat`
 * runs here against a fake `fetch`, so no network is involved and the backoff
 * delay is zeroed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicCompatProvider } from '../platform/src/platform/providers/anthropic-compat.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = 'https://provider-failures.invalid/v1';

const SSE_BODY = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}',
  '',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

/**
 * Answers only requests aimed at BASE_URL: `globalThis.fetch` is process-wide and
 * other work in the same process must not be counted or handed this file's replies.
 */
function installFetch(respond: (attempt: number) => Response | Promise<Response>): { readonly count: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(BASE_URL)) return new Response('not this test\'s request', { status: 404 });
    calls += 1;
    return respond(calls);
  }) as typeof fetch;
  return { count: () => calls };
}

function makeProvider(name: string): AnthropicCompatProvider {
  return new AnthropicCompatProvider({
    name,
    baseURL: BASE_URL,
    apiKey: 'test-key',
    defaultModel: 'test-model',
    models: ['test-model'],
    retryConfig: { initialDelayMs: 0, maxDelayMs: 0 },
  });
}

async function chat(provider: AnthropicCompatProvider, retries: number[]) {
  return provider.chat({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    onRetry: (attempt) => { retries.push(attempt); },
  });
}

describe('chaos: provider failures', () => {
  test('a provider that keeps answering 429 is retried a bounded number of times, then fails with the 429', async () => {
    const fetched = installFetch(() => new Response('slow down', { status: 429 }));
    const retries: number[] = [];

    await expect(chat(makeProvider('rate-limited'), retries)).rejects.toMatchObject({ statusCode: 429 });

    // One first try plus three retries; an unbounded loop would never get here.
    expect(fetched.count()).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
  });

  test('a provider that keeps answering 5xx is retried a bounded number of times, then fails with the 5xx', async () => {
    const fetched = installFetch(() => new Response('upstream broke', { status: 503 }));
    const retries: number[] = [];

    await expect(chat(makeProvider('server-error'), retries)).rejects.toMatchObject({ statusCode: 503 });

    expect(fetched.count()).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
  });

  test('a provider that fails twice and then answers delivers the answer', async () => {
    const fetched = installFetch((attempt) => attempt === 1
      ? new Response('slow down', { status: 429 })
      : attempt === 2
        ? new Response('upstream broke', { status: 502 })
        : new Response(SSE_BODY, { status: 200 }));
    const retries: number[] = [];

    const response = await chat(makeProvider('recovering'), retries);

    expect(response.content).toBe('recovered');
    expect(fetched.count()).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  test('a provider that times out reaches the caller as the timeout, not as an empty answer', async () => {
    installFetch(() => {
      const timeout = new Error('The operation timed out');
      timeout.name = 'TimeoutError';
      throw timeout;
    });

    await expect(chat(makeProvider('timing-out'), [])).rejects.toThrow('The operation timed out');
  });

  test('a failure that cannot succeed on retry is not retried', async () => {
    const fetched = installFetch(() => new Response('bad key', { status: 401 }));
    const retries: number[] = [];

    await expect(chat(makeProvider('rejected-key'), retries)).rejects.toMatchObject({ statusCode: 401 });

    expect(fetched.count()).toBe(1);
    expect(retries).toEqual([]);
  });
});
