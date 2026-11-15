import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetModelLimitReadings } from '../platform/src/platform/routing/model-limit-readings.js';
import { AnthropicProvider } from '../platform/src/platform/providers/anthropic.js';
import {
  extractTextToolCalls,
  fromOpenAIToolCalls,
} from '../platform/src/platform/providers/tool-formats.js';


/** routing.anthropic-output-cap reads every model id into the 64K row, so request bodies can be built. */
let previousOutputCapPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetModelLimitReadings();
  previousOutputCapPort = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'output-64k', 0.95)).port);
});
afterEach(() => {
  installJudgmentPort(previousOutputCapPort);
  forgetModelLimitReadings();
});

describe('provider streamed tool argument parsing', () => {
  test('keeps a malformed OpenAI call with an argument error the model can repair', () => {
    const toolCalls = fromOpenAIToolCalls([
      {
        id: 'call-bad',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":' },
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ id: 'call-bad', name: 'read_file', arguments: {} });
    expect(toolCalls[0]?.argumentError).toContain("Tool call 'read_file' was not run");
  });

  test('keeps valid OpenAI accumulated arguments', () => {
    const toolCalls = fromOpenAIToolCalls([
      {
        id: 'call-ok',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        id: 'call-ok',
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    ]);
  });

  test('keeps a malformed text-delimited call with an argument error', () => {
    const parsed = extractTextToolCalls(
      '<|toolcallbegin|>functions.read_file:0<|toolcallargumentbegin|>{"path":<|toolcallend|>',
    );

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({ name: 'read_file', arguments: {} });
    expect(parsed.toolCalls[0]?.argumentError).toContain("Tool call 'read_file' was not run");
  });

  test('keeps a malformed Anthropic streamed input_json_delta call with an argument error', async () => {
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-bad","name":"read_file"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(sse, { status: 200 })) as typeof globalThis.fetch;
    try {
      const provider = new AnthropicProvider('test-key');
      const response = await provider.chat({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'read' }],
        tools: [{
          name: 'read_file',
          description: 'read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        }],
      });

      expect(response.stopReason).toBe('tool_call');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]).toMatchObject({ id: 'call-bad', name: 'read_file', arguments: {} });
      expect(response.toolCalls[0]?.argumentError).toContain("Tool call 'read_file' was not run");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
