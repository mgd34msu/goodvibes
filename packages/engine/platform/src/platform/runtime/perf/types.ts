/**
 * Performance budget types for CI regression gates.
 *
 * Defines the contracts for budget definitions, collected metrics,
 * violations, and aggregated reports.
 */

/** Unit of measurement for a performance budget threshold. */
export type PerfUnit = 'ms' | 'bytes' | 'count' | 'percent';

/**
 * A performance budget defines an acceptable threshold for a named metric.
 * Violations are tracked consecutively; failure occurs when consecutiveViolations
 * exceeds the tolerance.
 */
export interface PerfBudget {
  /** Human-readable name for this budget. */
  name: string;
  /** The metric key this budget applies to. */
  metric: string;
  /** Acceptable bound for the metric value: the upper bound, or the lower bound when `direction` is `min`. */
  threshold: number;
  /** `max` (default): the value must stay at or below the threshold. `min`: at or above it (a success rate). */
  direction?: 'max' | 'min' | undefined;
  /** Unit of the threshold value. */
  unit: PerfUnit;
  /** Number of consecutive violations that triggers failure (e.g., 3 means fail on 3rd consecutive violation). */
  tolerance: number;
  /** Describes what this budget measures and why it matters. */
  description: string;
}

/**
 * A single performance metric sample collected at a point in time.
 */
export interface PerfMetric {
  /** The metric key (should match a PerfBudget.metric). */
  name: string;
  /** The sampled value. */
  value: number;
  /** Unit of the value. */
  unit: string;
  /** Unix epoch milliseconds when this sample was collected. */
  timestamp: number;
}

/**
 * A budget violation record, produced when a metric exceeds its threshold.
 */
export interface BudgetViolation {
  /** The budget that was violated. */
  budget: PerfBudget;
  /** The actual metric value that triggered the violation. */
  actual: number;
  /** How much the actual value exceeded the threshold (actual - threshold). */
  exceededBy: number;
  /** Number of consecutive samples that have violated this budget. */
  consecutiveViolations: number;
  /** Retained for readers of older reports; the monitor no longer sets it (see PerfReport.missing). */
  warning?: string | undefined;
}

/**
 * Aggregated performance report produced by a monitoring run.
 */
export interface PerfReport {
  /** Unix epoch milliseconds when this report was generated. */
  timestamp: number;
  /** All metrics collected during this monitoring run. */
  metrics: PerfMetric[];
  /** Violations where consecutiveViolations exceeds tolerance. */
  violations: BudgetViolation[];
  /** Budget metrics the snapshot did not supply. They were not measured, so they are neither violations nor passes. */
  missing?: string[] | undefined;
  /** The budgets this report was evaluated against, so a reader prints each metric's own bound. */
  budgets?: readonly PerfBudget[] | undefined;
  /** True if all budgets passed (no active violations). */
  passed: boolean;
}
