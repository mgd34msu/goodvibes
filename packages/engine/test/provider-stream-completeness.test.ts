import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../platform/src/platform/providers/openai.js';
import { OpenAICodexProvider } from '../platform/src/platform/providers/openai-codex.js';
import { accumOpenAIToolCall, finalizeOpenAIToolCalls, resolveOpenAIToolCallsAndFallback, type OpenAIToolCallSlot } from '../platform/src/platform/providers/openai-stream-helpers.js';
import { ProviderError } from '../platform/src/platform/types/errors.js';
import type { ProviderSubscription, SubscriptionManager } from '../platform/src/platform/config/subscriptions.js';

/** A retryable failure would otherwise sit out a real backoff: aborting at the first retry ends the wait at once. */
function failFast(): { signal: AbortSignal; onRetry: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, onRetry: () => controller.abort() };
}

function openAIWithStream(open: () => Promise<{ data: AsyncIterable<unknown>; response: Response }>): OpenAIProvider {
  const provider = new OpenAIProvider('test-key');
  const client = { chat: { completions: { create: () => ({ withResponse: open }) } } };
  (provider as unknown as { openaiClient: Promise<unknown> }).openaiClient = Promise.resolve(client);
  return provider;
}

async function* chunks(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const finish = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const request = { model: 'gpt-5', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('OpenAI chat stream', () => {
  test('a stream cut before its finish reason is an error, not a completed answer', async () => {
    const provider = openAIWithStream(async () => ({ data: chunks(text('Half an ans')), response: new Response('') }));
    await expect(provider.chat({ ...request, ...failFast() })).rejects.toThrow('without a finish reason');
  });

  test('a stream that finishes normally completes', async () => {
    const provider = openAIWithStream(async () => ({ data: chunks(text('Done.'), finish('stop')), response: new Response('') }));
    const response = await provider.chat(request);
    expect(response).toMatchObject({ content: 'Done.', stopReason: 'completed' });
  });

  test('a failure before the stream opens is labelled a request error', async () => {
    const provider = openAIWithStream(async () => { throw Object.assign(new Error('bad key'), { status: 401 }); });
    const error = await provider.chat(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).phase).toBe('request');
  });

  test('a failure while reading the stream is labelled a stream error', async () => {
    const provider = openAIWithStream(async () => ({
      data: (async function* () { yield text('x'); throw Object.assign(new Error('reset'), { status: 400 }); })(),
      response: new Response(''),
    }));
    const error = await provider.chat(request).catch((caught: unknown) => caught);
    expect((error as ProviderError).phase).toBe('stream');
  });

  test('a stream that fails after text reached the caller is not retried', async () => {
    let opened = 0;
    let retries = 0;
    const provider = openAIWithStream(async () => {
      opened += 1;
      return {
        data: (async function* () { yield text('Half'); throw Object.assign(new Error('overloaded'), { status: 503 }); })(),
        response: new Response(''),
      };
    });
    const delivered: string[] = [];
    await expect(provider.chat({
      ...request,
      onDelta: (delta) => { if (delta.content) delivered.push(delta.content); },
      onRetry: () => { retries += 1; },
    })).rejects.toThrow();
    expect(opened).toBe(1);
    expect(retries).toBe(0);
    expect(delivered).toEqual(['Half']);
  });
});

describe('tool-call slots without an index', () => {
  test('parallel calls from a server that omits index stay separate', () => {
    const acc = new Map<number, OpenAIToolCallSlot>();
    accumOpenAIToolCall(acc, { id: 'call_a', function: { name: 'read', arguments: '{"path":' } }, undefined);
    accumOpenAIToolCall(acc, { function: { arguments: '"a"}' } }, undefined);
    accumOpenAIToolCall(acc, { id: 'call_b', function: { name: 'read', arguments: '{"path":"b"}' } }, undefined);
    expect(finalizeOpenAIToolCalls(acc).map((call) => [call.id, call.function.arguments])).toEqual([
      ['call_a', '{"path":"a"}'],
      ['call_b', '{"path":"b"}'],
    ]);
  });

  test('name-bearing deltas with neither index nor id open separate calls', () => {
    const acc = new Map<number, OpenAIToolCallSlot>();
    accumOpenAIToolCall(acc, { function: { name: 'read', arguments: '{"path":"a"}' } }, undefined);
    accumOpenAIToolCall(acc, { function: { name: 'write', arguments: '{"path":"b"}' } }, undefined);
    expect(finalizeOpenAIToolCalls(acc).map((call) => [call.function.name, call.function.arguments])).toEqual([
      ['read', '{"path":"a"}'],
      ['write', '{"path":"b"}'],
    ]);
  });

  test('an explicit index still decides the slot', () => {
    const acc = new Map<number, OpenAIToolCallSlot>();
    accumOpenAIToolCall(acc, { index: 1, id: 'call_b', function: { name: 'x', arguments: '{}' } }, undefined);
    accumOpenAIToolCall(acc, { index: 0, id: 'call_a', function: { name: 'y', arguments: '{}' } }, undefined);
    expect(finalizeOpenAIToolCalls(acc).map((call) => call.id)).toEqual(['call_a', 'call_b']);
  });
});

describe('text tool-call fallback', () => {
  test('a model that writes its call as text still yields the call and a tool_call stop', () => {
    const text = 'Looking. <|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a"}<|tool_call_end|>';
    const resolved = resolveOpenAIToolCallsAndFallback([], text, 'completed', 'stop');
    expect(resolved.toolCalls.map((call) => call.name)).toEqual(['read']);
    expect(resolved.stopReason).toBe('tool_call');
  });

  test('plain text is left as it is', () => {
    const resolved = resolveOpenAIToolCallsAndFallback([], 'Hello', 'completed', 'stop');
    expect(resolved).toMatchObject({ toolCalls: [], responseText: 'Hello', stopReason: 'completed' });
  });
});

function fakeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url');
  return `h.${payload}.sig`;
}

function codexProvider(): OpenAICodexProvider {
  const record = {
    provider: 'openai', accessToken: fakeJwt(), refreshToken: 'refresh', tokenType: 'Bearer',
    expiresAt: Date.now() + 3_600_000, authMode: 'oauth', createdAt: Date.now(), updatedAt: Date.now(),
  } as ProviderSubscription;
  return new OpenAICodexProvider({
    get: (provider: string) => (provider === 'openai' ? record : null),
    saveSubscription: (next: ProviderSubscription) => next,
    resolveAccessToken: async () => record.accessToken,
  } as unknown as Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>);
}

function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const completed = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OpenAI Codex responses', () => {
  test('consecutive turns of one provider share the prompt cache key', async () => {
    const keys: unknown[] = [];
    const sessions: Array<string | null> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push((JSON.parse(String(init?.body)) as Record<string, unknown>)['prompt_cache_key']);
      sessions.push(new Headers(init?.headers).get('session_id'));
      return sse(completed);
    }) as typeof fetch;
    const provider = codexProvider();
    await provider.chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'one' }] });
    await provider.chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'two' }] });
    expect(typeof keys[0]).toBe('string');
    expect(keys[1]).toBe(keys[0]);
    expect(sessions).toEqual([keys[0] as string, keys[0] as string]);
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push((JSON.parse(String(init?.body)) as Record<string, unknown>)['prompt_cache_key']);
      return sse(completed);
    }) as typeof fetch;
    await codexProvider().chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'other' }] });
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('an incomplete response stopped by the content filter is not reported as truncation', async () => {
    globalThis.fetch = Object.assign(async () => sse(
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 1, output_tokens: 1 } } },
    ), { preconnect: realFetch.preconnect });
    const response = await codexProvider().chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }] });
    expect(response.stopReason).toBe('content_filter');
  });

  test('an incomplete response that hit the output limit is truncation', async () => {
    globalThis.fetch = Object.assign(async () => sse(
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } },
    ), { preconnect: realFetch.preconnect });
    const response = await codexProvider().chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }] });
    expect(response.stopReason).toBe('max_tokens');
  });

  test('a tool call whose arguments cannot be read comes back carrying the reason instead of vanishing', async () => {
    globalThis.fetch = Object.assign(async () => sse(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path": ' } },
      completed,
    ), { preconnect: realFetch.preconnect });
    const response = await codexProvider().chat({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], ...failFast() });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'read', arguments: {} });
    expect(response.toolCalls[0]?.argumentError).toContain("Tool call 'read' was not run");
  });
});
