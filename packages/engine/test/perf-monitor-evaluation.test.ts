import { describe, expect, test } from 'bun:test';
import { PerfMonitor } from '../platform/src/platform/runtime/perf/monitor.ts';
import { formatReport } from '../platform/src/platform/runtime/perf/reporter.ts';
import { createInitialSurfacePerfState } from '../platform/src/platform/runtime/store/domains/surface-perf.ts';

const MIB = 1024 * 1024;
const HOUR = 3_600_000;

function snapshot(heapMiB: number) {
  const surfacePerf = createInitialSurfacePerfState();
  surfacePerf.heapUsedBytes = heapMiB * MIB;
  return { surfacePerf, extraMetrics: {} };
}

describe('PerfMonitor', () => {
  test('budgets whose metric was not supplied are reported as not measured, not as violations', () => {
    const report = new PerfMonitor().evaluate(snapshot(200), 1_000);
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.missing).toContain('event.queue.depth');
    expect(formatReport(report)).toContain('Not measured');
  });

  test('a supplied metric over budget still fails after tolerance is reached', () => {
    const monitor = new PerfMonitor();
    const over = { surfacePerf: createInitialSurfacePerfState(), extraMetrics: { 'event.queue.depth': 5_000 } };
    let report = monitor.evaluate(over, 1);
    for (let i = 2; i <= 5; i++) report = monitor.evaluate(over, i);
    expect(report.passed).toBe(false);
    expect(report.violations.map((v) => v.budget.metric)).toEqual(['event.queue.depth']);
  });

  test('memory growth is the heap change over the time between two evaluations', () => {
    const monitor = new PerfMonitor();
    const first = monitor.evaluate(snapshot(200), 5_000);
    expect(first.metrics.find((m) => m.name === 'memory.growth.bytes_per_hour')!.value).toBe(0);
    const second = monitor.evaluate(snapshot(210), 5_000 + HOUR);
    expect(second.metrics.find((m) => m.name === 'memory.growth.bytes_per_hour')!.value).toBeCloseTo(10 * MIB, 0);
  });
});
