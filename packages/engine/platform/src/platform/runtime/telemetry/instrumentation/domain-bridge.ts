/**
 * DomainBridge, bridges RuntimeEventBus events to OTel span creation.
 *
 * Subscribes to all domain channels on the RuntimeEventBus and routes
 * lifecycle events to the appropriate span helper functions. Maintains
 * an active span map keyed by entity ID so that start events open spans
 * and terminal events close them with outcome context.
 *
 * Design principles:
 * - Span creation is purely observational, bridge failures must not
 *   affect the domain logic that emits events.
 * - All map lookups are safe, missing spans on terminal events are no-ops.
 * - The bridge is opt-in: calling `attach()` wires it; `detach()` unwires.
 */
import type { RuntimeEventBus } from '../../events/index.js';
import type { RuntimeTracer } from '../tracer.js';
import type { Span } from '../types.js';
import type { CascadeAppliedEvent } from '../../health/types.js';
import { recordHealthCascadeSpan } from '../spans/health.js';
import { attachAgentDomain, attachCompactionDomain, attachPermissionDomain, attachSessionDomain } from './domain-bridge-agent-session.js';
import { attachPluginDomain, attachMcpDomain } from './domain-bridge-plugin-mcp.js';
import { type DomainBridgeHelpers, type SpanMap } from './domain-bridge-shared.js';
import { attachTaskDomain, attachTransportDomain } from './domain-bridge-transport-task.js';
import { attachModelRequestDomain, attachToolDomain, attachTurnDomain } from './domain-bridge-turn-tool.js';
import { summarizeError } from '../../../utils/error-display.js';
import { logger } from '../../../utils/logger.js';

/**
 * DomainBridge wires the RuntimeEventBus to the OTel span system.
 *
 * Usage:
 * ```ts
 * const bridge = new DomainBridge(tracer);
 * const detach = bridge.attach(bus);
 * // later:
 * detach();
 * ```
 */
export class DomainBridge {
  /** Read per span, so spans follow the tracer the process has installed now. */
  private readonly _tracerOf: () => RuntimeTracer;

  /** Active spans per domain, keyed by entity ID. */
  private readonly _turnSpans: SpanMap = new Map();
  private readonly _toolSpans: SpanMap = new Map();
  private readonly _requestSpans: SpanMap = new Map();
  private readonly _pluginSpans: SpanMap = new Map();
  private readonly _mcpSpans: SpanMap = new Map();
  private readonly _transportSpans: SpanMap = new Map();
  private readonly _taskSpans: SpanMap = new Map();
  private readonly _agentSpans: SpanMap = new Map();
  private readonly _permissionSpans: SpanMap = new Map();
  private readonly _sessionSpans: SpanMap = new Map();
  private readonly _compactionSpans: SpanMap = new Map();

  constructor(tracer: RuntimeTracer | (() => RuntimeTracer)) {
    this._tracerOf = typeof tracer === 'function' ? tracer : () => tracer;
  }

  /**
   * Attach the bridge to the given event bus.
   *
   * Subscribes to all domain channels. Returns a cleanup function that
   * unsubscribes all listeners when called.
   *
   * @param bus - The RuntimeEventBus to subscribe to.
   * @returns A `detach` function that unsubscribes all domain listeners.
   */
  public attach(bus: RuntimeEventBus): () => void {
    const helpers = this._helpers();
    const unsubs: Array<() => void> = [
      attachTurnDomain({ bus, helpers }, this._turnSpans),
      attachToolDomain({ bus, helpers }, this._toolSpans, this._turnSpans),
      attachModelRequestDomain({ bus, helpers }, this._requestSpans, this._turnSpans),
      attachPluginDomain({ bus, helpers }, this._pluginSpans),
      attachMcpDomain({ bus, helpers }, this._mcpSpans),
      attachTransportDomain({ bus, helpers }, this._transportSpans),
      attachTaskDomain({ bus, helpers }, this._taskSpans),
      attachAgentDomain({ bus, helpers }, this._agentSpans),
      attachPermissionDomain({ bus, helpers }, this._permissionSpans, this._toolSpans),
      attachSessionDomain({ bus, helpers }, this._sessionSpans),
      attachCompactionDomain({ bus, helpers }, this._compactionSpans),
      // Health cascades travel on the session domain outside the typed event union.
      bus.onDomain('session', (env) => {
        const payload = env.payload as { readonly type: string };
        if (payload.type === 'CASCADE_APPLIED') this.recordCascade(payload as unknown as CascadeAppliedEvent, env.traceId ?? '');
      }),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
      // With the listeners gone no terminal event can arrive; end what is open
      // so those spans are exported rather than lost.
      for (const spans of this._allSpanMaps()) {
        for (const span of spans.values()) this._safe(() => span.end());
        spans.clear();
      }
    };
  }

  /**
   * Record a health cascade event as a point-in-time span.
   *
   * Called by the caller when CASCADE_APPLIED events are produced by the
   * CascadeEngine. The caller is responsible for providing the trace ID
   * from their current operational context.
   *
   * @param event - The CASCADE_APPLIED event.
   * @param traceId - Trace ID to use for correlation.
   */
  public recordCascade(event: CascadeAppliedEvent, traceId: string): void {
    this._safe(() => {
      recordHealthCascadeSpan(this._tracerOf(), event, { traceId });
    });
  }

  private _allSpanMaps(): SpanMap[] {
    return [
      this._turnSpans, this._toolSpans, this._requestSpans, this._pluginSpans, this._mcpSpans, this._transportSpans, this._taskSpans,
      this._agentSpans, this._permissionSpans, this._sessionSpans, this._compactionSpans,
    ];
  }

  private _safe(action: () => void): void {
    try {
      action();
    } catch (error) {
      logger.warn('Telemetry domain bridge action failed', {
        error: summarizeError(error),
      });
    }
  }

  private _withSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (span) action(span);
  }

  private _closeSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (!span) return;
    action(span);
    map.delete(key);
  }
  private _helpers(): DomainBridgeHelpers {
    const tracerOf = this._tracerOf;
    return {
      get tracer() { return tracerOf(); },
      safe: (action) => this._safe(action),
      withSpan: (map, key, action) => this._withSpan(map, key, action),
      closeSpan: (map, key, action) => this._closeSpan(map, key, action),
    };
  }
}
