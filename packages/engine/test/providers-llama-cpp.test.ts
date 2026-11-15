import { describe, expect, test } from 'bun:test';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import { LlamaCppProvider } from '../platform/src/platform/providers/llama-cpp.js';
import { ProviderError } from '../platform/src/platform/types/errors.js';

const TOOLS: ChatRequest['tools'] = [{
  name: 'analyze',
  description: 'Analyze code',
  parameters: { type: 'object', properties: { mode: { type: 'string' } } },
}];

const STREAMED: ChatResponse = { content: 'streamed', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };

/** A compat double that streams, or refuses every streamed request the way an older llama.cpp server does. */
function compat(mode: 'streams' | 'refuses-tools'): LLMProvider & { calls: number } {
  const double = {
    name: 'compat',
    models: ['qwen'],
    calls: 0,
    chat: async (): Promise<ChatResponse> => {
      double.calls += 1;
      if (mode === 'refuses-tools') {
        throw new ProviderError('Cannot use tools with stream', { statusCode: 500, provider: 'compat', operation: 'chat', phase: 'request' });
      }
      return STREAMED;
    },
  };
  return double;
}

// Each test uses its own server address: what a server does with streamed tool turns is remembered per server.
let port = 18_080;
function provider(compatProvider: LLMProvider, nativeFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): LlamaCppProvider {
  port += 1;
  return new LlamaCppProvider({
    name: 'llama.cpp', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '', defaultModel: 'qwen', models: ['qwen'],
    reasoningFormat: 'llamacpp', compatProvider, nativeFetch,
  });
}

describe('LlamaCppProvider', () => {
  test('a tool turn streams through the compat provider', async () => {
    const streaming = compat('streams');
    let buffered = 0;
    const llama = provider(streaming, async () => { buffered += 1; return Response.json({}); });
    const response = await llama.chat({ messages: [{ role: 'user', content: 'Analyze the repo' }], model: 'qwen', tools: TOOLS });
    expect(response.content).toBe('streamed');
    expect(streaming.calls).toBe(1);
    expect(buffered).toBe(0);
  });

  test('a server that refuses streamed tool requests is answered by the buffered request, and stays buffered for tool turns', async () => {
    const refusing = compat('refuses-tools');
    const bodies: Array<Record<string, unknown>> = [];
    const llama = provider(refusing, async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'analyze', arguments: '{"mode":"impact"}' } }] } }],
        usage: { prompt_tokens: 11, completion_tokens: 2 },
      });
    });
    const first = await llama.chat({ messages: [{ role: 'user', content: 'Analyze' }], model: 'qwen', tools: TOOLS, reasoningEffort: 'medium', maxRetries: 0 });
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'analyze', arguments: { mode: 'impact' } }]);
    expect(first.stopReason).toBe('tool_call');
    expect(bodies[0]).toMatchObject({ model: 'qwen', stream: false, enable_thinking: true });
    expect(llama.streamsToolTurns()).toBe(false);

    // Remembered: the next tool turn goes straight to the buffered request, with the streamed path's reasoning switch.
    await llama.chat({ messages: [{ role: 'user', content: 'Again' }], model: 'qwen', tools: TOOLS, reasoningEffort: 'none', maxRetries: 0 });
    expect(refusing.calls).toBe(1);
    expect(bodies[1]).toMatchObject({ stream: false, enable_thinking: false });
  });

  test('the buffered answer keeps inline reasoning out of the reply', async () => {
    const deltas: Array<{ content?: string | undefined; reasoning?: string | undefined }> = [];
    const llama = provider(compat('refuses-tools'), async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '<think>plan</think>Final answer' } }],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    }));
    const response = await llama.chat({
      messages: [
        { role: 'user', content: 'Analyze the repo' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'analyze', arguments: { mode: 'impact' } }] },
        { role: 'tool', callId: 'call-1', content: '{"summary":"ok"}' },
      ],
      model: 'qwen',
      maxRetries: 0,
      onDelta: (delta) => { deltas.push({ content: delta.content, reasoning: delta.reasoning }); },
    });
    expect(response.content).toBe('Final answer');
    expect(deltas).toEqual([{ content: undefined, reasoning: 'plan' }, { content: 'Final answer', reasoning: undefined }]);
  });

  for (const [finishReason, expected] of [['content_filter', 'content_filter'], ['eos_token', 'unknown']] as const) {
    test(`reports a ${finishReason} finish as ${expected}, not as a completed answer`, async () => {
      const llama = provider(compat('refuses-tools'), async () => Response.json({
        choices: [{ finish_reason: finishReason, message: { content: 'cut' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      const response = await llama.chat({
        messages: [
          { role: 'user', content: 'Analyze the repo' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'analyze', arguments: {} }] },
          { role: 'tool', callId: 'call-1', content: '{}' },
        ],
        model: 'qwen',
        maxRetries: 0,
      });
      expect(response.stopReason).toBe(expected);
    });
  }
});
