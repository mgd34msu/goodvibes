/**
 * A call the user cancels while it is still being admitted never reaches its
 * tool, yet observers were told it was received: they must also see it end
 * (TOOL_CANCELLED), the model must see a cancelled result, and the call's
 * one-shot admission source must be retired so the call cannot be admitted again.
 */
import { describe, expect, test } from 'bun:test';
import { executeToolCalls, TOOL_CALL_CANCELLED_MESSAGE, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { ToolCallAbortRegistry } from '../platform/src/platform/core/orchestrator-live-turn.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function admissionHeldUntilAborted(cancelled: () => void, retired: string[]) {
  const permissionManager = {
    check: async () => true,
    checkDetailed: async () => ({ approved: true }),
    // Admission waits for its own signal, as a prompt the user never answers would.
    admitAutonomous: (_source: string, _tool: string, _args: unknown, options: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      cancelled();
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason ?? new Error('aborted')), { once: true });
    }),
    autonomousPreparation: () => ({ port: undefined, assertCurrent: () => undefined }),
    retireAutonomousSource: (source: string) => { retired.push(source); },
  };
  return permissionManager as unknown as ToolExecutionDeps['permissionManager'];
}

describe('a call cancelled during admission', () => {
  test('ends as cancelled for the model and for observers, and its admission source is retired', async () => {
    const aborts = new ToolCallAbortRegistry();
    const bus = new RuntimeEventBus();
    const observed: string[] = [];
    bus.on('TOOL_RECEIVED', () => { observed.push('received'); });
    bus.on('TOOL_CANCELLED', () => { observed.push('cancelled'); });
    const retired: string[] = [];
    const toolRegistry = {
      has: () => true,
      prepareCall: async (callId: string, name: string, args: Record<string, unknown>) => ({ callId, name, args, schemaRevision: '1', judgmentDecisionIds: [] }),
    } as unknown as ToolExecutionDeps['toolRegistry'];
    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager: admissionHeldUntilAborted(() => { queueMicrotask(() => aborts.cancel('call-1')); }, retired),
      autonomousSource: () => ({ goal: 'Inspect the parser', criteria: ['Name the cause'] }),
      hookDispatcher: null,
      runtimeBus: bus,
      sessionId: 'session-1',
      emitterContext: (turnId) => ({ sessionId: 'session-1', traceId: turnId, source: 'orchestrator' as const }),
      toolCallSignals: aborts,
    };
    const results = await executeToolCalls(deps, 'turn-1', [{ id: 'call-1', name: 'probe', arguments: {} }]);
    await Promise.resolve();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ callId: 'call-1', success: false, cancelled: true, error: TOOL_CALL_CANCELLED_MESSAGE });
    expect(observed).toEqual(['received', 'cancelled']);
    expect(retired).toHaveLength(1);
    expect(aborts.list()).toHaveLength(0);
  });
});
