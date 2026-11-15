/**
 * openai-provider-refusal.test.ts
 *
 * What a refused OpenAI chat request tells the retry loop: the wait the server
 * asked for, and that a spent account is a billing failure rather than a rate limit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../platform/src/platform/providers/openai.js';
import { ProviderError } from '../platform/src/platform/types/errors.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function refuse(body: unknown, headers: Record<string, string>): Promise<ProviderError> {
  // x-should-retry keeps the SDK from retrying on its own; aborting once the refusal is
  // served ends the provider's retry wait at once, so the first failure is the one thrown.
  const controller = new AbortController();
  globalThis.fetch = Object.assign(async () => {
    controller.abort();
    return new Response(JSON.stringify(body), {
      status: 429, headers: { 'content-type': 'application/json', 'x-should-retry': 'false', ...headers },
    });
  }, { preconnect() {} });
  const failure = await new OpenAIProvider('test-key').chat({
    messages: [{ role: 'user', content: 'hello' }], model: 'gpt-5.6', maxTokens: 64, signal: controller.signal,
  }).then(() => undefined, (error: unknown) => error);
  if (!(failure instanceof ProviderError)) throw new Error('the refused request did not fail with a ProviderError');
  return failure;
}

describe('a refused OpenAI chat request', () => {
  test('carries the wait the server asked for', async () => {
    const failure = await refuse({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '9' });
    expect(failure.statusCode).toBe(429);
    expect(failure.category).toBe('rate_limit');
    expect(failure.retryAfterMs).toBe(9000);
  });

  test('a 429 for a spent quota is a billing failure', async () => {
    const failure = await refuse({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, { 'retry-after': '9' });
    expect(failure.statusCode).toBe(429);
    expect(failure.category).toBe('billing');
  });
});
