/**
 * connector-options.ts, the option and observability types both runtime-event
 * connectors (SSE and WebSocket) are configured with.
 *
 * Their own file so the SSE connector can be read and tested apart from the
 * WebSocket one without either importing the other's implementation.
 * `runtime-events.ts` re-exports everything here, so nothing about where a
 * caller imports these from has changed.
 */

import type { AuthTokenResolver, StreamReconnectPolicy } from '@goodvibes-jev/engine/transport-http';
import type { TransportObserver } from '@goodvibes-jev/engine/transport-core';

/**
 * Typed transport observability events emitted by the WebSocket connector.
 *
 * A structural subset of the platform-level `TransportEvent` union, the platform
 * (`@goodvibes-jev/engine/platform`) extends this with additional server-side event
 * types. Client code that holds a reference to the full `TransportEvent` union
 * can use this type without narrowing since the shapes are structurally
 * compatible.
 */
export type ConnectorTransportEvent =
  | { type: 'TRANSPORT_CONNECTION_STATE'; transportId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' }
  | { type: 'TRANSPORT_RECONNECT_ATTEMPT'; transportId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: 'TRANSPORT_BACKPRESSURE'; transportId: string; droppedCount: number; queueLength: number; queueBytes: number; reason: 'message_too_large' | 'queue_full' };

/**
 * Connection lifecycle state.
 *
 * - `connecting`    , the initial connection attempt is in flight.
 * - `connected`     , the daemon accepted the credential and the connection is delivering events.
 * - `reconnecting`  , the connection dropped and a retry is scheduled or in flight.
 * - `disconnected`  , the connection was closed by the caller or by a clean server close, or it dropped with reconnect switched off.
 * - `failed`        , the connection will not recover without a new connect: the maximum reconnect attempts were exhausted, the daemon refused the credential, or no auth token or socket could be had.
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/** Metadata emitted on every reconnect attempt. */
export interface ReconnectAttemptInfo {
  /** 1-based reconnect attempt index. */
  readonly attempt: number;
  /** Maximum attempts configured; `Infinity` means unlimited. */
  readonly maxAttempts: number;
  /** Milliseconds the connector will wait before the attempt. */
  readonly delayMs: number;
  /** Human-readable reason for the reconnect (e.g. the error message or WS close code). */
  readonly reason: string;
}

/** Metadata emitted when the outbound queue refuses a message. */
export interface BackpressureInfo {
  /** Number of messages dropped since the queue last drained. */
  readonly droppedCount: number;
  /** Current number of messages in the outbound queue. */
  readonly queueLength: number;
  /** Current byte footprint of the outbound queue. */
  readonly queueBytes: number;
  /** The overflow reason: 'message_too_large' or 'queue_full'. */
  readonly reason: 'message_too_large' | 'queue_full';
}

/**
 * How a runtime-event connection (SSE or WebSocket) decides which turn's frames it is rendering.
 *
 * - `'session-current'` (default), each session's frames belong to the turn
 *   that session was last seen to START; a terminal frame for any other turn,
 *   or for a turn this connection never saw run, is ignored. This is what stops
 *   a replayed `TURN_COMPLETED` from finishing the turn now in flight.
 * - `{ turnId }`, this connection renders exactly one turn, stated by the
 *   caller that submitted it.
 * - `'off'`, deliver every frame as it arrives, for a consumer that does its
 *   own turn bookkeeping and wants the raw feed.
 */
export type RuntimeEventTurnScope = 'session-current' | 'off' | { readonly turnId: string };

export interface RuntimeEventConnectorOptions {
  readonly reconnect?: StreamReconnectPolicy | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  /** @deprecated Use `onReconnectAttempt` for richer metadata. This callback is still fired for backward compatibility. */
  readonly onReconnect?: ((attempt: number, delayMs: number) => void) | undefined;
  /** Called on every reconnect attempt with structured metadata. */
  readonly onReconnectAttempt?: ((info: ReconnectAttemptInfo) => void) | undefined;
  /**
   * Called when the connection state changes. Subscribe to drive connection-state UI badges.
   * One connection carries every domain the connector's feeds listen to, so there is one state.
   */
  readonly onConnectionStateChange?: ((state: ConnectionState) => void) | undefined;
  /**
   * WebSocket. Called when a message sent through the emitter is dropped instead of queued:
   * the queue already holds {@link RuntimeEventConnectorOptions.maxQueuedMessages} messages or
   * {@link RuntimeEventConnectorOptions.maxQueuedBytes} bytes (`queue_full`), or the message
   * alone is larger than the byte limit (`message_too_large`). Called on the first drop since
   * the queue last drained and on every tenth after it, with `droppedCount` the running total;
   * the first drop is also reported through `onError` (`WS_QUEUE_OVERFLOW` or
   * `WS_FRAME_TOO_LARGE`).
   */
  readonly onBackpressure?: ((info: BackpressureInfo) => void) | undefined;
  /** WebSocket. Messages held while the socket is down or not yet authenticated. Default 1024. */
  readonly maxQueuedMessages?: number | undefined;
  /** WebSocket. UTF-8 bytes held while the socket is down or not yet authenticated, and the largest one message may be. Default 8 MiB. */
  readonly maxQueuedBytes?: number | undefined;
  /**
   * Called when a typed {@link ConnectorTransportEvent} is dispatched by the connector.
   *
   * Fires for `TRANSPORT_CONNECTION_STATE`, `TRANSPORT_RECONNECT_ATTEMPT`, and
   * `TRANSPORT_BACKPRESSURE` events in addition to the dedicated callbacks above.
   * Subscribe to this to receive a single unified stream of observability events
   * suitable for forwarding to an event bus or UI state store.
   */
  readonly onTransportEvent?: ((event: ConnectorTransportEvent) => void) | undefined;
  readonly observer?: TransportObserver | undefined;
  /**
   * Called each time the WebSocket connector opens its connection, providing an
   * `emitLocal` function the caller can use to send messages over it. Messages
   * wait in order while the socket reconnects; once the connection has ended,
   * the sender refuses them and the next connection hands over a new one.
   * Primarily for tests and local harnesses that need to inject outbound frames.
   */
  readonly onEmitter?: ((emitLocal: (data: string) => void) => void) | undefined;
  /** SSE and WebSocket. Defaults to `'session-current'`; see {@link RuntimeEventTurnScope}. */
  readonly turnScope?: RuntimeEventTurnScope | undefined;
  /**
   * WebSocket. Build each socket from its URL and the token resolved for this
   * connect, for a runtime that sends headers on the upgrade (React Native:
   * `new WebSocket(url, [], { headers: { Authorization } })`). The same token
   * then goes in the auth frame, so one resolution serves the whole connect.
   * Without it the socket is `new WebSocketImpl(url)`.
   */
  readonly createSocket?: ((url: string, token: string | null) => WebSocket) | undefined;
}

export type AuthTokenSource = string | null | undefined | AuthTokenResolver;
