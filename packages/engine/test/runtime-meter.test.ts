import { afterEach, describe, expect, test } from 'bun:test';
import { resetMetrics } from '../platform/src/platform/runtime/metrics.js';

/**
 * RuntimeMeter production wiring, verifies that the platform meter
 * singleton and all named instruments are accessible and use the correct API.
 * Counter: add(delta, labels?), value(labels?)
 * Histogram: record(value, labels?), snapshot(labels?)
 * Gauge: set(value, labels?), value(labels?)
 */
describe('runtime meter', () => {
  afterEach(() => {
    // reset singleton meter state so tests do not bleed into each other.
    resetMetrics();
  });

  test('httpRequestsTotal counter add() and value() work', async () => {
    const { httpRequestsTotal } = await import('../platform/src/platform/runtime/metrics.js');
    const before = httpRequestsTotal.value({ status_class: '2xx' });
    httpRequestsTotal.add(1, { status_class: '2xx' });
    expect(httpRequestsTotal.value({ status_class: '2xx' })).toBe(before + 1);
  });

  test('llmRequestDurationMs histogram record() is reflected in the merged snapshot across label sets', async () => {
    const { llmRequestDurationMs } = await import('../platform/src/platform/runtime/metrics.js');
    llmRequestDurationMs.record(100, { provider: 'anthropic' });
    llmRequestDurationMs.record(300, { provider: 'openai', model: 'm' });
    expect(llmRequestDurationMs.merged()).toMatchObject({ count: 2, sum: 400, min: 100, max: 300 });
    expect(llmRequestDurationMs.merged({ provider: 'openai' })).toMatchObject({ count: 1, sum: 300 });
  });

  test('sessionsActive gauge can be set and read', async () => {
    const { sessionsActive } = await import('../platform/src/platform/runtime/metrics.js');
    sessionsActive.set(7);
    expect(sessionsActive.value()).toBe(7);
  });

  test('sseSubscribers gauge can be set and read', async () => {
    const { sseSubscribers } = await import('../platform/src/platform/runtime/metrics.js');
    sseSubscribers.set(2);
    expect(sseSubscribers.value()).toBe(2);
  });

  test('transportRetriesTotal counter increments correctly', async () => {
    const { transportRetriesTotal } = await import('../platform/src/platform/runtime/metrics.js');
    const before = transportRetriesTotal.value();
    transportRetriesTotal.add(1);
    expect(transportRetriesTotal.value()).toBe(before + 1);
  });

  test('snapshotMetrics returns expected shape', async () => {
    const { snapshotMetrics } = await import('../platform/src/platform/runtime/metrics.js');
    const snap = snapshotMetrics();
    expect(snap).toHaveProperty('counters');
    expect(snap).toHaveProperty('gauges');
    expect(snap).toHaveProperty('histograms');

    const counters = (snap as Record<string, unknown>)['counters'] as Record<string, unknown>;
    expect(counters).toHaveProperty('http.requests.total');
    expect(counters).toHaveProperty('llm.requests.total');
    expect(counters).toHaveProperty('auth.success.total');
    expect(counters).toHaveProperty('auth.failure.total');
    expect(counters).toHaveProperty('transport.retries_total');

    const gauges = (snap as Record<string, unknown>)['gauges'] as Record<string, unknown>;
    expect(gauges).toHaveProperty('sessions.active');
    expect(gauges).toHaveProperty('sse.subscribers');
    expect(gauges).toHaveProperty('telemetry.buffer.fill');
  });

  test('snapshotMetrics includes histogram sub-keys', async () => {
    const { snapshotMetrics } = await import('../platform/src/platform/runtime/metrics.js');
    const snap = snapshotMetrics();
    expect(snap).toHaveProperty('histograms');
    const h = (snap as Record<string, unknown>)['histograms'] as Record<string, unknown>;
    expect(h).toHaveProperty(['http.request.duration_ms']);
    expect(h).toHaveProperty(['llm.request.duration_ms']);
    expect(h).toHaveProperty(['llm.tokens.input']);
    expect(h).toHaveProperty(['llm.tokens.output']);
    const hSnap = h['http.request.duration_ms'] as { count: number; sum: number; min: number; max: number; mean: number };
    expect(typeof hSnap.count).toBe('number');
    expect(typeof hSnap.sum).toBe('number');
    expect(typeof hSnap.mean).toBe('number');
  });

  test('requests recorded under method and status_class are counted per status class in snapshotMetrics', async () => {
    const { httpRequestsTotal, snapshotMetrics } = await import('../platform/src/platform/runtime/metrics.js');
    httpRequestsTotal.add(1, { status_class: '2xx', method: 'GET' });
    httpRequestsTotal.add(1, { status_class: '2xx', method: 'POST' });
    httpRequestsTotal.add(1, { status_class: '5xx', method: 'GET' });
    expect(snapshotMetrics().counters.http.requests.total).toEqual({ '2xx': 2, '4xx': 0, '5xx': 1 });
    expect(snapshotMetrics().counters['http.requests.total']).toEqual({ '2xx': 2, '4xx': 0, '5xx': 1 });
  });

  test('histogram samples and the sessions gauge show up in snapshotMetrics', async () => {
    const { httpRequestDurationMs, sessionsActive, snapshotMetrics } = await import('../platform/src/platform/runtime/metrics.js');
    httpRequestDurationMs.record(40, { method: 'GET', path_pattern: '/x', status_class: '2xx' });
    httpRequestDurationMs.record(60, { method: 'GET', path_pattern: '/y', status_class: '2xx' });
    sessionsActive.set(3);
    const snap = snapshotMetrics();
    expect(snap.histograms['http.request.duration_ms']).toMatchObject({ count: 2, sum: 100, min: 40, max: 60, mean: 50 });
    expect(snap.gauges.sessions.active).toBe(3);
  });
});
