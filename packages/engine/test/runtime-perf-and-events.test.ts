/**
 * runtime-perf-and-events.test.ts
 *
 * Memory-growth rate over a synthetic interval, and the event bus's
 * "unsubscribed means no more calls" guarantee for events already emitted.
 */
import { describe, expect, test } from 'bun:test';
import { PerfMonitor } from '../platform/src/platform/runtime/perf/monitor.js';
import { createInitialSurfacePerfState } from '../platform/src/platform/runtime/store/domains/surface-perf.js';
import { BUILTIN_SUITES } from '../platform/src/platform/runtime/eval/suites.js';
import { RuntimeEventBus, createEventEnvelope } from '../platform/src/platform/runtime/events/index.js';

describe('memory growth rate', () => {
  test('two evaluations 60 s apart with +512 KiB extrapolate to the per-hour rate of that interval', () => {
    const monitor = new PerfMonitor([]);
    const surfacePerf = createInitialSurfacePerfState();
    const t0 = 1_000_000;
    surfacePerf.heapUsedBytes = 80 * 1024 * 1024;
    surfacePerf.lastMemorySampleAt = t0 - 60_000;
    monitor.evaluate({ surfacePerf }, t0);

    surfacePerf.heapUsedBytes = 80 * 1024 * 1024 + 512 * 1024;
    surfacePerf.lastMemorySampleAt = t0;
    const report = monitor.evaluate({ surfacePerf }, t0 + 60_000);
    const metric = report.metrics.find((m) => m.name === 'memory.growth.bytes_per_hour');
    expect(metric!.value).toBeCloseTo(512 * 1024 * 60, 0);
  });

  test('the memory-growth-stable gate scenario passes whatever the machine speed', async () => {
    const scenario = BUILTIN_SUITES['core-performance']!.find((s) => s.id === 'core-perf:memory-growth-stable')!;
    const raw = await scenario.run();
    expect(raw.perfReport!.passed).toBe(true);
  });
});

describe('RuntimeEventBus unsubscribe', () => {
  function envelope() {
    return createEventEnvelope(
      'AGENT_COMPLETED' as const,
      { type: 'AGENT_COMPLETED' as const, agentId: 'a', durationMs: 0 },
      { sessionId: 's', traceId: 't', source: 'test' },
    );
  }

  test('a listener unsubscribed after emit() returns is not called with that event', async () => {
    const bus = new RuntimeEventBus();
    const calls: string[] = [];
    const offDomain = bus.onDomain('agents', () => { calls.push('domain'); });
    const offType = bus.on('AGENT_COMPLETED', () => { calls.push('type'); });
    bus.emit('agents', envelope());
    offDomain();
    offType();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test('a listener still subscribed is called', async () => {
    const bus = new RuntimeEventBus();
    const calls: string[] = [];
    bus.onDomain('agents', () => { calls.push('domain'); });
    bus.emit('agents', envelope());
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(calls).toEqual(['domain']);
  });
});
