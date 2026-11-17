// Proves: Two calls that touch the same file never run together, every call gets exactly one result (also on failure and on cancel), cancel reaches every running call, and a turn ends at its round limit and on a repeated call.
// Red when: One throwing call costs its neighbours their results, writes to one file overlap, a cancel misses a running call or a later call starts, calls run past the round ceiling without a closing answer, a cancelled batch loses a result, or a repeated call is never stopped.
/**
 * The one tool-batch executor and the one turn loop: independent calls of a
 * response run at the same time (counted, never timed), calls that could
 * depend on each other keep the model's order, every call gets exactly one
 * result in call order, one failure does not fail the others, cancelling
 * reaches every call, and a call repeated with the same result ends the turn.
 *
 * The executor, the planner, the registry and the loop are the real ones; the
 * tools are registered in the registry like any tool, and only the model's
 * responses are scripted.
 */
import { describe, expect, test } from 'bun:test';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { REPEAT_STOP_THRESHOLD, runTurn, type TurnContext, type TurnModelResponse, type TurnPolicy } from '../platform/src/platform/core/turn-loop.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { PermissionManager } from '../platform/src/platform/permissions/manager.js';
import type { ToolCall, ToolDefinition, ToolResult, ToolSideEffect } from '../platform/src/platform/types/tools.js';

interface Gate { readonly opened: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Counts calls inside their bodies at once; `reached(n)` resolves when n are in at the same time. */
function inFlight() {
  let now = 0, peak = 0;
  const waiters = new Map<number, Gate>();
  return {
    enter() { now++; peak = Math.max(peak, now); waiters.get(now)?.open(); },
    leave() { now--; },
    reached(count: number) { const g = gate(); waiters.set(count, g); if (now >= count) g.open(); return g.opened; },
    get peak() { return peak; },
  };
}

/** A tool sent to the model in full (`core`), so its first call runs instead of being answered with its schema. */
function tool(name: string, sideEffects: readonly ToolSideEffect[], body: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>, extra: Partial<ToolDefinition> = {}) {
  return {
    definition: { name, description: name, parameters: { type: 'object' }, sideEffects, core: true, ...extra } as ToolDefinition,
    async execute(args: Record<string, unknown>, options?: { signal?: AbortSignal }) {
      await body(args, options?.signal);
      return { success: true, output: `${name} ${JSON.stringify(args)}` };
    },
  };
}

// The executor's own-gate seam: an embedding's manager that answers each call. The gate itself is proved elsewhere.
const allowAll = { check: async () => true } as unknown as PermissionManager;

function execute(registry: ToolRegistry, calls: ToolCall[], extra: { turnSignal?: AbortSignal; onToolSettled?: (r: ToolResult) => void } = {}) {
  return executeToolCalls({
    toolRegistry: registry, permissionManager: allowAll, hookDispatcher: null, runtimeBus: null, sessionId: 's',
    emitterContext: () => ({ sessionId: 's', traceId: 't', source: 'test' }), workingDirectory: '/work', ...extra,
  }, 'turn', calls);
}

const read = (id: string, path: string): ToolCall => ({ id, name: 'read', arguments: { files: [{ path }] } });
const write = (id: string, path: string): ToolCall => ({ id, name: 'write', arguments: { files: [{ path }] } });

describe('the tool-batch executor', () => {
  test('one call that fails is its own failed result; the calls beside it still run and keep their output', async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool('read', ['read_fs'], async (args) => {
      const path = (args['files'] as { path: string }[])[0]!.path;
      ran.push(path);
      if (path === 'b.ts') throw new Error('b.ts is unreadable');
    }, { subjects: { paths: ['files[].path'] } }));
    const results = await execute(registry, [read('a', 'a.ts'), read('b', 'b.ts'), read('c', 'c.ts')]);
    expect(ran.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(results.map((r) => [r.callId, r.success])).toEqual([['a', true], ['b', false], ['c', true]]);
    expect(results[0]!.output).toContain('a.ts');
    expect(results[2]!.output).toContain('c.ts');
  });

  test('writes to different files run together; a write to a file already written in the batch, and a command, wait their turn', async () => {
    const events: string[] = [];
    const flight = inFlight();
    const twoWrites = flight.reached(2);
    const release = gate();
    const registry = new ToolRegistry();
    registry.register(tool('write', ['write_fs'], async (args) => {
      const path = (args['files'] as { path: string }[])[0]!.path;
      events.push(`start ${path}`); flight.enter(); if (path !== 'c.ts') await release.opened; flight.leave(); events.push(`end ${path}`);
    }, { subjects: { paths: ['files[].path'] } }));
    registry.register(tool('exec', ['exec'], async () => { events.push('exec'); }));
    const run = execute(registry, [write('w1', 'a.ts'), write('w2', '/work/b.ts'), write('w3', 'a.ts'), { id: 'x', name: 'exec', arguments: {} }, write('w4', 'c.ts')]);
    await twoWrites;
    expect(events).toEqual(['start a.ts', 'start /work/b.ts']);
    release.open();
    const results = await run;
    expect(events.indexOf('start a.ts', 1)).toBeGreaterThan(events.indexOf('end /work/b.ts'));
    expect(events.indexOf('exec')).toBeGreaterThan(events.lastIndexOf('end a.ts'));
    expect(events.indexOf('start c.ts')).toBeGreaterThan(events.indexOf('exec'));
    expect(results.map((r) => r.callId)).toEqual(['w1', 'w2', 'w3', 'x', 'w4']);
  });

  test('cancelling the turn reaches every running call and nothing after them starts', async () => {
    const controller = new AbortController();
    const flight = inFlight();
    const both = flight.reached(2);
    const aborted: string[] = [];
    let laterStarted = false;
    const registry = new ToolRegistry();
    registry.register(tool('read', ['read_fs'], async (args, signal) => {
      flight.enter();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { aborted.push(JSON.stringify(args)); resolve(); }, { once: true }));
    }, { subjects: { paths: ['files[].path'] } }));
    registry.register(tool('exec', ['exec'], async () => { laterStarted = true; }));
    const run = execute(registry, [read('a', 'a.ts'), read('b', 'b.ts'), { id: 'x', name: 'exec', arguments: {} }], { turnSignal: controller.signal });
    await both;
    controller.abort();
    await expect(run).rejects.toBeDefined();
    expect(aborted).toHaveLength(2);
    expect(laterStarted).toBe(false);
  });
});

describe('the turn loop', () => {
  const policy = (over: Partial<TurnPolicy> = {}): TurnPolicy => ({
    speaker: 'owner', budget: {}, completion: { maxRejectedDrafts: 2, deadlineMs: 1000 }, delegates: 'return',
    sink: { delta: () => {} }, ...over,
  });
  function context(responses: TurnModelResponse[], extra: Partial<TurnContext> = {}) {
    const messages: unknown[] = [];
    const requests: boolean[] = [];
    const ctx: TurnContext = {
      signal: new AbortController().signal,
      async request({ tools, onDelta }) { requests.push(tools); const next = responses.shift()!; onDelta(next.content); return next; },
      conversation: { addAssistantMessage: (content, o) => messages.push({ content, calls: o?.toolCalls?.length ?? 0 }), addToolResults: (r) => messages.push({ results: r.map((x) => x.callId) }) },
      ...extra,
    };
    return { ctx, messages, requests };
  }
  const answer = (content: string): TurnModelResponse => ({ content, toolCalls: [] });
  const calling = (...ids: string[]): TurnModelResponse => ({ content: '', toolCalls: ids.map((id) => ({ id, name: 't', arguments: {} })) });

  test('at the round limit the calls are not run and one closing request without tools gives the answer', async () => {
    const unrun: string[] = [];
    const ran: string[] = [];
    const { ctx, requests } = context([calling('a'), calling('b'), answer('closing')], {
      executeTools: async (calls) => calls.map((c) => { ran.push(c.id); return { callId: c.id, success: true }; }),
    });
    const outcome = await runTurn(ctx, policy({ budget: { turns: 2 }, sink: { delta: () => {}, unrunCalls: (calls) => unrun.push(...calls.map((c) => c.id)) } }));
    expect(ran).toEqual(['a']);
    expect(unrun).toEqual(['b']);
    expect(requests).toEqual([true, true, false]);
    expect(outcome.status).toBe('budget');
    expect(outcome.text).toBe('closing');
  });

  test('a cancel during a batch closes every call with a result, keeping the receipts that landed', async () => {
    const controller = new AbortController();
    const { ctx, messages } = context([calling('a', 'b')], {
      signal: controller.signal,
      executeTools: async (_calls, { onSettled }) => {
        onSettled({ callId: 'a', success: true, output: 'kept' });
        controller.abort();
        throw new Error('cancelled');
      },
    });
    const outcome = await runTurn(ctx, policy());
    expect(outcome.status).toBe('cancelled');
    expect(messages).toEqual([{ content: '', calls: 2 }, { results: ['a', 'b'] }]);
  });

  test('the same call returning the same result eight times ends the turn, though each run has its own call id', async () => {
    let runs = 0;
    const registry = new ToolRegistry();
    registry.register(tool('status', ['read_fs'], async () => { runs++; }));
    // The model asks for the same call every round, each time under a fresh call id, and never answers on its own.
    let round = 0;
    const requests: boolean[] = [];
    const ctx: TurnContext = {
      signal: new AbortController().signal,
      async request({ tools }) {
        requests.push(tools);
        if (!tools) return answer('stopped repeating');
        round++;
        if (round > REPEAT_STOP_THRESHOLD + 2) throw new Error('the repeat stop did not fire');
        return { content: '', toolCalls: [{ id: `call-${round}`, name: 'status', arguments: { verbose: true } }] };
      },
      conversation: { addAssistantMessage: () => {}, addToolResults: () => {} },
      executeTools: (calls, { signal, onSettled }) => execute(registry, calls, { turnSignal: signal, onToolSettled: onSettled }),
    };
    const outcome = await runTurn(ctx, policy());
    expect(outcome.status).toBe('stopped');
    expect(outcome.stop).toEqual({ rule: 'repeated-call', toolName: 'status', count: REPEAT_STOP_THRESHOLD });
    expect(outcome.text).toBe('stopped repeating');
    expect(runs).toBe(REPEAT_STOP_THRESHOLD);
    expect(requests).toEqual([...Array.from({ length: REPEAT_STOP_THRESHOLD }, () => true), false]);
  });
});
