import { sleepWithSignal } from './backoff.js';
import { mergeHeaders, resolveAuthToken, type AuthTokenResolver } from './auth.js';
import {
  getStreamReconnectDelay,
  normalizeStreamReconnectPolicy,
  type StreamReconnectPolicy,
} from './reconnect.js';
import { createHttpStatusError, HttpStatusError, RETRYABLE_STATUS_CODES, refusal, toRefusal, type Refusal } from '@goodvibes-jev/engine/errors';
import { isAbortError, readStreamGapDropped, type FetchLike } from '@goodvibes-jev/engine/transport-core';
import type { TransportJsonError } from './http-core.js';

/** How a stream ended. Exactly one is reported, once, for every stream that opened. */
export type StreamEnd =
  /** The client closed it (its closer, or its abort signal). */
  | { readonly kind: 'closed' }
  /** The source ended it, with everything it sent delivered. */
  | { readonly kind: 'source-ended'; readonly complete: true }
  /** The source ended it after `dropped` chunks were lost in transit and could not be had back. */
  | { readonly kind: 'source-ended'; readonly complete: false; readonly dropped: number }
  /** It could not be (re)opened, or failed after it opened, and will not reconnect. */
  | { readonly kind: 'failed'; readonly refusal: Refusal };

/** Frames the source dropped for this reader; `afterId` is the last one delivered before them. */
export interface StreamGap { readonly dropped: number; readonly afterId?: string }

/** Required members: a subscriber that cannot handle a gap or an end does not compile. */
export interface StreamSubscriber<E> {
  onEvent(event: E): void;
  /** Frames were lost: resync from a snapshot (or reopen from the last position); never ignore it. */
  onGap(gap: StreamGap): void;
  onEnd(end: StreamEnd): void;
}

/** Control frames never count as progress for the retry budget. */
export const STREAM_CONTROL_FRAMES: ReadonlySet<string> = new Set(['ready', 'heartbeat']);

/** One delivered Server-Sent Events frame: its `event:` name (`message` when it had none) and its parsed `data:`. */
export interface ServerSentEvent {
  readonly name: string;
  readonly payload: unknown;
}

export interface ServerSentEventHandlers extends StreamSubscriber<ServerSentEvent> {
  readonly onReady?: ((payload: unknown) => void) | undefined;
  /** A lost connection is being retried: attempt number, wait before it, and the failure that lost it. */
  readonly onReconnect?: ((input: { readonly attempt: number; readonly delayMs: number; readonly error: unknown }) => void) | undefined;
  /**
   * The `id:` of each complete frame, when the frame is delivered.
   *
   * The stream already remembers its position so its OWN reconnects resume,
   * but a caller that closes this stream and opens a NEW one for the next
   * turn starts from nothing, and a server that replays "recent traffic" to
   * a client claiming no position hands that new stream the tail of the
   * previous turn, terminal frames included. Recording the id here (or
   * reading {@link ServerSentEventStreamHandle.lastEventId} at close) is what
   * lets the next stream present `Last-Event-ID` and be replayed nothing it
   * has already seen.
   */
  readonly onEventId?: ((id: string) => void) | undefined;
}

/**
 * The stream's closer, plus the position it has reached.
 *
 * A plain `() => void` is still what callers store and call; `lastEventId`
 * is additive so an existing caller keeps compiling and a resuming caller can
 * read the position without holding an `onEventId` callback of its own.
 */
export interface ServerSentEventStreamHandle {
  (): void;
  /** The `id:` of the most recent frame delivered, or null if none carried one. */
  readonly lastEventId: string | null;
}

export interface ServerSentEventOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly authToken?: string | null | undefined;
  readonly getAuthToken?: AuthTokenResolver | undefined;
  readonly lastEventId?: string | null | undefined;
  readonly reconnect?: StreamReconnectPolicy | undefined;
  /**
   * Silence (ms) after which a stream whose server has sent a `heartbeat`
   * frame is treated as lost: the connection is dropped and, with reconnect
   * on, reopened from its last event id. Armed only once a heartbeat arrives,
   * so a server that sends none is never cut off. Defaults to
   * {@link sseIdleDeadlineMs}; 0 turns it off. The same deadline bounds each
   * open: a server that accepts the request but sends no response headers
   * within it fails that attempt (retried like any dropped connection).
   */
  readonly idleTimeoutMs?: number | undefined;
}

/** The daemon's SSE heartbeat interval (ms): one frame on open, then one per interval. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a heartbeating stream may stay silent before either end treats it
 * as gone: two intervals plus slack, so one late or lost heartbeat is not
 * enough. The daemon derives its own idle timeout from the same number.
 */
export function sseIdleDeadlineMs(heartbeatIntervalMs: number = SSE_HEARTBEAT_INTERVAL_MS): number {
  return heartbeatIntervalMs * 2 + 5_000;
}

/**
 * Whether reconnecting can clear a stream failure: a connection that could not
 * be made or was lost, a stream that ended, or a status a retry can clear. A
 * refused credential (401, 403) or any other answer from the server is final.
 */
function isRetryableStreamFailure(error: unknown): boolean {
  if ((error as { streamFinal?: unknown } | null)?.streamFinal === true) return false;
  const status = (error as { transport?: { status?: unknown } } | null)?.transport?.status;
  if (typeof status !== 'number') return true;
  return status === 0 || (status >= 200 && status < 300) || RETRYABLE_STATUS_CODES.includes(status);
}

function readEventPayload(data: string): unknown {
  if (!data.trimEnd()) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

export { isAbortError };

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * A connection that stayed up this long was healthy even if it only carried the
 * `ready` greeting and heartbeat comments, so its drop starts a fresh retry budget.
 */
const CONNECTION_STABILITY_MS = 30_000;

function createStreamError(
  status: number,
  url: string,
  body: string,
  headers?: Headers,
): HttpStatusError & { readonly transport: TransportJsonError } {
  const message = body.trim()
    ? `Unable to open SSE stream: ${status} ${body}`.trim()
    : `Unable to open SSE stream: ${status}`;
  const retryAfterMs = status > 0 ? parseRetryAfterMs(headers) : undefined;
  const error = status > 0
    ? status >= 500
      // A server error on opening the stream is an unreachable stream endpoint, so it is
      // reported as a network failure; only statuses a retry can clear are recoverable.
      ? new HttpStatusError(message, {
          status,
          category: 'network',
          source: 'transport',
          recoverable: RETRYABLE_STATUS_CODES.includes(status),
          url,
          method: 'GET',
          body,
        })
      : createHttpStatusError(status, url, 'GET', body)
    : new HttpStatusError(message, {
        status: undefined,
        category: 'network',
        source: 'transport',
        recoverable: true,
        url,
        method: 'GET',
        body,
      });
  const transportPayload: TransportJsonError = {
    status,
    body,
    url,
    method: 'GET',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  return Object.assign(error, {
    transport: transportPayload,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export { openRawServerSentEventStream as openServerSentEventStream };

/** Whether a `content-type` names an event stream (`text/event-stream`, any parameters, any case). */
function isEventStreamContentType(value: string | null): boolean {
  return (value ?? '').split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
}

/**
 * A 2xx that is not an event stream (a proxy's or captive portal's page, the
 * wrong URL): never opened, and final, because reconnecting gets the same page.
 */
function wrongContentTypeError(status: number, url: string, contentType: string | null) {
  const shown = contentType && contentType.trim() ? contentType.trim() : 'none';
  const error = createStreamError(status, url, `the server answered ${status} with content-type ${shown}, not text/event-stream`);
  return Object.assign(error, { streamFinal: true as const });
}

/** The refusal a stream that will not reconnect ends with. */
function streamEndRefusal(error: unknown, retryable: boolean): Refusal {
  const carried = toRefusal(error, {
    state: 'the event stream ended and is not reconnecting',
    next: retryable
      ? ['Open the stream again; it resumes from its last event id.']
      : ['Fix the cause named in the reason (credential, URL), then open the stream again.'],
    code: 'STREAM_ENDED',
  });
  return carried.retryable === retryable ? carried : refusal({ ...carried, retryable });
}

/** The gap a `gap` control frame names. */
function readGapFrame(payload: unknown): StreamGap {
  const record = payload && typeof payload === 'object' ? payload as { dropped?: unknown; afterId?: unknown } : {};
  const dropped = typeof record.dropped === 'number' && Number.isFinite(record.dropped) && record.dropped >= 0 ? Math.floor(record.dropped) : 0;
  return typeof record.afterId === 'string' && record.afterId ? { dropped, afterId: record.afterId } : { dropped };
}

export async function openRawServerSentEventStream(
  fetchImpl: FetchLike,
  url: string,
  handlers: ServerSentEventHandlers,
  options: ServerSentEventOptions = {},
): Promise<ServerSentEventStreamHandle> {
  options.signal?.throwIfAborted();
  const outerController = new AbortController();
  const reconnectPolicy = normalizeStreamReconnectPolicy(options.reconnect);
  const idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? sseIdleDeadlineMs());
  let lastEventId = options.lastEventId ?? null;
  let activeController: AbortController | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let readySettled = false;
  // Set once the first connection opened: from then on every end is reported through onEnd, once.
  let opened = false;
  let endReported = false;
  const end = (value: StreamEnd): void => {
    if (!opened || endReported) return;
    endReported = true;
    handlers.onEnd(value);
  };

  const abort = () => outerController.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });

  const readyPromise = new Promise<void>((resolve, reject) => {
    const settleReady = (...failure: [] | [unknown]) => {
      if (readySettled) return;
      readySettled = true;
      if (failure.length > 0) {
        reject(failure[0]);
      } else {
        resolve();
      }
    };
    outerController.signal.addEventListener('abort', () => settleReady(outerController.signal.reason), { once: true });

    // Resolves true once the stream opened (a 2xx with a body), false when the
    // first attempt failed to open and rejected the caller's open() instead.
    const runConnection = async (): Promise<boolean> => {
      const controller = new AbortController();
      activeController = controller;
      const signal = AbortSignal.any([outerController.signal, controller.signal]);
      let response: Response;
      // The open's deadline: no response headers within the idle deadline is a dead path, not a slow one.
      let openTimedOut = false;
      const openTimer = idleTimeoutMs > 0 ? setTimeout(() => { openTimedOut = true; controller.abort(); }, idleTimeoutMs) : undefined;
      (openTimer as { unref?: () => void } | undefined)?.unref?.();
      try {
        signal.throwIfAborted();
        const token = await resolveAuthToken(options.authToken ?? null, options.getAuthToken);
        signal.throwIfAborted();
        const headers = mergeHeaders(
          { Accept: 'text/event-stream' },
          options.headers,
          token ? { Authorization: `Bearer ${token}` } : undefined,
          lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
        );

        response = await fetchImpl(url, {
          method: 'GET',
          credentials: 'include',
          signal,
          headers,
        });
        signal.throwIfAborted();
      } catch (error) {
        const wrapped = createStreamError(0, url, openTimedOut && !outerController.signal.aborted
          ? `The server sent no response within ${Math.round(idleTimeoutMs / 1000)}s of the request; the connection is treated as lost`
          : error instanceof Error ? error.message : String(error));
        if (!readySettled) {
          settleReady(wrapped);
          return false;
        }
        throw wrapped;
      } finally {
        clearTimeout(openTimer);
      }

      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        const wrapped = createStreamError(response.status, url, body, response.headers);
        if (!readySettled) {
          settleReady(wrapped);
          return false;
        }
        throw wrapped;
      }
      const contentType = response.headers.get('content-type');
      if (!isEventStreamContentType(contentType)) {
        void response.body.cancel().catch(() => undefined);
        const wrapped = wrongContentTypeError(response.status, url, contentType);
        if (!readySettled) {
          settleReady(wrapped);
          return false;
        }
        throw wrapped;
      }

      settleReady();
      opened = true;
      const connectedAt = Date.now();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';
      let data = '';
      let pendingEventId: string | undefined;

      // Liveness: once the server has shown it heartbeats, a silence longer
      // than the deadline means the path died without a reset (sleep, a new
      // network, a dropped NAT mapping). Drop the connection so the reconnect
      // below resumes from the last event id instead of reading forever.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeating = false;
      let stalled: Error | undefined;
      const onStalled = (): void => {
        stalled = createStreamError(0, url, `No event or heartbeat arrived for ${Math.round(idleTimeoutMs / 1000)}s; the connection is treated as lost`);
        void reader.cancel(stalled).catch(() => undefined);
        controller.abort(stalled);
      };
      const armIdleTimer = (): void => {
        if (!heartbeating || idleTimeoutMs <= 0) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onStalled, idleTimeoutMs);
        (idleTimer as { unref?: () => void }).unref?.();
      };

      const flush = (): void => {
        if (pendingEventId !== undefined) {
          lastEventId = pendingEventId;
          handlers.onEventId?.(pendingEventId);
          pendingEventId = undefined;
        }
        if (!eventName && !data.trim()) {
          eventName = '';
          data = '';
          return;
        }
        // A connection that delivered a frame was healthy, so its drop starts a
        // fresh retry budget. Merely answering 200 does not count, and neither do
        // the control frames (the `ready` greeting and the `heartbeat` the daemon
        // sends on every connect): a stream the server accepts, greets and closes
        // at once must still run out of attempts.
        const name = eventName || 'message';
        if (!STREAM_CONTROL_FRAMES.has(name)) reconnectAttempts = 0;
        if (eventName === 'heartbeat' && !heartbeating) {
          heartbeating = true;
          armIdleTimer();
        }
        const payload = readEventPayload(data);
        if (name === 'ready') {
          handlers.onReady?.(payload);
        } else if (name === 'gap') {
          // The source dropped frames for this reader: a typed signal, never an ordinary event.
          handlers.onGap(readGapFrame(payload));
        } else {
          handlers.onEvent({ name, payload });
        }
        eventName = '';
        data = '';
      };

      const consumeLine = (line: string): void => {
        if (!line) {
          flush();
          return;
        }
        if (line.startsWith(':')) return;
        if (line.startsWith('id:')) {
          const candidate = line.slice(3).replace(/^ /, '');
          if (!candidate.includes('\0')) pendingEventId = candidate;
          return;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).replace(/^ /, '');
          return;
        }
        if (line.startsWith('data:')) {
          data += `${data ? '\n' : ''}${line.slice(5).replace(/^ /, '')}`;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (stalled) throw stalled;
          signal.throwIfAborted();
          if (done) break;
          armIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            consumeLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        }
        // A disconnect before the blank frame terminator must replay this frame.
        // Abort and remote-close can land in the same microtask. Yield once so
        // the abort listener can mark the stream stopped before reconnect logic
        // treats the close as unexpected.
        await Promise.resolve();
        if (reconnectPolicy.enabled && !controller.signal.aborted && !outerController.signal.aborted && !stopped) {
          // An idle stream delivers no frame past `ready`, so lifetime is the only sign of health.
          if (Date.now() - connectedAt >= CONNECTION_STABILITY_MS) reconnectAttempts = 0;
          throw createStreamError(response.status, url, 'Stream closed unexpectedly');
        }
        return true;
      } catch (error) {
        // A read error (reset, idle timeout, sleep/wake) after a long-lived connection is a drop, not a failed connect.
        if ((stalled || !controller.signal.aborted) && !outerController.signal.aborted && !stopped
          && Date.now() - connectedAt >= CONNECTION_STABILITY_MS) {
          reconnectAttempts = 0;
        }
        throw stalled ?? error;
      } finally {
        clearTimeout(idleTimer);
        controller.abort();
        if (activeController === controller) {
          activeController = null;
        }
      }
    };

    const loop = async (): Promise<void> => {
      while (!outerController.signal.aborted && !stopped) {
        try {
          if (!(await runConnection())) return;
          // The source ended the stream cleanly and reconnect is off.
          end({ kind: 'source-ended', complete: true });
          return;
        } catch (error) {
          if (outerController.signal.aborted || stopped) {
            settleReady(outerController.signal.reason ?? new DOMException('Stream closed', 'AbortError'));
            end({ kind: 'closed' });
            return;
          }
          const nextAttempt = reconnectAttempts + 1;
          const retryable = isRetryableStreamFailure(error);
          const shouldReconnect = reconnectPolicy.enabled && nextAttempt <= reconnectPolicy.maxAttempts && retryable;
          if (!shouldReconnect) {
            settleReady(error);
            // Chunks lost in transit that no reconnect will fetch again: the source ended incomplete.
            const dropped = readStreamGapDropped(error);
            end(dropped !== undefined
              ? { kind: 'source-ended', complete: false, dropped }
              : { kind: 'failed', refusal: streamEndRefusal(error, retryable) });
            return;
          }
          reconnectAttempts = nextAttempt;
          // Use the same 1-based attempt counter as the WS connector for a symmetric schedule.
          // A server-named wait (429/503 Retry-After) is a floor under the client's own schedule.
          const serverWaitMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
          const delayMs = Math.max(
            getStreamReconnectDelay(nextAttempt, reconnectPolicy),
            typeof serverWaitMs === 'number' && Number.isFinite(serverWaitMs) ? Math.min(serverWaitMs, MAX_RETRY_AFTER_MS) : 0,
          );
          handlers.onReconnect?.({ attempt: nextAttempt, delayMs, error });
          try {
            await sleepWithSignal(delayMs, outerController.signal);
          } catch (sleepError) {
            end(outerController.signal.aborted || stopped
              ? { kind: 'closed' }
              : { kind: 'failed', refusal: streamEndRefusal(sleepError, true) });
            return;
          }
        }
      }
      end({ kind: 'closed' });
    };

    void loop().catch((error) => {
      settleReady(error);
      end(outerController.signal.aborted || stopped
        ? { kind: 'closed' }
        : { kind: 'failed', refusal: streamEndRefusal(error, isRetryableStreamFailure(error)) });
    }).finally(() => {
      activeController?.abort();
      options.signal?.removeEventListener('abort', abort);
    });
  });
  await readyPromise;

  const close = (): void => {
    stopped = true;
    activeController?.abort();
    outerController.abort();
  };
  return Object.defineProperty(close, 'lastEventId', {
    get: () => lastEventId,
    enumerable: true,
  }) as ServerSentEventStreamHandle;
}
