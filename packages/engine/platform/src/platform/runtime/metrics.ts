/**
 * RuntimeMeter production wiring for the goodvibes-platform platform.
 *
 * Exposes named metric instruments used across the platform:
 * - HTTP request counters and histograms
 * - LLM request counters and histograms
 * - Auth success/failure counters
 * - Session and SSE subscriber gauges
 * - Telemetry buffer fill gauge
 *
 * It also holds the process's ACTIVE TRACER, which `telemetry.otelMode`
 * governs, see {@link platformTracer}.
 */
import { RuntimeMeter } from './telemetry/meter.js';
import { RuntimeTracer } from './telemetry/tracer.js';
import { toolFormatTelemetry } from './telemetry/tool-format-telemetry.js';
import type { Counter, Gauge, Histogram, HistogramSnapshot, MetricLabels } from './telemetry/types.js';
import { filterMetricLabels } from './telemetry/api-helpers.js';

/** Singleton RuntimeMeter instance for the platform. */
export const platformMeter = new RuntimeMeter({ scope: 'goodvibes-platform' });

/**
 * A tracer that records nothing. What the platform uses until a host installs
 * one, which is the same thing `telemetry.otelMode: 'off'` asks for.
 */
const DISABLED_TRACER = new RuntimeTracer({ scope: 'goodvibes-platform', enabled: false, exporters: [] });

let activeTracer: RuntimeTracer = DISABLED_TRACER;

/**
 * The tracer the platform's instrumentation opens spans on.
 *
 * `telemetry.otelMode` used to be checked in exactly one place,
 * `createTelemetryProvider`, which had no callers, while the live meter in this
 * module was built with no reference to it at all. So 'off', 'in-process' and
 * 'remote-export' produced identical behaviour: no spans, ever, because nothing
 * held a tracer to open one on.
 *
 * This is the seam that closes that. The composed runtime builds a provider from
 * the mode's two feature gates and installs its tracer here; instrumentation
 * asks for the tracer per call rather than capturing it, so a host that installs
 * one after the first LLM request still gets spans from the second.
 *
 * A function rather than a mutable export because a `let` binding read through
 * an ES module namespace is a live view in bundlers and a snapshot in some CJS
 * interop paths, and "did tracing turn on" is not a question to leave to that.
 */
export function platformTracer(): RuntimeTracer {
  return activeTracer;
}

/**
 * Install the process's tracer. Called once by the composed runtime.
 *
 * Passing `null` restores the recording-nothing tracer, which is what a test
 * that turned tracing on uses to put the process back.
 */
export function installPlatformTracer(tracer: RuntimeTracer | null): void {
  activeTracer = tracer ?? DISABLED_TRACER;
}


// ── Label roll-ups ────────────────────────────────────────────────────────────
//
// The meter's `value()`/`snapshot()` look up one exact label set, but writers
// record under richer sets (method + status_class, provider + model + status,
// ...). The wrappers below keep the exact-label behaviour and add `total(filter)`,
// which merges every recorded label set that contains the filter, so the
// operator snapshot reports what was recorded instead of zero.

const rollupResets: Array<() => void> = [];

function rollupKey(labels?: MetricLabels): string {
  const kept = labels ? (filterMetricLabels(labels) as MetricLabels) : {};
  return JSON.stringify(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function containsLabels(recorded: MetricLabels, filter?: MetricLabels): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => recorded[k] === v);
}

/** A counter that can also be summed across label sets. */
export interface RolledUpCounter extends Counter {
  /** Sum of every recorded label set that contains `filter` (all of them when omitted). */
  total(filter?: MetricLabels): number;
}

/** A gauge that can also be summed across label sets. */
export interface RolledUpGauge extends Gauge {
  /** Sum of the latest value of every label set that contains `filter` (all of them when omitted). */
  total(filter?: MetricLabels): number;
}

/** A histogram that can also be merged across label sets. */
export interface RolledUpHistogram extends Histogram {
  /** Count/sum/min/max merged over every label set that contains `filter` (all of them when omitted). */
  merged(filter?: MetricLabels): HistogramSnapshot;
  /** Epoch ms of the newest observation among label sets that contain `filter`, or null when there is none. */
  lastRecordedAt(filter?: MetricLabels): number | null;
}

function rolledUpCounter(inner: Counter): RolledUpCounter {
  const entries = new Map<string, { labels: MetricLabels; value: number }>();
  rollupResets.push(() => entries.clear());
  return {
    add(delta = 1, labels) {
      inner.add(delta, labels);
      if (delta < 0) return;
      const key = rollupKey(labels);
      const entry = entries.get(key);
      if (entry) entry.value += delta;
      else entries.set(key, { labels: labels ? (filterMetricLabels(labels) as MetricLabels) : {}, value: delta });
    },
    value: (labels) => inner.value(labels),
    total(filter) {
      let sum = 0;
      for (const entry of entries.values()) if (containsLabels(entry.labels, filter)) sum += entry.value;
      return sum;
    },
  };
}

function rolledUpGauge(inner: Gauge): RolledUpGauge {
  const entries = new Map<string, { labels: MetricLabels; value: number }>();
  rollupResets.push(() => entries.clear());
  return {
    set(value, labels) {
      inner.set(value, labels);
      entries.set(rollupKey(labels), { labels: labels ? (filterMetricLabels(labels) as MetricLabels) : {}, value });
    },
    value: (labels) => inner.value(labels),
    total(filter) {
      let sum = 0;
      for (const entry of entries.values()) if (containsLabels(entry.labels, filter)) sum += entry.value;
      return sum;
    },
  };
}

function rolledUpHistogram(inner: Histogram): RolledUpHistogram {
  const entries = new Map<string, { labels: MetricLabels; count: number; sum: number; min: number; max: number; at: number }>();
  rollupResets.push(() => entries.clear());
  return {
    record(value, labels) {
      inner.record(value, labels);
      const key = rollupKey(labels);
      const entry = entries.get(key);
      const at = Date.now();
      if (!entry) {
        entries.set(key, {
          labels: labels ? (filterMetricLabels(labels) as MetricLabels) : {},
          count: 1,
          sum: value,
          min: value,
          max: value,
          at,
        });
        return;
      }
      entry.count += 1;
      entry.sum += value;
      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
      entry.at = at;
    },
    snapshot: (labels) => inner.snapshot(labels),
    merged(filter) {
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const entry of entries.values()) {
        if (!containsLabels(entry.labels, filter)) continue;
        count += entry.count;
        sum += entry.sum;
        if (entry.min < min) min = entry.min;
        if (entry.max > max) max = entry.max;
      }
      if (count === 0) return { count: 0, sum: 0, min: 0, max: 0, mean: 0 };
      return { count, sum, min, max, mean: sum / count };
    },
    lastRecordedAt(filter) {
      let newest: number | null = null;
      for (const entry of entries.values()) {
        if (containsLabels(entry.labels, filter) && (newest === null || entry.at > newest)) newest = entry.at;
      }
      return newest;
    },
  };
}

// ── HTTP metrics ─────────────────────────────────────────────────────────────

/** Counter: total HTTP requests by method and status_class (1xx to 5xx; the snapshot reports 2xx, 4xx and 5xx). */
export const httpRequestsTotal = rolledUpCounter(platformMeter.counter('http.requests.total'));
/**
 * Histogram: HTTP request latency in ms by method, path_pattern, status_class.
 * `path_pattern` is the route that answered (or `unmatched`), never the path a
 * client sent: every label set is kept for the life of the process.
 */
export const httpRequestDurationMs = rolledUpHistogram(platformMeter.histogram('http.request.duration_ms'));

const HTTP_METHOD_LABELS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** A request method as a metric label: a known verb, or `OTHER`, so a client cannot add label sets. */
export function httpMethodLabel(method: string): string {
  const upper = method.toUpperCase();
  return HTTP_METHOD_LABELS.has(upper) ? upper : 'OTHER';
}

// ── LLM metrics ──────────────────────────────────────────────────────────────

/** Counter: total LLM requests started by provider, model (emitted on entry, before the call). */
export const llmRequestsStarted = platformMeter.counter('llm.requests.started');
/** Counter: total LLM requests by provider, model, status (success/error). */
export const llmRequestsTotal = rolledUpCounter(platformMeter.counter('llm.requests.total'));
/** Histogram: LLM request latency in ms by provider, model. */
export const llmRequestDurationMs = rolledUpHistogram(platformMeter.histogram('llm.request.duration_ms'));
/** What this process measured for one provider, or one model of it: calls, outcomes and latency. */
export interface LlmRouteMeasurement {
  readonly provider: string;
  readonly model: string | null;
  readonly successCalls: number;
  readonly errorCalls: number;
  readonly avgLatencyMs: number | null;
  readonly minLatencyMs: number | null;
  readonly maxLatencyMs: number | null;
  /** Epoch ms of the newest measured call (a failed call is measured too), or null when there is none. */
  readonly lastMeasuredAt: number | null;
}

/**
 * The live provider-health fact: every provider call this process made is
 * recorded by `instrumentedLlmCall` with its provider and model labels, so a
 * route's latency and outcomes are a lookup here, not a separate store.
 */
export function measureLlmRoute(provider: string, model?: string): LlmRouteMeasurement {
  const filter: MetricLabels = model ? { provider, model } : { provider };
  const latency = llmRequestDurationMs.merged(filter);
  const measured = latency.count > 0;
  return {
    provider,
    model: model ?? null,
    successCalls: llmRequestsTotal.total({ ...filter, status: 'success' }),
    errorCalls: llmRequestsTotal.total({ ...filter, status: 'error' }),
    avgLatencyMs: measured ? latency.mean : null,
    minLatencyMs: measured ? latency.min : null,
    maxLatencyMs: measured ? latency.max : null,
    lastMeasuredAt: llmRequestDurationMs.lastRecordedAt(filter),
  };
}
/** Histogram: LLM input token counts by provider, model. */
export const llmTokensInput = rolledUpHistogram(platformMeter.histogram('llm.tokens.input'));
/** Histogram: LLM output token counts by provider, model. */
export const llmTokensOutput = rolledUpHistogram(platformMeter.histogram('llm.tokens.output'));

// ── Auth metrics ─────────────────────────────────────────────────────────────

/** Counter: successful auth events. */
export const authSuccessTotal = platformMeter.counter('auth.success.total');
/** Counter: failed auth events. */
export const authFailureTotal = platformMeter.counter('auth.failure.total');

// ── Session and SSE metrics ───────────────────────────────────────────────────

/** Gauge: currently active sessions. */
export const sessionsActive = platformMeter.gauge('sessions.active');
/** Gauge: current SSE subscriber count per stream type. */
export const sseSubscribers = rolledUpGauge(platformMeter.gauge('sse.subscribers'));

// ── Transport metrics ─────────────────────────────────────────────────────────

/** Counter: total transport retries by transport_type and reason. */
export const transportRetriesTotal = rolledUpCounter(platformMeter.counter('transport.retries_total'));

// ── Telemetry buffer metrics ──────────────────────────────────────────────────

/** Gauge: fill level of the telemetry buffer (0..1). */
export const telemetryBufferFill = platformMeter.gauge('telemetry.buffer.fill');

// ── Listener error metrics ──────────────────────────────────────────

/** Counter: total listener errors caught during event dispatch. */
export const listenerErrorsTotal = rolledUpCounter(platformMeter.counter('listener_errors_total'));

/**
 * Reset all metric instruments on the singleton platform meter.
 * Use in afterEach() hooks to prevent singleton state from bleeding between tests.
 */
export function resetMetrics(): void {
  platformMeter.reset();
  for (const clear of rollupResets) clear();
  toolFormatTelemetry.reset();
}

/** A bucketed counter split by an outcome label (e.g. status class, success/error). */
export interface RuntimeMetricsBucket {
  readonly [label: string]: number;
}

/** The JSON-serialisable shape `snapshotMetrics()` returns. */
export interface RuntimeMetricsSnapshot {
  readonly counters: {
    readonly http: { readonly requests: { readonly total: RuntimeMetricsBucket } };
    readonly llm: { readonly requests: { readonly total: RuntimeMetricsBucket } };
    readonly auth: { readonly success: { readonly total: number }; readonly failure: { readonly total: number } };
    readonly transport: { readonly retries_total: number };
    readonly [flatKey: string]: unknown;
  };
  readonly gauges: {
    readonly sessions: { readonly active: number };
    readonly sse: { readonly subscribers: number };
    readonly telemetry: { readonly buffer: { readonly fill: number } };
    readonly [flatKey: string]: unknown;
  };
  readonly histograms: {
    readonly 'http.request.duration_ms': HistogramSnapshot;
    readonly 'llm.request.duration_ms': HistogramSnapshot;
    readonly 'llm.tokens.input': HistogramSnapshot;
    readonly 'llm.tokens.output': HistogramSnapshot;
  };
  /** Per-model edit-failure + declared-exec-expectation-miss counts (see tool-format-telemetry.ts). */
  readonly toolFormat: {
    readonly byModel: Record<string, Record<string, number>>;
    readonly byClass: Record<string, number>;
  };
  // An index signature so this remains assignable to the untyped
  // `Record<string, unknown>` return type older context surfaces (e.g.
  // daemon-api's DaemonRuntimeRouteContext) still declare for snapshotMetrics.
  readonly [topLevelKey: string]: unknown;
}

/**
 * Snapshot all metric instruments as a JSON-serialisable object.
 *
 * Reachable two ways: the `runtime.metrics.get` operator method (typed IO,
 * catalog-registered, see method-catalog-runtime.ts and routes/runtime-
 * metrics.ts), and its REST binding `GET /api/runtime/metrics`. Consumers
 * needing this shape directly (not through the operator client) can import
 * `snapshotMetrics`/`RuntimeMetricsSnapshot` from
 * `@goodvibes/engine/platform/platform/runtime/observability`.
 */
export function snapshotMetrics(): RuntimeMetricsSnapshot {
  const httpRequestsSnapshot = {
    '2xx': httpRequestsTotal.total({ status_class: '2xx' }),
    '4xx': httpRequestsTotal.total({ status_class: '4xx' }),
    '5xx': httpRequestsTotal.total({ status_class: '5xx' }),
  };
  const llmRequestsSnapshot = {
    success: llmRequestsTotal.total({ status: 'success' }),
    error: llmRequestsTotal.total({ status: 'error' }),
  };
  return {
    counters: {
      http: {
        requests: {
          total: httpRequestsSnapshot,
        },
      },
      llm: {
        requests: {
          total: llmRequestsSnapshot,
        },
      },
      auth: {
        success: { total: authSuccessTotal.value() },
        failure: { total: authFailureTotal.value() },
      },
      transport: {
        retries_total: transportRetriesTotal.total(),
      },
      'http.requests.total': httpRequestsSnapshot,
      'llm.requests.total': llmRequestsSnapshot,
      'auth.success.total': authSuccessTotal.value(),
      'auth.failure.total': authFailureTotal.value(),
      'transport.retries_total': transportRetriesTotal.total(),
      'listener_errors_total': listenerErrorsTotal.total(),
    },
    gauges: {
      sessions: {
        active: sessionsActive.value(),
      },
      sse: {
        subscribers: sseSubscribers.total(),
      },
      telemetry: {
        buffer: {
          fill: telemetryBufferFill.value(),
        },
      },
      'sessions.active': sessionsActive.value(),
      'sse.subscribers': sseSubscribers.total(),
      'telemetry.buffer.fill': telemetryBufferFill.value(),
    },
    histograms: {
      'http.request.duration_ms': httpRequestDurationMs.merged(),
      'llm.request.duration_ms': llmRequestDurationMs.merged(),
      'llm.tokens.input': llmTokensInput.merged(),
      'llm.tokens.output': llmTokensOutput.merged(),
    },
    // Per-model edit-failure + declared-exec-expectation-miss counts. Measurement
    // only: keyed by model id and failure class so tool-format regressions surface
    // as data ({ byModel: { [model]: { [class]: n } }, byClass: { [class]: n } }).
    toolFormat: toolFormatTelemetry.snapshot(),
  };
}
