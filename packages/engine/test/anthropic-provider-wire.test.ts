/**
 * anthropic-provider-wire.test.ts
 *
 * What the Anthropic provider puts on the wire: where the stable-prefix cache
 * breakpoint lands, how a cancelling batch is reported, and where the API key
 * is allowed to go when results are fetched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetModelLimitReadings } from '../platform/src/platform/routing/model-limit-readings.js';
import { AnthropicProvider } from '../platform/src/platform/providers/anthropic.js';
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

function sseBody(): ReadableStream<Uint8Array> {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

describe('stable-prefix cache breakpoint', () => {
  async function send(systemPrompt: string | undefined, toolText = 'first tool'): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    await new AnthropicProvider('test-key').chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-6',
      ...(systemPrompt ? { systemPrompt } : {}),
      tools: [
        { name: 'one', description: toolText, parameters: { type: 'object', properties: {} } },
        { name: 'two', description: 'second tool', parameters: { type: 'object', properties: {} } },
      ],
      maxTokens: 64,
    });
    return body!;
  }

  test('sits on the last system block so it covers the tools and the system prompt', async () => {
    const body = await send('You are a careful assistant. '.repeat(400));
    const system = body['system'] as Array<Record<string, unknown>>;
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(system.at(-1)!['cache_control']).toBeDefined();
    expect(tools.some((tool) => tool['cache_control'] !== undefined)).toBe(false);
  });

  test('with no system prompt it falls back to the last tool', async () => {
    const body = await send(undefined, 'a large tool description. '.repeat(300));
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]!['cache_control']).toBeUndefined();
    expect(tools[1]!['cache_control']).toBeDefined();
    expect(body['system']).toBeUndefined();
  });
});

describe('a refused chat request', () => {
  test('carries the wait the server asked for', async () => {
    // Aborting once the refusal is served ends the retry wait at once, so the first failure is the one thrown.
    const controller = new AbortController();
    globalThis.fetch = Object.assign(async () => {
      controller.abort();
      return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', {
        status: 429, headers: { 'retry-after': '7' },
      });
    }, { preconnect() {} });
    const failure = await new AnthropicProvider('test-key').chat({
      messages: [{ role: 'user', content: 'hello' }], model: 'claude-sonnet-4-6', maxTokens: 64, signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error);
    if (!(failure instanceof ProviderError)) throw new Error('the refused request did not fail with a ProviderError');
    expect(failure.statusCode).toBe(429);
    expect(failure.retryAfterMs).toBe(7000);
  });
});

describe('batches', () => {
  function provider(): AnthropicProvider {
    return new AnthropicProvider('test-key');
  }

  test('a batch that is cancelling is still running; it is cancelled only once it has ended', async () => {
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ id: 'b1', processing_status: 'canceling' }), { status: 200 }), { preconnect() {} });
    const batch = provider().batch!;
    expect((await batch.cancelBatch!('b1')).status).toBe('running');
    expect((await batch.retrieveBatch('b1')).status).toBe('running');

    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
      id: 'b1', processing_status: 'ended', cancel_initiated_at: '2026-01-01T00:00:00Z', results_url: 'https://api.anthropic.com/v1/messages/batches/b1/results',
    }), { status: 200 }), { preconnect() {} });
    const ended = await batch.retrieveBatch('b1');
    expect(ended.status).toBe('completed');
    expect(ended.resultAvailable).toBe(true);
  });

  test('results are fetched from the API origin with the key', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url: String(url), key: headers['x-api-key'] });
      if (String(url).endsWith('/results')) {
        return new Response('{"custom_id":"a","result":{"type":"canceled"}}\n', { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'b1', processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/b1/results' }), { status: 200 });
    }) as typeof globalThis.fetch;
    const results = await provider().batch!.getResults('b1');
    expect(results.map((r) => [r.customId, r.status])).toEqual([['a', 'cancelled']]);
    expect(seen.at(-1)).toEqual({ url: 'https://api.anthropic.com/v1/messages/batches/b1/results', key: 'test-key' });
  });

  test('every result kind maps to its own status, with usage, tool calls and a labelled bad line', async () => {
    const lines = [
      { custom_id: 'ok', result: { type: 'succeeded', message: {
        content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      } } },
      { custom_id: 'bad', result: { type: 'errored', error: { type: 'invalid_request_error', message: 'nope' } } },
      { custom_id: 'late', result: { type: 'expired' } },
    ].map((line) => JSON.stringify(line));
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/results')) return new Response([...lines, 'not json'].join('\n'), { status: 200 });
      return new Response(JSON.stringify({ id: 'b1', processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/b1/results' }), { status: 200 });
    }) as typeof globalThis.fetch;
    const results = await provider().batch!.getResults('b1');
    expect(results).toHaveLength(4);
    const [ok, bad, late, garbled] = results;
    expect(ok!.status).toBe('succeeded');
    expect(ok!.response).toMatchObject({
      content: 'hello',
      toolCalls: [{ id: 'tu1', name: 'lookup', arguments: { q: 1 } }],
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 },
      providerStopReason: 'tool_use',
    });
    expect(bad).toMatchObject({ customId: 'bad', status: 'failed', error: { message: 'nope', code: 'invalid_request_error' } });
    expect(late).toMatchObject({ customId: 'late', status: 'expired' });
    expect(late!.error?.message).toContain('expired');
    expect(garbled!.status).toBe('failed');
    expect(garbled!.customId.startsWith('unparseable:')).toBe(true);
    expect(garbled!.raw).toBe('not json');
  });

  test('a results_url on another host is refused and the key never goes there', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ id: 'b1', processing_status: 'ended', results_url: 'https://evil.example.net/results' }), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(provider().batch!.getResults('b1')).rejects.toThrow('results_url points outside the Anthropic API');
    expect(seen.some((url) => url.includes('evil.example.net'))).toBe(false);
  });
});
