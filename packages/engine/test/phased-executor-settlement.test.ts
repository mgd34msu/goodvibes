import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { IdempotencyStore } from '../platform/src/platform/runtime/idempotency/index.ts';
import { PhasedToolExecutor, budgetPhase, mapOutputPhase } from '../platform/src/platform/runtime/tools/index.ts';
import type { ToolRuntimeContext } from '../platform/src/platform/runtime/tools/index.ts';
import { applyOutputPolicy, getPolicy } from '../platform/src/platform/runtime/tools/output-policy.ts';
import type { ToolExecutionRecord } from '../platform/src/platform/runtime/tools/types.ts';
import type { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import type { Tool, ToolCall, ToolResult } from '../platform/src/platform/types/tools.ts';

let priorPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { priorPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(priorPort); });

function ctx(extra: Record<string, unknown> = {}, signal: AbortSignal = new AbortController().signal): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: { sessionId: 's', conversationId: 'c', turnId: 't', toolCallId: 'x', traceId: 'tr' },
    tasks: {},
    resources: { fileCache: {} as never, projectIndex: {} as never },
    provider: { providerId: 'mock', modelId: 'm', contextWindow: 8192 },
    cancellation: { signal },
    executionMode: 'interactive',
    hookDispatcher: { fire: async () => ({ ok: true }) },
    ...extra,
  } as unknown as ToolRuntimeContext;
}

function tool(name: string, execute: Tool['execute'], parameters: Record<string, unknown> = {}): Tool {
  return { definition: { name, description: '', parameters }, execute } as unknown as Tool;
}

const plain = { enableHooks: false, enablePermissions: false, enableEvents: false } as const;

function record(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { callId: 'r', toolName: 't', phases: [], currentPhase: 'received', startedAt: performance.now(), cancelled: false, ...overrides };
}

describe('a call is settled even when a phase throws', () => {
  test('a Jev failure out of auto-repair is rethrown after the record, abort listener and idempotency key are settled', async () => {
    installJudgmentPort({ model: 'fixture', async ask() { throw new JudgmentError('rejected', 'fixture refusal'); } });
    const idempotencyStore = new IdempotencyStore();
    const executor = new PhasedToolExecutor({ ...plain, idempotencyStore });
    const controller = new AbortController();
    let added = 0; let removed = 0;
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof realAdd>) => { added++; realAdd(...args); }) as unknown as typeof realAdd;
    controller.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => { removed++; realRemove(...args); }) as unknown as typeof realRemove;

    let runs = 0;
    const flagTool = tool('flag', async () => { runs++; return { callId: '', success: true, output: 'ran' }; },
      { type: 'object', properties: { enabled: { type: 'boolean' } } });
    // 'yes' is not a boolean literal, so repair asks Jev, which refuses.
    const call: ToolCall = { id: 'j1', name: 'flag', arguments: { enabled: 'yes' } };

    await expect(executor.execute(call, flagTool, ctx({}, controller.signal))).rejects.toThrow('fixture refusal');
    expect(runs).toBe(0);
    expect(executor.getActiveRecords()).toEqual([]);
    expect(executor.getRecord('j1')?.currentPhase).toBe('failed');
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);

    // The key was marked failed, so the same call can be submitted again instead of being refused as in flight.
    const retry = await executor.execute({ id: 'j1', name: 'flag', arguments: { enabled: true } }, flagTool, ctx());
    expect(retry.success).toBe(true);
    expect(runs).toBe(1);
  });
});

describe('a tool that resolves with success:false has failed', () => {
  test('it is reported through the failure hook, keeps its own result and may be retried', async () => {
    const idempotencyStore = new IdempotencyStore();
    const executor = new PhasedToolExecutor({ ...plain, idempotencyStore });
    let runs = 0;
    const edit = tool('edit', async () => {
      runs++;
      return runs === 1
        ? { callId: '', success: false, error: 'no match for the old text', output: 'detail the model needs' }
        : { callId: '', success: true, output: 'edited' };
    });
    const completed: string[] = []; const errored: string[] = [];
    const context = ctx({ tasks: { onComplete: (id: string) => completed.push(id), onError: (id: string) => errored.push(id) } });
    const call: ToolCall = { id: 'e1', name: 'edit', arguments: {} };

    const first = await executor.execute(call, edit, context);
    expect(first).toMatchObject({ success: false, error: 'no match for the old text', output: 'detail the model needs' });
    expect(executor.getRecord('e1')?.currentPhase).toBe('failed');
    expect(errored).toEqual(['e1']);
    expect(completed).toEqual([]);

    const second = await executor.execute({ ...call }, edit, context);
    expect(second).toMatchObject({ success: true, output: 'edited' });
    expect(runs).toBe(2);
  });
});

describe('a cancel that arrives after the tool finished', () => {
  test('the real result is kept and the call stays completed, so a retry does not run it twice', async () => {
    const idempotencyStore = new IdempotencyStore();
    const executor = new PhasedToolExecutor({ enableHooks: true, enablePermissions: false, enableEvents: false, idempotencyStore });
    let writes = 0;
    const write = tool('write', async () => { writes++; return { callId: '', success: true, output: 'wrote file' }; });
    const hookDispatcher = {
      fire: async (event: { phase: string }) => {
        if (event.phase === 'Post') executor.cancel('w1', 'user stop');
        return { ok: true };
      },
    };
    const call: ToolCall = { id: 'w1', name: 'write', arguments: {} };

    const result = await executor.execute(call, write, ctx({ hookDispatcher }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('wrote file');
    expect(result.warnings?.join(' ')).toContain('cancel arrived after the tool had finished');
    expect(executor.getRecord('w1')?.currentPhase).toBe('succeeded');

    const again = await executor.execute({ ...call }, write, ctx({ hookDispatcher }));
    expect(again.success).toBe(true);
    expect(writes).toBe(1);
  });
});

describe('permission is asked about the repaired arguments', () => {
  test('a renamed key reaches the permission manager and the tool under its declared name', async () => {
    const executor = new PhasedToolExecutor({ enableHooks: false, enablePermissions: true, enableEvents: false });
    const asked: Record<string, unknown>[] = [];
    const permissionManager = {
      getCategory: () => 'execute',
      checkDetailed: async (_name: string, args: Record<string, unknown>) => {
        asked.push(args);
        return {
          approved: true, persisted: false, sourceLayer: 'config_policy', reasonCode: 'config_allow',
          analysis: { classification: 'generic', riskLevel: 'low', summary: '', reasons: [] },
        };
      },
    };
    let received: Record<string, unknown> | undefined;
    const run = tool('run', async (args) => { received = args; return { callId: '', success: true, output: 'ok' }; },
      { type: 'object', properties: { cwd: { type: 'string' } } });

    const result = await executor.execute({ id: 'p1', name: 'run', arguments: { workdir: '/etc' } }, run, ctx({ permissionManager }));
    expect(result.success).toBe(true);
    expect(asked).toEqual([{ cwd: '/etc' }]);
    expect(received).toEqual({ cwd: '/etc' });
  });
});

describe('the time budget', () => {
  test('is measured from the start of the execute phase, not from the start of the pipeline', async () => {
    const budget = { maxMs: 1_000 };
    // Pipeline started long ago (a slow permission prompt): the tool has not run yet.
    const waited = record({ startedAt: performance.now() - 60_000 });
    expect((await budgetPhase({} as ToolCall, {} as Tool, ctx({ budget }), waited, 'entry')).success).toBe(true);

    // The tool began just now: finishing is inside the budget even though the pipeline is old.
    const fresh = record({ startedAt: performance.now() - 60_000, executeStartedAt: performance.now() });
    expect((await budgetPhase({} as ToolCall, {} as Tool, ctx({ budget }), fresh, 'exit')).success).toBe(true);

    // The tool itself ran past the budget.
    const slow = record({ executeStartedAt: performance.now() - 60_000 });
    const breached = await budgetPhase({} as ToolCall, {} as Tool, ctx({ budget }), slow, 'exit');
    expect(breached).toMatchObject({ success: false, budgetExceedReason: 'BUDGET_EXCEEDED_MS' });
  });

  test('is a deadline for the tool only when enforcement is on, and the configured default applies', async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') delays.push(ms);
      return realSetTimeout(handler, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      const quick = tool('quick', async () => ({ callId: '', success: true, output: 'ok' }));
      const off = new PhasedToolExecutor({ ...plain, enableBudgetEnforcement: false, defaultBudget: { maxMs: 7_001 } });
      await off.execute({ id: 'b1', name: 'quick', arguments: {} }, quick, ctx({ budget: { maxMs: 7_002 } }));
      expect(delays.filter(ms => ms === 7_001 || ms === 7_002)).toEqual([]);

      const on = new PhasedToolExecutor({ ...plain, enableBudgetEnforcement: true, defaultBudget: { maxMs: 7_003 } });
      await on.execute({ id: 'b2', name: 'quick', arguments: {} }, quick, ctx());
      expect(delays).toContain(7_003);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('output policy', () => {
  test('a result over the limit is cut when the context has no overflow handler', async () => {
    const result: ToolResult = { callId: 'o1', success: true, output: 'a'.repeat(200_000) };
    const { result: applied, audit } = await applyOutputPolicy(result, getPolicy('read'), undefined, 'read {}');
    expect(audit.actionTaken).toBe('truncated');
    expect((applied.output ?? '').length).toBeLessThan(getPolicy('read').maxBytes + 200);
    expect(applied.output).toContain('truncated');
  });

  test('the spill handler is given the full character budget of the policy', async () => {
    let seen: number | undefined;
    const handler = { handle: async (_output: string, options: { maxChars: number }) => { seen = options.maxChars; return { content: 'kept' }; } } as unknown as OverflowHandler;
    const policy = getPolicy('read');
    const output = 'b'.repeat(policy.maxBytes + 1);
    await applyOutputPolicy({ callId: 'o2', success: true, output }, policy, handler, 'read {}');
    expect(seen).toBe(policy.maxBytes);
  });

  test('delegate and analyze tools run under the class the contract verifier certifies', async () => {
    const big = 'c'.repeat(200_000);
    const classOf = async (category: string): Promise<string | undefined> => {
      const phased = { ...tool('t', async () => ({ callId: '', success: true })), category } as unknown as Tool;
      const rec = record({ result: { callId: 'm', success: true, output: big } });
      await mapOutputPhase({ id: 'm', name: 't', arguments: {} }, phased, ctx(), rec);
      return (rec.result as unknown as { _policyAudit?: { policyId: string } })._policyAudit?.policyId;
    };
    expect(await classOf('delegate')).toBe('read');
    expect(await classOf('analyze')).toBe('analyze');
    expect(await classOf('execute')).toBe('execute');
  });
});
