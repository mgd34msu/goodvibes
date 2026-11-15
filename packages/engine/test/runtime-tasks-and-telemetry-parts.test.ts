import { afterEach, describe, expect, jest, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLedgerExporter } from '../platform/src/platform/runtime/telemetry/exporters/local-ledger.js';
import { OtlpExporter } from '../platform/src/platform/runtime/telemetry/exporters/otlp.js';
import { RuntimeMeter } from '../platform/src/platform/runtime/telemetry/meter.js';
import { RuntimeTracer } from '../platform/src/platform/runtime/telemetry/tracer.js';
import { DomainBridge } from '../platform/src/platform/runtime/telemetry/instrumentation/domain-bridge.js';
import { endAgentSpan } from '../platform/src/platform/runtime/telemetry/spans/agent.js';
import { endCompactionSpan } from '../platform/src/platform/runtime/telemetry/spans/compaction.js';
import { endPluginSpan } from '../platform/src/platform/runtime/telemetry/spans/plugin.js';
import { endSessionSpan } from '../platform/src/platform/runtime/telemetry/spans/session.js';
import { endTaskSpan } from '../platform/src/platform/runtime/telemetry/spans/task.js';
import { endToolSpan } from '../platform/src/platform/runtime/telemetry/spans/tool.js';
import { endTurnSpan } from '../platform/src/platform/runtime/telemetry/spans/turn.js';
import {
  SpanKind,
  SpanStatusCode,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanStatus,
} from '../platform/src/platform/runtime/telemetry/types.js';
import { emitTaskCreated } from '../platform/src/platform/runtime/emitters/tasks.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { TaskTransitionError, TaskVerbUnsupportedError, UnifiedTaskManager } from '../platform/src/platform/runtime/tasks/manager.js';
import { ProcessTaskAdapter } from '../platform/src/platform/runtime/tasks/adapters/process-adapter.js';

const realFetch = globalThis.fetch;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

function makeSpan(kind: ReadableSpan['kind'], spanId: string): ReadableSpan {
  return {
    name: 'llm.call', kind, spanContext: { traceId: 'a'.repeat(32), spanId, isValid: true },
    startTimeMs: 1, endTimeMs: 2, durationMs: 1, attributes: {}, events: [],
    status: { code: SpanStatusCode.OK }, instrumentationScope: 'test',
  };
}

describe('OtlpExporter', () => {
  test('spans below the batch size are sent after the flush interval, with OTLP span kinds', async () => {
    jest.useFakeTimers();
    const posts: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ kind: number }> }> }> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const exporter = new OtlpExporter({
      endpoint: 'http://collector.invalid/v1/traces', batchSize: 512, timeoutMs: 1000, flushIntervalMs: 100,
    });

    await exporter.export([makeSpan(SpanKind.CLIENT, '1'.repeat(16)), makeSpan(SpanKind.INTERNAL, '2'.repeat(16)), makeSpan(SpanKind.SERVER, '3'.repeat(16))]);
    expect(posts).toHaveLength(0);
    jest.advanceTimersByTime(100);

    expect(posts).toHaveLength(1);
    const spans = posts[0]!.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((span) => span.kind)).toEqual([3, 1, 2]);

    jest.useRealTimers();
    await exporter.shutdown();
  });
});

describe('RuntimeMeter', () => {
  test('a series is read back with the same labels it was written with', () => {
    const meter = new RuntimeMeter({ scope: 'test' });
    const labels = { provider: 'a', sessionId: 'not-allowlisted' };
    meter.counter('c').add(2, labels);
    meter.gauge('g').set(7, labels);
    meter.histogram('h').record(4, labels);

    expect(meter.counter('c').value(labels)).toBe(2);
    expect(meter.gauge('g').value(labels)).toBe(7);
    expect(meter.histogram('h').snapshot(labels).count).toBe(1);
  });
});

describe('span end status', () => {
  function fakeSpan(): { span: Span; status: () => SpanStatus | undefined } {
    let status: SpanStatus | undefined;
    const span = {
      ended: false,
      setStatus: (next: SpanStatus) => { status = next; },
      setAttribute: () => span,
      setAttributes: () => span,
      addEvent: () => span,
      end: () => undefined,
    } as unknown as Span;
    return { span, status: () => status };
  }

  const failures: Array<[string, (span: Span) => void]> = [
    ['agent', (span) => endAgentSpan(span, { outcome: 'failed', durationMs: 1 })],
    ['task', (span) => endTaskSpan(span, { outcome: 'failed', durationMs: 1 })],
    ['tool', (span) => endToolSpan(span, { outcome: 'failed', durationMs: 1 })],
    ['turn', (span) => endTurnSpan(span, { outcome: 'error' })],
    ['session', (span) => endSessionSpan(span, { outcome: 'recovery_failed' })],
    ['plugin', (span) => endPluginSpan(span, { outcome: 'error' })],
    ['compaction', (span) => endCompactionSpan(span, { outcome: 'failed', tokensBefore: 1 })],
  ];

  test.each(failures)('the %s span of a failure with no message is exported as an error', (_name, end) => {
    const { span, status } = fakeSpan();
    end(span);
    expect(status()?.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('DomainBridge', () => {
  function capturingTracer(): { tracer: RuntimeTracer; exported: ReadableSpan[] } {
    const exported: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      name: 'capture',
      export: async (spans) => { exported.push(...spans); },
      flush: async () => undefined,
      shutdown: async () => undefined,
    };
    return { tracer: new RuntimeTracer({ scope: 'test', enabled: true, exporters: [exporter] }), exported };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const ctx = { sessionId: 's', source: 'test', traceId: '123e4567-e89b-12d3-a456-426614174000' } as const;

  test('a repeated start event ends the earlier span, and detaching ends what is still open', async () => {
    const { tracer, exported } = capturingTracer();
    const bus = new RuntimeEventBus();
    const detach = new DomainBridge(tracer).attach(bus);

    emitTaskCreated(bus, { ...ctx, taskId: 't1' }, { taskId: 't1', description: 'first', priority: 0 });
    emitTaskCreated(bus, { ...ctx, taskId: 't1' }, { taskId: 't1', description: 'second', priority: 0 });
    await flush();
    expect(exported).toHaveLength(1);

    detach();
    expect(exported).toHaveLength(2);
  });

  test('an event without a trace id still gets a valid trace id', async () => {
    const { tracer, exported } = capturingTracer();
    const bus = new RuntimeEventBus();
    const detach = new DomainBridge(tracer).attach(bus);

    emitTaskCreated(bus, { sessionId: 's', source: 'test', traceId: '', taskId: 't2' }, { taskId: 't2', description: 'd', priority: 0 });
    await flush();
    detach();

    expect(exported).toHaveLength(1);
    expect(exported[0]!.spanContext.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exported[0]!.spanContext.isValid).toBe(true);
  });
});

describe('UnifiedTaskManager', () => {
  function setup() {
    const store = createRuntimeStore();
    const manager = new UnifiedTaskManager(store, new RuntimeEventBus(), 's');
    return { store, manager, dispatch: createDomainDispatch(store) };
  }

  test('a late completion cannot overwrite a cancel made by another writer', () => {
    const { store, manager, dispatch } = setup();
    const task = manager.createTask({ kind: 'exec', title: 't', owner: 'o' });
    manager.startTask(task.id);
    dispatch.transitionRuntimeTask(task.id, 'cancelled', { endedAt: 5 }, 'ops');

    expect(() => manager.completeTask(task.id)).toThrow(TaskTransitionError);
    expect(store.getState().tasks.tasks.get(task.id)!.status).toBe('cancelled');
    expect(manager.getTaskStatus(task.id)).toBe('cancelled');
  });

  test('queries reflect a change another writer made in the store', () => {
    const { manager, dispatch } = setup();
    const task = manager.createTask({ kind: 'exec', title: 't', owner: 'o' });
    manager.startTask(task.id);
    expect(manager.getRunningTasks().map((entry) => entry.id)).toEqual([task.id]);

    dispatch.transitionRuntimeTask(task.id, 'completed', { endedAt: 5 }, 'adapter');

    expect(manager.getRunningTasks()).toEqual([]);
    expect(manager.getRunningCount('exec')).toBe(0);
  });

  test('a task the store evicted is dropped from the registry instead of staying running', () => {
    const { store, manager, dispatch } = setup();
    const stale = manager.createTask({ kind: 'exec', title: 'stale', owner: 'o' });
    manager.startTask(stale.id);
    // Another writer ends it, then enough ended tasks arrive that the store evicts it before the manager reads.
    dispatch.transitionRuntimeTask(stale.id, 'completed', { endedAt: 1 }, 'adapter');
    for (let i = 0; i < 1100; i += 1) {
      dispatch.syncRuntimeTask({
        id: `ended-${i}`, kind: 'exec', title: 'e', status: 'completed', owner: 'o', cancellable: true,
        childTaskIds: [], queuedAt: 2 + i, endedAt: 2 + i,
      }, 'adapter');
    }
    expect(store.getState().tasks.tasks.has(stale.id)).toBe(false);

    expect(manager.getRunningTasks()).toEqual([]);
    expect(manager.getRunningCount('exec')).toBe(0);
    expect(manager.getTask(stale.id)).toBeUndefined();
  });

  test('a child is linked to a parent the manager did not create', () => {
    const { store, manager, dispatch } = setup();
    dispatch.syncRuntimeTask({
      id: 'external-parent', kind: 'exec', title: 'p', status: 'running', owner: 'o', cancellable: true,
      childTaskIds: [], queuedAt: 1,
    }, 'adapter');
    const child = manager.createTask({ kind: 'exec', title: 'c', owner: 'o', parentTaskId: 'external-parent' });

    expect(store.getState().tasks.tasks.get('external-parent')!.childTaskIds).toEqual([child.id]);
  });

  test('a failure is final: nothing re-queues a task that no runner would start', () => {
    const { manager } = setup();
    const task = manager.createTask({
      kind: 'exec', title: 't', owner: 'o',
      retryPolicy: { maxAttempts: 3, currentAttempt: 0, delayMs: 100, backoff: 'exponential', retryOn: ['transient'] },
    });
    manager.startTask(task.id);
    expect(manager.failTask(task.id, { error: 'boom' }).status).toBe('failed');
  });

  test('a verb the owner does not implement is refused and leaves the row unchanged', () => {
    const { manager } = setup();
    const task = manager.createTask({ kind: 'exec', title: 't', owner: 'o' });
    manager.startTask(task.id);
    expect(() => manager.cancelTask(task.id)).toThrow(TaskVerbUnsupportedError);
    expect(manager.getTask(task.id)?.status).toBe('running');
  });
});

describe('ProcessTaskAdapter.sync', () => {
  test('a process the manager no longer lists leaves no pid entry behind', () => {
    const store = createRuntimeStore();
    let processes = [{ id: 'bg_1', pid: 41, cmd: 'sleep' }];
    const manager = {
      list: () => processes,
      getStatus: () => ({ pid: 41, done: false, exitCode: undefined }),
      stop: () => undefined,
    };
    const adapter = new ProcessTaskAdapter(store, manager as never);
    adapter.sync();
    const pids = (): number => (adapter as unknown as { _pidToId: Map<number, string> })._pidToId.size;
    expect(pids()).toBe(1);

    processes = [];
    adapter.sync();

    expect(pids()).toBe(0);
  });
});

describe('LocalLedgerExporter retention', () => {
  test('recording events alone reclaims files past the size cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodvibes-ledger-retention-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'spans.jsonl');
    const backup = `${filePath}.1`;
    writeFileSync(backup, 'x'.repeat(4096), 'utf8');
    const old = new Date(Date.now() - 60_000);
    utimesSync(backup, old, old);
    const exporter = new LocalLedgerExporter({
      filePath,
      atRestPolicy: { redact: false, retention: { maxAgeMs: 365 * 24 * 60 * 60 * 1000, maxTotalBytes: 1024 } },
    });

    for (let rev = 1; rev <= 200; rev += 1) {
      exporter.recordEvent({ runId: 'run-1', rev, eventName: 'TEST', payload: {}, ts: rev });
    }

    expect(existsSync(backup)).toBe(false);
  });
});
