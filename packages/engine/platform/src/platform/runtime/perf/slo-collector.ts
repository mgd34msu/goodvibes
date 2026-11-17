/**
 * SloCollector, collects SLO duration measurements from runtime events.
 *
 * Two domain listeners on the RuntimeEventBus track three critical path latencies:
 * - turn_start_ms: TURN_SUBMITTED → first STREAM_DELTA
 * - cancel_ms: the cancel request → TURN_CANCEL (the event carries `requestedAt`)
 * - permission_decision_ms: GATE_REQUESTED → DECISION_EMITTED, for calls the gate decided
 *   itself (a call put to the owner waits on his answer and is not counted)
 *
 * Maintains a capped rolling window of measurements per SLO and exposes
 * p95 values through `getMetrics()`. The doctor's check context builds one
 * per process, so `/doctor` and `ops.doctor` report the measured latency.
 */

import type { RuntimeEventBus } from '../events/index.js';
import type { PerfMetric } from './types.js';

/** Metric key constants for each SLO measurement. */
export const SLO_METRICS = {
  TURN_START: 'slo.turn_start.p95',
  CANCEL: 'slo.cancel.p95',
  PERMISSION_DECISION: 'slo.permission_decision.p95',
} as const;

/** Maximum number of samples retained in each rolling window. */
const WINDOW_SIZE = 200;

/**
 * Maximum age for a pending map entry before it is swept as stale.
 * Entries that never receive a follow-up event (a turn that ends without
 * output, a gate request whose decision is never published) are evicted after
 * this duration so the maps stay bounded.
 */
const PENDING_TTL_MS = 60_000;

/** Interval between periodic stale-entry sweeps (ms). */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Computes the 95th percentile from a numeric array.
 * Returns 0 for empty arrays.
 */
function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Appends a sample to a capped rolling window.
 * Evicts the oldest entry when the window exceeds WINDOW_SIZE.
 */
function appendSample(window: number[], sample: number): void {
  window.push(sample);
  if (window.length > WINDOW_SIZE) {
    window.shift();
  }
}

/**
 * SloCollector subscribes to the turn and gate domains and tracks per-SLO
 * duration samples in rolling windows. Call `getMetrics()` to read the
 * current p95 values.
 *
 * @example
 * ```ts
 * const collector = new SloCollector(bus);
 * const metrics = collector.getMetrics();
 * collector.dispose();
 * ```
 */
export class SloCollector {
  /** Rolling window of turn_start_ms samples (TURN_SUBMITTED → first STREAM_DELTA). */
  private readonly _turnStartSamples: number[] = [];
  /** Rolling window of cancel_ms samples (cancel request → TURN_CANCEL). */
  private readonly _cancelSamples: number[] = [];
  /** Rolling window of permission_decision_ms samples (GATE_REQUESTED → DECISION_EMITTED). */
  private readonly _permissionSamples: number[] = [];

  /** Pending turn start timestamps keyed by turnId, removed at the first delta or the turn's end. */
  private readonly _pendingTurnStart = new Map<string, number>();
  /** Pending permission request timestamps keyed by callId. */
  private readonly _pendingPermission = new Map<string, number>();

  /** Registered unsubscribe functions. */
  private readonly _unsubs: Array<() => void> = [];

  /** Timer handle for the periodic stale-entry sweep. */
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: Pick<RuntimeEventBus, 'onDomain'>) {
    this._subscribe(bus);
    this._sweepTimer = setInterval(() => this._sweepPending(), SWEEP_INTERVAL_MS);
    // Don't block clean process exit.
    this._sweepTimer.unref?.();
  }

  /**
   * Attach the two domain listeners. Each event costs one switch and at most
   * one map write.
   */
  private _subscribe(bus: Pick<RuntimeEventBus, 'onDomain'>): void {
    this._unsubs.push(bus.onDomain('turn', (envelope) => {
      const event = envelope.payload;
      switch (event.type) {
        case 'TURN_SUBMITTED':
          this._pendingTurnStart.set(event.turnId, envelope.ts);
          return;
        case 'STREAM_DELTA': {
          // Only the first delta of a turn finds its start; later deltas find nothing.
          const startAt = this._pendingTurnStart.get(event.turnId);
          if (startAt === undefined) return;
          appendSample(this._turnStartSamples, envelope.ts - startAt);
          this._pendingTurnStart.delete(event.turnId);
          return;
        }
        case 'TURN_CANCEL':
          this._pendingTurnStart.delete(event.turnId);
          if (event.requestedAt !== undefined && envelope.ts >= event.requestedAt) {
            appendSample(this._cancelSamples, envelope.ts - event.requestedAt);
          }
          return;
        case 'PREFLIGHT_FAIL':
        case 'TURN_ERROR':
        case 'TURN_COMPLETED':
          this._pendingTurnStart.delete(event.turnId);
          return;
        default:
          return;
      }
    }));

    this._unsubs.push(bus.onDomain('gate', (envelope) => {
      const event = envelope.payload;
      if (event.type === 'GATE_REQUESTED') {
        this._pendingPermission.set(event.callId, envelope.ts);
        return;
      }
      if (event.type === 'DECISION_EMITTED') {
        const startAt = this._pendingPermission.get(event.callId);
        if (startAt === undefined) return;
        this._pendingPermission.delete(event.callId);
        // The figure is the gate's own latency: a call put to the owner waited on his
        // answer, and a call whose admission failed was never decided.
        const source = event.sourceLayer ?? event.source;
        if (source === 'user_prompt' || source === 'admission_failed') return;
        appendSample(this._permissionSamples, envelope.ts - startAt);
      }
    }));
  }

  /**
   * Sweep the pending maps and evict entries older than PENDING_TTL_MS.
   */
  private _sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, ts] of this._pendingTurnStart) {
      if (ts < cutoff) this._pendingTurnStart.delete(key);
    }
    for (const [key, ts] of this._pendingPermission) {
      if (ts < cutoff) this._pendingPermission.delete(key);
    }
  }

  /**
   * Returns current p95 values as PerfMetric entries for the SLO metrics that have samples.
   * A metric with no samples is left out, so a budget check reads "no data" rather than a
   * 0 ms p95 that would pass any threshold; `getSampleCounts()` reports the empty ones.
   */
  public getMetrics(): PerfMetric[] {
    const now = Date.now();
    const all: Array<{ name: string; samples: readonly number[] }> = [
      { name: SLO_METRICS.TURN_START, samples: this._turnStartSamples },
      { name: SLO_METRICS.CANCEL, samples: this._cancelSamples },
      { name: SLO_METRICS.PERMISSION_DECISION, samples: this._permissionSamples },
    ];
    return all
      .filter((m) => m.samples.length > 0)
      .map((m): PerfMetric => ({ name: m.name, value: p95(m.samples), unit: 'ms', timestamp: now }));
  }

  /**
   * Returns the number of samples collected for each SLO metric.
   * Useful for diagnostics to distinguish "no data yet" from an actual 0ms result.
   */
  public getSampleCounts(): Readonly<Record<string, number>> {
    return {
      [SLO_METRICS.TURN_START]: this._turnStartSamples.length,
      [SLO_METRICS.CANCEL]: this._cancelSamples.length,
      [SLO_METRICS.PERMISSION_DECISION]: this._permissionSamples.length,
    };
  }

  /**
   * Unsubscribes all event listeners and releases resources.
   * The collector should not be used after disposal.
   */
  public dispose(): void {
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs.length = 0;
    this._pendingTurnStart.clear();
    this._pendingPermission.clear();
  }
}
