import { describe, expect, test } from 'bun:test';
import { OllamaProvider } from '@goodvibes-jev/engine/platform/platform/providers';
import { ProviderError } from '@goodvibes-jev/engine/platform/platform/types';
import type { StreamDelta } from '@goodvibes-jev/engine/platform/platform/providers';

function ndjson(lines: Record<string, unknown>[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

function providerFor(body: string, calls?: { count: number }): OllamaProvider {
  return new OllamaProvider({
    name: 'Ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    defaultModel: 'qwen3',
    models: ['qwen3'],
    nativeFetch: async () => {
      if (calls) calls.count += 1;
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
}

/** A retryable failure would otherwise sit out a real backoff: aborting at the first retry ends the wait at once. */
function failFast(): { signal: AbortSignal; onRetry: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, onRetry: () => controller.abort() };
}

const readTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {}, required: [] } };

describe('native Ollama streaming', () => {
  test('parallel tool calls streamed in separate chunks are all kept with distinct ids', async () => {
    const provider = providerFor(ndjson([
      { message: { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: { path: 'a.md' } } }] }, done: false },
      { message: { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: { path: 'b.md' } } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 },
    ]));
    const deltas: StreamDelta[] = [];
    const response = await provider.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'read both' }],
      tools: [readTool],
      onDelta: (delta) => { deltas.push(delta); },
    });
    expect(response.toolCalls).toEqual([
      { id: expect.stringMatching(/^ollama_call_[0-9a-f]{8}_0$/), name: 'read', arguments: { path: 'a.md' } },
      { id: expect.stringMatching(/^ollama_call_[0-9a-f]{8}_1$/), name: 'read', arguments: { path: 'b.md' } },
    ]);
    expect(response.stopReason).toBe('tool_call');
    const announced = deltas.flatMap((delta) => delta.toolCalls ?? []).map((call) => [call.index, call.id]);
    expect(announced).toEqual([[0, response.toolCalls[0]!.id], [1, response.toolCalls[1]!.id]]);
  });

  test('a stream that ends without its final chunk is an error, not a finished turn', async () => {
    const calls = { count: 0 };
    const provider = providerFor(ndjson([
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
    ]), calls);
    const retry = failFast();
    await expect(provider.chat({ model: 'qwen3', messages: [{ role: 'user', content: 'hi' }], ...retry })).rejects.toThrow('before the final chunk');
    expect(calls.count).toBe(1);
  });

  test('a stream cut after text was delivered is not retried into a duplicate answer', async () => {
    const calls = { count: 0 };
    const provider = providerFor(ndjson([
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
    ]), calls);
    const delivered: string[] = [];
    let retries = 0;
    await expect(provider.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta: StreamDelta) => { if (delta.content) delivered.push(delta.content); },
      onRetry: () => { retries += 1; },
    })).rejects.toThrow('before the final chunk');
    expect(calls.count).toBe(1);
    expect(retries).toBe(0);
    expect(delivered).toEqual(['Hel', 'lo']);
  });

  test('an error line in the stream rejects with the server message', async () => {
    const provider = providerFor(ndjson([
      { message: { role: 'assistant', content: 'partial' }, done: false },
      { error: 'model runner has unexpectedly stopped' },
    ]));
    const retry = failFast();
    await expect(provider.chat({ model: 'qwen3', messages: [{ role: 'user', content: 'hi' }], ...retry })).rejects.toThrow('model runner has unexpectedly stopped');
  });

  test('after falling back, the compat provider alone owns retrying its failures', async () => {
    let compatCalls = 0;
    const provider = new OllamaProvider({
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      nativeFetch: async () => new Response('not found', { status: 404 }),
      compatProvider: {
        name: 'compat',
        models: ['qwen3'],
        chat: async () => {
          compatCalls += 1;
          throw new ProviderError('compat unavailable', 503);
        },
      },
    });
    const retry = failFast();
    let outerRetries = 0;
    await expect(provider.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      signal: retry.signal,
      onRetry: () => { outerRetries += 1; retry.onRetry(); },
    })).rejects.toThrow('compat unavailable');
    expect(compatCalls).toBe(1);
    expect(outerRetries).toBe(0);
  });
});
