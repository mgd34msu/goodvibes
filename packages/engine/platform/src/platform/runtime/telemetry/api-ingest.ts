import type { RuntimeEventDomain } from '../events/index.js';
import type { TelemetryRecord, TelemetrySeverity } from './api.js';
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

/**
 * Each OTLP log record becomes one telemetry record that reads as the log did:
 * its severity, time and body are the record's, so an ingested error log is in
 * the errors list and the severity filter finds it.
 */
export function ingestExternalTelemetryLogs(input: IngestTelemetryBaseInput): void {
  const resourceLogs = Array.isArray(input.payload['resourceLogs']) ? input.payload['resourceLogs'] as unknown[] : [];
  for (const resource of resourceLogs) {
    const serviceName = fromOtlpAttributes(objectRecord(objectRecord(resource)['resource'])['attributes'])['service.name'];
    const scopeLogs = listNestedArray(resource, 'scopeLogs');
    for (const scope of scopeLogs) {
      const logRecords = listNestedArray(scope, 'logRecords');
      for (const logRecord of logRecords) {
        const entry = objectRecord(logRecord);
        const severity = severityFromOtlp(entry['severityNumber'], entry['severityText']);
        const timestamp = parseUnixNanoToMs(entry['timeUnixNano']) ?? parseUnixNanoToMs(entry['observedTimeUnixNano']) ?? Date.now();
        const body = fromOtlpBody(entry['body']);
        const attributes: Record<string, unknown> = {
          ...fromOtlpAttributes(entry['attributes']),
          ...(typeof serviceName === 'string' ? { 'service.name': serviceName } : {}),
        };
        input.traceIdentities.capture(typeof entry['traceId'] === 'string' ? entry['traceId'] : undefined, traceId => {
          const record: TelemetryRecord = {
            ...buildIngestedTelemetryRecord('OTLP_LOG_INGEST', entry, input.nextSequence, traceId),
            timestamp,
            severity,
            message: body.length > 0 ? body : `OTLP log${typeof serviceName === 'string' ? ` from ${serviceName}` : ''}`,
            attributes,
          };
          input.appendRecord(record);
          input.recordEvent('OTLP_LOG_INGEST', record);
        });
      }
    }
  }
}

/** OTLP severity numbers: 1-8 trace and debug, 9-12 info, 13-16 warn, 17-24 error and fatal; else the text, else info. */
function severityFromOtlp(severityNumber: unknown, severityText: unknown): TelemetrySeverity {
  if (typeof severityNumber === 'number' && severityNumber >= 1) {
    return severityNumber >= 17 ? 'error' : severityNumber >= 13 ? 'warn' : severityNumber >= 9 ? 'info' : 'debug';
  }
  const text = typeof severityText === 'string' ? severityText.toLowerCase() : '';
  if (text.startsWith('err') || text.startsWith('fatal')) return 'error';
  if (text.startsWith('warn')) return 'warn';
  if (text.startsWith('debug') || text.startsWith('trace')) return 'debug';
  return 'info';
}

/** A log body is an OTLP AnyValue; text is used as it is, anything else as JSON. */
function fromOtlpBody(value: unknown): string {
  const body = objectRecord(value);
  if (typeof body['stringValue'] === 'string') return body['stringValue'];
  const decoded = fromOtlpAnyValue(value);
  if (decoded !== undefined) return String(decoded);
  if (Object.keys(body).length === 0) return '';
  try { return JSON.stringify(body); } catch { return ''; }
}

/** Each OTLP span becomes one span in the trace list; the request body is not kept a second time. */
export function ingestExternalTelemetryTraces(
  input: Pick<IngestTelemetryBaseInput, 'payload' | 'traceIdentities'> & {
    readonly appendSpan: (span: ReadableSpan) => void;
  },
): void {
  const resourceSpans = Array.isArray(input.payload['resourceSpans']) ? input.payload['resourceSpans'] as unknown[] : [];
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
      }
    }
  }
}

/**
 * Each OTLP metric that carries data points, as received: its name, unit,
 * description and the one signal (sum, gauge, histogram, ...) holding its
 * points. The telemetry service keeps the latest per name and serves it from
 * the metrics route beside its own.
 */
export function readExternalTelemetryMetrics(payload: Record<string, unknown>): Record<string, unknown>[] {
  const resourceMetrics = Array.isArray(payload['resourceMetrics']) ? payload['resourceMetrics'] as unknown[] : [];
  const found: Record<string, unknown>[] = [];
  for (const resource of resourceMetrics) {
    const scopeMetrics = listNestedArray(resource, 'scopeMetrics');
    for (const scope of scopeMetrics) {
      const metrics = listNestedArray(scope, 'metrics');
      for (const metric of metrics) {
        const metricRecord = objectRecord(metric);
        if (typeof metricRecord['name'] !== 'string' || metricRecord['name'].length === 0) continue;
        for (const signalKey of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) {
          const signal = metricRecord[signalKey];
          if (typeof signal !== 'object' || signal === null) continue;
          const dataPoints = (signal as Record<string, unknown>)['dataPoints'];
          if (!Array.isArray(dataPoints) || dataPoints.length === 0) continue;
          found.push({
            name: metricRecord['name'],
            ...(typeof metricRecord['description'] === 'string' ? { description: metricRecord['description'] } : {}),
            ...(typeof metricRecord['unit'] === 'string' ? { unit: metricRecord['unit'] } : {}),
            [signalKey]: signal,
          });
          break;
        }
      }
    }
  }
  return found;
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
