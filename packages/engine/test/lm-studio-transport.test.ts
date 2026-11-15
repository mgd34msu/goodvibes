/** LM Studio transport: bounded native-chat memory, truncated streams are errors, no restarted answers. */
import { describe, expect, test } from 'bun:test';
import { LMStudioProvider } from '../platform/src/platform/providers/lm-studio.js';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderMessage } from '../platform/src/platform/providers/interface.js';
import { llmRequestsTotal } from '../platform/src/platform/runtime/metrics.js';
import type { LMStudioResponsesClient } from '../platform/src/platform/providers/lm-studio-helpers.js';

type Internals = {
  nativeResponseIds: Map<string, string>;
  rememberNativeResponse(model: string, systemPrompt: string | undefined, messages: ProviderMessage[], content: string, id: string | undefined): void;
  getNativeChatContext(model: string, systemPrompt: string | undefined, messages: ProviderMessage[], tools: undefined): { previousResponseId?: string } | null;
  chatViaResponses(params: ChatRequest, model: string): Promise<ChatResponse>;
};

const compatStub = (onChat: (params: ChatRequest) => void = () => undefined): LLMProvider => ({
  name: 'lm',
  models: ['m'],
  chat: async (params) => {
    onChat(params);
    return { content: 'compat', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'completed' };
  },
});

function provider(options: { responses?: LMStudioResponsesClient; nativeFetch?: typeof fetch; compat?: LLMProvider } = {}) {
  return new LMStudioProvider({
    name: 'lm',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    defaultModel: 'm',
    models: ['m'],
    compatProvider: options.compat ?? compatStub(),
    ...(options.responses ? { responsesClient: options.responses } : {}),
    ...(options.nativeFetch ? { nativeFetch: options.nativeFetch } : {}),
  });
}

const responsesClient = (events: unknown[]): LMStudioResponsesClient => ({
  create: async () => (async function* () { yield* events; })(),
});

const userMessage = (content: string): ProviderMessage => ({ role: 'user', content });

describe('native chat response ids', () => {
  test('stay bounded in count and key size across a long conversation, and still resolve the latest turn', () => {
    const lm = provider();
    const internals = lm as unknown as Internals;
    const history: ProviderMessage[] = [];
    for (let turn = 0; turn < 300; turn++) {
      history.push(userMessage(`${turn}:${'x'.repeat(5_000)}`));
      internals.rememberNativeResponse('m', 'sys', [...history], 'ok', `resp-${turn}`);
      history.push({ role: 'assistant', content: 'ok' });
    }
    expect(internals.nativeResponseIds.size).toBeLessThanOrEqual(256);
    let keyBytes = 0;
    for (const key of internals.nativeResponseIds.keys()) keyBytes += key.length;
    expect(keyBytes).toBeLessThan(256 * 128);
    const next = [...history, userMessage('next')];
    expect(internals.getNativeChatContext('m', 'sys', next, undefined)?.previousResponseId).toBe('resp-299');
  });
});

describe('Responses stream', () => {
  test('ending before response.completed throws instead of returning the partial text as complete', async () => {
    const lm = provider({
      responses: responsesClient([
        { type: 'response.output_text.delta', delta: 'The answ' },
        { type: 'response.output_text.delta', delta: 'er is' },
      ]),
    });
    await expect((lm as unknown as Internals).chatViaResponses({ model: 'm', messages: [userMessage('q')] }, 'm'))
      .rejects.toMatchObject({ phase: 'stream' });
  });

  test('a completed stream returns its text and usage', async () => {
    const lm = provider({
      responses: responsesClient([
        { type: 'response.output_text.delta', delta: 'done' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } },
      ]),
    });
    const response = await (lm as unknown as Internals).chatViaResponses({ model: 'm', messages: [userMessage('q')] }, 'm');
    expect(response.content).toBe('done');
    expect(response.usage.outputTokens).toBe(2);
    expect(response.stopReason).toBe('completed');
  });

  for (const [reason, expected] of [['content_filter', 'content_filter'], ['max_output_tokens', 'max_tokens'], [undefined, 'max_tokens'], ['something_new', 'unknown']] as const) {
    test(`an incomplete response (${reason ?? 'no reason given'}) reports ${expected}`, async () => {
      const lm = provider({
        responses: responsesClient([
          { type: 'response.output_text.delta', delta: 'cut' },
          { type: 'response.incomplete', response: { status: 'incomplete', ...(reason ? { incomplete_details: { reason } } : {}) } },
        ]),
      });
      const response = await (lm as unknown as Internals).chatViaResponses({ model: 'm', messages: [userMessage('q')] }, 'm');
      expect(response.stopReason).toBe(expected);
    });
  }

  test('a tool call with malformed arguments is returned with the reason, not dropped', async () => {
    const lm = provider({
      responses: responsesClient([
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{not json' } },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    });
    const response = await (lm as unknown as Internals).chatViaResponses({ model: 'm', messages: [userMessage('q')] }, 'm');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ id: 'c1', name: 'read', arguments: {} });
    expect(response.toolCalls[0]?.argumentError).toContain('not valid JSON');
  });
});

describe('failure after streamed text', () => {
  test('does not start the answer again on another API', async () => {
    let responsesCalls = 0;
    const sse = [
      'event: message.delta\ndata: {"content":"partial "}\n\n',
      'event: error\ndata: {"error":{"message":"model unloaded"}}\n\n',
    ].join('');
    const lm = provider({
      nativeFetch: (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch,
      responses: { create: async () => { responsesCalls++; return responsesClient([])  .create({}); } },
    });
    const deltas: string[] = [];
    await expect(lm.chat({
      model: 'm',
      messages: [userMessage('q')],
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
    })).rejects.toThrow('model unloaded');
    expect(deltas).toEqual(['partial ']);
    expect(responsesCalls).toBe(0);
  });
});

describe('retry after streamed text', () => {
  const tools = [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }];

  test('a retryable failure after a delta is final and the answer is not delivered twice', async () => {
    let calls = 0;
    const retries: number[] = [];
    const lm = provider({
      responses: {
        create: async () => {
          calls++;
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'partial ' };
            throw Object.assign(new Error('upstream dropped'), { statusCode: 502 });
          })();
        },
      },
    });
    const deltas: string[] = [];
    await expect(lm.chat({
      model: 'm',
      messages: [userMessage('q')],
      tools,
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
      onRetry: (attempt) => { retries.push(attempt); },
    })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(deltas).toEqual(['partial ']);
    expect(retries).toEqual([]);
  });
});

describe('delegation to the compat provider', () => {
  test('a 404 from the Responses API hands the original request to the compat provider once', async () => {
    const seen: ChatRequest[] = [];
    const lm = provider({
      compat: compatStub((params) => seen.push(params)),
      responses: { create: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); } },
    });
    const request: ChatRequest = { model: 'm', messages: [userMessage('q')], tools: [{ name: 't', description: 'd', parameters: {} }] };
    const response = await lm.chat(request);
    expect(response.content).toBe('compat');
    expect(seen).toEqual([request]);
  });

  test('the handover is recorded as neither a success nor an error by the wrapper', async () => {
    const lm = provider({
      responses: { create: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); } },
    });
    const before = llmRequestsTotal.total({ provider: 'lm', status: 'success' });
    const errorsBefore = llmRequestsTotal.total({ provider: 'lm', status: 'error' });
    const response = await lm.chat({ model: 'm', messages: [userMessage('q')], tools: [{ name: 't', description: 'd', parameters: {} }] });
    expect(response.content).toBe('compat');
    expect(llmRequestsTotal.total({ provider: 'lm', status: 'success' })).toBe(before);
    expect(llmRequestsTotal.total({ provider: 'lm', status: 'error' })).toBe(errorsBefore);
  });

  test('a retryable compat failure is attempted once by the wrapper, not once per wrapper retry', async () => {
    let compatCalls = 0;
    const lm = provider({
      compat: {
        name: 'lm',
        models: ['m'],
        chat: async () => {
          compatCalls++;
          throw Object.assign(new Error('bad gateway'), { statusCode: 502 });
        },
      },
      responses: { create: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); } },
    });
    await expect(lm.chat({ model: 'm', messages: [userMessage('q')], tools: [{ name: 't', description: 'd', parameters: {} }] })).rejects.toThrow();
    expect(compatCalls).toBe(1);
  });
});
