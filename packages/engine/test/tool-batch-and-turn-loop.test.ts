/**
 * The one tool-batch executor and the one turn loop: independent calls of a
 * response run at the same time (counted, never timed), calls that could
 * depend on each other keep the model's order, every call gets exactly one
 * result in call order, and cancelling reaches every call.
 */
import { describe, expect, test } from 'bun:test';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { planToolBatch, toolCallLane } from '../platform/src/platform/core/tool-batch.js';
import { runTurn, type TurnContext, type TurnModelResponse, type TurnPolicy } from '../platform/src/platform/core/turn-loop.js';
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

function tool(name: string, sideEffects: readonly ToolSideEffect[], body: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>, extra: Partial<ToolDefinition> = {}) {
  return {
    definition: { name, description: name, parameters: { type: 'object' }, sideEffects, ...extra } as ToolDefinition,
    async execute(args: Record<string, unknown>, options?: { signal?: AbortSignal }) {
      await body(args, options?.signal);
      return { success: true, output: `${name} ${JSON.stringify(args)}` };
    },
  };
}

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
  test('eight independent reads are all in flight at once, and their results come back in the order the model asked', async () => {
    const flight = inFlight();
    const all = flight.reached(8);
    const release = gate();
    const registry = new ToolRegistry();
    registry.register(tool('read', ['read_fs'], async () => { flight.enter(); await release.opened; flight.leave(); }, { subjects: { paths: ['files[].path'] } }));
    const calls = Array.from({ length: 8 }, (_, i) => read(`r${i}`, `src/f${i}.ts`));
    const run = execute(registry, calls);
    await all;
    release.open();
    const results = await run;
    expect(flight.peak).toBe(8);
    expect(results.map((r) => r.callId)).toEqual(calls.map((c) => c.id));
    expect(results.every((r) => r.success)).toBe(true);
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

describe('which calls may share a group', () => {
  const definitions: Record<string, ToolDefinition> = {
    read: { name: 'read', description: '', parameters: {}, sideEffects: ['read_fs'], subjects: { paths: ['files[].path'] } },
    find: { name: 'find', description: '', parameters: {}, sideEffects: ['read_fs'] },
    write: { name: 'write', description: '', parameters: {}, sideEffects: ['write_fs'], subjects: { paths: ['files[].path'] } },
    plugin: { name: 'plugin', description: '', parameters: {} },
  };
  const plan = (calls: ToolCall[], cwd?: string) => planToolBatch(calls, (c) => toolCallLane(definitions[c.name], c.arguments, cwd));

  test('a read of a file written earlier in the response, and a search after a write, start after the write', () => {
    expect(plan([write('w', 'a.ts'), read('r', 'a.ts'), read('q', 'b.ts')])).toEqual([[0], [1, 2]]);
    expect(plan([write('w', 'a.ts'), { id: 'f', name: 'find', arguments: {} }])).toEqual([[0], [1]]);
  });

  test('a relative and an absolute path count as the same file unless the working directory is known', () => {
    expect(plan([write('w1', 'a.ts'), write('w2', '/work/b.ts')])).toEqual([[0], [1]]);
    expect(plan([write('w1', 'a.ts'), write('w2', '/work/b.ts')], '/work')).toEqual([[0, 1]]);
    expect(plan([write('w1', 'src'), write('w2', 'src/x.ts')], '/work')).toEqual([[0], [1]]);
  });

  test('a tool with undeclared effects runs alone', () => {
    expect(plan([read('r1', 'a'), { id: 'p', name: 'plugin', arguments: {} }, read('r2', 'b')])).toEqual([[0], [1], [2]]);
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

  test('a rejected draft is withdrawn at most twice; the third stands with a not-verified note', async () => {
    const withdrawn: string[] = [];
    const corrections: string[] = [];
    const { ctx, messages } = context([answer('one'), answer('two'), answer('three')], {
      checkDraft: async () => ({ accepted: false, reason: 'tests not run', correction: 'run the tests' }),
      correct: (text) => corrections.push(text),
    });
    const outcome = await runTurn(ctx, policy({ sink: { delta: () => {}, draftWithdrawn: (d) => withdrawn.push(d) } }));
    expect(withdrawn).toEqual(['one', 'two']);
    expect(corrections).toHaveLength(2);
    expect(outcome).toMatchObject({ status: 'answered', text: 'three', verified: false, note: 'not verified: tests not run', rejectedDrafts: 2 });
    expect(messages).toEqual([{ content: 'three', calls: 0 }]);
  });

  test('at the round limit the calls are answered as not run and one closing request without tools gives the answer', async () => {
    const unrun: string[] = [];
    const { ctx, requests } = context([calling('a'), calling('b'), answer('closing')], {
      executeTools: async (calls) => calls.map((c) => ({ callId: c.id, success: true })),
    });
    const outcome = await runTurn(ctx, policy({ budget: { turns: 2 }, sink: { delta: () => {}, unrunCalls: (calls) => unrun.push(...calls.map((c) => c.id)) } }));
    expect(unrun).toEqual(['b']);
    expect(requests).toEqual([true, true, false]);
    expect(outcome).toMatchObject({ status: 'budget', text: 'closing' });
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
});
