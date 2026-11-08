import { afterEach, expect, test } from 'bun:test';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { emitOpsContextWarning } from '../sdk/src/platform/runtime/emitters/ops.js';
import { emitTurnCompleted, emitTurnError, emitTurnSubmitted } from '../sdk/src/platform/runtime/emitters/turn.js';
import { emitToolExecuting, emitToolSucceeded } from '../sdk/src/platform/runtime/emitters/tools.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';
import { TelemetryApiService } from '../sdk/src/platform/runtime/telemetry/api.js';
import { TelemetryTraceIdentities } from '../sdk/src/platform/runtime/telemetry/trace-identities.js';

const services: TelemetryApiService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function fixture(limits: { readonly eventLimit?: number; readonly errorLimit?: number; readonly spanLimit?: number } = {}) {
  const bus = new RuntimeEventBus();
  const service = new TelemetryApiService({ runtimeBus: bus, runtimeStore: createRuntimeStore(), includeRawPrompts: () => true, ...limits });
  services.push(service);
  const warn = (traceId: string, usage = 0.9) => emitOpsContextWarning(bus, { sessionId: 'identity-test', traceId, source: 'test' }, { usage, threshold: 0.8 });
  return { bus, service, warn };
}

function valid(id: string): void {
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(id).not.toBe('0'.repeat(32));
}

function logs(traceId: string) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId, body: { stringValue: 'Imported log' } }] }] }] };
}
function traces(traceId: string) {
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId: '123456789abcdef0', name: 'imported span' }] }] }] };
}

test('native IDs keep their exact bits, arbitrary labels do not collapse, and collectors own their aliases', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const first = fixture();
  const second = fixture();
  // The old strip/pad rule maps both of these labels to the same hex string.
  for (const label of ['trace:x', 'r-ace:x', '0123456789ABCDEF0123456789ABCDEF', '12345678-1234-4234-8234-123456789abc', '0'.repeat(32)]) first.warn(label);
  second.warn('trace:x');
  await flush();
  const a = first.service.listEvents({ traceId: 'trace:x' }, 'raw');
  const b = first.service.listEvents({ traceId: 'r-ace:x' }, 'raw');
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]!.traceId).not.toBe(b[0]!.traceId);
  expect(a[0]!.attributes.traceId).toBe(a[0]!.traceId);
  expect(first.service.listEvents({ traceId: 'never-observed' }, 'raw')).toEqual([]);
  expect(first.service.listEvents({ traceId: '0123456789abcdef0123456789abcdef' }, 'raw')[0]!.traceId).toBe('0123456789abcdef0123456789abcdef');
  expect(first.service.listEvents({ traceId: '12345678123442348234123456789abc' }, 'raw')[0]!.traceId).toBe('12345678123442348234123456789abc');
  expect(second.service.listEvents({ traceId: 'trace:x' }, 'raw')[0]!.traceId).not.toBe(a[0]!.traceId);
  for (const record of first.service.listEvents({}, 'raw')) valid(record.traceId);
}));

test('runtime records, imported logs and imported spans resolve one retained alias across queries and OTLP exports', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { service, warn } = fixture();
  const alias = 'one operation trace';
  warn(alias);
  await flush();
  const id = service.listEvents({ traceId: alias }, 'raw')[0]!.traceId;
  service.ingestLogs(logs(alias));
  service.ingestTraces(traces(alias));
  const events = service.listEvents({ traceId: alias }, 'raw');
  expect(events).toHaveLength(2);
  expect(events.every(record => record.traceId === id)).toBe(true);
  expect(service.listEventPage({ traceId: id }, 'raw').items).toEqual(events);
  const spans = service.listSpans({ traceId: alias }, 'raw');
  expect(spans).toHaveLength(1);
  expect(spans[0]!.spanContext.traceId).toBe(id);
  expect(service.listSpanPage({ traceId: id }, 'raw').items).toEqual(spans);
  const logDocument = JSON.stringify(service.buildOtlpLogDocument({ traceId: alias }, 'raw'));
  const traceDocument = JSON.stringify(service.buildOtlpTraceDocument({ traceId: alias }, 'raw'));
  expect(logDocument).toContain(`"traceId":"${id}"`);
  expect(traceDocument).toContain(`"traceId":"${id}"`);
}));

test('active spans preserve alias identity after event eviction and completed spans retain it until their eviction', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { bus, service, warn } = fixture({ eventLimit: 1, spanLimit: 1, errorLimit: 0 });
  const context = { sessionId: 'identity-test', turnId: 'active-turn', traceId: 'active operation', source: 'test' };
  emitTurnSubmitted(bus, context, { turnId: context.turnId, prompt: 'Start work' });
  await flush();
  const id = service.listEvents({ traceId: context.traceId }, 'raw')[0]!.traceId;
  warn('unrelated event');
  await flush();
  expect(service.listEvents({ traceId: context.traceId }, 'raw')).toEqual([]);
  emitTurnCompleted(bus, context, { turnId: context.turnId, response: 'Completed', stopReason: 'completed' });
  await flush();
  expect(service.listEvents({ traceId: context.traceId }, 'raw')[0]!.traceId).toBe(id);
  expect(service.listSpans({ traceId: context.traceId }, 'raw')[0]!.spanContext.traceId).toBe(id);
  warn('another unrelated event');
  await flush();
  expect(service.listEvents({ traceId: context.traceId }, 'raw')).toEqual([]);
  expect(service.listSpans({ traceId: context.traceId }, 'raw')[0]!.spanContext.traceId).toBe(id);
  service.ingestTraces(traces('replacement span'));
  expect(service.listSpans({ traceId: context.traceId }, 'raw')).toEqual([]);
  warn(context.traceId);
  await flush();
  expect(service.listEvents({ traceId: context.traceId }, 'raw')[0]!.traceId).not.toBe(id);
}));

test('the error buffer retains its trace after ordinary events and completed spans have been evicted', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { bus, service, warn } = fixture({ eventLimit: 1, errorLimit: 1, spanLimit: 0 });
  const context = { sessionId: 'identity-test', turnId: 'failed-turn', traceId: 'retained failure', source: 'test' };
  emitTurnError(bus, context, { turnId: context.turnId, error: 'Synthetic failed operation', stopReason: 'provider_error' });
  await flush();
  const id = service.listErrors({ traceId: context.traceId }, 'raw')[0]!.traceId;
  warn('another trace');
  await flush();
  expect(service.listEvents({ traceId: context.traceId }, 'raw')).toEqual([]);
  expect(service.listSpans({ traceId: context.traceId }, 'raw')).toEqual([]);
  expect(service.listErrorPage({ traceId: context.traceId }, 'raw').items[0]!.traceId).toBe(id);
  service.dispose();
  expect(service.listErrors({ traceId: context.traceId }, 'raw')[0]!.traceId).toBe(id);
}));

test('parent and child spans keep their trace and parent link through intervening event eviction', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { bus, service, warn } = fixture({ eventLimit: 1, spanLimit: 4 });
  const context = { sessionId: 'identity-test', turnId: 'parent-turn', traceId: 'shared parent trace', source: 'test' };
  emitTurnSubmitted(bus, context, { turnId: context.turnId, prompt: 'Start parent' });
  emitToolExecuting(bus, context, { callId: 'child-call', turnId: context.turnId, tool: 'read', startedAt: Date.now() });
  await flush();
  const id = service.listEvents({ traceId: context.traceId }, 'raw')[0]!.traceId;
  warn('intervening trace');
  await flush();
  emitTurnCompleted(bus, context, { turnId: context.turnId, response: 'Parent finished', stopReason: 'completed' });
  emitToolSucceeded(bus, context, { callId: 'child-call', turnId: context.turnId, tool: 'read', durationMs: 5 });
  await flush();
  const spans = service.listSpans({ traceId: context.traceId }, 'raw');
  const parent = spans.find(span => span.name === 'turn.lifecycle');
  const child = spans.find(span => span.name === 'tool.execute');
  expect(parent?.spanContext.traceId).toBe(id);
  expect(child?.spanContext.traceId).toBe(id);
  expect(child?.parentSpanId).toBe(parent?.spanContext.spanId);
}));

test('a subscriber cannot change the identity that buffer ownership will later release', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { service, warn } = fixture({ eventLimit: 1 });
  let changed: boolean | undefined;
  service.subscribe(record => { changed = Reflect.set(record, 'traceId', 'rewritten by borrower'); });
  warn('borrowed identity');
  await flush();
  expect(changed).toBe(false);
  const id = service.listEvents({ traceId: 'borrowed identity' }, 'raw')[0]!.traceId;
  valid(id);
  warn('replacement');
  await flush();
  expect(service.listEvents({ traceId: 'borrowed identity' }, 'raw')).toEqual([]);
  warn('borrowed identity');
  await flush();
  expect(service.listEvents({ traceId: 'borrowed identity' }, 'raw')[0]!.traceId).not.toBe(id);
}));

test('a stream opened before its first alias event uses the live identity and ignores unrelated events', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const { service, warn } = fixture({ eventLimit: 0, errorLimit: 0, spanLimit: 0 });
  const controller = new AbortController();
  const response = service.createStream(new Request('http://localhost/telemetry/stream', { signal: controller.signal }), { traceId: 'future trace', view: 'raw' });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const read = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('No matching telemetry event')), 1000); })]);
      return decoder.decode(result.value);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  };
  try {
    expect(await read()).toContain('event: ready');
    warn('unrelated trace', 0.81);
    warn('future trace', 0.93);
    await flush();
    const chunk = await read();
    expect(chunk).toContain('event: telemetry');
    expect(chunk).toContain('0.93');
    expect(chunk).not.toContain('0.81');
    const data = chunk.split('\n').find(line => line.startsWith('data: '));
    const record = JSON.parse(data!.slice(6)) as { traceId: string };
    valid(record.traceId);
    expect(service.listEvents({}, 'raw')).toEqual([]);
  } finally {
    controller.abort();
    await reader.cancel();
  }
}));

test('alias lookup issues nothing and the last owner release retires an alias even when publication throws', () => {
  const identities = new TelemetryTraceIdentities();
  let id = '';
  expect(identities.resolve('unknown')).toBeUndefined();
  identities.capture('owned trace', captured => {
    id = captured;
    identities.retain(id);
    identities.retain(id);
  });
  expect(identities.resolve('owned trace')).toBe(id);
  identities.release(id);
  expect(identities.resolve('owned trace')).toBe(id);
  identities.release(id);
  expect(identities.resolve('owned trace')).toBeUndefined();
  expect(() => identities.capture('throwing publisher', () => { throw new Error('Publisher failed'); })).toThrow('Publisher failed');
  expect(identities.resolve('throwing publisher')).toBeUndefined();
  expect(identities.resolve('owned trace')).toBeUndefined();
});
