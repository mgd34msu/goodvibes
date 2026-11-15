import { expect, test } from 'bun:test';
import { executeCompanionToolCalls } from '../platform/src/platform/companion/companion-chat-turn-execution.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import type { PermissionManager } from '../platform/src/platform/permissions/manager.ts';

function run(configValues: Record<string, unknown> | undefined) {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'heavy', description: 'heavy', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ success: true, output: 'the output', tokenCount: 900 }),
  });
  return executeCompanionToolCalls({
    toolRegistry: registry,
    permissionManager: { check: async () => true } as unknown as PermissionManager,
    hookDispatcher: null,
    runtimeBus: null,
    ...(configValues ? { configManager: { get: (key: string) => configValues[key] } as never } : {}),
  }, [{ id: 'c1', name: 'heavy', arguments: {} }], () => {}, 'session', 'turn');
}

test('a companion chat tool call over runtime.toolBudget.maxTokens is reported as failed with its output kept', async () => {
  const [result] = await run({
    'runtime.toolBudget.enforced': true, 'runtime.toolBudget.maxMs': 0, 'runtime.toolBudget.maxTokens': 500, 'runtime.toolBudget.maxCostUsd': 0,
  });
  expect(result).toMatchObject({ success: false, output: 'the output' });
  expect(result!.error).toContain('check the result before repeating');
});

test('the same call succeeds while enforcement is off or no configuration is supplied', async () => {
  const [off] = await run({ 'runtime.toolBudget.enforced': false, 'runtime.toolBudget.maxTokens': 500 });
  const [none] = await run(undefined);
  expect(off).toMatchObject({ success: true });
  expect(none).toMatchObject({ success: true });
});
