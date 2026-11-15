import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '../platform/src/platform/runtime/events/index.ts';
import { SloCollector } from '../platform/src/platform/runtime/perf/slo-collector.ts';

/** The sweep is timer-driven, so the test runs it directly against the collector's own bookkeeping. */
interface Internals { _sweepPending(): void; _seenFirstDelta: Map<string, number> }

let collector: SloCollector | undefined;
afterEach(() => {
  collector?.dispose();
  collector = undefined;
  setSystemTime();
});

test('a turn that streamed and never reported a terminal event is forgotten after the pending TTL', async () => {
  const bus = new RuntimeEventBus();
  collector = new SloCollector(bus);
  const internals = collector as unknown as Internals;
  const start = 1_700_000_000_000;
  setSystemTime(new Date(start));

  bus.emit('turn', createEventEnvelope('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-1' } as never, { sessionId: 's', traceId: 't', source: 'test' }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(internals._seenFirstDelta.size).toBe(1);

  const ts = [...internals._seenFirstDelta.values()][0]!;
  setSystemTime(new Date(ts + 10_000));
  internals._sweepPending();
  expect(internals._seenFirstDelta.size).toBe(1);

  setSystemTime(new Date(ts + 61_000));
  internals._sweepPending();
  expect(internals._seenFirstDelta.size).toBe(0);
});

test('a metric with no samples is left out of getMetrics instead of reading as a passing 0 ms', () => {
  collector = new SloCollector(new RuntimeEventBus());
  expect(collector.getMetrics()).toEqual([]);
  expect(collector.getSampleCounts()['slo.turn_start.p95']).toBe(0);
});
