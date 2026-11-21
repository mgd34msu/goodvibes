import { WebSocketMessageAssembler, createStreamTextAssembler, sendWebSocketMessage } from '@goodvibes/engine/transport-core';
import {
  RUNTIME_EVENT_DOMAINS,
  type RuntimeEventDomain,
  type RuntimeEventRecord,
} from '@goodvibes/engine/contracts';
import {
  ConfigurationError,
  DaemonErrorCategory,
  GoodVibesError,
  createHttpStatusError,
  isStructuredDaemonErrorBody,
} from '@goodvibes/engine/errors';
import {
  normalizeAuthToken,
  normalizeStreamReconnectPolicy,
  getStreamReconnectDelay,
} from '@goodvibes/engine/transport-http';
import { buildUrl } from '@goodvibes/engine/transport-http';
import {
  describeUnknownTransportError,
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
  type TransportObserver,
} from '@goodvibes/engine/transport-core';
import {
  createRemoteDomainEvents,
  type DomainEventConnector,
  type DomainEvents,
  type RemoteDomainEventsOptions,
  type SerializedEventEnvelope,
} from './domain-events.js';
import { buildGate } from './event-source-connector.js';
import { readEventEnvelope } from './envelope.js';
import { createSharedDomainConnector, endUnservedDomains } from './shared-connection.js';
import { readTurnLifecycleFrame } from './turn-lifecycle-gate.js';

export type SerializedRuntimeEnvelope<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  SerializedEventEnvelope<TEvent>;

export type RemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  DomainEvents<RuntimeEventDomain, TEvent>;

export interface RemoteRuntimeEventsOptions {
  readonly onError?: ((error: Error, domain: RuntimeEventDomain) => void) | undefined;
  readonly observer?: TransportObserver | undefined;
}

/**
 * Returns a filtered view of a {@link RemoteRuntimeEvents} object where every
 * callback only fires for events whose envelope `sessionId` equals the given
 * session identifier.
 *
 * This is a convenience wrapper around {@link forSession} scoped to the
 * canonical runtime-event domains. Use it instead of manually checking
 * `e.sessionId` in every callback.
 *
 * @example
 * const events = client.realtime.viaSse();
 * const session = await client.operator.sessions.create({ title: 'demo' });
 * const sessionId = session.session.id;
 *
 * // Before forSession, repeated manual guard:
 * events.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   if (e.sessionId !== sessionId) return;
 *   process.stdout.write(e.payload.content);
 * });
 *
 * // After forSession, clean, session-scoped subscription:
 * const sessionEvents = forSessionRuntime(events, sessionId);
 * sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   process.stdout.write(e.payload.content);
 * });
 */
export { forSession as forSessionRuntime } from './domain-events.js';

import type {
  AuthTokenSource,
  BackpressureInfo,
  ConnectionState,
  RuntimeEventConnectorOptions,
} from './connector-options.js';

export type {
  BackpressureInfo,
  ConnectionState,
  ConnectorTransportEvent,
  ReconnectAttemptInfo,
  RuntimeEventConnectorOptions,
  RuntimeEventTurnScope,
  AuthTokenSource,
} from './connector-options.js';
export { buildEventSourceUrl, createEventSourceConnector } from './event-source-connector.js';
type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

/**
 * Default reconnect attempts for WebSocket connections: none, as for SSE
 * (`DEFAULT_STREAM_MAX_ATTEMPTS`). A refused or revoked credential ends the
 * connection without a retry, so an unlimited budget cannot loop on it.
 */
export const DEFAULT_WS_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

/**
 * A socket that stayed authenticated this long was healthy, so its drop starts
 * a fresh reconnect budget. An accepted auth frame alone does not: a daemon or
 * proxy that accepts it and then cuts the socket would otherwise restart the
 * backoff at its shortest delay forever. The same window as the SSE stream.
 */
const WS_CONNECTION_STABILITY_MS = 30_000;


function getSocketOpenState(WebSocketImpl: typeof WebSocket): number {
  return typeof WebSocketImpl.OPEN === 'number' ? WebSocketImpl.OPEN : 1;
}

function text0(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isSocketOpen(socket: WebSocket, WebSocketImpl: typeof WebSocket): boolean {
  return socket.readyState === getSocketOpenState(WebSocketImpl);
}

/**
 * Creates a {@link WebSocketTransportError} from a raw server-sent payload body,
 * unpacking a {@link StructuredDaemonErrorBody} when present, matching the
 * envelope parity that `createHttpStatusError` provides for HTTP errors.
 *
 * When the server sends a structured `{ error, code, category, recoverable, … }` body
 * inside a WS message, consumers receive the same richly-typed envelope as HTTP callers.
 * Unstructured or non-object bodies fall back to the provided `fallbackMessage`.
 *
 * @param fallbackMessage - Used when `body` is not a structured daemon error.
 * @param body - The raw body parsed from the server frame (may be any shape).
 * @param options - Optional overrides for `code`, `hint`, and `cause`.
 */
/**
 * Helper that builds a {@link WebSocketTransportError} options bag without
 * assigning `undefined` to optional keys, satisfying `exactOptionalPropertyTypes`.
 */
function buildWsErrorOpts(
  code: string,
  overrides: {
    hint?: string;
    cause?: unknown;
    category?: import('@goodvibes/engine/errors').ErrorCategory;
    recoverable?: boolean;
    status?: number;
    requestId?: string;
    provider?: string;
    operation?: string;
    phase?: string;
  } = {},
): { readonly code: string } {
  const opts: Record<string, unknown> = { code };
  if (overrides.hint !== undefined) opts['hint'] = overrides.hint;
  if (overrides.cause !== undefined) opts['cause'] = overrides.cause;
  if (overrides.category !== undefined) opts['category'] = overrides.category;
  if (overrides.recoverable !== undefined) opts['recoverable'] = overrides.recoverable;
  if (overrides.status !== undefined) opts['status'] = overrides.status;
  if (overrides.requestId !== undefined) opts['requestId'] = overrides.requestId;
  if (overrides.provider !== undefined) opts['provider'] = overrides.provider;
  if (overrides.operation !== undefined) opts['operation'] = overrides.operation;
  if (overrides.phase !== undefined) opts['phase'] = overrides.phase;
  return opts as unknown as { readonly code: string };
}

export function createWebSocketRemoteError(
  fallbackMessage: string,
  body: unknown,
  options: { readonly code?: string; readonly hint?: string; readonly cause?: unknown } = {},
): WebSocketTransportError {
  if (isStructuredDaemonErrorBody(body)) {
    const overrides: Parameters<typeof buildWsErrorOpts>[1] = {};
    const effectiveHint = text0(body.hint) ?? options.hint;
    if (effectiveHint !== undefined) overrides.hint = effectiveHint;
    if (options.cause !== undefined) overrides.cause = options.cause;
    // The frame comes off the wire: keep only fields of the declared type. The
    // HTTP reader already drops a category outside the wire set, so a category
    // is kept only when it survives there unchanged.
    const wireStatus = typeof body.status === 'number' && Number.isFinite(body.status) ? body.status : undefined;
    const readCategory = createHttpStatusError(wireStatus ?? 500, '', 'WS', body).category;
    if (typeof body.category === 'string' && readCategory === body.category) overrides.category = readCategory;
    if (typeof body.recoverable === 'boolean') overrides.recoverable = body.recoverable;
    if (wireStatus !== undefined) overrides.status = wireStatus;
    const requestId = text0(body.requestId);
    if (requestId !== undefined) overrides.requestId = requestId;
    const provider = text0(body.provider);
    if (provider !== undefined) overrides.provider = provider;
    const operation = text0(body.operation);
    if (operation !== undefined) overrides.operation = operation;
    const phase = text0(body.phase);
    if (phase !== undefined) overrides.phase = phase;
    // Use the caller-supplied code (or 'WS_REMOTE_ERROR') as the canonical transport code.
    // The server's body.code is not used as the WebSocketTransportError code because
    // Symbol.hasInstance enforces a canonical-code allowlist; arbitrary server codes
    // would break instanceof checks. The body message and metadata are still preserved.
    const code = options.code ?? 'WS_REMOTE_ERROR';
    return new WebSocketTransportError(body.error, buildWsErrorOpts(code, overrides));
  }
  const message = typeof body === 'string' && body.trim()
    ? body.trim()
    : fallbackMessage;
  const overrides: Parameters<typeof buildWsErrorOpts>[1] = {};
  if (options.hint !== undefined) overrides.hint = options.hint;
  if (options.cause !== undefined) overrides.cause = options.cause;
  else if (body !== null && body !== undefined) overrides.cause = body;
  return new WebSocketTransportError(message, buildWsErrorOpts(options.code ?? 'WS_REMOTE_ERROR', overrides));
}

export class WebSocketTransportError extends GoodVibesError {
  /**
   * WebSocket runtime-event transport error.
   *
   * Canonical internal codes are `WS_CLOSE_ABNORMAL`,
   * `WS_EVENT_ERROR`, `WS_QUEUE_OVERFLOW`, `WS_REMOTE_ERROR`, and
   * `WS_FRAME_TOO_LARGE`.
   *
   * Overrides Symbol.hasInstance to enable cross-realm instanceof checks.
   * Without this, `instanceof WebSocketTransportError` in a different realm
   * (e.g. a Cloudflare Worker or cross-frame context) falls through to the base
   * GoodVibesError brand only and cannot distinguish WS errors from other
   * platform errors. The brand check here also guards against plain objects with a
   * matching `code`.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== WebSocketTransportError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require the base platform brand AND a WS-specific code prefix to prevent plain
    // objects like { code: 'WEBSOCKET_TRANSPORT_ERROR' } from passing.
    // Use an explicit allowlist of canonical WS codes rather than
    // the open-ended 'WS_' prefix check which would match any hand-crafted
    // GoodVibesError with a WS_* code.
    const CANONICAL_WS_CODES = new Set([
      'WEBSOCKET_TRANSPORT_ERROR',
      'WS_CLOSE_ABNORMAL',
      'WS_EVENT_ERROR',
      'WS_QUEUE_OVERFLOW',
      'WS_REMOTE_ERROR',
      'WS_FRAME_TOO_LARGE',
    ]);
    return GoodVibesError[Symbol.hasInstance](value)
      && typeof (value as Record<PropertyKey, unknown>).code === 'string'
      && CANONICAL_WS_CODES.has(String((value as Record<PropertyKey, unknown>).code));
  }

  // Use one of: WS_CLOSE_ABNORMAL, WS_EVENT_ERROR, WS_QUEUE_OVERFLOW, WS_REMOTE_ERROR, WS_FRAME_TOO_LARGE.
  //
  // Extended options mirror the HttpStatusError / createHttpStatusError envelope so that
  // structured daemon error bodies received over WebSocket produce the same richly-typed
  // error as their HTTP equivalents. Fields omitted default to transport-appropriate values.
  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly hint?: string;
      readonly code: string;
      /** Defaults to `'network'`. Override when the server sends a structured category (e.g. `'rate_limit'`). */
      readonly category?: import('@goodvibes/engine/errors').ErrorCategory | undefined;
      /** Defaults to `true`. Override to `false` for unrecoverable structured errors. */
      readonly recoverable?: boolean | undefined;
      readonly status?: number | undefined;
      readonly requestId?: string | undefined;
      readonly provider?: string | undefined;
      readonly operation?: string | undefined;
      readonly phase?: string | undefined;
    },
  ) {
    super(message, {
      code: options.code,
      category: options.category ?? 'network',
      source: 'transport',
      recoverable: options.recoverable ?? true,
      hint: options.hint,
      cause: options.cause,
      status: options.status,
      requestId: options.requestId,
      provider: options.provider,
      operation: options.operation,
      phase: options.phase,
    });
    this.name = 'WebSocketTransportError';
  }
}

export function createRemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  connect: DomainEventConnector<RuntimeEventDomain, TEvent>,
  options: RemoteRuntimeEventsOptions = {},
): RemoteRuntimeEvents<TEvent> {
  const domainOptions: RemoteDomainEventsOptions<RuntimeEventDomain> = {
    onConnectionError: (error, domain) => {
      invokeTransportObserver(() => options.observer?.onError?.(error), options.observer?.onObserverError);
      options.onError?.(error, domain);
    },
  };
  return createRemoteDomainEvents(
    RUNTIME_EVENT_DOMAINS,
    connect,
    domainOptions,
  );
}

export function buildWebSocketUrl(
  baseUrl: string,
  domains: readonly RuntimeEventDomain[],
  /** The id of the last event the client holds: the daemon replays what came after it. */
  lastEventId?: string | null,
): string {
  // buildUrl runs normalizeBaseUrl, the one rule for which hosts may use plain
  // http/ws (loopback, private-network and .local hosts, or the explicit
  // GOODVIBES_ALLOW_INSECURE_TRANSPORT override) and for keeping a base path
  // prefix. The WebSocket carries the bearer token, so it follows that same
  // rule rather than a narrower one of its own.
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/ws'));
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConfigurationError(`Unsupported WebSocket base URL protocol: ${url.protocol}`, {
      source: 'transport',
      hint: 'Runtime event WebSocket clients require http, https, ws, or wss base URLs.',
    });
  }
  url.searchParams.set('clientKind', 'web');
  if (domains.length > 0) {
    url.searchParams.set('domains', domains.join(','));
  }
  if (lastEventId) url.searchParams.set('lastEventId', lastEventId);
  return url.toString();
}

/** The categories a daemon refusal frame may name. */
const DAEMON_ERROR_CATEGORIES: readonly DaemonErrorCategory[] = Object.values(DaemonErrorCategory);

/** Messages the WebSocket connector holds for sending while its socket is down or not yet authenticated. */
const DEFAULT_WS_MAX_QUEUED_MESSAGES = 1024;
/** Bytes (UTF-8) the WebSocket connector holds for sending, in total and for one message. */
const DEFAULT_WS_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function createWebSocketConnector<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  baseUrl: string,
  token: AuthTokenSource,
  WebSocketImpl: typeof WebSocket,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, TEvent> {
  const { observer } = options;
  // One gate per connector, not per connection: it must outlive a reconnect, whose
  // replay of recent traffic is what it exists to filter.
  const gate = buildGate(options.turnScope);
  // The id of the last event frame this connector was handed, for the life of the
  // connector: every new socket presents it as `lastEventId`, so the daemon replays
  // what a dropped or lagging socket lost (as the SSE connector's Last-Event-ID does).
  let position: string | null = null;
  const maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? DEFAULT_WS_MAX_QUEUED_MESSAGES);
  const maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? DEFAULT_WS_MAX_QUEUED_BYTES);
  // Every domain the connector's feeds listen to rides one socket; a changed set
  // is sent on it as subscribe and unsubscribe frames.
  return createSharedDomainConnector<RuntimeEventDomain, TEvent>(async (domains, sink) => {
    // The domains this connection carries, and what the daemon has been told on
    // the current socket (its URL and auth frame, then subscription frames).
    let carried = new Set<RuntimeEventDomain>(domains);
    let told = new Set<RuntimeEventDomain>();
    let url = buildWebSocketUrl(baseUrl, [...carried], position);
    const reconnect = options.reconnect;
    // On unless the caller turns it off, with no attempt limit by default: a
    // refused credential ends the connection at once (see onMessage), so the
    // only thing retried is a daemon or network that is coming back.
    const enabled = reconnect?.enabled ?? true;
    const reconnectPolicy = normalizeStreamReconnectPolicy({
      ...reconnect,
      maxAttempts: reconnect?.maxAttempts ?? DEFAULT_WS_MAX_ATTEMPTS,
    });
    let stopped = false;
    // Set when the connection has ended on its own: nothing more is queued or sent on it.
    let over = false;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: TimeoutHandle | null = null;
    // Track last emitted connection state to avoid duplicate emissions.
    let lastConnectionState: ConnectionState | null = null;
    // The daemon's hostname: the same for every socket this connection opens.
    const transportId = (() => { try { return new URL(url).hostname; } catch { return url; } })();

    const emitConnectionState = (state: ConnectionState): void => {
      if (state === lastConnectionState) return;
      lastConnectionState = state;
      options.onConnectionStateChange?.(state);
      options.onTransportEvent?.({ type: 'TRANSPORT_CONNECTION_STATE', transportId, state });
    };

    // Messages waiting for an authenticated socket, kept across reconnects within
    // a count and byte limit. Native writes use backpressure.
    const outboundQueue: Array<{ readonly data: string; readonly bytes: number }> = [];
    let queuedBytes = 0;
    let droppedSinceFlush = 0;

    const dropQueue = (): void => {
      outboundQueue.length = 0;
      queuedBytes = 0;
      droppedSinceFlush = 0;
    };

    // The connection is over and will not recover without a new connect: drop what
    // it can no longer send, say so on the state channel and tell the feeds, which
    // open a fresh connection (handing over a new sender) unless `final` (the daemon
    // refused or revoked the credential).
    const terminate = (state: 'failed' | 'disconnected', final = false): void => {
      over = true;
      dropQueue();
      emitConnectionState(state);
      sink.ended({ final });
    };

    const reportError = (error: Error): void => {
      invokeTransportObserver(() => observer?.onError?.(error), observer?.onObserverError);
      options.onError?.(error);
    };

    const reportOverflow = (reason: BackpressureInfo['reason']): void => {
      droppedSinceFlush += 1;
      // The first drop since the queue last drained, then every tenth.
      if (droppedSinceFlush !== 1 && droppedSinceFlush % 10 !== 0) return;
      const info: BackpressureInfo = { droppedCount: droppedSinceFlush, queueLength: outboundQueue.length, queueBytes: queuedBytes, reason };
      options.onBackpressure?.(info);
      options.onTransportEvent?.({ type: 'TRANSPORT_BACKPRESSURE', transportId, ...info });
      if (droppedSinceFlush !== 1) return;
      reportError(new WebSocketTransportError(reason === 'message_too_large'
        ? `A message was not sent: it is larger than the ${maxQueuedBytes}-byte outbound limit.`
        : `A message was not sent: ${outboundQueue.length} message(s), ${queuedBytes} bytes, are already waiting for the connection.`, {
        code: reason === 'message_too_large' ? 'WS_FRAME_TOO_LARGE' : 'WS_QUEUE_OVERFLOW',
        hint: reason === 'message_too_large'
          ? 'Send it in smaller parts, or raise maxQueuedBytes.'
          : 'Wait for the connection to report connected before sending more, or raise maxQueuedMessages / maxQueuedBytes.',
      }));
    };

    const assembler = new WebSocketMessageAssembler();
    // Stream deltas arrive as increments between resync points; this hands them out whole.
    const streamText = createStreamTextAssembler();
    let connectionAbort = new AbortController();
    let flushing = false;
    let authenticated = false;
    // When the daemon accepted this socket's auth frame (undefined: not authenticated).
    let authenticatedAt: number | undefined;
    // Set by connect() when it resolved the token to build the socket with.
    let connectToken: string | null | undefined;
    const getAuthToken = normalizeAuthToken(token ?? undefined);
    const emitLocal = (data: string): void => {
      // Checked before `stopped`: a connection that ended on its own is also disposed.
      if (over) {
        reportError(new WebSocketTransportError('A message was not sent: this connection has ended.', {
          code: 'WEBSOCKET_TRANSPORT_ERROR',
          hint: 'Send it with the sender handed over for the next connection (onEmitter).',
        }));
        return;
      }
      if (stopped) return;
      const bytes = utf8Length(data);
      if (bytes > maxQueuedBytes) {
        reportOverflow('message_too_large');
        return;
      }
      if (outboundQueue.length >= maxQueuedMessages || queuedBytes + bytes > maxQueuedBytes) {
        reportOverflow('queue_full');
        return;
      }
      outboundQueue.push({ data, bytes });
      queuedBytes += bytes;
      if (authenticated && socket && isSocketOpen(socket, WebSocketImpl)) flushOutboundQueue(socket);
    };

    // Notify caller of the emitter handle for tests and local frame injection.
    options.onEmitter?.(emitLocal);

    const closeSocket = () => {
      if (!socket) return;
      authenticated = false;
      authenticatedAt = undefined;
      connectionAbort.abort();
      assembler.reset();
      // clear any pending reconnect timer so close() cannot schedule
      // a second reconnect while one is already pending.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      socket.close();
      socket = null;
    };

    // `unrecoverableAs` is the state to end in when no reconnect is coming: 'failed' where
    // retrying the same thing cannot help (refused credentials, a socket that cannot be
    // made), 'disconnected' for a plain drop with reconnect switched off.
    const scheduleReconnect = (reason = 'connection closed', unrecoverableAs: 'failed' | 'disconnected' = 'disconnected') => {
      if (stopped) return;
      if (!enabled) {
        terminate(unrecoverableAs);
        return;
      }
      const nextAttempt = reconnectAttempt + 1;
      if (nextAttempt > reconnectPolicy.maxAttempts) {
        terminate('failed');
        return;
      }
      reconnectAttempt = nextAttempt;
      // Use shared backoff helper so WS and SSE are on identical schedule.
      const delayMs = getStreamReconnectDelay(nextAttempt, reconnectPolicy);
      // Fire legacy callback for backward compatibility AND new structured callback.
      options.onReconnect?.(nextAttempt, delayMs);
      options.onReconnectAttempt?.({
        attempt: nextAttempt,
        maxAttempts: reconnectPolicy.maxAttempts,
        delayMs,
        reason,
      });
      // Dispatch typed event so UI event-bus subscribers receive the same
      // metadata as the onReconnectAttempt callback.
      options.onTransportEvent?.({
        type: 'TRANSPORT_RECONNECT_ATTEMPT',
        transportId,
        attempt: nextAttempt,
        maxAttempts: reconnectPolicy.maxAttempts,
        delayMs,
        reason,
      });
      emitConnectionState('reconnecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect().catch(handleConnectFailure);
      }, delayMs) as TimeoutHandle;
      // Do not keep Node/Bun processes alive solely to wait for a reconnect.
      reconnectTimer.unref?.();
    };

    const handleConnectFailure = (error: unknown): void => {
      reportError(transportErrorFromUnknown(error, 'WebSocket runtime event connection failed'));
      scheduleReconnect('could not open the socket', 'failed');
    };

    const flushOutboundQueue = (openedSocket: WebSocket): void => {
      if (!authenticated || flushing || stopped || socket !== openedSocket) return;
      flushing = true;
      const signal = connectionAbort.signal;
      void (async () => {
        try {
          while (outboundQueue.length && !stopped && socket === openedSocket) {
            const next = outboundQueue[0]!;
            await sendWebSocketMessage(openedSocket, next.data, signal);
            if (outboundQueue[0] === next) {
              outboundQueue.shift();
              queuedBytes -= next.bytes;
            }
          }
          if (outboundQueue.length === 0) droppedSinceFlush = 0;
        } catch (error) { if (!signal.aborted) options.onError?.(transportErrorFromUnknown(error, 'WebSocket send failed')); }
        finally {
          flushing = false;
          if (socket && socket !== openedSocket && isSocketOpen(socket, WebSocketImpl)) flushOutboundQueue(socket);
        }
      })();
    };

    /** Tell the daemon which domains were added or dropped since it was last told, on this socket. */
    const sendSubscriptionChanges = (target: WebSocket): void => {
      const added = [...carried].filter((domain) => !told.has(domain));
      const removed = [...told].filter((domain) => !carried.has(domain));
      told = new Set(carried);
      try {
        if (added.length > 0) target.send(JSON.stringify({ type: 'subscribe', domains: added }));
        if (removed.length > 0) target.send(JSON.stringify({ type: 'unsubscribe', domains: removed }));
      } catch (error) {
        // The socket is going away; its close reconnects with the current set in the URL.
        reportError(transportErrorFromUnknown(error, 'WebSocket send failed'));
      }
    };

    const onOpen = async (event: Event) => {
      // NOTE: do NOT call emitConnectionState('connecting') here, connect()
      // already emits it before creating the socket. 'connected' waits for the
      // daemon to accept the auth frame (see onMessage).
      const candidateSocket = event.currentTarget as WebSocket | null;
      const openedSocket = candidateSocket && typeof candidateSocket.send === 'function'
        ? candidateSocket
        : socket;
      try {
        // The token this socket was built with, when it was built with one; else resolve now.
        const authToken = connectToken !== undefined ? connectToken : (await getAuthToken()) ?? null;
        // surface a diagnostic error when the token resolver returns null
        // before a reconnect loop is scheduled.
        if (authToken === null || authToken === undefined) {
          options.onError?.(new ConfigurationError(
            'WebSocket auth token resolver returned null. Check transport options.authToken / options.getAuthToken.',
            { code: 'ENGINE_AUTH_TOKEN_MISSING', source: 'config' },
          ));
          closeSocket();
          // The resolver may have a token by the next attempt (after a login), so retry within
          // the reconnect budget; with reconnect off this is the end of the connection.
          scheduleReconnect('auth token unavailable', 'failed');
          return;
        }
        if (!openedSocket || stopped || socket !== openedSocket) return;
        // Notify observer of outbound WS connection.
        invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'ws' }), observer?.onObserverError);
        // Send auth frame first, then drain any messages buffered during resolution.
        // Inject traceparent into the auth frame for W3C Trace Context propagation over WebSocket.
        const wsTraceHeaders: Record<string, string> = {};
        await injectTraceparentAsync(wsTraceHeaders);
        if (stopped || socket !== openedSocket) return;
        // No domains here: the authenticated upgrade's URL already subscribed them, and a
        // change since is sent as subscribe/unsubscribe once the daemon accepts this frame.
        openedSocket.send(JSON.stringify({
          type: 'auth',
          token: authToken,
          ...(wsTraceHeaders['traceparent'] ? { traceparent: wsTraceHeaders['traceparent'] } : {}),
          ...(wsTraceHeaders['tracestate'] ? { tracestate: wsTraceHeaders['tracestate'] } : {}),
        }));
      } catch (error) {
        reportError(transportErrorFromUnknown(error, 'WebSocket send failed'));
        closeSocket();
        scheduleReconnect('send failed', 'failed');
      }
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        if (typeof event.data !== 'string') {
          throw new WebSocketTransportError('WebSocket runtime event frame was not a string payload.', { code: 'WS_EVENT_ERROR' });
        }
        const decoded = assembler.accept(JSON.parse(event.data));
        if (decoded === undefined) return;
        const frame = decoded as { type?: string; event?: string; id?: unknown; payload?: unknown; ok?: boolean; error?: unknown; code?: unknown; category?: unknown; next?: unknown };
        // A refusal frame's own code and category, as the daemon sent them.
        const frameCode = typeof frame.code === 'string' && frame.code.trim() ? frame.code.trim() : undefined;
        const frameCategory = DAEMON_ERROR_CATEGORIES.find((category) => category === frame.category);
        const frameNext = Array.isArray(frame.next) && typeof frame.next[0] === 'string' ? frame.next[0] : undefined;
        if (frame.type === 'auth' && frame.ok === false) {
          // The daemon refused the auth frame, for the reason its code and category say (a
          // refused credential, or a frame it could not accept). The same frame is refused
          // again on a reconnect, so end here and say why.
          const reason = typeof frame.error === 'string' && frame.error.trim() ? frame.error.trim() : 'no reason given';
          const authentication = frameCategory === undefined || frameCategory === 'authentication';
          const hint = frameNext ?? (authentication
            ? 'Check the auth token, or request a new one, then open a new connection.'
            : 'Fix what the daemon named, then open a new connection.');
          reportError(frameCode
            ? new GoodVibesError(`The daemon refused the WebSocket authentication: ${reason}`, {
              code: frameCode, category: frameCategory ?? 'authentication', source: 'transport', recoverable: false, hint,
            })
            : new WebSocketTransportError(`The daemon refused the WebSocket authentication: ${reason}`, {
              code: 'WS_REMOTE_ERROR', category: frameCategory ?? 'authentication', recoverable: false, hint,
            }));
          closeSocket();
          terminate('failed', true);
          return;
        }
        if (frame.type === 'error') {
          // A frame the daemon refused (a subscription it could not apply, a malformed frame):
          // the connection goes on, and the caller is told what was refused.
          const reason = typeof frame.error === 'string' && frame.error.trim() ? frame.error.trim() : 'no reason given';
          reportError(new GoodVibesError(`The daemon refused a WebSocket frame: ${reason}`, {
            code: frameCode ?? 'WS_REMOTE_ERROR',
            category: frameCategory ?? 'protocol',
            source: 'transport',
            recoverable: true,
            ...(frameNext ? { hint: frameNext } : {}),
          }));
          endUnservedDomains(frame, sink);
          return;
        }
        if (frame.type === 'event' && frame.event === 'ready') {
          // What the presented position turned into, read as the SSE connector reads it: an
          // unresolved one replayed nothing, so the gap is said, the position forgotten and the gate reset.
          const ready = frame.payload;
          const resume = (ready as { resume?: { resume?: unknown } } | null | undefined)?.resume?.resume;
          if (resume === 'unresolved') {
            position = null;
            gate?.reset();
            reportError(new GoodVibesError('The daemon could not resume the event stream from its last position, so events since then were not replayed.', {
              category: 'protocol',
              source: 'transport',
              recoverable: true,
              hint: 'The daemon restarted or the position aged out of its recent-event window. Re-read current state instead of waiting for events that may already have happened.',
            }));
          }
          endUnservedDomains(ready, sink);
          return;
        }
        if (frame.type === 'subscribed') {
          endUnservedDomains(frame, sink);
          return;
        }
        if (frame.type === 'closed') {
          // The daemon stopped serving this socket because its credential was revoked; a
          // reconnect with the same credential is refused too, so end here and say what to do.
          const closed = frame as { reason?: unknown; next?: unknown };
          const reason = typeof closed.reason === 'string' && closed.reason.trim() ? closed.reason.trim() : 'closed by the daemon';
          const revokedError = new WebSocketTransportError(`The daemon ended this connection: ${reason}`, {
            code: 'WS_REMOTE_ERROR',
            category: 'authentication',
            recoverable: false,
            hint: typeof closed.next === 'string' && closed.next.trim() ? closed.next.trim() : 'Sign in again, then open a new connection.',
          });
          reportError(revokedError);
          closeSocket();
          terminate('failed', true);
          return;
        }
        if (frame.type === 'auth' && frame.ok === true && socket) {
          // Connected means the daemon accepted the credential, so a stale token reads
          // connecting then failed, never connected. The reconnect budget starts afresh
          // only once the socket has stayed up for the stability window (see onClose).
          authenticated = true;
          authenticatedAt = Date.now();
          emitConnectionState('connected');
          options.onOpen?.();
          endUnservedDomains(frame, sink);
          sendSubscriptionChanges(socket);
          flushOutboundQueue(socket);
          return;
        }
        // Every event frame advances the position the next socket resumes from.
        if (frame.type === 'event' && typeof frame.id === 'string' && frame.id) position = frame.id;
        if (frame.type === 'event' && typeof frame.event === 'string' && carried.has(frame.event as RuntimeEventDomain)
          && frame.payload && typeof frame.payload === 'object') {
          // The shared envelope reader (envelope.ts): unknown keys are ignored.
          const wsPayload: SerializedRuntimeEnvelope<TEvent> | null = readEventEnvelope<TEvent>(frame.payload, streamText);
          if (!wsPayload) {
            throw new WebSocketTransportError('A WebSocket runtime event frame is not an event envelope: it needs a type and a payload.', {
              code: 'WS_EVENT_ERROR',
            });
          }
          // A reconnect replays the domain's recent traffic, terminal turn frames included.
          if (gate) {
            const turnFrame = readTurnLifecycleFrame(wsPayload.sessionId, wsPayload.payload);
            if (turnFrame && !gate.accepts(turnFrame)) return;
          }
          sink.deliver(frame.event as RuntimeEventDomain, wsPayload);
          // Notify observer of inbound WS event.
          invokeTransportObserver(() => {
            observer?.onTransportActivity?.({ direction: 'recv', url, kind: 'ws' });
          }, observer?.onObserverError);
          if (wsPayload.payload) {
            invokeTransportObserver(() => {
              (observer as { onEvent?: (e: unknown) => void } | undefined)?.onEvent?.(wsPayload.payload);
            }, observer?.onObserverError);
          }
        }
      } catch (error) {
        reportError(new GoodVibesError(`Malformed WebSocket runtime event frame: ${transportErrorFromUnknown(error, 'parse error').message}`, {
          category: 'protocol',
          source: 'transport',
          recoverable: true,
          cause: error,
        }));
      }
    };

    const onClose = (event: CloseEvent) => {
      // RFC 6455 §7.4.1: code 1005 (No Status Received) is synthesized by runtimes
      // when a socket closes WITHOUT a close frame, including abnormal drops (process
      // death, proxy teardown, RST) where wasClean === false. Only a genuine clean
      // shutdown has wasClean === true AND code === 1000. Everything else must reconnect.
      //
      // Compatibility note: the `wasClean` field is present on the browser CloseEvent
      // and on the 'ws' package's CloseEvent (used by Node.js and Bun). If a runtime
      // somehow does not expose wasClean, `event.wasClean` is undefined (falsy), so
      // the expression `event.wasClean === true` correctly falls back to reconnecting
      // for any ambiguous close, never suppresses reconnect incorrectly.
      const isCleanClose = event.wasClean === true && event.code === 1000;
      // A socket that stayed authenticated through the stability window was healthy:
      // its drop is a new outage, so the backoff starts again from the first attempt.
      if (authenticatedAt !== undefined && Date.now() - authenticatedAt >= WS_CONNECTION_STABILITY_MS) reconnectAttempt = 0;
      if (!stopped && !isCleanClose) {
        // Abnormal close, surface error and schedule reconnect.
        // The raw close reason is forwarded so TRANSPORT_RECONNECT_ATTEMPT
        // metadata is meaningful to diagnostic UIs.
        reportError(webSocketCloseError(event));
        closeSocket();
        // Pass the close reason so reconnect metadata is meaningful.
        const rawReason = typeof event.reason === 'string' && event.reason.trim()
          ? event.reason.trim()
          : `code=${event.code}`;
        scheduleReconnect(rawReason);
      } else {
        // Clean close (wasClean === true && code === 1000), deliberate server-side
        // disconnect. We do NOT schedule a reconnect: the server explicitly terminated
        // the session and the client should stay disconnected.
        //
        // **Contract:** `scheduleReconnect` is only called for non-clean closes.
        // UIs observing `TRANSPORT_CONNECTION_STATE` will see the state transition
        // to 'disconnected' emitted directly here in onClose, and will NOT see
        // 'reconnecting' following a clean close.
        closeSocket();
        terminate('disconnected');
      }
    };

    const onError = (event: Event) => {
      reportError(webSocketEventError(event, socket, url));
    };

    const connect = async () => {
      if (stopped) return;
      closeSocket();
      emitConnectionState('connecting');
      // A new socket subscribes, through its URL, to the domains carried now.
      url = buildWebSocketUrl(baseUrl, [...carried], position);
      told = new Set(carried);
      let nextSocket: WebSocket;
      if (options.createSocket) {
        const token = (await getAuthToken()) ?? null;
        if (stopped) return;
        connectToken = token;
        // A runtime may throw here (a blocked port, a bad scheme); the callers report that.
        nextSocket = options.createSocket(url, token);
      } else {
        connectToken = undefined;
        nextSocket = new WebSocketImpl(url);
      }
      socket = nextSocket;
      connectionAbort = new AbortController();
      nextSocket.addEventListener('open', onOpen);
      nextSocket.addEventListener('message', onMessage);
      nextSocket.addEventListener('close', onClose);
      nextSocket.addEventListener('error', onError);
    };

    void connect().catch(handleConnectFailure);
    return {
      retarget(next) {
        carried = new Set(next);
        // Before authentication the auth frame carries the set; while the socket is
        // down the next socket's URL does.
        if (authenticated && socket && isSocketOpen(socket, WebSocketImpl)) sendSubscriptionChanges(socket);
        return true;
      },
      close() {
        stopped = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }
        closeSocket();
        // 'failed' is final (see ConnectionState): disposing a connection that has
        // already given up must not relabel it 'disconnected'.
        if (lastConnectionState !== 'failed') emitConnectionState('disconnected');
        // Nothing queued is sent once the connection is disposed.
        dropQueue();
      },
    };
  });
}

function webSocketCloseError(event: CloseEvent): Error {
  // Cap reason length to prevent oversized error messages.
  const rawReason = typeof event.reason === 'string' ? event.reason.trim() : '';
  const reason = rawReason.length > 256 ? `${rawReason.slice(0, 256)}…` : rawReason;
  const code = typeof event.code === 'number' ? event.code : 1005;
  const wasClean = typeof event.wasClean === 'boolean' ? event.wasClean : false;
  const detail = [
    `code=${code}`,
    reason ? `reason=${reason}` : undefined,
    `wasClean=${wasClean}`,
  ].filter(Boolean).join(' ');
  return new WebSocketTransportError(`WebSocket runtime event stream closed unexpectedly: ${detail}`, {
    code: 'WS_CLOSE_ABNORMAL',
    cause: { code, reason, wasClean },
  });
}

function webSocketEventError(event: Event, socket: WebSocket | null, url: string): Error {
  // We cast to ErrorEvent to access `error`/`message` fields.
  // Per the WHATWG spec, WebSocket `error` events are plain Events, not ErrorEvents
  //, so `candidate.error` and `candidate.message` may be undefined in compliant
  // browsers. The safe-extract path below handles both cases: if `candidate.error`
  // is defined we treat it as an ErrorEvent (V8/Bun do populate it on some failures);
  // if not, we fall through to the generic `describeUnknownTransportError` branch.
  // Using `socket.onerror` directly instead would lose the envelope-unwrap logic here.
  const candidate = event as ErrorEvent;
  // avoid retaining the raw event.error (which may hold currentTarget/target
  // back-references to the WebSocket, creating retention chains over many reconnects).
  // Capture only name+message from Error instances; stringify anything else.
  const safeError = candidate.error instanceof Error
    ? { name: candidate.error.name, message: candidate.error.message }
    : candidate.error !== undefined && candidate.error !== null
      ? String(candidate.error)
      : undefined;
  const cause = {
    eventType: event.type,
    url,
    readyState: socket?.readyState,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    error: safeError,
  };
  if (candidate.error) {
    return new WebSocketTransportError(
      `WebSocket runtime event stream error: ${transportErrorFromUnknown(candidate.error, 'WebSocket error').message}`,
      { code: 'WS_REMOTE_ERROR', cause },
    );
  }
  const eventMessage = typeof candidate.message === 'string' && candidate.message.trim().length > 0
    ? candidate.message.trim()
    : undefined;
  return new WebSocketTransportError(
    eventMessage
      ? `WebSocket runtime event stream error: ${eventMessage}`
      : `WebSocket runtime event stream error: ${describeUnknownTransportError(event)}`,
    { code: 'WS_REMOTE_ERROR', cause },
  );
}
