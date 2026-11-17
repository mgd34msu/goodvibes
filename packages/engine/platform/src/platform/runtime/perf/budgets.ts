/**
 * Default performance budget definitions for goodvibes-platform.
 *
 * Measurable budgets for frame latency,
 * event throughput, tool executor overhead, memory growth, and
 * compaction latency.
 */

import type { PerfBudget } from './types.js';

/**
 * The default performance budgets. `/doctor` and `ops.doctor` compare the
 * measured turn-start, cancel and permission-decision p95 with them; the eval
 * suites evaluate them through PerfMonitor. A metric outside its bound for
 * `tolerance` consecutive evaluations is a violation.
 */
export const DEFAULT_BUDGETS: PerfBudget[] = [
  {
    name: 'Frame Render Latency (p95)',
    metric: 'frame.render.p95',
    threshold: 16,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 frame render duration must stay under 16ms to maintain 60fps. ' +
      'Sustained violations indicate rendering bottlenecks under operational load.',
  },
  {
    name: 'Event Queue Depth',
    metric: 'event.queue.depth',
    threshold: 1000,
    unit: 'count',
    tolerance: 5,
    description:
      'Event queue must not accumulate more than 1000 pending events. ' +
      'Deep queues indicate the event loop cannot drain fast enough.',
  },
  {
    name: 'Tool Executor Overhead (p95)',
    metric: 'tool.executor.overhead.p95',
    threshold: 5,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 overhead per tool executor phase (scheduling, dispatch, teardown) ' +
      'must be under 5ms. Sustained violations indicate executor inefficiency.',
  },
  {
    name: 'Memory Growth Rate',
    metric: 'memory.growth.bytes_per_hour',
    threshold: 52_428_800, // 50 MiB in bytes
    unit: 'bytes',
    tolerance: 2,
    description:
      'Sustained heap growth must remain below 50 MiB/hour. ' +
      'Faster growth indicates a memory leak in long-running sessions.',
  },
  {
    name: 'Compaction Latency (p95)',
    metric: 'compaction.latency.p95',
    threshold: 500,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 compaction duration must be under 500ms. ' +
      'Slower compaction blocks the conversation loop and degrades UX.',
  },
  // ── SLO Gates ──────────────────────────────────────────────────────────────
  {
    name: 'SLO: Turn Start Latency (p95)',
    metric: 'slo.turn_start.p95',
    threshold: 2000,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from TURN_SUBMITTED to first STREAM_DELTA must be under 2000ms. ' +
      'Sustained violations indicate provider latency or pipeline overhead regression.',
  },
  {
    name: 'SLO: Cancel Latency (p95)',
    metric: 'slo.cancel.p95',
    threshold: 500,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from the cancel request to the turn\'s TURN_CANCEL must be under 500ms. ' +
      'Sustained violations indicate the cancellation path is blocked or too slow.',
  },
  {
    name: 'SLO: Gate Decision (p95)',
    metric: 'slo.permission_decision.p95',
    threshold: 2500,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from GATE_REQUESTED to DECISION_EMITTED must be under 2500ms. ' +
      'The span includes one Jev stakes reading for a side-effecting call (two requests in parallel); ' +
      'sustained violations indicate gate or judgment-port latency regression.',
  },
  // ── Integration Delivery SLO ─────────────────────────────────────────────
  {
    name: 'SLO: Integration Delivery Success Rate',
    metric: 'slo.integration.delivery_success_rate',
    threshold: 95,
    direction: 'min',
    unit: 'percent',
    tolerance: 3,
    description:
      'Integration delivery success rate must remain above 95% over any 100-delivery window. '
      + 'Sustained violations indicate systemic integration delivery failures requiring investigation.',
  },
  {
    name: 'SLO: Integration DLQ Depth',
    metric: 'slo.integration.dlq_depth',
    threshold: 10,
    unit: 'count',
    tolerance: 3,
    description:
      'Integration dead-letter queue depth must remain below 10 entries. '
      + 'A deeper queue indicates persistent delivery failures that require manual replay or investigation.',
  },
];
