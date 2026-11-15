import { describe, expect, test } from 'bun:test';
import type { OperatorContractManifest, OperatorMethodContract } from '../contracts/src/types.ts';
import { consumedIdsFor, render as renderHomeAssistant } from '../scripts/generate-homeassistant-client.ts';
import { buildDisposition } from '../scripts/generate-webui-facade.ts';

function method(overrides: Record<string, unknown>): OperatorMethodContract {
  return {
    id: 'homeassistant.sample', transport: ['http'], http: { method: 'POST', path: '/api/sample' },
    inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} },
    ...overrides,
  } as unknown as OperatorMethodContract;
}

function contractOf(...methods: OperatorMethodContract[]): OperatorContractManifest {
  return { product: { version: '0.0.0' }, operator: { methods } } as unknown as OperatorContractManifest;
}

const baseIds = [
  'control.status', 'channels.tools.surface.list', 'channels.agent_tools.surface.list',
  'channels.tools.invoke', 'channels.actions.invoke', 'tasks.get', 'tasks.cancel', 'tasks.status',
];
const fillers = baseIds.map((id) => method({ id }));

describe('home assistant client generator', () => {
  test('a numeric enum renders its numbers, not True', () => {
    const out = renderHomeAssistant(contractOf(...fillers, method({
      inputSchema: { type: 'object', properties: { level: { enum: [1, 2, 0] }, flag: { enum: [true, false] } } },
    })));
    expect(out).toContain('Literal[1, 2, 0]');
    expect(out).toContain('Literal[True, False]');
  });

  test('keys that are not Python identifiers use the functional TypedDict form', () => {
    const out = renderHomeAssistant(contractOf(...fillers, method({
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, 'foo-bar': { type: 'integer' } }, required: ['from'] },
    })));
    expect(out).toContain('HomeassistantSampleInput = TypedDict("HomeassistantSampleInput", {"from": str, "foo-bar": NotRequired[int]}, total=True)');
  });

  test('a consumed method with no REST binding names its id instead of crashing', () => {
    expect(() => consumedIdsFor(contractOf(...fillers, method({ http: undefined })))).toThrow('homeassistant.sample');
  });
});

describe('webui facade disposition', () => {
  test('a method with neither an http binding nor ws transport is refused by id', () => {
    expect(() => buildDisposition([method({ id: 'x.y', http: undefined, transport: ['http'] })])).toThrow('x.y');
  });

  test('ws-only and REST methods are labelled', () => {
    expect(buildDisposition([method({ id: 'a' }), method({ id: 'b', http: undefined, transport: ['ws'] })])).toEqual({ a: 'rest', b: 'ws-invoke' });
  });
});
