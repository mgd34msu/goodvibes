import { afterEach, describe, expect, test } from 'bun:test';
import {
  httpRequestDurationMs,
  httpRequestsTotal,
  llmRequestsTotal,
  llmTokensInput,
  resetMetrics,
  snapshotMetrics,
  sseSubscribers,
  transportRetriesTotal,
} from '../platform/src/platform/runtime/metrics.ts';

afterEach(() => resetMetrics());

// The daemon records each instrument under a richer label set than the
// snapshot's outcome label, so the snapshot has to sum across them.
describe('snapshotMetrics with the label sets production writes', () => {
  test('HTTP requests recorded with method and status class are counted per class', () => {
    httpRequestsTotal.add(1, { method: 'GET', status_class: '2xx' });
    httpRequestsTotal.add(2, { method: 'POST', status_class: '2xx' });
    httpRequestsTotal.add(1, { method: 'GET', status_class: '5xx' });

    const total = snapshotMetrics().counters.http.requests.total;
    expect(total['2xx']).toBe(3);
    expect(total['5xx']).toBe(1);
    expect(total['4xx']).toBe(0);
  });

  test('LLM requests recorded with provider, model and status are counted per status', () => {
    llmRequestsTotal.add(1, { provider: 'p', model: 'm', status: 'success' });
    llmRequestsTotal.add(1, { provider: 'q', model: 'n', status: 'success' });
    llmRequestsTotal.add(1, { provider: 'p', model: 'm', status: 'error' });

    const total = snapshotMetrics().counters.llm.requests.total;
    expect(total.success).toBe(2);
    expect(total.error).toBe(1);
  });

  test('retries and subscribers recorded under labels are summed, and a gauge keeps its latest value per label set', () => {
    transportRetriesTotal.add(1, { transport_type: 'a', reason: 'timeout' });
    transportRetriesTotal.add(2, { transport_type: 'b', reason: 'reset' });
    sseSubscribers.set(3, { stream_type: 'telemetry' });
    sseSubscribers.set(1, { stream_type: 'telemetry' });
    sseSubscribers.set(4, { stream_type: 'events' });

    const snapshot = snapshotMetrics();
    expect(snapshot.counters.transport.retries_total).toBe(3);
    expect(snapshot.gauges.sse.subscribers).toBe(5);
  });

  test('labelled histograms are merged by count, sum, min and max, not by averaging means', () => {
    httpRequestDurationMs.record(10, { method: 'GET', path_pattern: '/a', status_class: '2xx' });
    httpRequestDurationMs.record(30, { method: 'GET', path_pattern: '/a', status_class: '2xx' });
    httpRequestDurationMs.record(100, { method: 'POST', path_pattern: '/b', status_class: '5xx' });
    llmTokensInput.record(7, { provider: 'p', model: 'm' });

    const histograms = snapshotMetrics().histograms;
    expect(histograms['http.request.duration_ms']).toEqual({ count: 3, sum: 140, min: 10, max: 100, mean: 140 / 3 });
    expect(histograms['llm.tokens.input'].count).toBe(1);
    expect(histograms['llm.request.duration_ms'].count).toBe(0);
  });

  test('resetting metrics clears the rolled-up totals too', () => {
    httpRequestsTotal.add(1, { method: 'GET', status_class: '2xx' });
    resetMetrics();
    expect(snapshotMetrics().counters.http.requests.total['2xx']).toBe(0);
  });
});
