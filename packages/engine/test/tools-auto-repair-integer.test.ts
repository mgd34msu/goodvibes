import { describe, expect, test } from 'bun:test';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { repairToolCall } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';

useToolReadings([]);

const schema = (type: 'integer' | 'number'): ToolDefinition => ({
  name: 'paged',
  description: 'A paged read.',
  parameters: { type: 'object', required: ['count'], properties: { count: { type } } },
});

describe('string to number repair', () => {
  test('a whole-number string is repaired for an integer parameter', async () => {
    const result = await repairToolCall('paged', { count: '3' }, schema('integer'));
    expect(result.repaired).toBe(true);
    expect(result.fixed['count']).toBe(3);
  });

  test('a fractional string is not turned into an integer', async () => {
    const result = await repairToolCall('paged', { count: '2.5' }, schema('integer'));
    expect(result.repaired).toBe(false);
    expect(result.fixed['count']).toBe('2.5');
  });

  for (const text of ['Infinity', '0x10', '1e3', '-Infinity']) {
    test(`${text} is left for the schema to refuse, for integer and number parameters`, async () => {
      for (const type of ['integer', 'number'] as const) {
        const result = await repairToolCall('paged', { count: text }, schema(type));
        expect(result.repaired).toBe(false);
        expect(result.fixed['count']).toBe(text);
      }
    });
  }

  test('a fractional string is still repaired for a number parameter', async () => {
    const result = await repairToolCall('paged', { count: '1.5' }, schema('number'));
    expect(result.fixed['count']).toBe(1.5);
  });
});

describe('string to number repair inside objects and array items', () => {
  const nested: ToolDefinition = {
    name: 'nested',
    description: 'Nested numbers.',
    parameters: {
      type: 'object',
      properties: {
        output: { type: 'object', properties: { max_tokens: { type: 'integer' } } },
        edits: {
          type: 'array',
          items: { type: 'object', properties: { hints: { type: 'object', properties: { near_line: { type: 'integer' } } } } },
        },
      },
    },
  };

  test('output.max_tokens and edits[].hints.near_line sent as whole-number strings are repaired', async () => {
    const result = await repairToolCall('nested', { output: { max_tokens: '3' }, edits: [{ hints: { near_line: '12' } }] }, nested);
    expect(result.repaired).toBe(true);
    expect(result.fixed['output']).toEqual({ max_tokens: 3 });
    expect(result.fixed['edits']).toEqual([{ hints: { near_line: 12 } }]);
  });

  test('a fractional string for a nested integer is left for the schema to refuse', async () => {
    const result = await repairToolCall('nested', { output: { max_tokens: '2.5' } }, nested);
    expect(result.fixed['output']).toEqual({ max_tokens: '2.5' });
  });
});
