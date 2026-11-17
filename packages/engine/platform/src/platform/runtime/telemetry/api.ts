import { VERSION } from '../../version.js';
import { platformTracer, telemetryBufferFill } from '../metrics.js';
import { TelemetryTraceIdentities } from './trace-identities.js';
import { normalizeError, type NormalizedError } from '../../utils/error-display.js';
import type {
  AnyRuntimeEvent,
  RuntimeEventBus,
  RuntimeEventDomain,
  RuntimeEventEnvelope,
} from '../events/index.js';
import type { RuntimeStore } from '../store/index.js';
import type {
  AttributeValue,
  ReadableSpan,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanStatus,
} from './types.js';
import { SpanKind as SpanKinds, SpanStatusCode } from './types.js';
import {
  ALL_DOMAINS,
  appendBounded,
  buildAttributes,
  buildListResponse,
  buildOtlpLogDocumentFromRecords,
  buildOtlpMetricDocumentFromState,
  buildOtlpTraceDocumentFromSpans,
  buildRecordId,
  createSpanId,
  clampLimit,
  DEFAULT_ERROR_LIMIT,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  extractErrorCandidate,
  extractProvider,
  inferErrorSource,
  inferSeverity,
  isErrorEventType,
  normalizePayload,
  SERVICE_NAME,
  summarizePayload,
  toAttributeValue,
  toObjectMap,
} from './api-helpers.js';
import {
  applyTelemetryRecordFilter,
  applyTelemetrySpanFilter,
  telemetryRecordMatches,
} from './api-query.js';
import { createTelemetryEventStream } from './api-stream.js';
import {
  ingestExternalTelemetryLogs,
  ingestExternalTelemetryMetrics,
  ingestExternalTelemetryTraces,
} from './api-ingest.js';

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';
export type TelemetryViewMode = 'safe' | 'raw';

export interface TelemetryFilter {
  readonly limit?: number | undefined;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly eventTypes?: readonly string[] | undefined;
  readonly severity?: TelemetrySeverity | undefined;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly view?: TelemetryViewMode | undefined;
}

export interface TelemetryRecord {
  readonly id: string;
  readonly domain: RuntimeEventDomain;
  readonly type: string;
  readonly timestamp: number;
  readonly severity: TelemetrySeverity;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly source: string;
  readonly message: string;
  readonly payload: unknown;
  readonly attributes: Record<string, unknown>;
  readonly error?: NormalizedError | undefined;
}

export interface TelemetryCapabilities {
  readonly signals: {
    readonly events: true;
    readonly errors: true;
    readonly metrics: true;
    readonly traces: boolean;
  };
  readonly encodings: {
    readonly json: true;
    readonly sse: true;
    readonly otlpJson: {
      readonly traces: true;
      readonly metrics: true;
      readonly logs: true;
    };
  };
}

/** Counts for the foreground session, read at snapshot time from the owners that count them. */
export interface SessionMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly agentsSpawned: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Gate decisions the owner answered. */
  readonly permissionPrompts: number;
  readonly permissionDenials: number;
  readonly errors: number;
  readonly warnings: number;
}

export interface TraceExportState {
  /** Spans are recorded in this process. */
  readonly recording: boolean;
  /** The collectors recorded spans are sent to; empty when they stay in-process. */
  readonly endpoints: readonly string[];
}

/** The process tracer's state: what `telemetry.otelMode` installed. */
export function readTraceExportState(): TraceExportState {
  const tracer = platformTracer();
  return { recording: tracer.enabled, endpoints: tracer.exportEndpoints() };
}

export interface TelemetryAggregates {
  readonly totalEvents: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalSpans: number;
  readonly byDomain: Readonly<Record<string, number>>;
  readonly byEventType: Readonly<Record<string, number>>;
  readonly errorsByCategory: Readonly<Record<string, number>>;
}

export interface TelemetryRuntimeSnapshot {
  readonly sessionId: string;
  readonly sessionStatus: string;
  /** Whether this process records spans (`telemetry.otelMode`) and where it sends them. */
  readonly traceExport: TraceExportState;
  readonly tasks: {
    readonly total: number;
    readonly queued: number;
    readonly running: number;
    readonly blocked: number;
  };
  readonly agents: {
    readonly total: number;
    readonly active: number;
  };
  readonly approvals: {
    readonly pending: number;
  };
}

export interface TelemetrySnapshot {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly generatedAt: number;
  readonly service: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: TelemetryCapabilities;
  readonly runtime: TelemetryRuntimeSnapshot;
  readonly sessionMetrics: SessionMetrics;
  readonly aggregates: TelemetryAggregates;
  readonly recent: {
    readonly events: TelemetryListResponse<TelemetryRecord>;
    readonly errors: TelemetryListResponse<TelemetryRecord>;
    readonly spans: TelemetryListResponse<ReadableSpan>;
  };
}

export interface TelemetryPageInfo {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly cursor?: string | undefined;
  readonly nextCursor?: string | undefined;
}

export interface TelemetryListResponse<T> {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly items: readonly T[];
  readonly pageInfo: TelemetryPageInfo;
}

/** Most open start-without-end spans kept per kind. */
const MAX_ACTIVE_SYNTHETIC_SPANS = 1000;

interface ActiveSyntheticSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly startTimeMs: number;
  readonly attributes: SpanAttributes;
}

interface TelemetryApiServiceOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  /** Read the owning daemon's current opt-in; omitted means raw reads are disabled. */
  readonly includeRawPrompts?: (() => boolean) | undefined;
  readonly eventLimit?: number | undefined;
  readonly errorLimit?: number | undefined;
  readonly spanLimit?: number | undefined;
  /**
   * Lists approvals so the snapshot can count those still undecided. The
   * store's gate flag cannot: the gate reports a request only after its
   * decision. Omitted, the pending count falls back to that flag.
   */
  readonly listApprovals?: (() => readonly { readonly status: string }[]) | undefined;
}

export class TelemetryRawViewDisabledError extends Error {
  readonly code = 'TELEMETRY_RAW_DISABLED';

  constructor() {
    super('Raw telemetry is disabled. Enable telemetry.includeRawPrompts to allow authorized raw reads.');
    this.name = 'TelemetryRawViewDisabledError';
  }
}

export class TelemetryApiService {
  private readonly runtimeBus: RuntimeEventBus;
  private readonly runtimeStore: RuntimeStore;
  private readonly includeRawPrompts: () => boolean;
  private readonly eventLimit: number;
  private readonly errorLimit: number;
  private readonly spanLimit: number;
  private readonly listApprovals: (() => readonly { readonly status: string }[]) | undefined;
  private readonly records: TelemetryRecord[] = [];
  private readonly errors: TelemetryRecord[] = [];
  private readonly spans: ReadableSpan[] = [];
  private readonly traceIdentities = new TelemetryTraceIdentities();
  private readonly eventCountsByDomain = new Map<string, number>();
  private readonly eventCountsByType = new Map<string, number>();
  private readonly errorCountsByCategory = new Map<string, number>();
  private readonly subscribers = new Set<(record: TelemetryRecord) => void>();
  private readonly unsubs: Array<() => void> = [];
  private readonly activeTurnSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeTaskSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeAgentSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeToolSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly turnSpanIds = new Map<string, string>();
  private readonly taskSpanIds = new Map<string, string>();
  private readonly agentSpanIds = new Map<string, string>();
  // Lifetime counters. The record, error and span buffers are bounded rings, so
  // their lengths stop growing at the limit and cannot feed a cumulative metric.
  private eventsRecorded = 0;
  private warningsRecorded = 0;
  private spansRecorded = 0;
  private seq = 0;

  constructor(options: TelemetryApiServiceOptions) {
    this.runtimeBus = options.runtimeBus;
    this.runtimeStore = options.runtimeStore;
    this.includeRawPrompts = options.includeRawPrompts ?? (() => false);
    this.listApprovals = options.listApprovals;
    this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    this.errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
    this.spanLimit = options.spanLimit ?? DEFAULT_SPAN_LIMIT;
    this.subscribeAllDomains();
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.subscribers.clear();
    for (const active of [this.activeTurnSpans, this.activeTaskSpans, this.activeAgentSpans, this.activeToolSpans]) {
      for (const span of active.values()) this.traceIdentities.release(span.traceId);
      active.clear();
    }
    this.turnSpanIds.clear();
    this.taskSpanIds.clear();
    this.agentSpanIds.clear();
  }

  subscribe(listener: (record: TelemetryRecord) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  isRawEnabled(): boolean {
    return this.includeRawPrompts() === true;
  }

  private assertViewAvailable(view: TelemetryViewMode): void {
    if (view === 'raw' && !this.isRawEnabled()) throw new TelemetryRawViewDisabledError();
  }

  getCapabilities(): TelemetryCapabilities {
    return {
      signals: {
        events: true,
        errors: true,
        metrics: true,
        traces: this.spans.length > 0,
      },
      encodings: {
        json: true,
        sse: true,
        otlpJson: {
          traces: true,
          metrics: true,
          logs: true,
        },
      },
    };
  }

  getSnapshot(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetrySnapshot {
    this.assertViewAvailable(view);
    rawAccessible = rawAccessible && this.isRawEnabled();
    const state = this.runtimeStore.getState();
    const limit = clampLimit(filter.limit, 20);
    return {
      version: 1,
      view,
      rawAccessible,
      generatedAt: Date.now(),
      service: {
        name: SERVICE_NAME,
        version: VERSION,
      },
      capabilities: this.getCapabilities(),
      runtime: {
        sessionId: state.session.id,
        sessionStatus: state.session.status,
        traceExport: readTraceExportState(),
        tasks: {
          total: state.tasks.tasks.size,
          queued: state.tasks.queuedIds.length,
          running: state.tasks.runningIds.length,
          blocked: state.tasks.blockedIds.length,
        },
        agents: {
          total: state.agents.agents.size,
          active: state.agents.activeAgentIds.length,
        },
        approvals: {
          pending: this.listApprovals
            ? this.listApprovals().filter((approval) => approval.status === 'pending' || approval.status === 'claimed').length
            : 0,
        },
      },
      sessionMetrics: this.getSessionMetrics(),
      aggregates: this.getAggregates(),
      recent: {
        events: this.listEventPage({ ...filter, limit }, view, rawAccessible),
        errors: this.listErrorPage({ ...filter, limit }, view, rawAccessible),
        spans: this.listSpanPage({ ...filter, limit }, view, rawAccessible),
      },
    };
  }

  /**
   * The session counters, computed now: tokens and turns from the conversation
   * domain, permission answers from the gate's decisions, the rest from the
   * lifetime event counts this service already keeps.
   */
  getSessionMetrics(): SessionMetrics {
    const state = this.runtimeStore.getState();
    const usage = state.conversation.sessionUsage;
    const count = (type: string): number => this.eventCountsByType.get(type) ?? 0;
    return {
      turns: state.conversation.totalTurns,
      toolCalls: count('TOOL_RECEIVED'),
      toolErrors: count('TOOL_FAILED'),
      agentsSpawned: count('AGENT_SPAWNING'),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      permissionPrompts: state.permissions.promptCount,
      permissionDenials: state.permissions.denialCount,
      errors: [...this.errorCountsByCategory.values()].reduce((sum, value) => sum + value, 0),
      warnings: this.warningsRecorded,
    };
  }

  getAggregates(): TelemetryAggregates {
    const totalErrors = [...this.errorCountsByCategory.values()].reduce((sum, count) => sum + count, 0);
    return {
      totalEvents: this.eventsRecorded,
      totalErrors,
      totalWarnings: this.warningsRecorded,
      totalSpans: this.spansRecorded,
      byDomain: toObjectMap(this.eventCountsByDomain),
      byEventType: toObjectMap(this.eventCountsByType),
      errorsByCategory: toObjectMap(this.errorCountsByCategory),
    };
  }

  listEvents(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listEventPage(filter, view, view === 'raw').items;
  }

  listErrors(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listErrorPage(filter, view, view === 'raw').items;
  }

  listSpans(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly ReadableSpan[] {
    return this.listSpanPage(filter, view, view === 'raw').items;
  }

  listEventPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    this.assertViewAvailable(view);
    const { items, pageInfo } = applyTelemetryRecordFilter(this.records, this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  listErrorPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    this.assertViewAvailable(view);
    const { items, pageInfo } = applyTelemetryRecordFilter(this.errors, this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  listSpanPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<ReadableSpan> {
    this.assertViewAvailable(view);
    const { items, pageInfo } = applyTelemetrySpanFilter(this.spans, this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  createStream(
    request: Request,
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): Response {
    this.assertViewAvailable(view);
    return createTelemetryEventStream({
      request,
      filter,
      view,
      rawAccessible: rawAccessible && this.isRawEnabled(),
      assertViewAvailable: () => this.assertViewAvailable(view),
      records: this.records,
      matchesRecord: (record, nextFilter) => telemetryRecordMatches(record, this.resolveTraceFilter(nextFilter)),
      subscribe: (listener) => this.subscribe(listener),
      getCapabilities: () => this.getCapabilities(),
      getSubscriberCount: () => this.subscribers.size,
    });
  }

  buildOtlpTraceDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpTraceDocumentFromSpans(this.listSpans(filter, view));
  }

  buildOtlpLogDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpLogDocumentFromRecords(this.listEvents(filter, view));
  }

  buildOtlpMetricDocument(): Record<string, unknown> {
    return buildOtlpMetricDocumentFromState(this.runtimeStore.getState(), this.getAggregates(), this.getSessionMetrics());
  }

  private subscribeAllDomains(): void {
    for (const domain of ALL_DOMAINS) {
      this.unsubs.push(this.runtimeBus.onDomain(domain, (envelope) => {
        this.handleEnvelope(domain, envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }));
    }
  }

  private resolveTraceFilter(filter: TelemetryFilter): TelemetryFilter {
    if (!filter.traceId) return filter;
    const traceId = this.traceIdentities.resolve(filter.traceId);
    // An unseen alias cannot equal a native trace ID. Keep it as a nonmatch,
    // rather than dropping the filter or creating a new identity while querying.
    return traceId === undefined ? filter : { ...filter, traceId };
  }

  private appendRecord(record: TelemetryRecord, buffer = this.records, limit = this.eventLimit): void {
    // Subscribers borrow this same record; its identity must stay fixed until
    // every retaining buffer releases it.
    Object.freeze(record);
    this.traceIdentities.retain(record.traceId);
    appendBounded(buffer, record, limit, evicted => this.traceIdentities.release(evicted.traceId));
  }

  private appendSpan(span: ReadableSpan): void {
    Object.freeze(span.spanContext);
    Object.freeze(span);
    this.spansRecorded += 1;
    this.traceIdentities.retain(span.spanContext.traceId);
    appendBounded(this.spans, span, this.spanLimit, evicted => this.traceIdentities.release(evicted.spanContext.traceId));
  }

  private startSyntheticSpan(
    active: Map<string, ActiveSyntheticSpan>,
    key: string,
    span: ActiveSyntheticSpan,
    spanIds?: Map<string, string>,
  ): void {
    this.traceIdentities.retain(span.traceId);
    const previous = active.get(key);
    active.set(key, span);
    spanIds?.set(key, span.spanId);
    if (previous !== undefined) this.traceIdentities.release(previous.traceId);
    // A start whose end event never arrives (a crash, a dropped event) would
    // otherwise stay here for the life of the process. Drop the oldest; it is
    // never exported, which is what a span that never ended amounts to.
    while (active.size > MAX_ACTIVE_SYNTHETIC_SPANS) {
      const oldestKey = active.keys().next().value as string;
      const oldest = active.get(oldestKey);
      active.delete(oldestKey);
      spanIds?.delete(oldestKey);
      if (oldest !== undefined) this.traceIdentities.release(oldest.traceId);
    }
  }

  private handleEnvelope(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): void {
    const payload = normalizePayload(envelope.payload);
    const errorCandidate = extractErrorCandidate(payload);
    const normalizedError = errorCandidate && isErrorEventType(envelope.type)
      ? normalizeError(errorCandidate, {
        source: inferErrorSource(domain),
        ...(extractProvider(payload) ? { provider: extractProvider(payload) } : {}),
      })
      : undefined;
    this.traceIdentities.capture(envelope.traceId, traceId => {
      const attributes = { ...buildAttributes(domain, envelope, payload), traceId };
      const record: TelemetryRecord = {
        id: buildRecordId(domain, envelope, this.seq++),
        domain,
        type: envelope.type,
        timestamp: envelope.ts,
        severity: inferSeverity(envelope.type, normalizedError),
        traceId,
        sessionId: envelope.sessionId ?? '',
        ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
        ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
        ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
        source: envelope.source ?? '',
        message: summarizePayload(envelope.type, payload),
        payload,
        attributes,
        ...(normalizedError ? { error: normalizedError } : {}),
      };

      this.appendRecord(record);
      this.countRecord(record);
      // An error-severity event with no error text is still an error: the
      // errors list and its counts must agree with the severity filter.
      const errorCategory = normalizedError?.category ?? (record.severity === 'error' ? 'unknown' : undefined);
      if (errorCategory !== undefined) {
        this.appendRecord(record, this.errors, this.errorLimit);
        this.errorCountsByCategory.set(errorCategory, (this.errorCountsByCategory.get(errorCategory) ?? 0) + 1);
      }
      telemetryBufferFill.set(this.eventLimit > 0 ? this.records.length / this.eventLimit : 0);
      this.captureSyntheticSpan(record);
      this.notify(record);
    });
  }

  private captureSyntheticSpan(record: TelemetryRecord): void {
    switch (record.type) {
      case 'TURN_SUBMITTED':
        if (record.turnId) {
          const spanId = createSpanId();
          this.startSyntheticSpan(this.activeTurnSpans, record.turnId, {
            name: 'turn.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          }, this.turnSpanIds);
        }
        return;
      case 'TASK_STARTED':
        if (record.taskId) {
          const spanId = createSpanId();
          this.startSyntheticSpan(this.activeTaskSpans, record.taskId, {
            name: 'task.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          }, this.taskSpanIds);
        }
        return;
      case 'AGENT_SPAWNING':
      case 'AGENT_RUNNING':
        if (record.agentId && !this.activeAgentSpans.has(record.agentId)) {
          const spanId = createSpanId();
          const parentSpanId = record.taskId ? this.taskSpanIds.get(record.taskId) : undefined;
          this.startSyntheticSpan(this.activeAgentSpans, record.agentId, {
            name: 'agent.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          }, this.agentSpanIds);
        }
        return;
      case 'TOOL_EXECUTING':
        if (typeof record.attributes.callId === 'string') {
          const callId = record.attributes.callId;
          const spanId = createSpanId();
          const parentSpanId = record.agentId
            ? this.agentSpanIds.get(record.agentId)
            : record.taskId
              ? this.taskSpanIds.get(record.taskId)
              : record.turnId
                ? this.turnSpanIds.get(record.turnId)
                : undefined;
          this.startSyntheticSpan(this.activeToolSpans, callId, {
            name: 'tool.execute',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TURN_COMPLETED':
      case 'TURN_ERROR':
      case 'TURN_CANCEL':
      case 'PREFLIGHT_FAIL':
        this.completeSyntheticSpan(record.turnId, this.activeTurnSpans, record, 'turn.lifecycle', this.turnSpanIds);
        return;
      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
      case 'TASK_CANCELLED':
        this.completeSyntheticSpan(record.taskId, this.activeTaskSpans, record, 'task.lifecycle', this.taskSpanIds);
        return;
      case 'AGENT_COMPLETED':
      case 'AGENT_FAILED':
      case 'AGENT_CANCELLED':
        this.completeSyntheticSpan(record.agentId, this.activeAgentSpans, record, 'agent.lifecycle', this.agentSpanIds);
        return;
      case 'TOOL_SUCCEEDED':
      case 'TOOL_FAILED':
      case 'TOOL_CANCELLED': {
        const callId = typeof record.attributes.callId === 'string' ? record.attributes.callId : undefined;
        this.completeSyntheticSpan(callId, this.activeToolSpans, record, 'tool.execute');
        return;
      }
      default:
        return;
    }
  }

  private completeSyntheticSpan(
    key: string | undefined,
    activeMap: Map<string, ActiveSyntheticSpan>,
    record: TelemetryRecord,
    defaultName: string,
    spanIds?: Map<string, string>,
  ): void {
    const active = key ? activeMap.get(key) : undefined;
    const durationMs = typeof record.attributes.durationMs === 'number' ? Math.max(0, record.attributes.durationMs) : undefined;
    const synthesized: ActiveSyntheticSpan = active ?? {
      name: defaultName,
      kind: SpanKinds.INTERNAL,
      traceId: record.traceId,
      spanId: createSpanId(),
      startTimeMs: durationMs !== undefined ? Math.max(0, record.timestamp - durationMs) : record.timestamp,
      attributes: this.buildSpanAttributes(record, { synthesized: true }),
    };
    if (key) {
      activeMap.delete(key);
      spanIds?.delete(key);
    }

    try {
      const status: SpanStatus = record.error || record.severity === 'error'
        ? { code: SpanStatusCode.ERROR, message: record.error?.summary ?? record.type }
        : { code: SpanStatusCode.OK };
      const events: SpanEvent[] = [
        {
          name: record.type,
          timestamp: record.timestamp,
          attributes: Object.fromEntries(
            Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
              .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
              .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
          ),
        },
      ];

      this.appendSpan(Object.freeze({
        name: synthesized.name,
        kind: synthesized.kind,
        spanContext: {
          traceId: synthesized.traceId,
          spanId: synthesized.spanId,
          isValid: true,
        },
        ...(synthesized.parentSpanId ? { parentSpanId: synthesized.parentSpanId } : {}),
        startTimeMs: synthesized.startTimeMs,
        endTimeMs: record.timestamp,
        durationMs: Math.max(0, record.timestamp - synthesized.startTimeMs),
        attributes: {
          ...synthesized.attributes,
          ...Object.fromEntries(
            Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
              .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
              .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
          ),
        },
        events,
        status,
        instrumentationScope: `${SERVICE_NAME}/telemetry`,
      }));
    } finally {
      if (active !== undefined) this.traceIdentities.release(active.traceId);
    }
  }

  private buildSpanAttributes(record: TelemetryRecord, extra: Record<string, unknown> = {}): SpanAttributes {
    const attributes: SpanAttributes = {};
    // Event payload fields first: one named `severity` or `source` must not
    // replace the envelope's value below.
    for (const [key, value] of Object.entries(record.attributes)) {
      const attributeValue = toAttributeValue(value);
      if (attributeValue !== undefined) {
        attributes[key] = attributeValue;
      }
    }
    Object.assign(attributes, {
      telemetryDomain: record.domain,
      eventType: record.type,
      source: record.source,
      severity: record.severity,
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...extra,
    });
    if (record.error) {
      attributes.errorCategory = record.error.category;
      attributes.errorSource = record.error.source;
      if (record.error.code) attributes.errorCode = record.error.code;
      if (record.error.statusCode !== undefined) attributes.errorStatusCode = record.error.statusCode;
      if (record.error.provider) attributes.errorProvider = record.error.provider;
      if (record.error.operation) attributes.errorOperation = record.error.operation;
    }
    return attributes;
  }

  /**
   * Implement TelemetryIngestSink.ingestLogs, delegates to ingestExternalLogs.
   * Satisfies the interface expected by DaemonHttpRouterContext.ingestSink.
   */
  ingestLogs(payload: Record<string, unknown>): void {
    this.ingestExternalLogs(payload);
  }

  /**
   * Implement TelemetryIngestSink.ingestTraces, delegates to ingestExternalTraces.
   */
  ingestTraces(payload: Record<string, unknown>): void {
    this.ingestExternalTraces(payload);
  }

  /**
   * Implement TelemetryIngestSink.ingestMetrics, delegates to ingestExternalMetrics.
   */
  ingestMetrics(payload: Record<string, unknown>): void {
    this.ingestExternalMetrics(payload);
  }

  /**
   * Ingest an externally-received OTLP log payload into this service's event
   * buffer. Each entry in `resourceLogs[].scopeLogs[].logRecords[]` is mapped
   * to a TelemetryRecord and appended to `this.records` with domain 'telemetry'.
   * Records are bounded by eventLimit (default 500). Subscribers are notified.
   * Call is synchronous and never throws.
   */
  ingestExternalLogs(payload: Record<string, unknown>): void {
    ingestExternalTelemetryLogs({
      payload,
      traceIdentities: this.traceIdentities,
      appendRecord: record => this.appendRecord(record),
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
    });
  }

  /**
   * Ingest an externally-received OTLP trace payload into this service's span
   * buffer. Each entry in `resourceSpans[].scopeSpans[].spans[]` is mapped
   * to a ReadableSpan and appended to `this.spans`, bounded by spanLimit.
   */
  ingestExternalTraces(payload: Record<string, unknown>): void {
    ingestExternalTelemetryTraces({
      payload,
      traceIdentities: this.traceIdentities,
      appendRecord: record => this.appendRecord(record),
      appendSpan: span => this.appendSpan(span),
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
    });
  }

  /**
   * Ingest an externally-received OTLP metrics payload. Creates a synthetic
   * TelemetryRecord tagged 'OTLP_METRICS_INGEST' and appends it to the event
   * buffer so it is visible on GET /api/v1/telemetry/events.
   * Sentinel is only emitted when at least one metric datapoint is present.
   */
  ingestExternalMetrics(payload: Record<string, unknown>): void {
    ingestExternalTelemetryMetrics({
      payload,
      traceIdentities: this.traceIdentities,
      appendRecord: record => this.appendRecord(record),
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
    });
  }

  private recordIngestedEvent(_type: string, record: TelemetryRecord): void {
    this.countRecord(record);
    this.notify(record);
  }

  private countRecord(record: TelemetryRecord): void {
    this.eventsRecorded += 1;
    if (record.severity === 'warn') this.warningsRecorded += 1;
    this.eventCountsByDomain.set(record.domain, (this.eventCountsByDomain.get(record.domain) ?? 0) + 1);
    this.eventCountsByType.set(record.type, (this.eventCountsByType.get(record.type) ?? 0) + 1);
  }

  private notify(record: TelemetryRecord): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(record);
      } catch {
        // Telemetry subscribers must never break the runtime.
      }
    }
  }
}
