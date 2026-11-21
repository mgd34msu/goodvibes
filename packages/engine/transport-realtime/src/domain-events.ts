import type { EventEnvelope } from '@goodvibes/engine/transport-core';
import { DEFAULT_STREAM_RECONNECT_POLICY, getStreamReconnectDelay } from '@goodvibes/engine/transport-http';
import {
  createRuntimeEventFeeds,
  isAbortError,
  transportErrorFromUnknown,
  type EventLike,
  type RuntimeEventFeed,
  type RuntimeEventFeeds,
} from '@goodvibes/engine/transport-core';

export interface SerializedEventEnvelope<TEvent extends EventLike = EventLike> {
  readonly type: string;
  readonly ts?: number | undefined;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly source?: string | undefined;
  readonly payload: TEvent;
}

export type DomainEventConnector<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = (
  domain: TDomain,
  onEnvelope: (envelope: SerializedEventEnvelope<TEvent>) => void,
  /**
   * Call once when the connection ends on its own and will not come back
   * without a new connect (the stream closed with reconnect off or spent, the
   * socket was closed cleanly, refused or gave up). `final` is true when a new
   * connect cannot help either (the daemon refused the credential): the feed
   * then stops until a listener registers again. Otherwise the feed opens a
   * new connection itself, after a capped backoff, while it has listeners.
   * Not called for the cleanup function the feed itself invoked.
   */
  onEnded?: (end?: DomainEventConnectionEnd) => void,
  /**
   * Aborts when the feed no longer wants the connection it is still waiting
   * for (its last listener left before it opened). The connector then stops
   * waiting, rejects with an AbortError, and drops an open nobody else wants.
   */
  signal?: AbortSignal,
) => void | Promise<() => void>;

/** How a connection ended, as its connector reports it. */
export interface DomainEventConnectionEnd {
  /** True when connecting again cannot help (a refused credential). */
  readonly final: boolean;
  /** The daemon's code for a feed it ended on its own (EVENT_ACCESS_DENIED, UNKNOWN_EVENT_DOMAIN). */
  readonly code?: string | undefined;
  /** Why, in the daemon's or the connector's words. */
  readonly reason?: string | undefined;
}

export type DomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = RuntimeEventFeeds<TDomain, TEvent>;

export interface RemoteDomainEventsOptions<TDomain extends string = string> {
  readonly onConnectionError?: ((error: Error, domain: TDomain) => void) | undefined;
}

function addListener<T>(map: Map<string, Set<T>>, type: string, listener: T): () => void {
  const listeners = map.get(type) ?? new Set<T>();
  listeners.add(listener);
  map.set(type, listeners);
  return () => {
    const existing = map.get(type);
    if (!existing) return;
    existing.delete(listener);
    if (existing.size === 0) {
      map.delete(type);
    }
  };
}

function hasAnyListener(map: Map<string, Set<unknown>>): boolean {
  for (const listeners of map.values()) {
    if (listeners.size > 0) return true;
  }
  return false;
}

const isExpectedDisconnectError = isAbortError;

function normalizeConnectionError(error: unknown, domain: string): Error {
  return error instanceof Error
    ? error
    : transportErrorFromUnknown(error, `Remote domain event connection for "${domain}" failed`);
}

function reportUnexpectedConnectionError<TDomain extends string>(
  error: unknown,
  domain: TDomain,
  options: RemoteDomainEventsOptions<TDomain>,
): void {
  options.onConnectionError?.(normalizeConnectionError(error, domain), domain);
}

function listenerFailure(error: unknown, domain: string): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(`Domain event listener for "${domain}" threw: ${cause.message}`, { cause });
}

/**
 * Invoke one subscriber callback with its exceptions contained.
 *
 * The SSE read loop (transport-http's sse-stream.ts) has no catch around its
 * onEvent call, so an exception escaping here unwinds the read loop and, with
 * reconnect disabled by default, terminates the feed permanently for every
 * other subscriber. The WebSocket path contains listener errors the same way in
 * runtime-events.ts's onMessage. Catching per listener also keeps one bad
 * subscriber from starving the ones dispatched after it.
 *
 * This local delivery is not gated on the transport's own connection state, so
 * it can still reach in-process subscribers after the transport has reported
 * its terminal `failed` state; local delivery is intentionally allowed to
 * outlive wire delivery.
 */
function dispatchToListener<TValue, TDomain extends string>(
  listener: (value: TValue) => void,
  value: TValue,
  domain: TDomain,
  options: RemoteDomainEventsOptions<TDomain>,
): void {
  try {
    listener(value);
  } catch (error) {
    try {
      options.onConnectionError?.(listenerFailure(error, domain), domain);
    } catch {
      // An onConnectionError that itself throws must not reach the read loop either.
    }
  }
}

function toEventEnvelope<TEvent extends EventLike>(
  envelope: SerializedEventEnvelope<TEvent>,
): EventEnvelope<string, TEvent> {
  return {
    type: envelope.type,
    ts: typeof envelope.ts === 'number' ? envelope.ts : Date.now(),
    traceId: typeof envelope.traceId === 'string' ? envelope.traceId : undefined,
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : undefined,
    source: typeof envelope.source === 'string' ? envelope.source : undefined,
    payload: envelope.payload,
  };
}

function createRemoteDomainEventFeed<
  TDomain extends string,
  TEvent extends EventLike,
>(
  domain: TDomain,
  connect: DomainEventConnector<TDomain, TEvent>,
  options: RemoteDomainEventsOptions<TDomain>,
): RuntimeEventFeed<TEvent> {
  const payloadListeners = new Map<string, Set<(payload: TEvent) => void>>();
  const envelopeListeners = new Map<string, Set<(envelope: EventEnvelope<string, TEvent>) => void>>();
  let disconnect: (() => void) | null = null;
  // True from the moment a connector resolves until its cleanup (if it gave one)
  // has run. Tracked apart from `disconnect` because a connector may establish a
  // live connection and return no cleanup function; without this the next on()
  // would open a second connection beside the first.
  let connected = false;
  let connectPromise: Promise<void> | null = null;
  let disconnectPending = false;

  const hasListeners = (): boolean => (
    hasAnyListener(payloadListeners as Map<string, Set<unknown>>)
    || hasAnyListener(envelopeListeners as Map<string, Set<unknown>>)
  );

  // The connection the feed currently believes in. A late onEnded from a
  // connection the feed already let go of must not tear down its successor.
  let activeAttempt: { ended: boolean; handedOver: boolean; final: boolean; end?: DomainEventConnectionEnd | undefined; readonly cancel?: AbortController } | null = null;
  // Reopening after a connection that ended or could not be made: one timer,
  // a capped backoff, and a count that resets once an event arrives.
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  let reopenAttempt = 0;

  const scheduleReopen = (): void => {
    if (reopenTimer || !hasListeners()) return;
    reopenAttempt += 1;
    // The first reopen is immediate (the connector already waited before it
    // gave up); later ones back off from 500 ms to 30 s.
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      if (hasListeners()) maybeConnect();
    }, getStreamReconnectDelay(reopenAttempt - 1, DEFAULT_STREAM_RECONNECT_POLICY));
    (reopenTimer as { unref?: () => void }).unref?.();
  };

  const cancelReopen = (): void => {
    if (reopenTimer) clearTimeout(reopenTimer);
    reopenTimer = null;
  };

  const maybeConnect = (): void => {
    if (connected || disconnect || connectPromise || reopenTimer) return;
    const attempt: { ended: boolean; handedOver: boolean; final: boolean; end?: DomainEventConnectionEnd | undefined; readonly cancel: AbortController } = {
      ended: false, handedOver: false, final: false, cancel: new AbortController(),
    };
    activeAttempt = attempt;
    const onEnded = (end?: DomainEventConnectionEnd): void => {
      if (attempt.ended) return;
      attempt.ended = true;
      attempt.final = end?.final === true;
      attempt.end = end;
      // Still being handed over: the then-handler below settles it.
      if (!attempt.handedOver) return;
      forgetConnection(attempt);
    };
    connectPromise = Promise.resolve(connect(domain, (envelope) => {
      const eventType = typeof envelope.type === 'string' ? envelope.type : '';
      if (!eventType) return;
      reopenAttempt = 0;
      const payload = envelope.payload;
      const typedEnvelope = toEventEnvelope(envelope);
      // snapshot Sets before iterating to prevent skipped listeners
      // from concurrent subscribe/unsubscribe during dispatch.
      for (const listener of [...(payloadListeners.get(eventType) ?? [])]) {
        dispatchToListener(listener, payload, domain, options);
      }
      for (const listener of [...(envelopeListeners.get(eventType) ?? [])]) {
        dispatchToListener(listener, typedEnvelope, domain, options);
      }
    }, onEnded, attempt.cancel.signal)).then((cleanup) => {
      attempt.handedOver = true;
      // when connect() returns a non-function cleanup (void), we have no
      // way to honour a pending disconnect request. Log the gap and bail. Callers
      // must return a cleanup function whenever they establish a real connection.
      if (typeof cleanup !== 'function') {
        if (attempt.ended) {
          forgetConnection(attempt);
          return;
        }
        connected = true;
        if (disconnectPending) {
          reportUnexpectedConnectionError(
            new Error('Domain event connector resolved without a cleanup function while a disconnect was pending. The connection cannot be closed.'),
            domain,
            options,
          );
        }
        return;
      }
      if (disconnectPending && !hasListeners()) {
        activeAttempt = null;
        cleanup();
        return;
      }
      if (attempt.ended) {
        // The connection died before the connector finished handing it over.
        forgetConnection(attempt, cleanup);
        return;
      }
      connected = true;
      disconnect = cleanup;
    }).catch((error: unknown) => {
      if (activeAttempt === attempt) activeAttempt = null;
      if (isExpectedDisconnectError(error)) return;
      reportUnexpectedConnectionError(error, domain, options);
      // A connection that could not be made (the daemon is restarting or the
      // network is down) is tried again; a refusal no retry can clear is not.
      if ((error as { recoverable?: unknown } | null)?.recoverable !== false) scheduleReopenAfterSettle = true;
    }).finally(() => {
      connectPromise = null;
      disconnectPending = false;
      if (scheduleReopenAfterSettle) {
        scheduleReopenAfterSettle = false;
        scheduleReopen();
      }
    });
  };
  let scheduleReopenAfterSettle = false;

  /** The connection ended by itself: let go of it, and open a new one unless that cannot help. */
  const forgetConnection = (attempt: { ended: boolean; handedOver: boolean; final: boolean; end?: DomainEventConnectionEnd | undefined }, cleanup: (() => void) | null = disconnect): void => {
    if (activeAttempt !== attempt) return;
    activeAttempt = null;
    disconnect = null;
    connected = false;
    try {
      cleanup?.();
    } catch (error) {
      reportUnexpectedConnectionError(error, domain, options);
    }
    if (!attempt.final) {
      scheduleReopen();
      return;
    }
    // The daemon ended this one domain and said why (the credential may not read it, or no
    // such domain exists): that is the answer the listener is given.
    if (attempt.end?.code) {
      reportUnexpectedConnectionError(
        Object.assign(new Error(attempt.end.reason ?? `The daemon sends nothing for the "${domain}" event domain on this connection (${attempt.end.code}), so it is not reopened.`), { code: attempt.end.code }),
        domain,
        options,
      );
      return;
    }
    reportUnexpectedConnectionError(
      new Error(`Remote event stream for "${domain}" ended with an answer reconnecting cannot change (such as a refused credential), so it is not reopened. Sign in again or fix the cause; registering a listener afterwards opens a new connection.`),
      domain,
      options,
    );
  };

  const maybeDisconnect = (): void => {
    if (hasListeners()) return;
    cancelReopen();
    reopenAttempt = 0;
    if (disconnect) {
      activeAttempt = null;
      disconnect();
      disconnect = null;
      connected = false;
      return;
    }
    if (connectPromise) {
      disconnectPending = true;
      // The open still in flight is not waited for: the connector stops it now.
      activeAttempt?.cancel?.abort();
    }
  };

  return {
    on(type, listener) {
      const unsubscribe = addListener(payloadListeners, type, listener as (payload: TEvent) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
    onEnvelope(type, listener) {
      const unsubscribe = addListener(envelopeListeners, type, listener as (envelope: EventEnvelope<string, TEvent>) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
  };
}

export function createRemoteDomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
>(
  domains: readonly TDomain[],
  connect: DomainEventConnector<TDomain, TEvent>,
  options: RemoteDomainEventsOptions<TDomain> = {},
): DomainEvents<TDomain, TEvent> {
  return createRuntimeEventFeeds(
    domains,
    (domain) => createRemoteDomainEventFeed(domain, connect, options),
  );
}

/**
 * Wraps an existing {@link RuntimeEventFeed} and returns a filtered feed whose
 * callbacks only fire for envelopes whose `sessionId` matches the given value.
 *
 * Unsubscribe handles returned by `on` / `onEnvelope` on the filtered feed
 * correctly remove the underlying listener from the original feed.
 *
 * Uses a single shared envelope listener per event type so that N
 * subscribers for the same (feed, sessionId, type) triple consume only one
 * envelope-listener slot on the underlying feed instead of N.
 */
function createFilteredFeed<TEvent extends EventLike>(
  feed: RuntimeEventFeed<TEvent>,
  sessionId: string,
): RuntimeEventFeed<TEvent> {
  // Shared listeners: one envelope-level subscription per event type.
  const sharedByType = new Map<string, {
    readonly unsub: () => void;
    readonly payloadListeners: Set<(payload: TEvent) => void>;
    readonly envelopeListeners: Set<(envelope: EventEnvelope<string, TEvent>) => void>;
  }>();

  function getOrCreateShared(type: string) {
    const existing = sharedByType.get(type);
    if (existing) return existing;
    const payloadListeners = new Set<(payload: TEvent) => void>();
    const envelopeListeners = new Set<(envelope: EventEnvelope<string, TEvent>) => void>();
    const unsub = feed.onEnvelope(type as TEvent['type'], (envelope) => {
      if (envelope.sessionId !== sessionId) return;
      // One throwing subscriber must not skip the siblings sharing this slot.
      // The first failure is re-thrown so the underlying feed still reports it
      // (the remote feed contains and routes it via onConnectionError).
      let failure: unknown;
      let failed = false;
      const call = (run: () => void): void => {
        try {
          run();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      };
      for (const pl of payloadListeners) call(() => pl(envelope.payload as TEvent));
      for (const el of envelopeListeners) call(() => el(envelope as EventEnvelope<string, TEvent>));
      if (failed) throw failure;
    });
    const shared = { unsub, payloadListeners, envelopeListeners };
    sharedByType.set(type, shared);
    return shared;
  }

  function removeSharedIfEmpty(type: string) {
    const shared = sharedByType.get(type);
    if (!shared) return;
    if (shared.payloadListeners.size === 0 && shared.envelopeListeners.size === 0) {
      shared.unsub();
      sharedByType.delete(type);
    }
  }

  return {
    on<TType extends TEvent['type']>(
      type: TType,
      listener: (payload: Extract<TEvent, { type: TType }>) => void,
    ): () => void {
      const shared = getOrCreateShared(type);
      const typedListener = listener as (payload: TEvent) => void;
      shared.payloadListeners.add(typedListener);
      return () => {
        shared.payloadListeners.delete(typedListener);
        removeSharedIfEmpty(type);
      };
    },
    onEnvelope<TType extends TEvent['type']>(
      type: TType,
      listener: (envelope: EventEnvelope<TType, Extract<TEvent, { type: TType }>>) => void,
    ): () => void {
      const shared = getOrCreateShared(type);
      const typedListener = listener as (envelope: EventEnvelope<string, TEvent>) => void;
      shared.envelopeListeners.add(typedListener);
      return () => {
        shared.envelopeListeners.delete(typedListener);
        removeSharedIfEmpty(type);
      };
    },
  };
}

/**
 * Returns a filtered view of the given domain events object where every
 * callback only fires for events whose envelope `sessionId` equals the
 * supplied value.
 *
 * All domain feeds and the `domain()` accessor are pre-filtered. The
 * `domains` list is preserved unchanged.
 *
 * Unsubscribe handles returned by the filtered feeds propagate correctly
 * to the underlying connection.
 *
 * @example
 * const events = client.realtime.viaSse();
 * // Without forSession, manual filter:
 * events.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   if (e.sessionId !== mySessionId) return;
 *   process.stdout.write(e.payload.content);
 * });
 *
 * // With forSession, no filter needed:
 * const sessionEvents = forSession(events, mySessionId);
 * sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   process.stdout.write(e.payload.content);
 * });
 */
export function forSession<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
>(
  events: DomainEvents<TDomain, TEvent>,
  sessionId: string,
): DomainEvents<TDomain, TEvent> {
  const filteredFeeds = {} as Record<TDomain, RuntimeEventFeed<TEvent>>;
  for (const domain of events.domains) {
    filteredFeeds[domain] = createFilteredFeed(events[domain], sessionId);
  }
  return Object.freeze({
    ...filteredFeeds,
    domains: events.domains,
    domain(d: TDomain): RuntimeEventFeed<TEvent> {
      return filteredFeeds[d];
    },
  }) as DomainEvents<TDomain, TEvent>;
}
