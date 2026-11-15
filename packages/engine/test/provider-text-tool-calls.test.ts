import { describe, expect, test } from 'bun:test';
import {
  extractTextToolCalls,
  fromOpenAIToolCalls,
  parseToolCallArguments,
} from '../platform/src/platform/providers/tool-formats.ts';
import { assembleAnthropicContentBlocks } from '../platform/src/platform/providers/anthropic-sse-assembler.ts';

const KIMI_CALL = '<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a.txt"}<|tool_call_end|><|tool_calls_section_end|>';

describe('text-extracted tool calls', () => {
  test('the same response text yields different call ids in two responses', () => {
    const first = extractTextToolCalls(KIMI_CALL).toolCalls;
    const second = extractTextToolCalls(KIMI_CALL).toolCalls;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });

  test('calls inside one response keep distinct ids', () => {
    const two = KIMI_CALL.replace('<|tool_calls_section_end|>', '') + KIMI_CALL.replace('<|tool_calls_section_begin|>', '');
    const { toolCalls } = extractTextToolCalls(two);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.id).not.toBe(toolCalls[1]!.id);
  });
});

describe('tool call arguments', () => {
  test('a null argument string is a call with no arguments', () => {
    expect(parseToolCallArguments('null')).toEqual({});
    const calls = fromOpenAIToolCalls([{ id: 'c1', type: 'function', function: { name: 'ping', arguments: 'null' } }]);
    expect(calls).toEqual([{ id: 'c1', name: 'ping', arguments: {} }]);
  });

  test('JSON that is not an object never reaches a tool as its arguments', () => {
    for (const raw of ['[]', '"x"', '3', 'true']) {
      expect(parseToolCallArguments(raw)).toBeUndefined();
    }
  });

  test('arguments that cannot be read come back as a call carrying the reason, in every shape', () => {
    const calls = fromOpenAIToolCalls([{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"a":' } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'c1', name: 'ping', arguments: {} });
    expect(calls[0]?.argumentError).toContain("Tool call 'ping' was not run");
    const text = extractTextToolCalls('<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>[1]<|tool_call_end|><|tool_calls_section_end|>').toolCalls;
    expect(text[0]?.argumentError).toContain('not a JSON object');
    const sse = assembleAnthropicContentBlocks(new Map([[0, { id: 't1', name: 'read', args: '{"p' }], [1, { id: 't2', name: 'read', args: '{"p":1}' }]]), '', 'anthropic');
    expect(sse.toolCalls.map((call) => [call.id, call.argumentError === undefined])).toEqual([['t1', false], ['t2', true]]);
    expect(sse.toolCalls[1]?.arguments).toEqual({ p: 1 });
  });

  test('an object is returned as is', () => {
    expect(parseToolCallArguments('{"a":1}')).toEqual({ a: 1 });
  });
});
