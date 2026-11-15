import type { RuntimeEventDomain } from '../events/index.js';
import type { TelemetryRecord } from './api.js';
import type { AttributeValue, ReadableSpan, SpanAttributes, SpanEvent, SpanKind } from './types.js';
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
        const startMs = parseUnixNanoToMs(entry['startTimeUnixNano']) ?? Date.now();
        const endMs = parseUnixNanoToMs(entry['endTimeUnixNano']) ?? startMs;
        const parentSpanId = typeof entry['parentSpanId'] === 'string' && entry['parentSpanId'] !== ''
          ? entry['parentSpanId']
          : undefined;
        const status = objectRecord(entry['status']);
        const rawStatusCode = status['code'];
        const statusCode = rawStatusCode === 1 ? SpanStatusCode.OK : rawStatusCode === 2 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET;
        input.traceIdentities.capture(typeof entry['traceId'] === 'string' ? entry['traceId'] : undefined, traceId => input.appendSpan({
          name,
          kind: fromOtlpSpanKind(entry['kind']),
          spanContext: { traceId, spanId, isValid: true },
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          startTimeMs: startMs,
          endTimeMs: endMs,
          durationMs: Math.max(0, endMs - startMs),
          attributes: fromOtlpAttributes(entry['attributes']),
          events: listNestedEntries(entry['events']).map((event): SpanEvent => ({
            name: typeof event['name'] === 'string' ? event['name'] : '',
            timestamp: parseUnixNanoToMs(event['timeUnixNano']) ?? startMs,
            attributes: fromOtlpAttributes(event['attributes']),
          })),
          status: {
            code: statusCode,
            ...(typeof status['message'] === 'string' && status['message'] !== '' ? { message: status['message'] } : {}),
          },
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

/**
 * OTLP/JSON writes 64-bit nanosecond times as decimal strings (a plain number
 * is tolerated); a value that is neither is absent, not zero.
 */
function parseUnixNanoToMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value / 1_000_000) : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(BigInt(value) / 1_000_000n);
  return undefined;
}

/** OTLP span kinds count from 1 (0 is UNSPECIFIED); the in-process kinds count from 0. */
function fromOtlpSpanKind(value: unknown): SpanKind {
  switch (value) {
    case 3: return SpanKinds.CLIENT;
    case 2: return SpanKinds.SERVER;
    case 4: return SpanKinds.PRODUCER;
    case 5: return SpanKinds.CONSUMER;
    default: return SpanKinds.INTERNAL;
  }
}

function fromOtlpAnyValue(value: unknown): AttributeValue | undefined {
  const any = objectRecord(value);
  if (typeof any['stringValue'] === 'string') return any['stringValue'];
  if (typeof any['boolValue'] === 'boolean') return any['boolValue'];
  if (typeof any['doubleValue'] === 'number') return any['doubleValue'];
  if (typeof any['intValue'] === 'number') return any['intValue'];
  if (typeof any['intValue'] === 'string' && /^-?\d+$/.test(any['intValue'])) return Number(any['intValue']);
  const values = objectRecord(any['arrayValue'])['values'];
  if (Array.isArray(values)) {
    const items = values.map(fromOtlpAnyValue);
    if (items.every((item): item is string => typeof item === 'string')) return items;
    if (items.every((item): item is number => typeof item === 'number')) return items;
    if (items.every((item): item is boolean => typeof item === 'boolean')) return items;
  }
  return undefined;
}

function fromOtlpAttributes(value: unknown): SpanAttributes {
  const attributes: SpanAttributes = {};
  for (const entry of listNestedEntries(value)) {
    if (typeof entry['key'] !== 'string') continue;
    const decoded = fromOtlpAnyValue(entry['value']);
    if (decoded !== undefined) attributes[entry['key']] = decoded;
  }
  return attributes;
}

function listNestedEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectRecord) : [];
}

function listNestedArray(value: unknown, key: string): unknown[] {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key])
    ? (value as Record<string, unknown>)[key] as unknown[]
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
