import { describe, expect, test } from 'bun:test';
import { fireTriggers } from '../platform/src/platform/workflow/trigger-executor.ts';
import type { HookEvent } from '../platform/src/platform/hooks/types.ts';
import type { TriggerDefinition } from '../platform/src/platform/tools/workflow/index.ts';

// An empty action reaches executeAction but cannot launch a process. Its
// explicit error distinguishes a passed condition from a rejected condition.
async function conditionPasses(condition: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  const event: HookEvent = { path: 'Post:tool:exec', phase: 'Post', category: 'tool',
    specific: 'exec', sessionId: 'synthetic-condition', timestamp: 0, payload };
  const trigger = { id: 'synthetic-condition', enabled: true, event: event.path, condition, action: '' } as TriggerDefinition;
  const [result] = await fireTriggers(event, { list: () => [trigger] });
  expect(result?.executed).toBe(false);
  return result?.error === 'Empty action command';
}

describe('trigger condition data boundary', () => {
  test.each(['__proto__', 'constructor', 'prototype'])('rejects %s even when the condition tests for absence', async (part) => {
    expect(await conditionPasses(`payload.${part} === undefined`)).toBe(false);
    expect(await conditionPasses(`payload.nested.${part} !== undefined`, { nested: {} })).toBe(false);
    expect(await conditionPasses(`payload.${part} === 'synthetic'`, { [part]: 'synthetic' })).toBe(false);
  });

  test('does not consult inherited properties', async () => {
    const payload = Object.create({ granted: true }) as Record<string, unknown>;
    expect(await conditionPasses('payload.granted === true', payload)).toBe(false);
  });

  test('rejects getters and coercion hooks without invoking them', async () => {
    let calls = 0;
    const payload = { get granted() { calls++; return true; }, value: { toString() { calls++; return 'synthetic'; } } };
    expect(await conditionPasses('payload.granted === true', payload)).toBe(false);
    expect(await conditionPasses("payload.value === 'synthetic'", payload)).toBe(false);
    expect(calls).toBe(0);
  });

  test('preserves own primitive, array and missing-field conditions', async () => {
    expect(await conditionPasses("event.phase === 'Post' && payload.items.0.count >= 2", { items: [{ count: 3 }] })).toBe(true);
    expect(await conditionPasses('payload.missing === undefined')).toBe(true);
    expect(await conditionPasses('payload.value === null', { value: null })).toBe(true);
    expect(await conditionPasses('payload.enabled === false', { enabled: false })).toBe(true);
    expect(await conditionPasses("payload.nested.label === 'synthetic'", { nested: { label: 'synthetic' } })).toBe(true);
  });
});
