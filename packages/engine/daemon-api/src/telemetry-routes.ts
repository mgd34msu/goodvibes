import type { DaemonTelemetryRouteHandlers } from './context.js';
import { jsonErrorResponse, missingScopeRefusal } from './error-response.js';
import type { AuthenticatedPrincipal } from './http-policy.js';
import { decodeOtlpProtobuf } from './otlp-protobuf.js';
import type { RuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { DaemonErrorCategory } from '@goodvibes-jev/engine/errors';
import { readBoundedPositiveInteger, readOptionalBoundedInteger, type JsonRecord } from './route-helpers.js';

type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';
type TelemetryViewMode = 'safe' | 'raw';

interface TelemetryFilter {
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

interface TelemetryApiLike {
  isRawEnabled(): boolean;
  getSnapshot(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): {
    readonly generatedAt: number;
    readonly view: TelemetryViewMode;
    readonly rawAccessible: boolean;
    readonly runtime: unknown;
    readonly sessionMetrics: unknown;
    readonly aggregates: unknown;
  };
  listEventPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  listErrorPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  listSpanPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  createStream(req: Request, filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): Response;
  buildOtlpTraceDocument(filter: TelemetryFilter, view: TelemetryViewMode): unknown;
  buildOtlpLogDocument(filter: TelemetryFilter, view: TelemetryViewMode): unknown;
  buildOtlpMetricDocument(): unknown;
}

/**
 * Ingest sink, receives parsed OTLP records forwarded by the POST receivers.
 * When null (no ingest sink wired), the POST receivers answer 503
 * TELEMETRY_UNAVAILABLE so an exporter never sees success for dropped data.
 */
interface TelemetryIngestSink {
  /** Ingest a batch of log records from an OTLP ExportLogsServiceRequest. */
  ingestLogs(payload: Record<string, unknown>): void;
  /** Ingest a batch of trace spans from an OTLP ExportTraceServiceRequest. */
  ingestTraces(payload: Record<string, unknown>): void;
  /** Ingest a batch of metric data points from an OTLP ExportMetricsServiceRequest. */
  ingestMetrics(payload: Record<string, unknown>): void;
}

interface TelemetryRouteContext {
  readonly telemetryApi: TelemetryApiLike | null;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipal | null;
  /**
   * Sink for OTLP POST receivers. Must be provided by the caller.
   * In production `DaemonHttpRouter` this is the `TelemetryApiService` instance
   * which stores ingested records in its bounded event buffer (default 500
   * records) and makes them observable via GET /api/v1/telemetry/events.
   * Pass `null` when ingestion is not available; the receivers then answer
   * 503 TELEMETRY_UNAVAILABLE after authenticating the caller.
   */
  readonly ingestSink: TelemetryIngestSink | null;
}

const MAX_TELEMETRY_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

function parseLimit(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  return readBoundedPositiveInteger(value, 100, 1_000);
}

function parseTimestampMillis(value: string | null): number | undefined {
  return readOptionalBoundedInteger(value, 0, MAX_TELEMETRY_TIMESTAMP_MS);
}

function parseCsv<T extends string>(value: string | null): readonly T[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as T[];
  return parsed.length > 0 ? parsed : undefined;
}

function parseSeverity(value: string | null): TelemetrySeverity | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function parseView(value: string | null): TelemetryViewMode | undefined {
  return value === 'safe' || value === 'raw' ? value : undefined;
}

function buildFilter(url: URL): TelemetryFilter {
  const limit = parseLimit(url.searchParams.get('limit'));
  const since = parseTimestampMillis(url.searchParams.get('since'));
  const until = parseTimestampMillis(url.searchParams.get('until'));
  const domains = parseCsv<RuntimeEventDomain>(url.searchParams.get('domains'));
  const eventTypes = parseCsv<string>(url.searchParams.get('types'));
  const severity = parseSeverity(url.searchParams.get('severity'));
  const view = parseView(url.searchParams.get('view'));
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(domains ? { domains } : {}),
    ...(eventTypes ? { eventTypes } : {}),
    ...(severity ? { severity } : {}),
    ...(url.searchParams.get('traceId') ? { traceId: url.searchParams.get('traceId') ?? undefined } : {}),
    ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId') ?? undefined } : {}),
    ...(url.searchParams.get('turnId') ? { turnId: url.searchParams.get('turnId') ?? undefined } : {}),
    ...(url.searchParams.get('agentId') ? { agentId: url.searchParams.get('agentId') ?? undefined } : {}),
    ...(url.searchParams.get('taskId') ? { taskId: url.searchParams.get('taskId') ?? undefined } : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') ?? undefined } : {}),
    ...(view ? { view } : {}),
  };
}

/** Max ingest payload (4 MiB), reject larger bodies with 413 */
const OTLP_INGEST_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Accepted content-types for OTLP/HTTP ingest. */
const OTLP_JSON_CONTENT_TYPE = 'application/json';
const OTLP_PROTOBUF_CONTENT_TYPES = new Set(['application/x-protobuf', 'application/protobuf']);

type OtlpIngestKind = 'logs' | 'traces' | 'metrics';

const OTLP_PARTIAL_SUCCESS_KEYS: Record<OtlpIngestKind, string> = {
  logs: 'partialSuccess',
  traces: 'partialSuccess',
  metrics: 'partialSuccess',
};
const OTLP_INGEST_SCOPES = ['ingest:telemetry', 'write:telemetry'] as const;

/**
 * Validate and parse an OTLP HTTP ingest request body.
 * Returns a parsed JSON Record on success, or a Response (error) on failure.
 *
 * Protocol: OTLP/HTTP spec §4.2, supports JSON and binary protobuf service
 * requests for logs, traces, and metrics.
 */
async function parseOtlpBody(
  req: Request,
  kind: OtlpIngestKind,
): Promise<JsonRecord | Response> {
  const contentType = ((req.headers.get('content-type') ?? '').toLowerCase().split(';')[0] ?? '').trim();

  const acceptsJson = contentType === OTLP_JSON_CONTENT_TYPE;
  const acceptsProtobuf = OTLP_PROTOBUF_CONTENT_TYPES.has(contentType);
  if (!acceptsJson && !acceptsProtobuf) {
    return jsonErrorResponse(
      {
        error: `Unsupported Content-Type '${contentType}' for OTLP ingest`,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        category: DaemonErrorCategory.BAD_REQUEST,
        hint: `Use '${OTLP_JSON_CONTENT_TYPE}' or 'application/x-protobuf'.`,
      },
      { status: 415 },
    );
  }

  // reject oversized requests before buffering the body into memory.
  const contentLength = Number(req.headers.get('content-length'));
  if (!Number.isNaN(contentLength) && contentLength > OTLP_INGEST_MAX_BODY_BYTES) {
    return jsonErrorResponse(
      {
        error: `OTLP ingest payload too large (Content-Length: ${contentLength} > ${OTLP_INGEST_MAX_BODY_BYTES} bytes)`,
        code: 'PAYLOAD_TOO_LARGE',
        category: DaemonErrorCategory.BAD_REQUEST,
      },
      { status: 413 },
    );
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > OTLP_INGEST_MAX_BODY_BYTES) {
    return jsonErrorResponse(
      {
        error: `OTLP ingest payload too large (${raw.byteLength} > ${OTLP_INGEST_MAX_BODY_BYTES} bytes)`,
        code: 'PAYLOAD_TOO_LARGE',
        category: DaemonErrorCategory.BAD_REQUEST,
      },
      { status: 413 },
    );
  }

  if (acceptsProtobuf) {
    try {
      return decodeOtlpProtobuf(kind, new Uint8Array(raw));
    } catch {
      return jsonErrorResponse(
        { error: 'OTLP ingest body is not valid protobuf', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
        { status: 400 },
      );
    }
  }

  try {
    const text = new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonErrorResponse(
        { error: 'OTLP ingest body must be a JSON object', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
        { status: 400 },
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    return jsonErrorResponse(
      { error: 'OTLP ingest body is not valid JSON', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
      { status: 400 },
    );
  }
}

function otlpIngestSuccess(kind: OtlpIngestKind): Response {
  // Per OTLP/HTTP spec: respond with ExportXxxServiceResponse shape.
  // partialSuccess omitted when empty (all records accepted).
  return Response.json({ [OTLP_PARTIAL_SUCCESS_KEYS[kind]]: {} });
}

function authenticateTelemetryIngest(context: TelemetryRouteContext, req: Request): AuthenticatedPrincipal | Response {
  const principal = context.resolveAuthenticatedPrincipal(req);
  if (!principal) {
    return jsonErrorResponse(
      { error: 'Authentication required for OTLP ingest', code: 'AUTH_REQUIRED', category: DaemonErrorCategory.AUTHENTICATION, status: 401 },
      { status: 401 },
    );
  }
  const missingIngest = principal.admin ? null : missingScopeRefusal('telemetry ingest', OTLP_INGEST_SCOPES, principal.scopes, { anyOf: true });
  if (missingIngest) return jsonErrorResponse(missingIngest, { status: 403 });
  return principal;
}

/** No ingest sink is wired, so the records would be dropped; the exporter must not read that as stored. */
function ingestUnavailable(): Response {
  return jsonErrorResponse({
    error: 'This daemon has no telemetry store to receive OTLP records.',
    code: 'TELEMETRY_UNAVAILABLE',
    category: DaemonErrorCategory.SERVICE,
    source: 'runtime',
    recoverable: true,
    state: 'the records were not stored',
    next: ['Send them to a daemon whose runtime is running (GET /api/v1/telemetry answers there)', 'Or keep them in the exporter and retry later'],
    status: 503,
  }, { status: 503 });
}

function unavailable(): Response {
  return jsonErrorResponse({
    error: 'Telemetry API unavailable',
    code: 'TELEMETRY_UNAVAILABLE',
    category: DaemonErrorCategory.SERVICE,
    source: 'runtime',
    recoverable: true,
    hint: 'Start the daemon runtime and ensure the runtime store is available before reading telemetry.',
    status: 503,
  }, { status: 503 });
}

function invalidCursor(error: unknown): Response {
  if (error instanceof Error && 'code' in error && error.code === 'TELEMETRY_RAW_DISABLED') return rawDisabled();
  // Only a cursor the store could not read is the caller's fault. Any other
  // failure is the daemon's, and telling the caller to drop its cursor would
  // hide it.
  if (!(error instanceof Error) || !error.message.startsWith('Invalid telemetry cursor')) {
    return jsonErrorResponse({
      error: 'Telemetry read failed. Retry shortly; if it keeps failing, check the daemon logs.',
      code: 'TELEMETRY_READ_FAILED',
      category: DaemonErrorCategory.SERVICE,
      source: 'runtime',
      recoverable: true,
      status: 500,
    }, { status: 500 });
  }
  return jsonErrorResponse({
    error: error instanceof Error ? error.message : 'Invalid telemetry cursor',
    code: 'INVALID_CURSOR',
    category: DaemonErrorCategory.BAD_REQUEST,
    source: 'runtime',
    recoverable: false,
    hint: 'Use the nextCursor returned by the previous telemetry page, or omit cursor to start from the newest records.',
    status: 400,
  }, { status: 400 });
}

function rawDisabled(): Response {
  return jsonErrorResponse({
    error: 'Raw telemetry is disabled',
    code: 'TELEMETRY_RAW_DISABLED',
    category: DaemonErrorCategory.AUTHORIZATION,
    source: 'permission',
    recoverable: false,
    hint: 'Enable telemetry.includeRawPrompts in the serving daemon configuration, then authenticate with read:telemetry-sensitive or an admin session.',
    status: 403,
  }, { status: 403 });
}

function authenticateTelemetryRequest(
  context: TelemetryRouteContext,
  req: Request,
  requestedView: TelemetryViewMode,
): { principal: AuthenticatedPrincipal; view: TelemetryViewMode; rawAccessible: boolean } | Response {
  const principal = context.resolveAuthenticatedPrincipal(req);
  if (!principal) {
    return jsonErrorResponse({
      error: 'Authentication required for telemetry access',
      code: 'AUTH_REQUIRED',
      category: DaemonErrorCategory.AUTHENTICATION,
      source: 'runtime',
      recoverable: false,
      hint: 'Authenticate with the operator shared token or an authenticated user session before calling telemetry APIs.',
      status: 401,
    }, { status: 401 });
  }

  const missingRead = missingScopeRefusal('telemetry access', ['read:telemetry'], principal.scopes, {
    hint: 'Use a token or session with the read:telemetry scope, or elevate to an admin/shared-token session.',
  });
  if (missingRead) return jsonErrorResponse(missingRead, { status: 403 });

  // One scope test grants and refuses the raw view, so a caller it refuses is told the scope, not the setting.
  const missingRaw = principal.admin ? null : missingScopeRefusal('the raw telemetry view', ['read:telemetry-sensitive'], principal.scopes, {
    hint: 'Use an admin/shared-token session or a token granted read:telemetry-sensitive to access raw telemetry payloads.',
  });
  const rawAuthorized = missingRaw === null;
  if (requestedView === 'raw' && missingRaw) return jsonErrorResponse(missingRaw, { status: 403 });

  const rawAccessible = rawAuthorized && context.telemetryApi?.isRawEnabled() === true;
  if (requestedView === 'raw' && !rawAccessible) return rawDisabled();

  return {
    principal,
    view: requestedView,
    rawAccessible,
  };
}

export function createDaemonTelemetryRouteHandlers(
  context: TelemetryRouteContext,
): DaemonTelemetryRouteHandlers {
  return {
    getTelemetrySnapshot: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible));
    },
    getTelemetryEvents: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listEventPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryErrors: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listErrorPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listSpanPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      const snapshot = context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible);
      return Response.json({
        version: 1,
        generatedAt: snapshot.generatedAt,
        view: snapshot.view,
        rawAccessible: snapshot.rawAccessible,
        runtime: snapshot.runtime,
        sessionMetrics: snapshot.sessionMetrics,
        aggregates: snapshot.aggregates,
      });
    },
    createTelemetryEventStream: (req) => {
      if (!context.telemetryApi) return unavailable();
      const filter = buildFilter(new URL(req.url));
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return context.telemetryApi.createStream(req, filter, access.view, access.rawAccessible);
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryOtlpTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpTraceDocument(filter, access.view));
    },
    getTelemetryOtlpLogs: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpLogDocument(filter, access.view));
    },
    getTelemetryOtlpMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const access = authenticateTelemetryRequest(context, req, 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpMetricDocument());
    },
    // -------------------------------------------------------------------------
    // OTLP POST ingest receivers
    // -------------------------------------------------------------------------
    postTelemetryOtlpLogs: async (req) => {
      const auth = authenticateTelemetryIngest(context, req);
      if (auth instanceof Response) return auth;
      const sink = context.ingestSink;
      if (!sink) return ingestUnavailable();
      const bodyOrErr = await parseOtlpBody(req, 'logs');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      sink.ingestLogs(bodyOrErr);
      return otlpIngestSuccess('logs');
    },
    postTelemetryOtlpTraces: async (req) => {
      const auth = authenticateTelemetryIngest(context, req);
      if (auth instanceof Response) return auth;
      const sink = context.ingestSink;
      if (!sink) return ingestUnavailable();
      const bodyOrErr = await parseOtlpBody(req, 'traces');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      sink.ingestTraces(bodyOrErr);
      return otlpIngestSuccess('traces');
    },
    postTelemetryOtlpMetrics: async (req) => {
      const auth = authenticateTelemetryIngest(context, req);
      if (auth instanceof Response) return auth;
      const sink = context.ingestSink;
      if (!sink) return ingestUnavailable();
      const bodyOrErr = await parseOtlpBody(req, 'metrics');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      sink.ingestMetrics(bodyOrErr);
      return otlpIngestSuccess('metrics');
    },
  };
}
