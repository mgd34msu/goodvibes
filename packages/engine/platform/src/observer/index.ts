/**
 * PlatformObserver, first-class observability hooks for the GoodVibes platform.
 *
 * Consumers can implement any subset of `PlatformObserver` and pass the instance
 * via the `observer` option on supported client factories. All methods are
 * optional; the platform works identically whether an observer is present or not.
 *
 * Observer call sites are wrapped through `invokeObserver`: an observer that
 * throws will not propagate into platform logic. Failures are reported and returned
 * so observer isolation does not hide broken callbacks.
 *
 * @example
 * const platform = createGoodVibesPlatform({
 *   baseUrl: 'https://daemon.example.com',
 *   tokenStore: createMemoryTokenStore(),
 *   observer: createConsoleObserver({ level: 'debug' }),
 * });
 */

/** OpenTelemetry SpanStatusCode.ERROR. Use in custom observer implementations with `span.setStatus({ code: SPAN_STATUS_ERROR })`. */
export const SPAN_STATUS_ERROR = 2 as const;

import type { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { AnyRuntimeEvent } from '../events/domain-map.js';
import type { TransportObserver, TransportActivityInfo } from '@goodvibes-jev/engine/transport-core';

export type { AnyRuntimeEvent };

/**
 * The auth state kind used in transition notifications.
 * - `'anonymous'`, no credentials present
 * - `'session'`, session-cookie or short-lived token
 * - `'token'`, long-lived bearer token
 */
export type AuthStateKind = 'anonymous' | 'session' | 'token';

/**
 * The reason an auth transition occurred.
 */
export type AuthTransitionReason = 'login' | 'logout' | 'refresh' | 'expire' | 'revoke';

/**
 * Re-export TransportActivityInfo from transport-core so platform consumers
 * don't need to import from an internal package.
 */
export type { TransportActivityInfo } from '@goodvibes-jev/engine/transport-core';

/**
 * Auth transition metadata surfaced to the observer.
 */
export interface AuthTransitionInfo {
  readonly from: AuthStateKind;
  readonly to: AuthStateKind;
  readonly reason: AuthTransitionReason;
}

/**
 * Optional observer interface. Implement any subset of methods and pass the
 * instance to a supported client factory. All methods are optional.
 *
 * Every call site should go through `invokeObserver` so observer errors are
 * isolated from platform control flow while remaining observable.
 */
// PlatformObserver extends TransportObserver which contributes:
//   onTransportActivity?(info: TransportActivityInfo): void
// See @goodvibes-jev/engine/transport-core for the inherited member definition.
export interface PlatformObserver extends TransportObserver {
  /**
   * Called for every event dispatched through the realtime transport
   * (SSE or WebSocket). Receives the fully-typed runtime event payload.
   *
   * Wired as of 0.19.7, fires on every envelope dispatched through
   * `createEventSourceConnector` and `createWebSocketConnector`.
   */
  onEvent?(event: AnyRuntimeEvent): void;

  /**
   * Called when the platform catches and is about to rethrow a GoodVibesError.
   * The error is still rethrown; this is notification only.
   *
   * Wired as of 0.19.7, fires at every `GoodVibesError` throw site in
   * the transport and auth layers before the error propagates to the caller.
   */
  onError?(err: GoodVibesError): void;

  /**
   * Called at HTTP/SSE/WebSocket transport boundaries.
   * - `'send'` fires before the request is dispatched.
   * - `'recv'` fires after a response is received (with status + duration).
   *
   * Wired as of 0.19.7, fires in `transport-http` request/response boundary
   * and in realtime connect/message boundaries.
   */
  onTransportActivity?(activity: TransportActivityInfo): void;

  /**
   * Called when the platform's auth state transitions (login, logout, token
   * refresh, expiry, or revocation).
   */
  onAuthTransition?(transition: AuthTransitionInfo): void;
}

/**
 * Result returned from a protected observer callback invocation.
 */
export type ObserverInvocationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

export interface InvokeObserverOptions {
  /**
   * Optional callback label included in failure logs.
   */
  readonly label?: string | undefined;
  /**
   * Set to false when a caller handles a failed result itself and does not want
   * the default warning.
   */
  readonly report?: boolean | undefined;
}

function reportObserverFailure(error: unknown, label: string | undefined): void {
  try {
    const suffix = label ? `: ${label}` : '';
    globalThis.console?.warn?.(`[platform:observer] observer callback failed${suffix}`, error);
  } catch {
    // Logging must not become another way for observer isolation to break platform flow.
  }
}

/**
 * Safely invoke an observer method. Observer errors are isolated so they
 * never disrupt platform control flow, but failures are returned and logged by
 * default. This is the canonical call pattern for all observer call sites
 * throughout the platform.
 *
 * @param fn - Zero-argument thunk wrapping the observer call.
 */
export function invokeObserver(
  fn: () => void,
  options: InvokeObserverOptions = {},
): ObserverInvocationResult {
  try {
    fn();
    return { ok: true };
  } catch (error) {
    if (options.report !== false) {
      reportObserverFailure(error, options.label);
    }
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

export interface ConsoleObserverOptions {
  /** Minimum log level. Defaults to `'info'`. */
  readonly level?: 'debug' | 'info' | undefined;
}

/**
 * Create a development-friendly observer that logs platform activity to the console.
 *
 * Use `level: 'debug'` to also log transport activity and every runtime event.
 *
 * @example
 * const platform = createGoodVibesPlatform({
 *   baseUrl: '...',
 *   observer: createConsoleObserver({ level: 'debug' }),
 * });
 */
export function createConsoleObserver(
  options: ConsoleObserverOptions = {},
): PlatformObserver {
  const level = options.level ?? 'info';

  return {
    /* eslint-disable no-console */
    onAuthTransition(transition) {
      console.log(
        `[platform:observer] auth transition ${transition.from} → ${transition.to} (${transition.reason})`,
      );
    },
    onError(err) {
      console.error(
        `[platform:observer] error kind=${err.kind} category=${err.category}`,
        err.message,
      );
    },
    onTransportActivity(activity) {
      if (level !== 'debug') return;
      const status = activity.status !== undefined ? ` status=${activity.status}` : '';
      const dur = activity.durationMs !== undefined ? ` ${activity.durationMs}ms` : '';
      console.debug(
        `[platform:observer] transport ${activity.direction} ${activity.kind ?? 'http'} ${activity.url}${status}${dur}`,
      );
    },
    onEvent(event) {
      if (level !== 'debug') return;
      console.debug(`[platform:observer] event ${event.type}`);
    },
    /* eslint-enable no-console */
  };
}

/**
 * Accept-only OpenTelemetry types so we don't add a hard dependency on
 * `@opentelemetry/*`. Consumers bring their own tracer and meter.
 */
export interface OtelTracer {
  startActiveSpan<F extends (span: OtelSpan) => unknown>(name: string, fn: F): ReturnType<F>;
  startSpan(name: string, options?: unknown): OtelSpan;
}

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(error: Error | unknown): this;
  end(): void;
}

export interface OtelMeter {
  createCounter(name: string, options?: { description?: string }): OtelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram;
}

export interface OtelCounter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface OtelHistogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

/**
 * Create an observer that emits OpenTelemetry spans and metrics.
 *
 * Pass a pre-configured `Tracer` and `Meter` from your OpenTelemetry SDK setup.
 * This adapter has no hard dependency on `@opentelemetry/*`, it accepts the
 * abstractions defined above, which match the subset of the real
 * OpenTelemetry API.
 *
 * @example
 * import { trace, metrics } from '@opentelemetry/api';
 *
 * const observer = createOpenTelemetryObserver(
 *   trace.getTracer('goodvibes-platform'),
 *   metrics.getMeter('goodvibes-platform'),
 * );
 * const platform = createGoodVibesPlatform({ baseUrl: '...', observer });
 */
export function createOpenTelemetryObserver(
  tracer: OtelTracer,
  meter: OtelMeter,
): PlatformObserver {
  const authCounter = meter.createCounter('platform.auth.transitions', {
    description: 'Number of platform auth state transitions',
  });
  const errorCounter = meter.createCounter('platform.errors', {
    description: 'Number of platform errors observed',
  });
  const transportHistogram = meter.createHistogram('platform.transport.duration_ms', {
    description: 'platform transport call duration',
    unit: 'ms',
  });

  return {
    onAuthTransition(transition) {
      authCounter.add(1, {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
      });
      const span = tracer.startSpan('platform.auth.transition');
      span.setAttribute('platform.auth.from', transition.from);
      span.setAttribute('platform.auth.to', transition.to);
      span.setAttribute('platform.auth.reason', transition.reason);
      span.end();
    },
    onError(err) {
      errorCounter.add(1, { kind: err.kind, category: err.category });
      const span = tracer.startSpan('platform.error');
      span.setAttribute('platform.error.kind', err.kind);
      span.setAttribute('platform.error.category', err.category);
      span.setAttribute('platform.error.recoverable', err.recoverable);
      span.recordException(err);
      span.setStatus({ code: SPAN_STATUS_ERROR, message: err.message });
      span.end();
    },
    onTransportActivity(activity) {
      if (activity.direction !== 'recv') return; // only record completed calls
      if (activity.durationMs !== undefined) {
        transportHistogram.record(activity.durationMs, {
          kind: activity.kind ?? 'http',
          ...(activity.status !== undefined && { status: activity.status }),
        });
      }
    },
    onEvent(_event) {
      // Event counting is high-cardinality; consumers can add their own meter
      // by wrapping this observer if they need per-event metrics.
    },
  };
}
