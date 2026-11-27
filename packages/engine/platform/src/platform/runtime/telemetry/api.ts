import { VERSION } from '../../version.js';
import { platformTracer, telemetryBufferFill } from '../metrics.js';
import { onSpanEnded } from './tracer.js';
import { TelemetryTraceIdentities } from './trace-identities.js';
import { normalizeError, type NormalizedError } from '../../utils/error-display.js';
import type {
  AnyRuntimeEvent,
  RuntimeEventBus,
  RuntimeEventDomain,
  RuntimeEventEnvelope,
} from '../events/index.js';
import type { RuntimeStore } from '../store/index.js';
import type { ReadableSpan } from './types.js';
import {
  ALL_DOMAINS,
  appendBounded,
  buildAttributes,
  buildListResponse,
  buildOtlpLogDocumentFromRecords,
  buildOtlpMetricDocumentFromState,
  buildOtlpTraceDocumentFromSpans,
  buildRecordId,
  clampLimit,
  DEFAULT_ERROR_LIMIT,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  extractErrorCandidate,
  extractProvider,
  inferErrorSource,
  inferSeverity,
  isErrorEventType,
  isStreamChunkEventType,
  normalizePayload,
  SERVICE_NAME,
  summarizePayload,
  toObjectMap,
} from './api-helpers.js';
import {
  applyTelemetryRecordFilter,
  applyTelemetrySpanFilter,
  telemetryRecordMatches,
} from './api-query.js';
import { createTelemetryEventStream } from './api-stream.js';
import { isOpenApprovalStatus } from '../../control-plane/approval-lifecycle.js';
import { currentRecordReach, keepReachable, type RecordReachFilter } from '@goodvibes/engine/daemon-api';

/**
 * Whether a record is of a session or an agent the caller may reach (control-plane/caller-reach.ts): its session (a
 * web chat as itself, a shared or hosted session), else the agent it names. A record of neither (the daemon's own
 * session, its startup, its transport) is the owner's.
 */
function telemetryRecordReachable(record: Pick<TelemetryRecord, 'sessionId' | 'agentId'>, reach: RecordReachFilter): boolean {
  if (record.sessionId && reach('session', record.sessionId)) return true;
  return record.agentId !== undefined && reach('task', record.agentId);
}

/** The records the request's caller may reach (all of them for the owner himself). */
function reachableTelemetryRecords(records: readonly TelemetryRecord[]): readonly TelemetryRecord[] {
  const reach = currentRecordReach();
  return reach ? records.filter((record) => telemetryRecordReachable(record, reach)) : records;
}

/** The spans of a session the request's caller may reach (`session.id` or a compaction's `compaction.session_id`). */
function reachableSpans(spans: readonly ReadableSpan[]): readonly ReadableSpan[] {
  const reach = currentRecordReach();
  if (!reach) return spans;
  return spans.filter((span) => {
    const attributes = span.attributes as Readonly<Record<string, unknown>> | undefined;
    const sessionId = attributes?.['session.id'] ?? attributes?.['compaction.session_id'];
    return typeof sessionId === 'string' && sessionId !== '' && reach('session', sessionId);
  });
}
import {
  ingestExternalTelemetryLogs,
  ingestExternalTelemetryTraces,
  readExternalTelemetryMetrics,
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
  /** Of those, the ones that are down now: their last batch failed after all retries and its spans were dropped. */
  readonly unreachable: readonly string[];
}

/** The process tracer's state: what `telemetry.otelMode` installed. */
export function readTraceExportState(): TraceExportState {
  const tracer = platformTracer();
  return { recording: tracer.enabled, endpoints: tracer.exportEndpoints(), unreachable: tracer.unreachableEndpoints() };
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
  /** The process session id (`user-<id>`), fixed for the life of this process. */
  readonly sessionId: string;
  /** The saved conversation running now, the id /resume and the session list use; empty when none is open. */
  readonly conversationSessionId: string;
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

/** Most externally posted metrics kept, by name; the oldest name is dropped first. */
const MAX_INGESTED_METRICS = 256;

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
  /** The latest metric posted to the OTLP metrics receiver, per metric name. */
  private readonly ingestedMetrics = new Map<string, Record<string, unknown>>();
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
    // The spans telemetry.otelMode records (turns, tools, agents, tasks, model
    // calls, ...) are the spans this service lists: the same ones a collector
    // receives. With the mode off nothing is recorded and the list holds only
    // spans posted to the OTLP traces receiver.
    this.unsubs.push(onSpanEnded((span) => this.appendTracerSpan(span)));
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.subscribers.clear();
    this.ingestedMetrics.clear();
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
        traces: this.spans.length > 0 || platformTracer().enabled,
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
    // A caller that is not the owner himself: every count is of what it may reach (control-plane/caller-reach.ts).
    if (currentRecordReach() !== undefined) return this.reachableSnapshot(filter, view, rawAccessible, limit);
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
        conversationSessionId: state.session.conversationSessionId,
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
            ? this.listApprovals().filter((approval) => isOpenApprovalStatus(approval.status)).length
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
   * The snapshot for a caller that is not the owner himself: the records, errors and spans it may reach (sessions and
   * agents of the projects given it), and every count made of those (tasks, agents and waiting questions by the same
   * rule; turns, tool calls, tokens and errors from the kept records it may reach). The daemon's own lifetime counters,
   * which keep no session, are the owner's.
   */
  private reachableSnapshot(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean, limit: number): TelemetrySnapshot {
    const state = this.runtimeStore.getState();
    const records = reachableTelemetryRecords(this.records);
    const errors = reachableTelemetryRecords(this.errors);
    const spans = reachableSpans(this.spans);
    const tasks = keepReachable([...state.tasks.tasks.values()], 'task', (task) => task.id);
    const agents = keepReachable([...state.agents.agents.values()], 'task', (agent) => agent.id);
    const approvals = this.listApprovals ? keepReachable(this.listApprovals(), 'approval', (approval) => approval.id) : [];
    const count = (type: string): number => records.filter((record) => record.type === type).length;
    const tokens = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens'): number => records
      .filter((record) => record.type === 'LLM_RESPONSE_RECEIVED')
      .reduce((sum, record) => { const value = (record.payload as Record<string, unknown> | null)?.[field]; return sum + (typeof value === 'number' ? value : 0); }, 0);
    const tally = (keys: readonly string[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const key of keys) out[key] = (out[key] ?? 0) + 1;
      return out;
    };
    const warnings = records.filter((record) => record.severity === 'warn').length;
    return {
      version: 1,
      view,
      rawAccessible,
      generatedAt: Date.now(),
      service: { name: SERVICE_NAME, version: VERSION },
      capabilities: this.getCapabilities(),
      runtime: {
        sessionId: state.session.id,
        conversationSessionId: state.session.conversationSessionId,
        sessionStatus: state.session.status,
        traceExport: readTraceExportState(),
        tasks: {
          total: tasks.length,
          queued: tasks.filter((task) => task.status === 'queued').length,
          running: tasks.filter((task) => task.status === 'running').length,
          blocked: tasks.filter((task) => task.status === 'blocked').length,
        },
        agents: {
          total: agents.length,
          active: agents.filter((agent) => state.agents.activeAgentIds.includes(agent.id)).length,
        },
        approvals: { pending: approvals.filter((approval) => isOpenApprovalStatus(approval.status)).length },
      },
      sessionMetrics: {
        turns: count('TURN_COMPLETED'),
        toolCalls: count('TOOL_RECEIVED'),
        toolErrors: count('TOOL_FAILED'),
        agentsSpawned: count('AGENT_SPAWNING'),
        inputTokens: tokens('inputTokens'),
        outputTokens: tokens('outputTokens'),
        cacheReadTokens: tokens('cacheReadTokens'),
        permissionPrompts: approvals.length,
        permissionDenials: approvals.filter((approval) => approval.status === 'denied').length,
        errors: errors.length,
        warnings,
      },
      aggregates: {
        totalEvents: records.length,
        totalErrors: errors.length,
        totalWarnings: warnings,
        totalSpans: spans.length,
        byDomain: tally(records.map((record) => record.domain)),
        byEventType: tally(records.map((record) => record.type)),
        errorsByCategory: tally(errors.map((record) => String(record.error?.category ?? 'unknown'))),
      },
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
    const { items, pageInfo } = applyTelemetryRecordFilter(reachableTelemetryRecords(this.records), this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  listErrorPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    this.assertViewAvailable(view);
    const { items, pageInfo } = applyTelemetryRecordFilter(reachableTelemetryRecords(this.errors), this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  listSpanPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<ReadableSpan> {
    this.assertViewAvailable(view);
    const { items, pageInfo } = applyTelemetrySpanFilter(reachableSpans(this.spans), this.resolveTraceFilter(filter), view);
    return buildListResponse(items, view, rawAccessible && this.isRawEnabled(), pageInfo);
  }

  createStream(
    request: Request,
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): Response {
    this.assertViewAvailable(view);
    // The reach of the caller who opened the stream, read now (its later frames are sent outside its request): it
    // follows only records of sessions and agents it may reach (control-plane/caller-reach.ts), live and replayed.
    const reach = currentRecordReach();
    const mayFollow = (record: TelemetryRecord): boolean => !reach || telemetryRecordReachable(record, reach);
    return createTelemetryEventStream({
      request,
      filter,
      view,
      rawAccessible: rawAccessible && this.isRawEnabled(),
      assertViewAvailable: () => this.assertViewAvailable(view),
      records: this.records,
      matchesRecord: (record, nextFilter) => mayFollow(record) && telemetryRecordMatches(record, this.resolveTraceFilter(nextFilter)),
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
    return buildOtlpMetricDocumentFromState(
      this.runtimeStore.getState(),
      this.getAggregates(),
      this.getSessionMetrics(),
      [...this.ingestedMetrics.values()],
    );
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

  /** A span a tracer in this process ended, under the trace id its events' records carry here. */
  private appendTracerSpan(span: ReadableSpan): void {
    this.traceIdentities.capture(span.spanContext.traceId, (traceId) => {
      this.appendSpan(traceId === span.spanContext.traceId
        ? span
        : { ...span, spanContext: { ...span.spanContext, traceId } });
    });
  }

  private handleEnvelope(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): void {
    // A streamed chunk is counted, not kept: hundreds arrive per answer and
    // would push everything else out of the history and the resume window.
    if (isStreamChunkEventType(envelope.type)) {
      this.countType(domain, envelope.type);
      return;
    }
    const payload = normalizePayload(envelope.payload);
    const errorCandidate = extractErrorCandidate(payload);
    const normalizedError = errorCandidate && isErrorEventType(envelope.type)
      ? normalizeError(errorCandidate, {
        source: inferErrorSource(domain),
        ...(extractProvider(payload) ? { provider: extractProvider(payload) } : {}),
      })
      : undefined;
    this.traceIdentities.capture(envelope.traceId, traceId => {
      const attributes = { ...buildAttributes(domain, envelope), traceId };
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
      this.notify(record);
    });
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
   * buffer. Each entry in `resourceLogs[].scopeLogs[].logRecords[]` becomes a
   * record with the log's severity, time and body; an error log is also in the
   * errors list. Records are bounded by eventLimit (default 500). Subscribers
   * are notified. Call is synchronous and never throws.
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
      appendSpan: span => this.appendSpan(span),
    });
  }

  /**
   * Ingest an externally-received OTLP metrics payload. The latest posting of
   * each metric (by name) is kept and served by the metrics route, under the
   * `otlp-ingest` scope, beside this service's own metrics.
   */
  ingestExternalMetrics(payload: Record<string, unknown>): void {
    for (const metric of readExternalTelemetryMetrics(payload)) {
      const name = metric['name'] as string;
      this.ingestedMetrics.delete(name);
      this.ingestedMetrics.set(name, metric);
      if (this.ingestedMetrics.size > MAX_INGESTED_METRICS) {
        const oldest = this.ingestedMetrics.keys().next();
        if (!oldest.done) this.ingestedMetrics.delete(oldest.value);
      }
    }
  }

  private recordIngestedEvent(_type: string, record: TelemetryRecord): void {
    this.countRecord(record);
    if (record.severity === 'error') {
      this.appendRecord(record, this.errors, this.errorLimit);
      this.errorCountsByCategory.set('external', (this.errorCountsByCategory.get('external') ?? 0) + 1);
    }
    this.notify(record);
  }

  private countRecord(record: TelemetryRecord): void {
    if (record.severity === 'warn') this.warningsRecorded += 1;
    this.countType(record.domain, record.type);
  }

  private countType(domain: string, type: string): void {
    this.eventsRecorded += 1;
    this.eventCountsByDomain.set(domain, (this.eventCountsByDomain.get(domain) ?? 0) + 1);
    this.eventCountsByType.set(type, (this.eventCountsByType.get(type) ?? 0) + 1);
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
