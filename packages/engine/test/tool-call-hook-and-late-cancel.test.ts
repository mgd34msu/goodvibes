import { describe, expect, test } from 'bun:test';
import { executeToolCalls, TOOL_CALL_CANCELLED_AFTER_COMPLETION_MESSAGE, toolBudgetFromConfig, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolCallAbortRegistry } from '../platform/src/platform/core/orchestrator-live-turn.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { PermissionManager } from '../platform/src/platform/permissions/manager.ts';

const allowAll = { check: async () => true } as unknown as PermissionManager;

function deps(toolRegistry: ToolRegistry, extra: Partial<ToolExecutionDeps> = {}): ToolExecutionDeps {
  return {
    toolRegistry,
    permissionManager: allowAll,
    hookDispatcher: null,
    runtimeBus: null,
    sessionId: 'session',
    emitterContext: (turnId: string) => ({ sessionId: 'session', traceId: turnId, source: 'orchestrator' as const }),
    ...extra,
  };
}

describe('a Pre tool hook that fails', () => {
  test('does not run the tool and tells the model which hook step failed', async () => {
    let ran = 0;
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'writer', description: 'writes', parameters: { type: 'object', properties: {} } },
      execute: async () => { ran++; return { success: true, output: 'written' }; },
    });
    const hookDispatcher = { fire: async () => { throw new Error('hook process crashed'); } };
    const [result] = await executeToolCalls(deps(registry, { hookDispatcher }), 'turn', [{ id: 'c1', name: 'writer', arguments: {} }]);
    expect(ran).toBe(0);
    expect(result).toMatchObject({ callId: 'c1', success: false });
    expect(result!.error).toContain('Pre hook failed');
    expect(result!.error).toContain('hook process crashed');
  });
});

describe('a failed Pre tool hook event', () => {
  test('does not carry a secret quoted in the hook error', async () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'writer', description: 'writes', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: 'written' }),
    });
    const bus = new RuntimeEventBus();
    const events: unknown[] = [];
    bus.on('TOOL_FAILED', (event) => { events.push(event); });
    const hookDispatcher = { fire: async () => { throw new Error(`hook rejected call with ${secret}`); } };
    await executeToolCalls(deps(registry, { hookDispatcher, runtimeBus: bus }), 'turn', [{ id: 'c1', name: 'writer', arguments: {} }]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('Pre hook failed');
  });
});

describe('tool result events', () => {
  const secret = 'ghp_' + 'a'.repeat(36);
  function registryReturning(result: { success: boolean; output?: string; error?: string }): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'echoer', description: 'echoes', parameters: { type: 'object', properties: {} } },
      execute: async () => result,
    });
    return registry;
  }

  test('a failing tool whose error echoes a token does not put it in TOOL_FAILED', async () => {
    const bus = new RuntimeEventBus();
    const events: unknown[] = [];
    bus.on('TOOL_FAILED', (event) => { events.push(event); });
    await executeToolCalls(deps(registryReturning({ success: false, error: `auth failed for ${secret}` }), { runtimeBus: bus }), 'turn', [{ id: 'c1', name: 'echoer', arguments: {} }]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('auth failed');
  });

  test('a succeeding tool whose output starts with a token does not put it in the TOOL_SUCCEEDED preview', async () => {
    const bus = new RuntimeEventBus();
    const events: unknown[] = [];
    bus.on('TOOL_SUCCEEDED', (event) => { events.push(event); });
    await executeToolCalls(deps(registryReturning({ success: true, output: `token=${secret}` }), { runtimeBus: bus }), 'turn', [{ id: 'c1', name: 'echoer', arguments: {} }]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('a call cancelled as its tool completes', () => {
  test('keeps the output and says the action may already have happened', async () => {
    const aborts = new ToolCallAbortRegistry();
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'sender', description: 'sends', parameters: { type: 'object', properties: {} } },
      // The tool ignores the signal: it finishes successfully in the same instant the user cancels.
      execute: async () => { aborts.cancel('c1'); return { success: true, output: 'message sent' }; },
    });
    const [result] = await executeToolCalls(deps(registry, { toolCallSignals: aborts }), 'turn', [{ id: 'c1', name: 'sender', arguments: {} }]);
    expect(result).toMatchObject({ callId: 'c1', success: false, cancelled: true, output: 'message sent', error: TOOL_CALL_CANCELLED_AFTER_COMPLETION_MESSAGE });
  });
});

describe('the tool budget', () => {
  function registryReporting(extra: Record<string, unknown>): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'reader', description: 'reads', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: 'the whole file', ...extra }),
    });
    return registry;
  }

  test('a call over its token limit fails with its output kept and a check-before-repeat note', async () => {
    const [result] = await executeToolCalls(
      deps(registryReporting({ tokenCount: 900 }), { toolBudget: () => ({ maxTokens: 500 }) }), 'turn', [{ id: 'c1', name: 'reader', arguments: {} }]);
    expect(result).toMatchObject({ callId: 'c1', success: false, output: 'the whole file' });
    expect(result!.error).toContain('900 tokens');
    expect(result!.error).toContain('check the result before repeating');
  });

  test('a call within its limits, or with no budget, is untouched', async () => {
    const call = [{ id: 'c1', name: 'reader', arguments: {} }];
    const [within] = await executeToolCalls(deps(registryReporting({ tokenCount: 100 }), { toolBudget: () => ({ maxTokens: 500 }) }), 'turn', call);
    const [none] = await executeToolCalls(deps(registryReporting({ tokenCount: 900 }), { toolBudget: () => undefined }), 'turn', call);
    expect(within).toMatchObject({ success: true });
    expect(none).toMatchObject({ success: true });
  });

  test('the configuration yields a budget only while enforcement is on and a limit is set', () => {
    const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;
    expect(toolBudgetFromConfig(config({ 'runtime.toolBudget.enforced': false, 'runtime.toolBudget.maxMs': 5 }))).toBeUndefined();
    expect(toolBudgetFromConfig(config({ 'runtime.toolBudget.enforced': true, 'runtime.toolBudget.maxMs': 0, 'runtime.toolBudget.maxTokens': 0, 'runtime.toolBudget.maxCostUsd': 0 }))).toBeUndefined();
    expect(toolBudgetFromConfig(config({ 'runtime.toolBudget.enforced': true, 'runtime.toolBudget.maxMs': 0, 'runtime.toolBudget.maxTokens': 7, 'runtime.toolBudget.maxCostUsd': 0 }))).toEqual({ maxTokens: 7 });
  });
});

describe('a tool result larger than the output ceiling', () => {
  function registryReturning(output: string): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'dump', description: 'dumps', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output }),
    });
    return registry;
  }
  const big = 'line of text\n'.repeat(12_000);

  test('is cut with a note that says so before it reaches the conversation', async () => {
    const [result] = await executeToolCalls(deps(registryReturning(big)), 'turn', [{ id: 'c1', name: 'dump', arguments: {} }]);
    expect(result!.success).toBe(true);
    expect((result!.output ?? '').length).toBeLessThan(big.length);
    expect(result!.output).toContain('[Output cut:');
  });

  test('is kept whole for read, which pages itself and tells the model where to continue', async () => {
    const registry = new ToolRegistry();
    const paged = JSON.stringify({ content: 'x'.repeat(130_000), summary: { truncated: { next_start_line: 9 } } });
    registry.register({
      definition: { name: 'read', description: 'reads', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: paged }),
    });
    const [result] = await executeToolCalls(deps(registry), 'turn', [{ id: 'c1', name: 'read', arguments: {} }]);
    expect(result!.output).toBe(paged);
  });

  test('is kept whole when the caller asked for a larger max_tokens', async () => {
    const [result] = await executeToolCalls(deps(registryReturning(big)), 'turn', [{ id: 'c1', name: 'dump', arguments: { max_tokens: 100_000 } }]);
    expect(result!.output).toBe(big);
  });
});
