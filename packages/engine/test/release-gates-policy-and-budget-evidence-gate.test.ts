import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from './_helpers/runtime-seam.ts';
import type { TurnEvent } from './_helpers/runtime-seam.ts';
import type { TaskEvent } from './_helpers/runtime-seam.ts';
import { ForensicsCollector } from './_helpers/runtime-seam.ts';
import { ForensicsRegistry } from './_helpers/runtime-seam.ts';
import { PhasedToolExecutor } from './_helpers/runtime-seam.ts';
import type { ToolRuntimeContext } from './_helpers/runtime-seam.ts';
import type { Tool, ToolCall } from '@goodvibes-jev/engine/platform/platform/types';
import { useFailureReadings } from './_helpers/failure-readings.ts';

// Drain queued microtasks so bus.emit() listeners (async dispatch) run before assertions.

async function emitTurn(
  bus: RuntimeEventBus,
  payload: Record<string, unknown>,
  sessionId = 'sess-policy-budget-gate',
  traceId = 'trace-policy-budget-gate',
  settled?: () => boolean,
): Promise<void> {
  bus.emit(
    'turn',
    createEventEnvelope(
      payload['type'] as TurnEvent['type'],
      payload as TurnEvent,
      { sessionId, source: 'test', traceId },
    ),
  );
  // Listener dispatch and the failure/phase readings are microtask chains, which one
  // setImmediate turn fully drains. Where the caller can name the observable outcome
  // (the report existing), keep turning until it is there instead of guessing a count.
  for (let i = 0; i < 1_000; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (settled === undefined || settled()) return;
  }
  throw new Error('The forensic report was not produced after the turn event');
}

function makeContext(
  bus: RuntimeEventBus,
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: {
      sessionId: 'sess-policy-budget-gate',
      conversationId: 'conv-policy-budget-gate',
      turnId: 'turn-policy-budget-gate',
      toolCallId: 'call-policy-budget-gate',
      traceId: 'trace-policy-budget-gate',
    },
    tasks: {},
    resources: {
      fileCache: {} as never,
      projectIndex: {} as never,
    },
    provider: {
      providerId: 'mock',
      modelId: 'mock-model',
      contextWindow: 8192,
    },
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'interactive',
    runtimeBus: bus,
    permissionManager: {
      check: async () => true,
      getCategory: () => 'write',
    } as never,
    hookDispatcher: {
      fire: async () => ({ ok: true, decision: 'allow' }),
    } as never,
    ...overrides,
  };
}

describe('policy and budget evidence gate', () => {
  // Reports read their phases' slowness; this port reads every phase as not slow.
  useFailureReadings([]);
  test('permission-denied tool failure carries permission evidence into the forensic bundle', async () => {
    const bus = new RuntimeEventBus();
    const registry = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, registry);
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: true,
      enableEvents: true,
    });

    const call: ToolCall = { id: 'call-perm', name: 'write', arguments: { path: '/tmp/out.txt' } };
    const tool: Tool = {
      name: 'write',
      definition: { name: 'write', description: '', parameters: {} },
      execute: async () => ({ callId: 'call-perm', success: true }),
    } as never;

    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'turn-policy-budget-gate', prompt: 'write a file' });

    const result = await executor.execute(call, tool, makeContext(bus, {
      permissionManager: {
        check: async () => false,
        getCategory: () => 'write',
      } as never,
    }));

    expect(result.success).toBe(false);
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'turn-policy-budget-gate', error: result.error ?? 'permission denied' },
      undefined, undefined, () => registry.latest() !== null);

    const report = registry.latest()!;
    const bundle = registry.buildBundle(report.id)!;

    expect(report.permissionEvidence).toHaveLength(1);
    expect(report.permissionEvidence[0]?.approved).toBe(false);
    expect(report.permissionEvidence[0]?.source).toBe('permission-manager');
    expect(bundle.evidence.permissionDecisionCount).toBe(1);
    expect(bundle.evidence.deniedPermissionCount).toBe(1);
    collector.dispose();
  });

  test('budget-breached tool failure carries budget evidence into the forensic bundle', async () => {
    const bus = new RuntimeEventBus();
    const registry = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, registry);
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: true,
      enableBudgetEnforcement: true,
    });

    const call: ToolCall = { id: 'call-budget', name: 'analyze', arguments: {} };
    const tool: Tool = {
      name: 'analyze',
      definition: { name: 'analyze', description: '', parameters: {} },
      execute: async () => ({ callId: 'call-budget', success: true, tokenCount: 5000 }),
    } as never;

    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'turn-policy-budget-gate', prompt: 'analyze with token budget' });

    const result = await executor.execute(call, tool, makeContext(bus, {
      budget: { maxTokens: 10 },
    }));

    expect(result.success).toBe(false);
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'turn-policy-budget-gate', error: result.error ?? 'budget exceeded' },
      undefined, undefined, () => registry.latest() !== null);

    const report = registry.latest()!;
    const bundle = registry.buildBundle(report.id)!;

    expect(report.budgetBreaches).toHaveLength(1);
    expect(report.budgetBreaches[0]?.eventType).toBe('BUDGET_EXCEEDED_TOKENS');
    expect(report.budgetBreaches[0]?.meta['usedTokens']).toBe(5000);
    expect(bundle.evidence.budgetBreachCount).toBe(1);
    collector.dispose();
  });
});
