/**
 * PerfMonitor, collects metrics from the runtime store and evaluates
 * them against registered performance budgets.
 *
 * The monitor maintains a violation streak counter per budget so that
 * transient spikes do not trip CI; only sustained regressions fail.
 */

import type { SurfacePerfDomainState } from '../store/domains/surface-perf.js';
import type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
} from './types.js';
import { DEFAULT_BUDGETS } from './budgets.js';

/**
 * Snapshot of runtime state provided to the monitor for metric extraction.
 * Callers supply this from the store or from test fixtures.
 */
export interface PerfSnapshot {
  /** Current surface performance domain state. */
  surfacePerf: SurfacePerfDomainState;
  /**
   * Optional additional metric overrides keyed by metric name.
   * Useful for injecting tool executor or compaction metrics from
   * other subsystems that are not yet reflected in the store domain.
   */
  extraMetrics?: Record<string, number> | undefined;
}

/**
 * Computes the 95th percentile from a numeric array.
 * Returns 0 for empty arrays.
 */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * PerfMonitor collects metrics from a runtime snapshot, evaluates them
 * against a set of performance budgets, and tracks consecutive violation
 * streaks per budget.
 *
 * @example
 * ```ts
 * const monitor = new PerfMonitor();
 * const report = monitor.evaluate(snapshot);
 * if (!report.passed) process.exit(1);
 * ```
 */
export class PerfMonitor {
  private readonly budgets: PerfBudget[];
  /** Maps budget metric name to number of consecutive violations. */
  private readonly streaks: Map<string, number> = new Map();
  /** Heap and time of the previous evaluation; the growth rate is the change between the two samples. */
  private _previousHeapSample: { readonly heapUsedBytes: number; readonly at: number } | undefined;

  constructor(budgets: PerfBudget[] = DEFAULT_BUDGETS) {
    this.budgets = budgets;
  }

  /**
   * Extracts PerfMetrics from a PerfSnapshot.
   *
   * Metrics derived from SurfacePerfDomainState:
   * - frame.render.p95, p95 of recentCycles.durationMs
   * - memory.growth.bytes_per_hour, heap growth rate since previous evaluate()
   *
   * Metrics from extraMetrics (pass-through):
   * - event.queue.depth
   * - tool.executor.overhead.p95
   * - compaction.latency.p95
   */
  private extractMetrics(snapshot: PerfSnapshot, now: number): PerfMetric[] {
    const { surfacePerf, extraMetrics = {} } = snapshot;
    const metrics: PerfMetric[] = [];

    // Frame render p95
    const renderDurations = surfacePerf.recentCycles.map((c) => c.durationMs);
    metrics.push({
      name: 'frame.render.p95',
      value: p95(renderDurations),
      unit: 'ms',
      timestamp: now,
    });

    // Memory growth rate: bytes/hour between this evaluate() and the previous one.
    // The first evaluation has nothing to compare against, so it reports 0.
    const previous = this._previousHeapSample;
    const elapsedMs = previous ? now - previous.at : 0;
    const bytesPerHour =
      previous && elapsedMs > 0
        ? ((surfacePerf.heapUsedBytes - previous.heapUsedBytes) / elapsedMs) * 3_600_000
        : 0;
    this._previousHeapSample = { heapUsedBytes: surfacePerf.heapUsedBytes, at: now };
    metrics.push({
      name: 'memory.growth.bytes_per_hour',
      value: bytesPerHour,
      unit: 'bytes',
      timestamp: now,
    });

    // Pass-through extra metrics
    for (const [metricName, value] of Object.entries(extraMetrics)) {
      const budget = this.budgets.find((b) => b.metric === metricName);
      metrics.push({
        name: metricName,
        value,
        unit: budget?.unit ?? 'count',
        timestamp: now,
      });
    }

    return metrics;
  }

  /**
   * Evaluates the given snapshot against all registered budgets.
   * Updates internal violation streak counters.
   *
   * @param snapshot - Runtime state snapshot to evaluate.
   * @param now - Evaluation time in epoch ms; callers that replay synthetic
   *   samples pass the time the sample belongs to so the growth rate is
   *   computed over their interval, not over real elapsed time.
   * @returns A PerfReport summarising metrics and active violations.
   */
  evaluate(snapshot: PerfSnapshot, now: number = Date.now()): PerfReport {
    const metrics = this.extractMetrics(snapshot, now);
    const violations: BudgetViolation[] = [];
    const missing: string[] = [];

    for (const budget of this.budgets) {
      const metric = metrics.find((m) => m.name === budget.metric);
      if (!metric) {
        // An input the caller did not supply is not a measurement over budget:
        // list it as not measured, and leave it out of the violations and `passed`.
        missing.push(budget.metric);
        continue;
      }

      const actual = metric.value;
      const outside = budget.direction === 'min' ? actual < budget.threshold : actual > budget.threshold;

      if (outside) {
        const prev = this.streaks.get(budget.metric) ?? 0;
        const consecutiveViolations = prev + 1;
        this.streaks.set(budget.metric, consecutiveViolations);

        if (consecutiveViolations >= budget.tolerance) {
          violations.push({
            budget,
            actual,
            exceededBy: Math.abs(actual - budget.threshold),
            consecutiveViolations,
          });
        }
      } else {
        // Reset streak on passing sample
        this.streaks.set(budget.metric, 0);
      }
    }

    return {
      timestamp: now,
      metrics,
      violations,
      missing,
      budgets: this.budgets,
      passed: violations.length === 0,
    };
  }

  /** Resets all violation streak counters. */
  reset(): void {
    this.streaks.clear();
  }

  /** Returns the current violation streak for a given metric, or 0. */
  streak(metric: string): number {
    return this.streaks.get(metric) ?? 0;
  }
}
