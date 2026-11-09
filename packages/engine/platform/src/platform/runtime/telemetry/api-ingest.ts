import type { RuntimeEventDomain } from '../events/index.js';
import type { TelemetryRecord } from './api.js';
import type { ReadableSpan } from './types.js';
import type { TelemetryTraceIdentities } from './trace-identities.js';
import { SpanKind as SpanKinds, SpanStatusCode } from './types.js';
import { createSpanId } from './api-helpers.js';

interface IngestTelemetryBaseInput {
  readonly payload: Record<string, unknown>;
  readonly traceIdentities: TelemetryTraceIdentities;
  readonly appendRecord: (record: TelemetryRecord) => void;
  readonly recordEvent: (type: string, record: TelemetryRecord) => void;
  readonly nextSequence: () => number;
}

export function ingestExternalTelemetryLogs(input: IngestTelemetryBaseInput): void {
  const resourceLogs = Array.isArray(input.payload['resourceLogs']) ? input.payload['resourceLogs'] as unknown[] : [];
  for (const resource of resourceLogs) {
    const scopeLogs = listNestedArray(resource, 'scopeLogs');
    for (const scope of scopeLogs) {
      const logRecords = listNestedArray(scope, 'logRecords');
      for (const logRecord of logRecords) {
        const entry = objectRecord(logRecord);
        publishIngestedRecord('OTLP_LOG_INGEST', entry, input);
      }
    }
  }
}

export function ingestExternalTelemetryTraces(
  input: IngestTelemetryBaseInput & {
    readonly appendSpan: (span: ReadableSpan) => void;
  },
): void {
  const resourceSpans = Array.isArray(input.payload['resourceSpans']) ? input.payload['resourceSpans'] as unknown[] : [];
  let spansAppended = 0;
  for (const resource of resourceSpans) {
    const scopeSpans = listNestedArray(resource, 'scopeSpans');
    for (const scope of scopeSpans) {
      const spans = listNestedArray(scope, 'spans');
      for (const spanPayload of spans) {
        const entry = objectRecord(spanPayload);
        const spanId = typeof entry['spanId'] === 'string' ? entry['spanId'] : createSpanId();
        const name = typeof entry['name'] === 'string' ? entry['name'] : 'otlp.span';
        const startMs = typeof entry['startTimeUnixNano'] === 'number'
          ? Math.floor(entry['startTimeUnixNano'] / 1_000_000)
          : Date.now();
        const endMs = typeof entry['endTimeUnixNano'] === 'number'
          ? Math.floor(entry['endTimeUnixNano'] / 1_000_000)
          : startMs;
        input.traceIdentities.capture(typeof entry['traceId'] === 'string' ? entry['traceId'] : undefined, traceId => input.appendSpan({
          name,
          kind: SpanKinds.INTERNAL,
          spanContext: { traceId, spanId, isValid: true },
          startTimeMs: startMs,
          endTimeMs: endMs,
          durationMs: endMs - startMs,
          attributes: {},
          events: [],
          status: { code: SpanStatusCode.UNSET },
          instrumentationScope: 'otlp-ingest',
        }));
        spansAppended += 1;
      }
    }
  }
  if (spansAppended === 0) return;
  publishIngestedRecord('OTLP_TRACE_INGEST', input.payload, input);
}

export function ingestExternalTelemetryMetrics(input: IngestTelemetryBaseInput): void {
  const resourceMetrics = Array.isArray(input.payload['resourceMetrics']) ? input.payload['resourceMetrics'] as unknown[] : [];
  let datapointsFound = 0;
  for (const resource of resourceMetrics) {
    const scopeMetrics = listNestedArray(resource, 'scopeMetrics');
    for (const scope of scopeMetrics) {
      const metrics = listNestedArray(scope, 'metrics');
      for (const metric of metrics) {
        const metricRecord = objectRecord(metric);
        for (const signalKey of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) {
          const signal = metricRecord[signalKey]!;
          if (typeof signal !== 'object' || signal === null) continue;
          const dataPoints = (signal as Record<string, unknown>)['dataPoints'];
          if (Array.isArray(dataPoints)) datapointsFound += dataPoints.length;
        }
      }
    }
  }
  if (datapointsFound === 0) return;
  publishIngestedRecord('OTLP_METRICS_INGEST', input.payload, input);
}

function publishIngestedRecord(type: string, payload: Record<string, unknown>, input: IngestTelemetryBaseInput): void {
  input.traceIdentities.capture(typeof payload['traceId'] === 'string' ? payload['traceId'] : undefined, traceId => {
    const record = buildIngestedTelemetryRecord(type, payload, input.nextSequence, traceId);
    input.appendRecord(record);
    input.recordEvent(type, record);
  });
}

function buildIngestedTelemetryRecord(
  type: string,
  payload: Record<string, unknown>,
  nextSequence: () => number,
  traceId: string,
): TelemetryRecord {
  const domain: RuntimeEventDomain = 'ops';
  const now = Date.now();
  const seq = nextSequence();
  return {
    id: `${domain}:${type}:${now}:${seq}`,
    domain,
    type,
    timestamp: now,
    severity: 'info',
    traceId,
    sessionId: '',
    source: 'otlp-ingest',
    message: `OTLP ingest: ${type}`,
    payload,
    attributes: {},
  };
}

function listNestedArray(value: unknown, key: string): unknown[] {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key])
    ? (value as Record<string, unknown>)[key] as unknown[]
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
