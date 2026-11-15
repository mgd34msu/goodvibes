/**
 * TransportEvent, discriminated union covering ACP/daemon transport lifecycle events.
 *
 * Covers transport lifecycle events for the runtime event bus.
 */

export type TransportEvent =
  /** Transport layer is being initialised. */
  | { type: 'TRANSPORT_INITIALIZING'; transportId: string; protocol: string }
  /** Transport is authenticating with the remote endpoint. */
  | { type: 'TRANSPORT_AUTHENTICATING'; transportId: string }
  /** Transport connection is established and ready. */
  | { type: 'TRANSPORT_CONNECTED'; transportId: string; endpoint: string }
  /** Transport is synchronising state with the remote. */
  | { type: 'TRANSPORT_SYNCING'; transportId: string }
  /** Transport connection has been closed. */
  | { type: 'TRANSPORT_DISCONNECTED'; transportId: string; reason?: string; willRetry: boolean }
  /** Transport has failed unrecoverably and will not retry. */
  | { type: 'TRANSPORT_TERMINAL_FAILURE'; transportId: string; error: string }
  /** A retry has been scheduled after a transient failure. */
  | { type: 'TRANSPORT_RETRY_SCHEDULED'; transportId: string; attempt: number; maxAttempts: number; backoffMs: number; reason: string }
  /** A scheduled retry is now being executed. */
  | { type: 'TRANSPORT_RETRY_EXECUTED'; transportId: string; attempt: number; maxAttempts: number }
  /** An SSE subscriber connected to the event stream. */
  | { type: 'STREAM_SUBSCRIBER_CONNECTED'; streamId: string; subscriberId: string; streamType: string }
  /** An SSE subscriber disconnected from the event stream. */
  | { type: 'STREAM_SUBSCRIBER_DISCONNECTED'; streamId: string; subscriberId: string; streamType: string; reason?: string }
  /**
   * The WebSocket connector's outbound queue refused a message: it was full (count or
   * bytes) while the socket was down or not yet authenticated, or the message alone was
   * over the byte limit. Emitted on the first drop since the queue last drained and on
   * every tenth after it, alongside `onBackpressure`.
   */
  | {
      type: 'TRANSPORT_BACKPRESSURE';
      /** Transport/connector identifier (the daemon's hostname for WS connectors). */
      transportId: string;
      /** Number of messages dropped since the queue last drained. */
      droppedCount: number;
      /** Current number of messages waiting in the outbound buffer. */
      queueLength: number;
      /** Current byte footprint of the outbound buffer. */
      queueBytes: number;
      /** Overflow reason. */
      reason: 'message_too_large' | 'queue_full';
    }
  /**
   * The realtime transport connection state has changed.
   *
   * Emitted by `createWebSocketConnector` on every state transition. Subscribe
   * to this in UI layers to drive connection-state badges (e.g. online/reconnecting
   * indicators).
   *
   * The `onConnectionStateChange` callback in `RuntimeEventConnectorOptions` fires
   * at the same time and provides the same state string for non-event-bus consumers.
   */
  | {
      type: 'TRANSPORT_CONNECTION_STATE';
      /** Transport/connector identifier (domain name for WS connectors). */
      transportId: string;
      /** New connection state. */
      state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
    }
  /**
   * A realtime transport reconnect attempt is scheduled.
   *
   * Carries the attempt, the backoff delay and the reason, for diagnostic UIs.
   */
  | {
      type: 'TRANSPORT_RECONNECT_ATTEMPT';
      /** Transport/connector identifier (domain name for WS connectors). */
      transportId: string;
      /** 1-based attempt index. */
      attempt: number;
      /** Maximum attempts configured. */
      maxAttempts: number;
      /** Milliseconds the connector will wait before the next connect call. */
      delayMs: number;
      /** Human-readable reason for the reconnect. */
      reason: string;
    };

/** All transport event type literals as a union. */
export type TransportEventType = TransportEvent['type'];
