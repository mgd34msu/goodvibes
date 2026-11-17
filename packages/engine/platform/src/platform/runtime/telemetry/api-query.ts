import type { ReadableSpan } from './types.js';
import type {
  TelemetryFilter,
  TelemetryPageInfo,
  TelemetryRecord,
  TelemetryViewMode,
} from './api.js';
import {
  buildSpanCursor,
  clampLimit,
  extractRecordSequence,
  sanitizeRecord,
  sanitizeSpan,
} from './api-helpers.js';

export function compareTelemetryRecordsNewestFirst(left: TelemetryRecord, right: TelemetryRecord): number {
  const timestampDelta = right.timestamp - left.timestamp;
  if (timestampDelta !== 0) return timestampDelta;
  return extractRecordSequence(right) - extractRecordSequence(left);
}

/** What an SSE reconnect is sent before it goes live. */
export interface TelemetryResume {
  /** Records after the cursor, oldest first, at most the limit. */
  readonly records: readonly TelemetryRecord[];
  /** The cursor is no longer held, so records between it and the oldest one held may be missing. */
  readonly gap: boolean;
  /** More records than the limit were missed; the oldest of them are not sent. */
  readonly truncated: boolean;
}

/**
 * Records that happened after `cursor`, oldest first, for an SSE reconnect:
 * the newest `limit` of them, so the stream continues without a hole before
 * live records (`truncated` says older ones were skipped). The cursor record
 * itself is not repeated, and it need not match the filter. A cursor the
 * history no longer holds resumes from the records held, and says so (`gap`).
 */
export function listTelemetryRecordsAfterCursor(
  records: readonly TelemetryRecord[],
  matches: (record: TelemetryRecord) => boolean,
  cursor: string,
  limit: number,
): TelemetryResume {
  const newestFirst = [...records].sort(compareTelemetryRecordsNewestFirst);
  const found = newestFirst.findIndex((record) => record.id === cursor);
  const missed = newestFirst.slice(0, found >= 0 ? found : newestFirst.length).filter(matches);
  return {
    records: missed.slice(0, limit).reverse(),
    gap: found < 0,
    truncated: missed.length > limit,
  };
}

export function applyTelemetryRecordFilter(
  records: readonly TelemetryRecord[],
  filter: TelemetryFilter,
  view: TelemetryViewMode,
): { items: readonly TelemetryRecord[]; pageInfo: TelemetryPageInfo } {
  const filtered = records.filter((record) => telemetryRecordMatches(record, filter));
  filtered.sort(compareTelemetryRecordsNewestFirst);
  const limit = clampLimit(filter.limit, 100);
  const startIndex = filter.cursor ? resolveTelemetryRecordCursor(filtered, filter.cursor) + 1 : 0;
  const page = filtered.slice(startIndex, startIndex + limit);
  const next = filtered[startIndex + limit];
  return {
    items: page.map((record) => sanitizeRecord(record, view)),
    pageInfo: {
      limit,
      returned: page.length,
      hasMore: Boolean(next),
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
      // The cursor is the last record returned; the next page starts after it.
      ...(next ? { nextCursor: page[page.length - 1]!.id } : {}),
    },
  };
}

export function applyTelemetrySpanFilter(
  spans: readonly ReadableSpan[],
  filter: TelemetryFilter,
  view: TelemetryViewMode,
): { items: readonly ReadableSpan[]; pageInfo: TelemetryPageInfo } {
  const filtered = spans.filter((span) => {
    if (filter.since !== undefined && span.startTimeMs < filter.since) return false;
    if (filter.until !== undefined && span.endTimeMs > filter.until) return false;
    if (filter.traceId && span.spanContext.traceId !== filter.traceId) return false;
    if (filter.turnId !== undefined && spanAttribute(span, 'turn.id', 'turnId') !== filter.turnId) return false;
    if (filter.agentId !== undefined && spanAttribute(span, 'agent.id', 'agentId') !== filter.agentId) return false;
    if (filter.taskId !== undefined && spanAttribute(span, 'task.id', 'taskId') !== filter.taskId) return false;
    // A span's type is its name (`turn.lifecycle`, `tool.execute`); an ingested span may name its start event.
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      const startEventType = typeof span.attributes.startEventType === 'string' ? span.attributes.startEventType : undefined;
      if (!filter.eventTypes.includes(span.name) && (startEventType === undefined || !filter.eventTypes.includes(startEventType))) return false;
    }
    return true;
  }).sort((left, right) => right.endTimeMs - left.endTimeMs);
  const limit = clampLimit(filter.limit, 100);
  const startIndex = filter.cursor ? resolveTelemetrySpanCursor(filtered, filter.cursor) + 1 : 0;
  const page = filtered.slice(startIndex, startIndex + limit);
  const next = filtered[startIndex + limit];
  return {
    items: page.map((span) => sanitizeSpan(span, view)),
    pageInfo: {
      limit,
      returned: page.length,
      hasMore: Boolean(next),
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
      ...(next ? { nextCursor: buildSpanCursor(page[page.length - 1]!) } : {}),
    },
  };
}

/** A span's id attribute under the tracer's dotted name, or the plain name an ingested span may use. */
function spanAttribute(span: ReadableSpan, dotted: string, plain: string): unknown {
  return span.attributes[dotted] ?? span.attributes[plain];
}

export function telemetryRecordMatches(record: TelemetryRecord, filter: TelemetryFilter): boolean {
  if (filter.since !== undefined && record.timestamp < filter.since) return false;
  if (filter.until !== undefined && record.timestamp > filter.until) return false;
  if (filter.domains && filter.domains.length > 0 && !filter.domains.includes(record.domain)) return false;
  if (filter.eventTypes && filter.eventTypes.length > 0 && !filter.eventTypes.includes(record.type)) return false;
  if (filter.severity && record.severity !== filter.severity) return false;
  if (filter.traceId && record.traceId !== filter.traceId) return false;
  if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
  if (filter.turnId && record.turnId !== filter.turnId) return false;
  if (filter.agentId && record.agentId !== filter.agentId) return false;
  if (filter.taskId && record.taskId !== filter.taskId) return false;
  return true;
}

export function resolveTelemetryRecordCursor(records: readonly TelemetryRecord[], cursor: string): number {
  const index = records.findIndex((record) => record.id === cursor);
  if (index >= 0) return index;
  throw new Error(`Invalid telemetry cursor: ${cursor}`);
}

export function resolveTelemetrySpanCursor(spans: readonly ReadableSpan[], cursor: string): number {
  const index = spans.findIndex((span) => buildSpanCursor(span) === cursor);
  if (index >= 0) return index;
  throw new Error(`Invalid telemetry cursor: ${cursor}`);
}
