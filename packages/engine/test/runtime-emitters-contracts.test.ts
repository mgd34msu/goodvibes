/**
 * runtime-emitters-contracts.test.ts
 *
 * Retry events and counter through a real HTTP transport, the ops action
 * events only for interventions that happened, and the tool-result summary's
 * size, kind and preview rules.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { transportRetryHooks } from '../platform/src/platform/runtime/emitters/transport.js';
import { emitOpsTaskCancelled } from '../platform/src/platform/runtime/emitters/ops.js';
import { toToolResultSummary } from '../platform/src/platform/runtime/emitters/tools.js';
import { transportRetriesTotal } from '../platform/src/platform/runtime/metrics.js';
import { createHttpJsonTransport } from '../transport-http/src/http-core.js';
import type { EmitterContext } from '../platform/src/platform/runtime/emitters/index.js';

const ctx = { source: 'test', traceId: 'trace-1', sessionId: 'session-1' } as EmitterContext;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('transport retry events', () => {
  test('one retry through a real transport emits scheduled and executed events and counts once', async () => {
    const bus = new RuntimeEventBus();
    const types: string[] = [];
    bus.onDomain('transport', (event: { payload: { type: string } }) => { types.push(event.payload.type); });
    let calls = 0;
    const transport = createHttpJsonTransport({
      baseUrl: 'https://example.com',
      fetchImpl: Object.assign(
        async () => {
          calls += 1;
          return calls === 1
            ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
            : new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        { preconnect: () => {} },
      ),
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      ...transportRetryHooks(bus, ctx, 'http-test'),
    });
    const before = transportRetriesTotal.value();
    await transport.requestJson('/api/test');
    await flush();
    expect(types).toEqual(['TRANSPORT_RETRY_SCHEDULED', 'TRANSPORT_RETRY_EXECUTED']);
    expect(transportRetriesTotal.value() - before).toBe(1);
  });
});

describe('ops action events', () => {
  function collect(outcome: 'success' | 'rejected' | 'error') {
    const bus = new RuntimeEventBus();
    const types: string[] = [];
    bus.onDomain('ops', (event: { payload: { type: string } }) => { types.push(event.payload.type); });
    emitOpsTaskCancelled(bus, ctx, { taskId: 't1', reason: 'ops_cancel', outcome });
    return flush().then(() => types);
  }

  test('a successful cancel emits the action event and the audit', async () => {
    expect(await collect('success')).toEqual(['OPS_TASK_CANCELLED', 'OPS_AUDIT']);
  });

  test('a rejected or failed cancel emits only the audit', async () => {
    expect(await collect('rejected')).toEqual(['OPS_AUDIT']);
    expect(await collect('error')).toEqual(['OPS_AUDIT']);
  });
});

describe('toToolResultSummary', () => {
  test('byteSize counts UTF-8 bytes, not UTF-16 units', () => {
    expect(toToolResultSummary({ success: true, output: 'ééé' }).byteSize).toBe(6);
    expect(toToolResultSummary({ success: false, error: 'éé' }).byteSize).toBe(4);
  });

  test('only a JSON object or array is labelled json', () => {
    expect(toToolResultSummary({ success: true, output: '{"a":1}' }).kind).toBe('json');
    expect(toToolResultSummary({ success: true, output: ' [1,2] ' }).kind).toBe('json');
    expect(toToolResultSummary({ success: true, output: '123' }).kind).toBe('text');
    expect(toToolResultSummary({ success: true, output: 'true' }).kind).toBe('text');
    expect(toToolResultSummary({ success: true, output: '{not json' }).kind).toBe('text');
  });
});
