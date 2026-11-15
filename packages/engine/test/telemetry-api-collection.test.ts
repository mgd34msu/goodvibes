import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '../platform/src/platform/runtime/events/index.js';
import { emitTaskStarted } from '../platform/src/platform/runtime/emitters/tasks.js';
import { emitTurnCompleted, emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { TelemetryApiService, type TelemetryRecord } from '../platform/src/platform/runtime/telemetry/api.js';
import {
  buildAttributes,
  buildOtlpTraceDocumentFromSpans,
} from '../platform/src/platform/runtime/telemetry/api-helpers.js';
import { createTelemetryEventStream } from '../platform/src/platform/runtime/telemetry/api-stream.js';
import { SpanKind, SpanStatusCode, type ReadableSpan } from '../platform/src/platform/runtime/telemetry/types.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const services: TelemetryApiService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function makeService(options: { eventLimit?: number } = {}): { bus: RuntimeEventBus; service: TelemetryApiService } {
  const bus = new RuntimeEventBus();
  const service = new TelemetryApiService({
    runtimeBus: bus,
    runtimeStore: createRuntimeStore(),
    includeRawPrompts: () => true,
    ...options,
  });
  services.push(service);
  return { bus, service };
}

function emitSwapFailed(bus: RuntimeEventBus, reason: string, extra: Record<string, unknown> = {}): void {
  bus.emit('workspace', createEventEnvelope('WORKSPACE_SWAP_FAILED', {
    type: 'WORKSPACE_SWAP_FAILED', from: '/a', to: '/b', code: 'UNKNOWN', reason, ...extra,
  } as never, { sessionId: 's', source: 'test', traceId: '123e4567-e89b-12d3-a456-426614174000' }));
}

const ctx = { sessionId: 's', source: 'test', traceId: '123e4567-e89b-12d3-a456-426614174000' } as const;

describe('telemetry paging', () => {
  test('following nextCursor returns every event exactly once, newest first', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 5; i += 1) emitSwapFailed(bus, `swap ${i}`);
    await flush();
    const all = service.listEvents({ limit: 10 }, 'raw').map((record) => record.id);
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = service.listEventPage({ limit: 2, ...(cursor ? { cursor } : {}) }, 'raw', true);
      seen.push(...response.items.map((record) => record.id));
      cursor = response.pageInfo.nextCursor;
      if (!response.pageInfo.hasMore) break;
    }
    expect(seen).toEqual(all);
  });

  test('error pages lose nothing at a page boundary', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 5; i += 1) emitSwapFailed(bus, `swap ${i}`);
    await flush();
    const all = service.listErrors({ limit: 10 }, 'raw').map((record) => record.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = service.listErrorPage({ limit: 2, ...(cursor ? { cursor } : {}) }, 'raw', true);
      seen.push(...response.items.map((record) => record.id));
      cursor = response.pageInfo.nextCursor;
      if (!response.pageInfo.hasMore) break;
    }
    expect(all).toHaveLength(5);
    expect(seen).toEqual(all);
  });

  test('span pages lose nothing at a page boundary', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 5; i += 1) {
      emitTurnSubmitted(bus, { ...ctx, turnId: `turn-${i}` }, { turnId: `turn-${i}`, prompt: 'p' });
      emitTurnCompleted(bus, { ...ctx, turnId: `turn-${i}` }, { turnId: `turn-${i}`, response: 'r', stopReason: 'completed' });
    }
    await flush();
    const all = service.listSpans({ limit: 10 }, 'raw').map((span) => span.spanContext.spanId);
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = service.listSpanPage({ limit: 2, ...(cursor ? { cursor } : {}) }, 'raw', true);
      seen.push(...response.items.map((span) => span.spanContext.spanId));
      cursor = response.pageInfo.nextCursor;
      if (!response.pageInfo.hasMore) break;
    }
    expect(seen).toEqual(all);
  });
});

async function readTelemetryIds(response: Response, expected: number, abort: () => void): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const ids: string[] = [];
  let sawReady = false;
  while (!sawReady || ids.length < expected) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (text.startsWith('event: ready')) sawReady = true;
    const match = /^id: (.+)$/m.exec(text);
    if (match) ids.push(match[1]!);
  }
  abort();
  await reader.cancel().catch(() => undefined);
  return ids;
}

describe('telemetry event stream', () => {
  test('a reconnect replays the events after Last-Event-ID, oldest first, and none before it', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 5; i += 1) emitSwapFailed(bus, `swap ${i}`);
    await flush();
    const oldestFirst = service.listEvents({ limit: 10 }, 'raw').map((record) => record.id).reverse();

    const controller = new AbortController();
    const request = new Request('http://localhost/telemetry', {
      headers: { 'last-event-id': oldestFirst[2]! },
      signal: controller.signal,
    });
    const replayed = await readTelemetryIds(service.createStream(request, {}, 'raw', true), 2, () => controller.abort());

    expect(replayed).toEqual([oldestFirst[3]!, oldestFirst[4]!]);
  });

  test('a replay is limited to the events nearest the cursor', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 6; i += 1) emitSwapFailed(bus, `swap ${i}`);
    await flush();
    const oldestFirst = service.listEvents({ limit: 10 }, 'raw').map((record) => record.id).reverse();

    const controller = new AbortController();
    const request = new Request('http://localhost/telemetry', {
      headers: { 'last-event-id': oldestFirst[0]! },
      signal: controller.signal,
    });
    const replayed = await readTelemetryIds(service.createStream(request, { limit: 2 }, 'raw', true), 2, () => controller.abort());

    expect(replayed).toEqual([oldestFirst[1]!, oldestFirst[2]!]);
  });

  function streamHarness(signal: AbortSignal) {
    const state = { listener: undefined as ((record: TelemetryRecord) => void) | undefined, unsubscribed: false };
    const response = createTelemetryEventStream({
      request: new Request('http://localhost/telemetry', { signal }),
      filter: {},
      view: 'raw',
      rawAccessible: true,
      assertViewAvailable: () => undefined,
      records: [],
      matchesRecord: () => true,
      subscribe: (listener) => {
        state.listener = listener;
        return () => { state.unsubscribed = true; };
      },
      getCapabilities: () => ({
        signals: { events: true, errors: true, metrics: true, traces: false },
        encodings: { json: true, sse: true, otlpJson: { traces: true, metrics: true, logs: true } },
      }),
      getSubscriberCount: () => (state.unsubscribed ? 0 : 1),
    });
    return { state, response };
  }

  test('a client that never reads is disconnected instead of queueing every event', async () => {
    const { state, response } = streamHarness(new AbortController().signal);
    const record: TelemetryRecord = {
      id: 'ops:X:1:1', domain: 'ops', type: 'X', timestamp: 1, severity: 'info', traceId: 't', sessionId: 's',
      source: 'test', message: 'm', payload: {}, attributes: {},
    };
    for (let i = 0; i < 3000; i += 1) state.listener?.({ ...record, id: `ops:X:1:${i}` });

    expect(state.unsubscribed).toBe(true);
    const reader = response.body!.getReader();
    let chunks = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks += 1;
    }
    expect(chunks).toBeLessThan(3000);
  });

  test('a request already aborted leaves no subscription behind', () => {
    const { state } = streamHarness(AbortSignal.abort());
    expect(state.unsubscribed).toBe(true);
  });
});

describe('telemetry collection', () => {
  test('events of the workspace domain are collected', async () => {
    const { bus, service } = makeService();
    emitSwapFailed(bus, 'mkdir failed');
    await flush();

    expect(service.listEvents({}, 'raw').map((record) => record.type)).toEqual(['WORKSPACE_SWAP_FAILED']);
    expect(service.listErrors({}, 'raw')).toHaveLength(1);
  });

  test('aggregates count everything recorded, not only what the ring still holds', async () => {
    const { bus, service } = makeService({ eventLimit: 5 });
    for (let i = 0; i < 12; i += 1) emitSwapFailed(bus, `swap ${i}`);
    await flush();

    const aggregates = service.getAggregates();
    expect(service.listEvents({ limit: 50 }, 'raw')).toHaveLength(5);
    expect(aggregates.totalEvents).toBe(12);
    expect(aggregates.byDomain['workspace']).toBe(12);
    expect(aggregates.totalErrors).toBe(12);
    expect(Object.values(aggregates.errorsByCategory).reduce((sum, count) => sum + count, 0)).toBe(12);
  });

  test('warnings are counted when recorded, not from a capped listing', async () => {
    const { bus, service } = makeService({ eventLimit: 600 });
    for (let i = 0; i < 520; i += 1) {
      bus.emit('tasks', createEventEnvelope('TASK_BLOCKED', {
        type: 'TASK_BLOCKED', taskId: `t-${i}`, reason: 'waiting',
      } as never, ctx));
    }
    await flush();
    const warnings = service.listEvents({ severity: 'warn', limit: 500 }, 'raw').length;

    expect(warnings).toBe(500);
    expect(service.getAggregates().totalWarnings).toBe(520);
  });

  test('a payload field named like an envelope field does not replace the envelope value', async () => {
    const { bus, service } = makeService();
    emitSwapFailed(bus, 'x', { severity: 'payload-severity', source: 'payload-source' });
    await flush();
    const [record] = service.listEvents({}, 'raw');

    expect(record?.attributes['source']).toBe('test');
    expect(record?.attributes['domain']).toBe('workspace');
    expect(record?.payload).toMatchObject({ severity: 'payload-severity', source: 'payload-source' });
  });

  test('span attributes carry the envelope severity and source over payload fields', async () => {
    const { bus, service } = makeService();
    emitTurnSubmitted(bus, { ...ctx, turnId: 'turn-1' }, { turnId: 'turn-1', prompt: 'p' });
    bus.emit('turn', createEventEnvelope('TURN_ERROR', {
      type: 'TURN_ERROR', turnId: 'turn-1', error: 'boom', severity: 'payload-severity', source: 'payload-source',
    } as never, { ...ctx, turnId: 'turn-1' }));
    await flush();
    const [span] = service.listSpans({}, 'raw');

    expect(span?.attributes['severity']).toBe('error');
    expect(span?.attributes['source']).toBe('test');
  });

  test('a failure event with no error text still ends its collector span as an error', async () => {
    const { bus, service } = makeService();
    emitTurnSubmitted(bus, { ...ctx, turnId: 'turn-1' }, { turnId: 'turn-1', prompt: 'p' });
    bus.emit('turn', createEventEnvelope('TURN_ERROR', { type: 'TURN_ERROR', turnId: 'turn-1' } as never, { ...ctx, turnId: 'turn-1' }));
    await flush();
    const [span] = service.listSpans({}, 'raw');

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('TURN_ERROR');
  });

  test('buildAttributes keeps the envelope fields when the payload reuses their names', () => {
    const attributes = buildAttributes('turn', { type: 'TURN_SUBMITTED', source: 'envelope', traceId: 'tr', sessionId: 's' } as never, {
      source: 'payload', domain: 'payload', eventType: 'payload',
    });
    expect(attributes).toMatchObject({ source: 'envelope', domain: 'turn', eventType: 'TURN_SUBMITTED' });
  });
});

describe('telemetry span bookkeeping', () => {
  type Internals = {
    turnSpanIds: Map<string, string>;
    activeTurnSpans: Map<string, unknown>;
    taskSpanIds: Map<string, string>;
    activeTaskSpans: Map<string, unknown>;
  };

  test('a finished turn leaves no entry behind', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 50; i += 1) {
      emitTurnSubmitted(bus, { ...ctx, turnId: `turn-${i}` }, { turnId: `turn-${i}`, prompt: 'p' });
      emitTurnCompleted(bus, { ...ctx, turnId: `turn-${i}` }, { turnId: `turn-${i}`, response: 'r', stopReason: 'completed' });
    }
    await flush();
    const internals = service as unknown as Internals;

    expect(internals.turnSpanIds.size).toBe(0);
    expect(internals.activeTurnSpans.size).toBe(0);
  });

  test('starts that never end are capped rather than kept for the life of the process', async () => {
    const { bus, service } = makeService();
    for (let i = 0; i < 1100; i += 1) emitTaskStarted(bus, { ...ctx, taskId: `task-${i}` }, { taskId: `task-${i}` });
    await flush();
    const internals = service as unknown as Internals;

    expect(internals.activeTaskSpans.size).toBe(1000);
    expect(internals.taskSpanIds.size).toBe(1000);
    expect(internals.taskSpanIds.has('task-0')).toBe(false);
    expect(internals.taskSpanIds.has('task-1099')).toBe(true);
  });
});

describe('OTLP trace document', () => {
  test('span kinds use the OTLP numbering, which starts at 1', () => {
    const span = (kind: ReadableSpan['kind']): ReadableSpan => ({
      name: 's', kind, spanContext: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), isValid: true },
      startTimeMs: 1, endTimeMs: 2, durationMs: 1, attributes: {}, events: [],
      status: { code: SpanStatusCode.OK }, instrumentationScope: 'x',
    });
    const document = buildOtlpTraceDocumentFromSpans([span(SpanKind.INTERNAL), span(SpanKind.CLIENT)]) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ kind: number }> }> }>;
    };
    expect(document.resourceSpans[0]!.scopeSpans[0]!.spans.map((entry) => entry.kind)).toEqual([1, 3]);
  });
});

describe('OTLP trace ingest', () => {
  test('the service round-trips its own OTLP trace output', async () => {
    const source = makeService();
    emitTurnSubmitted(source.bus, { ...ctx, turnId: 'turn-1' }, { turnId: 'turn-1', prompt: 'p' });
    emitTurnCompleted(source.bus, { ...ctx, turnId: 'turn-1' }, { turnId: 'turn-1', response: 'r', stopReason: 'completed' });
    await flush();
    const [original] = source.service.listSpans({}, 'raw');
    const document = source.service.buildOtlpTraceDocument({}, 'raw');

    const sink = makeService();
    sink.service.ingestTraces(document);
    const ingested = sink.service.listSpans({}, 'raw').find((span) => span.spanContext.spanId === original!.spanContext.spanId);

    expect(ingested).toBeDefined();
    expect(ingested!.startTimeMs).toBe(original!.startTimeMs);
    expect(ingested!.endTimeMs).toBe(original!.endTimeMs);
    expect(ingested!.durationMs).toBe(original!.durationMs);
    expect(ingested!.kind).toBe(original!.kind);
    expect(ingested!.status.code).toBe(original!.status.code);
    expect(ingested!.attributes['eventType']).toBe(original!.attributes['eventType']);
  });

  test('parentage, string nanosecond times and attributes from a foreign sender are kept', () => {
    const { service } = makeService();
    service.ingestTraces({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: 'c'.repeat(32),
            spanId: 'd'.repeat(16),
            parentSpanId: 'e'.repeat(16),
            name: 'client.call',
            kind: 3,
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000000250000000',
            attributes: [{ key: 'http.status', value: { intValue: '200' } }, { key: 'peer', value: { stringValue: 'x' } }],
            status: { code: 2, message: 'bad' },
          }],
        }],
      }],
    });
    const [span] = service.listSpans({}, 'raw');

    expect(span).toMatchObject({
      name: 'client.call',
      kind: SpanKind.CLIENT,
      parentSpanId: 'e'.repeat(16),
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_250,
      durationMs: 250,
      attributes: { 'http.status': 200, peer: 'x' },
      status: { code: SpanStatusCode.ERROR, message: 'bad' },
    });
  });
});
