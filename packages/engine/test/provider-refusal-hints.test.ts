/**
 * provider-refusal-hints.test.ts
 *
 * What the Anthropic, Anthropic-compatible, Gemini, OpenAI-compatible and
 * OpenAI Codex adapters tell the retry loop: a stream that failed after text
 * reached the caller is not replayed, a refused request carries the wait the
 * server asked for, and a spent quota is a billing failure.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetModelLimitReadings } from '../platform/src/platform/routing/model-limit-readings.js';
import { AnthropicProvider } from '../platform/src/platform/providers/anthropic.js';
import { AnthropicCompatProvider } from '../platform/src/platform/providers/anthropic-compat.js';
import { GeminiProvider } from '../platform/src/platform/providers/gemini.js';
import { OpenAICompatProvider } from '../platform/src/platform/providers/openai-compat.js';
import { OpenAICodexProvider } from '../platform/src/platform/providers/openai-codex.js';
import type { ProviderSubscription, SubscriptionManager } from '../platform/src/platform/config/subscriptions.js';
import { ProviderError } from '../platform/src/platform/types/errors.js';

const originalFetch = globalThis.fetch;
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetModelLimitReadings();
  previousPort = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'output-64k', 0.95)).port);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  installJudgmentPort(previousPort);
  forgetModelLimitReadings();
});

const messages = [{ role: 'user' as const, content: 'hello' }];

function serve(make: () => Response, onCall?: () => void): void {
  globalThis.fetch = Object.assign(async () => { onCall?.(); return make(); }, { preconnect() {} });
}

// Ends before message_stop after a text delta: a retryable 502 from the stream reader.
function truncatedAnthropicStream(): Response {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Half"}}\n\n',
  ];
  return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const compat = () => new AnthropicCompatProvider({
  name: 'compat-fixture', baseURL: 'https://compat.example.test/v1', apiKey: 'k', defaultModel: 'm', models: ['m'],
});

async function failureOf(run: (signal: AbortSignal) => Promise<unknown>, abortOnServe: AbortController): Promise<ProviderError> {
  const failure = await run(abortOnServe.signal).then(() => undefined, (error: unknown) => error);
  if (!(failure instanceof ProviderError)) throw new Error('the request did not fail with a ProviderError');
  return failure;
}

describe('a stream that fails after text reached the caller is not retried', () => {
  test.each([
    ['anthropic', () => new AnthropicProvider('test-key'), 'claude-sonnet-4-6'],
    ['anthropic-compat', compat, 'm'],
  ] as const)('%s', async (_name, make, model) => {
    let calls = 0;
    let retries = 0;
    serve(truncatedAnthropicStream, () => { calls += 1; });
    const delivered: string[] = [];
    await expect(make().chat({
      messages, model, maxTokens: 64,
      onDelta: (delta) => { if (delta.content) delivered.push(delta.content); },
      onRetry: () => { retries += 1; },
    })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(retries).toBe(0);
    expect(delivered).toEqual(['Half']);
  });
});

describe('a refused request carries the wait the server asked for', () => {
  // Aborting once the refusal is served ends the retry wait at once, so the first failure is the one thrown.
  function refuse(headers: Record<string, string>, body = '{"error":{"message":"slow down"}}'): AbortController {
    const controller = new AbortController();
    serve(() => new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'x-should-retry': 'false', ...headers } }), () => controller.abort());
    return controller;
  }

  test('anthropic-compat', async () => {
    const controller = refuse({ 'retry-after': '7' });
    const failure = await failureOf((signal) => compat().chat({ messages, model: 'm', maxTokens: 64, signal }), controller);
    expect(failure.statusCode).toBe(429);
    expect(failure.retryAfterMs).toBe(7000);
  });

  test('gemini', async () => {
    const controller = refuse({ 'retry-after': '6' });
    const failure = await failureOf((signal) => new GeminiProvider('test-key').chat({ messages, model: 'gemini-2.5-flash', maxTokens: 64, signal }), controller);
    expect(failure.statusCode).toBe(429);
    expect(failure.retryAfterMs).toBe(6000);
  });

  test('openai-compat, and a spent quota is a billing failure', async () => {
    const make = () => new OpenAICompatProvider({ name: 'compat-fixture', baseURL: 'https://compat.example.test/v1', apiKey: 'k', defaultModel: 'm', models: ['m'] });
    const rate = refuse({ 'retry-after': '9' }, '{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}');
    const limited = await failureOf((signal) => make().chat({ messages, model: 'm', maxTokens: 64, signal }), rate);
    expect(limited.statusCode).toBe(429);
    expect(limited.retryAfterMs).toBe(9000);
    expect(limited.category).toBe('rate_limit');

    const spent = refuse({ 'retry-after': '9' }, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}');
    const billing = await failureOf((signal) => make().chat({ messages, model: 'm', maxTokens: 64, signal }), spent);
    expect(billing.category).toBe('billing');
  });

  test('openai codex', async () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url');
    const record = {
      provider: 'openai', accessToken: `h.${payload}.s`, refreshToken: 'r', tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000, authMode: 'oauth', createdAt: 1, updatedAt: 1,
    } as ProviderSubscription;
    const manager = {
      get: () => record, saveSubscription: (next: ProviderSubscription) => next, resolveAccessToken: async () => record.accessToken,
    } as unknown as Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>;
    const controller = refuse({ 'retry-after': '5' }, 'slow down');
    const failure = await failureOf((signal) => new OpenAICodexProvider(manager).chat({ messages, model: 'gpt-5.6-sol', maxTokens: 16, signal }), controller);
    expect(failure.statusCode).toBe(429);
    expect(failure.retryAfterMs).toBe(5000);
  });
});
