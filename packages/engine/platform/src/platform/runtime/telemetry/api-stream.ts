import { sseSubscribers } from '../metrics.js';
import type {
  TelemetryCapabilities,
  TelemetryFilter,
  TelemetryRecord,
  TelemetryViewMode,
} from './api.js';
import {
  clampLimit,
  sanitizeRecord,
} from './api-helpers.js';
import { listTelemetryRecordsAfterCursor } from './api-query.js';

export interface CreateTelemetryStreamInput {
  readonly request: Request;
  readonly filter: TelemetryFilter;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly assertViewAvailable: () => void;
  readonly records: readonly TelemetryRecord[];
  /** Resolve source aliases against the collector's live retained identities. */
  readonly matchesRecord: (record: TelemetryRecord, filter: TelemetryFilter) => boolean;
  readonly subscribe: (listener: (record: TelemetryRecord) => void) => () => void;
  readonly getCapabilities: () => TelemetryCapabilities;
  readonly getSubscriberCount: () => number;
}

/** Chunks a stalled client may leave unread before its stream is closed. */
const MAX_QUEUED_CHUNKS = 1024;

export function createTelemetryEventStream(input: CreateTelemetryStreamInput): Response {
  input.assertViewAvailable();
  const encoder = new TextEncoder();
  let unsub = (): void => {};
  const requestedCursor = input.request.headers.get('last-event-id')?.trim() || input.filter.cursor;

  let teardown = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      let closed = false;
      const stop = (error?: unknown): void => {
        if (closed) return;
        closed = true;
        teardown();
        if (error !== undefined) controller.error(error);
        else controller.close();
      };
      const checkAccess = (): boolean => {
        try {
          input.assertViewAvailable();
          return true;
        } catch (error) {
          stop(error);
          return false;
        }
      };
      const resume = requestedCursor
        ? listTelemetryRecordsAfterCursor(
          input.records,
          (record) => input.matchesRecord(record, input.filter),
          requestedCursor,
          clampLimit(input.filter.limit, 100),
        )
        : undefined;
      if (resume) {
        for (const record of resume.records) {
          if (!checkAccess()) return;
          const projected = sanitizeRecord(record, input.view);
          controller.enqueue(encoder.encode(`id: ${projected.id}\nevent: telemetry\ndata: ${JSON.stringify(projected)}\n\n`));
        }
      }
      unsub = input.subscribe((record) => {
        if (closed || !checkAccess()) return;
        if (!input.matchesRecord(record, input.filter)) return;
        // A client that stopped reading would otherwise queue every event for the stream's lifetime.
        if ((controller.desiredSize ?? 1) <= 0) {
          stop();
          return;
        }
        const projected = sanitizeRecord(record, input.view);
        controller.enqueue(encoder.encode(`id: ${projected.id}\nevent: telemetry\ndata: ${JSON.stringify(projected)}\n\n`));
      });
      sseSubscribers.set(input.getSubscriberCount(), { stream_type: 'telemetry' });
      const heartbeat = setInterval(() => {
        if (closed || !checkAccess()) return;
        // The same rule as events: a client that stopped reading is closed
        // rather than left to queue heartbeats when no event matches its filter.
        if ((controller.desiredSize ?? 1) <= 0) {
          stop();
          return;
        }
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      teardown = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsub();
        input.request.signal.removeEventListener('abort', abort);
        sseSubscribers.set(input.getSubscriberCount(), { stream_type: 'telemetry' });
      };
      const abort = (): void => stop();
      input.request.signal.addEventListener('abort', abort, { once: true });
      // An abort that happened before this listener existed will never fire it.
      if (input.request.signal.aborted) {
        stop();
        return;
      }
      controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({
        version: 1,
        capabilities: input.getCapabilities(),
        view: input.view,
        rawAccessible: input.rawAccessible,
        // A cursor the history no longer holds is not refused: the stream
        // resumes from the oldest record held and says records may be missing.
        ...(requestedCursor && resume && !resume.gap ? { resumedFrom: requestedCursor } : {}),
        ...(resume?.gap ? { gap: true } : {}),
        ...(resume?.truncated ? { truncated: true } : {}),
      })}\n\n`));
    },
    cancel: () => {
      teardown();
    },
  }, new CountQueuingStrategy({ highWaterMark: MAX_QUEUED_CHUNKS }));

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
