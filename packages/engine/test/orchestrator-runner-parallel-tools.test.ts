/**
 * Tool calls of one worker turn: consecutive parallel-safe calls overlap,
 * a call that is not parallel-safe is a barrier, results reach the model in
 * call order, and a cancelled or failed batch still closes every call exactly
 * once. Ordering is driven by gates the tests open, never by time.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../platform/src/platform/agents/orchestrator-runner.js';
import { callingAgentId } from '../platform/src/platform/agents/calling-agent.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { MAX_PARALLEL_TOOL_CALLS, createAdmissionLock } from '../platform/src/platform/agents/parallel-tool-calls.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import type { BackgroundPermissionManager } from '../platform/src/platform/agents/background-permission-gate.js';
import type { ConversationMessageSnapshot } from '../platform/src/platform/core/conversation.js';
import type { ToolResult } from '../platform/src/platform/types/tools.js';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.js';

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model', provider: 'fake', registryKey: 'fake:fake-model', displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0, selectable: true,
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Gate { readonly opened: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
/** Resolves once `count` calls have signalled. */
function counter(count: number): { hit(): void; reached: Promise<void> } {
  let seen = 0;
  const g = gate();
  return { hit() { if (++seen === count) g.open(); }, reached: g.opened };
}

type Mode = 'parallel' | 'serial';
interface ToolSpec {
  readonly name: string;
  readonly mode: Mode;
  /** Runs inside the call; may hold it open. */
  readonly body?: (signal: AbortSignal | undefined) => Promise<ToolResult | void>;
}

const done: ChatResponse = { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
const turnOf = (...names: string[]): ChatResponse => ({
  content: '', toolCalls: names.map((name, i) => ({ id: `id-${i}-${name}`, name, arguments: { i } })),
  usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call',
});

function setup(tools: readonly ToolSpec[], script: (call: number) => ChatResponse, extra: Partial<AgentOrchestratorRunContext> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runner-parallel-')); roots.push(root);
  const requests: ChatRequest[] = [];
  const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) { requests.push(request); return script(requests.length); } };
  const registry = new ToolRegistry();
  for (const spec of tools) {
    registry.register({
      definition: { name: spec.name, description: spec.name, parameters: { type: 'object' }, concurrency: spec.mode },
      execute: async (_input, options) => {
        const settled = await spec.body?.(options?.signal);
        return settled ?? { success: true, output: `${spec.name} ok` };
      },
    } );
  }
  let source: (() => ConversationMessageSnapshot[]) | undefined;
  const context: AgentOrchestratorRunContext = {
    workingDirectory: root, surfaceRoot: undefined, runtimeBus: new RuntimeEventBus(), featureFlagManager: null,
    emitterContext: () => ({ sessionId: 's', traceId: 't', source: 'test' }),
    emitAgentProgress: () => {}, emitAgentStarted: () => {}, emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: () => {}, emitAgentCompletedEvent: () => {}, emitStreamDelta: () => {},
    processManager: undefined, messageBus: new AgentMessageBus(), knowledgeService: undefined, memoryRegistry: undefined,
    archetypeLoader: undefined, providerOptimizer: undefined,
    providerRegistry: {
      getCurrentModel: () => FAKE_MODEL, getForModel: () => provider, listModels: () => [FAKE_MODEL],
      getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {},
    },
    getFullRegistry: () => registry,
    buildScopedRegistry: (_names, full) => full,
    resolveProviderForRecord: (_r, _rec, model) => ({ provider, modelId: model.id, requestedModelId: model.registryKey }),
    resolveFallbackModelRoutes: () => [],
    registerConversationSource: (_id, get) => { source = get; },
    ...extra,
  };
  const record: AgentRecord = {
    id: 'agent-par', task: 'read things', template: 'engineer', tools: tools.map((t) => t.name), status: 'pending',
    startedAt: 0, toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct',
    reviewMode: 'none', communicationLane: 'parent-only',
  };
  return { context, record, requests, messages: () => source?.() ?? [] };
}

const toolRows = (messages: readonly ConversationMessageSnapshot[]) =>
  messages.filter((m): m is Extract<ConversationMessageSnapshot, { role: 'tool' }> => m.role === 'tool');

describe('worker turn tool scheduling', () => {
  test('parallel-safe calls overlap and their results are appended in call order', async () => {
    const entered = counter(2);
    const release = { a: gate(), b: gate() };
    const h = setup([
      { name: 'read_a', mode: 'parallel', body: async () => { entered.hit(); await release.a.opened; } },
      { name: 'read_b', mode: 'parallel', body: async () => { entered.hit(); await release.b.opened; } },
    ], (n) => n === 1 ? turnOf('read_a', 'read_b') : done);
    const run = runAgentTask(h.context, h.record);
    await entered.reached; // both are inside their bodies at once
    release.b.open();      // the later call finishes first
    release.a.open();
    await run;
    expect(h.record.toolCallCount).toBe(2);
    const secondRequest = h.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(secondRequest.map((m) => (m as { callId: string }).callId)).toEqual(['id-0-read_a', 'id-1-read_b']);
  });

  test('a call that is not parallel-safe is a barrier: earlier calls finish first, it runs alone, later calls follow', async () => {
    const events: string[] = [];
    const earlyEntered = counter(2);
    const earlyGate = gate();
    const h = setup([
      { name: 'r1', mode: 'parallel', body: async () => { earlyEntered.hit(); events.push('r1 start'); await earlyGate.opened; events.push('r1 end'); } },
      { name: 'r2', mode: 'parallel', body: async () => { earlyEntered.hit(); events.push('r2 start'); await earlyGate.opened; events.push('r2 end'); } },
      { name: 'w', mode: 'serial', body: async () => { events.push('w start'); events.push('w end'); } },
      { name: 'r3', mode: 'parallel', body: async () => { events.push('r3 start'); events.push('r3 end'); } },
    ], (n) => n === 1 ? turnOf('r1', 'r2', 'w', 'r3') : done);
    const run = runAgentTask(h.context, h.record);
    await earlyEntered.reached;
    expect(events).not.toContain('w start'); // barrier has not started while r1/r2 are open
    earlyGate.open();
    await run;
    expect(events.indexOf('w start')).toBeGreaterThan(events.indexOf('r1 end'));
    expect(events.indexOf('w start')).toBeGreaterThan(events.indexOf('r2 end'));
    expect(events.indexOf('r3 start')).toBeGreaterThan(events.indexOf('w end'));
    expect(h.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { callId: string }).callId))
      .toEqual(['id-0-r1', 'id-1-r2', 'id-2-w', 'id-3-r3']);
  });

  test('no more than the fan-out cap run at once, and the rest follow in order', async () => {
    const total = MAX_PARALLEL_TOOL_CALLS + 3;
    let active = 0, peak = 0;
    const filled = counter(MAX_PARALLEL_TOOL_CALLS);
    const hold = gate();
    const specs: ToolSpec[] = Array.from({ length: total }, (_, i) => ({
      name: `r${i}`, mode: 'parallel' as const,
      body: async () => { active++; peak = Math.max(peak, active); filled.hit(); await hold.opened; active--; },
    }));
    const h = setup(specs, (n) => n === 1 ? turnOf(...specs.map((s) => s.name)) : done);
    const run = runAgentTask(h.context, h.record);
    await filled.reached;
    expect(active).toBe(MAX_PARALLEL_TOOL_CALLS); // lanes are full; the rest wait
    hold.open();
    await run;
    expect(peak).toBe(MAX_PARALLEL_TOOL_CALLS);
    expect(h.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { callId: string }).callId))
      .toEqual(specs.map((s, i) => `id-${i}-${s.name}`));
  });

  test('a call that fails leaves its sibling result intact, one result per call', async () => {
    const bothEntered = counter(2);
    const g = gate();
    const h = setup([
      { name: 'bad', mode: 'parallel', body: async () => { bothEntered.hit(); await g.opened; throw new Error('boom'); } },
      { name: 'good', mode: 'parallel', body: async () => { bothEntered.hit(); await g.opened; return { callId: 'good', success: true, output: 'kept' }; } },
    ], (n) => n === 1 ? turnOf('bad', 'good') : done);
    const run = runAgentTask(h.context, h.record);
    await bothEntered.reached;
    g.open();
    await run;
    const rows = h.requests[1]!.messages.filter((m) => m.role === 'tool') as { callId: string; content: string }[];
    expect(rows.map((r) => r.callId)).toEqual(['id-0-bad', 'id-1-good']);
    expect(rows[0]!.content).toContain('boom');
    expect(rows[1]!.content).toBe('kept');
  });

  test('a call whose arguments the provider could not read is answered with the error and never run', async () => {
    let executions = 0;
    const unreadable = 'Tool call \'opt\' was not run: the arguments were cut off. Send the call again with a JSON object of arguments.';
    const h = setup([
      { name: 'opt', mode: 'serial', body: async () => { executions++; } },
    ], (n) => n === 1
      ? { ...turnOf('opt'), toolCalls: [{ id: 'id-0-opt', name: 'opt', arguments: {}, argumentError: unreadable }] }
      : done);
    await runAgentTask(h.context, h.record);
    expect(executions).toBe(0);
    const rows = h.requests[1]!.messages.filter((m) => m.role === 'tool') as { callId: string; content: string }[];
    expect(rows.map((r) => r.callId)).toEqual(['id-0-opt']);
    expect(rows[0]!.content).toContain(unreadable);
  });

  test('cancelling with two calls in flight aborts both and closes each exactly once, with nothing appended afterwards', async () => {
    const controller = new AbortController();
    const bothEntered = counter(2);
    const aborted: string[] = [];
    // These bodies return only through abort.
    const body = (name: string) => async (signal: AbortSignal | undefined): Promise<void> => {
      bothEntered.hit();
      await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { aborted.push(name); resolve(); }, { once: true }); });
    };
    const h = setup([
      { name: 'r1', mode: 'parallel', body: body('r1') },
      { name: 'r2', mode: 'parallel', body: body('r2') },
    ], (n) => n === 1 ? turnOf('r1', 'r2') : done, { getCancellationSignal: () => controller.signal });
    const run = runAgentTask(h.context, h.record);
    await bothEntered.reached;
    h.record.status = 'cancelled';
    controller.abort();
    await run;
    expect(aborted.sort()).toEqual(['r1', 'r2']);
    const rows = toolRows(h.messages());
    expect(rows.map((r) => r.callId)).toEqual(['id-0-r1', 'id-1-r2']);
    expect(rows.every((r) => r.outcome === 'cancelled' || r.content.includes('cancel'))).toBe(true);
    const lengthAtSettle = h.messages().length;
    await Promise.resolve(); await Promise.resolve();
    expect(h.messages()).toHaveLength(lengthAtSettle);
    expect(h.record.status).toBe('cancelled');
  });

  test('owner prompts for concurrent calls are asked one at a time', async () => {
    const asks: string[] = [];
    let asking = 0, overlap = 0;
    const firstAsked = gate();
    const answerFirst = gate();
    const permissionManager = {
      getBackgroundAgentsMode: () => 'inherit',
      passesBoundary: () => true,
      check: async () => true,
      async checkDetailed(toolName: string) {
        asking++; overlap = Math.max(overlap, asking);
        asks.push(toolName);
        if (toolName === 'r1') { firstAsked.open(); await answerFirst.opened; }
        asking--;
        return { approved: true };
      },
    } as unknown as BackgroundPermissionManager;
    const bothRunning = counter(2);
    const h = setup([
      { name: 'r1', mode: 'parallel', body: async () => { bothRunning.hit(); } },
      { name: 'r2', mode: 'parallel', body: async () => { bothRunning.hit(); } },
    ], (n) => n === 1 ? turnOf('r1', 'r2') : done, { permissionManager });
    const run = runAgentTask(h.context, h.record);
    await firstAsked.opened;
    // The second call has reached admission but may not ask while the first is unanswered.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(asks).toEqual(['r1']);
    answerFirst.open();
    await run;
    expect(asks).toEqual(['r1', 'r2']);
    expect(overlap).toBe(1);
    await bothRunning.reached;
  });
});

describe('worker turn tool scheduling through the autonomous permission owner', () => {
  test('calls overlap while their admissions are asked one at a time, results in call order', async () => {
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} }, autoApprove: false, directory: '/synthetic/parallel' }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/parallel',
      getSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} } }),
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const realAdmit = manager.admitAutonomous.bind(manager);
    let admitting = 0, admitPeak = 0;
    (manager as { admitAutonomous: unknown }).admitAutonomous = async (...args: Parameters<typeof realAdmit>) => {
      admitting++; admitPeak = Math.max(admitPeak, admitting);
      try { return await realAdmit(...args); } finally { admitting--; }
    };
    const entered = counter(2);
    const g = gate();
    const h = setup([
      { name: 'r1', mode: 'parallel', body: async () => { entered.hit(); await g.opened; } },
      { name: 'r2', mode: 'parallel', body: async () => { entered.hit(); await g.opened; } },
    ], (n) => n === 1 ? turnOf('r1', 'r2') : done, {
      permissionManager: manager as unknown as BackgroundPermissionManager,
      autonomousSource: () => ({ goal: 'read things', criteria: [] }),
    });
    const run = runAgentTask(h.context, h.record);
    await entered.reached;
    g.open();
    await run;
    expect(admitPeak).toBe(1);
    expect(h.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { callId: string }).callId))
      .toEqual(['id-0-r1', 'id-1-r2']);
  });
});

describe('worker turn admission bookkeeping', () => {
  test('a settled worker tool call retires the source id it was admitted under, through the manager the runner hands the tool runtime', async () => {
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} }, autoApprove: false, directory: '/synthetic/retire' }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/retire',
      getSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} } }),
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const realAdmit = manager.admitAutonomous.bind(manager);
    const realRetire = manager.retireAutonomousSource.bind(manager);
    const admitted: string[] = [], retired: string[] = [];
    (manager as { admitAutonomous: unknown }).admitAutonomous = async (...args: Parameters<typeof realAdmit>) => { admitted.push(args[0]); return realAdmit(...args); };
    (manager as { retireAutonomousSource: unknown }).retireAutonomousSource = (id: string) => { retired.push(id); realRetire(id); };
    const h = setup([
      { name: 'r1', mode: 'serial', body: async () => {} },
    ], (n) => n === 1 ? turnOf('r1') : done, {
      permissionManager: manager as unknown as BackgroundPermissionManager,
      autonomousSource: () => ({ goal: 'read things', criteria: [] }),
    });
    await runAgentTask(h.context, h.record);
    expect(admitted.length).toBe(1);
    expect(retired).toEqual(admitted);
  });
});

describe('calling agent on a contract-unit tool call', () => {
  test('a tool run through the autonomous permission owner sees its own agent as the caller, so a process it starts is attributed to that agent', async () => {
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} }, autoApprove: false, directory: '/synthetic/caller' }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/caller',
      getSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} } }),
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const seen: (string | undefined)[] = [];
    const h = setup([
      { name: 'r1', mode: 'serial', body: async () => { seen.push(callingAgentId()); } },
    ], (n) => n === 1 ? turnOf('r1') : done, {
      permissionManager: manager as unknown as BackgroundPermissionManager,
      autonomousSource: () => ({ goal: 'read things', criteria: [] }),
    });
    await runAgentTask(h.context, h.record);
    expect(seen).toEqual([h.record.id]);
  });
});

describe('admission lock', () => {
  test('a waiter that is aborted gives up without letting later waiters jump the holder', async () => {
    const lock = createAdmissionLock();
    const holder = gate();
    const order: string[] = [];
    const first = lock(undefined, async () => { order.push('first'); await holder.opened; order.push('first done'); });
    const controller = new AbortController();
    const second = lock(controller.signal, async () => { order.push('second'); });
    const third = lock(undefined, async () => { order.push('third'); });
    controller.abort(new Error('stop'));
    await expect(second).rejects.toThrow('stop');
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['first']);
    holder.open();
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'first done', 'third']);
  });
});

describe('limits on a worker tool call', () => {
  const budgetConfig = (values: Record<string, unknown>): Partial<AgentOrchestratorRunContext> =>
    ({ configManager: { get: (key: string) => values[key] } as never });
  const contentOf = (h: ReturnType<typeof setup>) =>
    (h.requests[1]!.messages.filter((m) => m.role === 'tool') as { content: string }[]).map((m) => m.content);

  test('a call that reports more tokens than runtime.toolBudget.maxTokens comes back to the model as failed with a check-before-repeat note', async () => {
    const h = setup([
      { name: 'heavy', mode: 'serial', body: async () => ({ callId: 'x', success: true, output: 'the output', tokenCount: 900 } as ToolResult) },
    ], (n) => n === 1 ? turnOf('heavy') : done, budgetConfig({
      'runtime.toolBudget.enforced': true, 'runtime.toolBudget.maxMs': 0, 'runtime.toolBudget.maxTokens': 500, 'runtime.toolBudget.maxCostUsd': 0,
    }));
    await runAgentTask(h.context, h.record);
    const [row] = contentOf(h);
    expect(row).toContain('exceeded its budget');
    expect(row).toContain('check the result before repeating');
  });

  test('the same call is untouched while enforcement is off', async () => {
    const h = setup([
      { name: 'heavy', mode: 'serial', body: async () => ({ callId: 'x', success: true, output: 'the output', tokenCount: 900 } as ToolResult) },
    ], (n) => n === 1 ? turnOf('heavy') : done, budgetConfig({
      'runtime.toolBudget.enforced': false, 'runtime.toolBudget.maxTokens': 500,
    }));
    await runAgentTask(h.context, h.record);
    expect(contentOf(h)).toEqual(['the output']);
  });

  test('a huge result from a tool that does not limit itself is cut with a note before it enters the worker conversation', async () => {
    const huge = 'a line of tool output\n'.repeat(20_000);
    const h = setup([{ name: 'dump', mode: 'serial', body: async () => ({ callId: 'x', success: true, output: huge }) }],
      (n) => n === 1 ? turnOf('dump') : done);
    await runAgentTask(h.context, h.record);
    const [row] = contentOf(h);
    expect(row!.length).toBeLessThan(huge.length);
    expect(row).toContain('[Output cut:');
  });

  test('a read result is left whole: it already paged itself, and a second cut would drop lines its continuation says were delivered', async () => {
    const paged = JSON.stringify({ content: 'x'.repeat(130_000), summary: { truncated: { next_start_line: 9 } } });
    const h = setup([{ name: 'read', mode: 'serial', body: async () => ({ callId: 'x', success: true, output: paged }) }],
      (n) => n === 1 ? turnOf('read') : done);
    await runAgentTask(h.context, h.record);
    expect(contentOf(h)).toEqual([paged]);
  });
});
