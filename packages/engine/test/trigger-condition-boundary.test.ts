import { describe, expect, test } from 'bun:test';
import { fireTriggers } from '../platform/src/platform/workflow/trigger-executor.ts';
import type { HookEvent } from '../platform/src/platform/hooks/types.ts';
import type { TriggerDefinition } from '../platform/src/platform/tools/workflow/index.ts';

// A passed condition reaches the command guard before anything is launched; the guard
// refuses, so no process starts. `reached` is therefore true only for a passed
// condition, and a failed one reports why in `error`.
async function runCondition(condition: string, payload: Record<string, unknown> = {}): Promise<{ reached: boolean; error: string | undefined }> {
  const event: HookEvent = { path: 'Post:tool:exec', phase: 'Post', category: 'tool',
    specific: 'exec', sessionId: 'synthetic-condition', timestamp: 0, payload };
  const trigger = { id: 'synthetic-condition', enabled: true, event: event.path, condition, action: 'true' } as TriggerDefinition;
  let reached = false;
  const [result] = await fireTriggers(event, { list: () => [trigger] }, {
    guardCommand: async () => { reached = true; return 'stopped by test'; },
  });
  expect(result?.executed).toBe(false);
  return { reached, error: result?.error };
}

const REFUSED = 'Action refused by command policy: stopped by test';

async function conditionPasses(condition: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  const { reached, error } = await runCondition(condition, payload);
  if (reached) expect(error).toBe(REFUSED);
  return reached;
}

describe('trigger condition data boundary', () => {
  test.each(['__proto__', 'constructor', 'prototype'])('rejects %s even when the condition tests for absence', async (part) => {
    for (const [condition, payload] of [
      [`payload.${part} === undefined`, {}],
      [`payload.nested.${part} !== undefined`, { nested: {} }],
      [`payload.${part} === 'synthetic'`, { [part]: 'synthetic' }],
    ] as const) {
      const { reached, error } = await runCondition(condition, payload);
      expect(reached).toBe(false);
      expect(error).toStartWith('Condition could not be evaluated:');
    }
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
