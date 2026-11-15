/**
 * Tests for UX-first enhancements:
 *  Connection-state events and reconnect metadata from the WebSocket connector
 *  Outbound queue: kept in order across reconnects, bounded, dropped when the connection ends
 *  WS error envelope parity (createWebSocketRemoteError)
 *  Transport events dispatched by the connector
 */
import { describe, expect, test } from 'bun:test';
import {
  createWebSocketConnector,
  createWebSocketRemoteError,
  WebSocketTransportError,
  type BackpressureInfo,
  type ConnectionState,
  type ConnectorTransportEvent,
  type ReconnectAttemptInfo,
  type RuntimeEventConnectorOptions,
} from '../transport-realtime/src/runtime-events.ts';
import { waitFor } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// Minimal mock WebSocket for connector tests
// ---------------------------------------------------------------------------
type WsEventName = 'open' | 'message' | 'close' | 'error';

interface MockWebSocketHandle {
  simulateOpen(): void;
  simulateMessage(data: string): void;
  simulateClose(code?: number, reason?: string): void;
  sentMessages: string[];
}

function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket;
  instances: MockWebSocketHandle[];
} {
  const instances: MockWebSocketHandle[] = [];

  class MockWebSocket {
    private listeners = new Map<WsEventName, Set<EventListenerOrEventListenerObject>>();
    readonly sentMessages: string[] = [];
    readonly url: string;
    readyState: number = 0;

    constructor(url: string) {
      this.url = url;
      const handle: MockWebSocketHandle = {
        simulateOpen: () => {
          this.readyState = 1;
          this._dispatch('open', new Event('open'));
        },
        simulateMessage: (data: string) => {
          const evt = new MessageEvent('message', { data });
          this._dispatch('message', evt);
        },
        simulateClose: (code = 1006, reason = '') => {
          this.readyState = 3;
          const evt = new CloseEvent('close', { code, reason, wasClean: code === 1000 });
          this._dispatch('close', evt);
        },
        sentMessages: this.sentMessages,
      };
      instances.push(handle);
    }

    static get OPEN(): number { return 1; }

    addEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }

    removeEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      this.listeners.get(event)?.delete(listener);
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close() { this.readyState = 3; }

    private _dispatch(event: WsEventName, evt: Event) {
      for (const listener of this.listeners.get(event) ?? []) {
        if (typeof listener === 'function') listener(evt);
        else listener.handleEvent(evt);
      }
    }
  }

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances };
}

/** Asserts at least one mock socket was created and returns the first one, narrowed. */
function firstInstance(instances: MockWebSocketHandle[]): MockWebSocketHandle {
  expect(instances.length).toBeGreaterThanOrEqual(1);
  return instances[0]!;
}

/**
 * DomainEventConnector's declared return type is `void | Promise<() => void>`,
 * the WebSocket branch always resolves a real stop function, but the type
 * doesn't promise that. Assert it before calling, so a real regression (the
 * connector silently returning nothing) fails loudly instead of leaking an
 * open socket across tests.
 */
function stopOrThrow(stop: (() => void) | void): void {
  if (typeof stop !== 'function') throw new Error('connector did not return a stop function');
  stop();
}

/** Opens a mock socket and waits until the connector has sent its auth frame. */
async function open(ws: MockWebSocketHandle): Promise<void> {
  ws.simulateOpen();
  await waitFor(() => ws.sentMessages.length > 0);
}

/** The daemon accepting the credential: the connector may now flush its queue. */
function acceptAuth(ws: MockWebSocketHandle): void {
  ws.simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
}

/** Waits for the connector to create its n-th socket (1-based) and returns it. */
async function socketNumber(instances: MockWebSocketHandle[], n: number): Promise<MockWebSocketHandle> {
  await waitFor(() => instances.length >= n);
  return instances[n - 1]!;
}

const reconnectOnce = { enabled: true, baseDelayMs: 0, maxDelayMs: 0 } as const;
const stateEvents = (events: ConnectorTransportEvent[]): ConnectionState[] =>
  events.flatMap((event) => (event.type === 'TRANSPORT_CONNECTION_STATE' ? [event.state] : []));

// ---------------------------------------------------------------------------
// Connection-state events and reconnect metadata
// ---------------------------------------------------------------------------
describe('connection-state events', () => {
  test('onConnectionStateChange fires connecting then connected on successful open', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});
    expect(instances).toHaveLength(1);

    await open(firstInstance(instances));
    // The auth frame is sent, but the daemon has not accepted it yet.
    expect(states).toEqual(['connecting']);
    acceptAuth(firstInstance(instances));

    // Exact sequence: connecting (from connect()) then connected (once the daemon accepted the credential).
    expect(states).toEqual(['connecting', 'connected']);

    stopOrThrow(stop);
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
  });

  test('onConnectionStateChange fires reconnecting after abnormal close', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));
    acceptAuth(firstInstance(instances));
    firstInstance(instances).simulateClose(1006); // abnormal close
    await waitFor(() => states.includes('reconnecting'));

    expect(states).toEqual(['connecting', 'connected', 'reconnecting']);
    stopOrThrow(stop);
  });

  test('onConnectionStateChange fires failed when attempts exhausted', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 1 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // The single allowed reconnect is used up by the first drop; the second drop has none left.
    await open(firstInstance(instances));
    firstInstance(instances).simulateClose(1006);
    const second = await socketNumber(instances, 2);
    await open(second);
    second.simulateClose(1006);
    await waitFor(() => states.includes('failed'));

    expect(states.filter((state) => state === 'reconnecting')).toHaveLength(1);
    expect(instances).toHaveLength(2);
    stopOrThrow(stop);
  });

  test('a refused credential ends the connection as failed instead of sitting connected', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const errors: Error[] = [];
    const attempts: ReconnectAttemptInfo[] = [];
    let ended = 0;

    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      reconnect: { ...reconnectOnce, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
      onReconnectAttempt: (info) => attempts.push(info),
      onError: (error) => errors.push(error instanceof Error ? error : new Error(String(error))),
    });
    const stop = await connector('agents', () => {}, () => { ended += 1; });

    await open(firstInstance(instances));
    expect(states).toEqual(['connecting']);
    firstInstance(instances).simulateMessage(JSON.stringify({ type: 'auth', ok: false, error: 'token revoked' }));

    // Never 'connected': the credential was not accepted.
    expect(states).toEqual(['connecting', 'failed']);
    expect(ended).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WebSocketTransportError);
    expect(errors[0]!.message).toContain('token revoked');
    // The same token would fail again, so no reconnect is scheduled.
    expect(attempts).toEqual([]);
    expect(instances).toHaveLength(1);
    stopOrThrow(stop);
  });

  test('onReconnectAttempt fires with structured metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const attempts: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 5 },
      onReconnectAttempt: (info) => attempts.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));
    firstInstance(instances).simulateClose(1006, 'server error');
    await waitFor(() => attempts.length >= 1);

    expect(attempts[0]).toEqual({ attempt: 1, maxAttempts: 5, delayMs: 0, reason: 'server error' });

    stopOrThrow(stop);
  });

  test('legacy onReconnect still fires alongside onReconnectAttempt (backward compat)', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const legacyCalls: [number, number][] = [];
    const newCalls: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 5 },
      onReconnect: (attempt, delayMs) => legacyCalls.push([attempt, delayMs]),
      onReconnectAttempt: (info) => newCalls.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));
    firstInstance(instances).simulateClose(1006);
    await waitFor(() => legacyCalls.length >= 1 && newCalls.length >= 1);

    // Both agree on the attempt number and delay.
    expect(legacyCalls[0]).toEqual([newCalls[0]!.attempt, newCalls[0]!.delayMs]);

    stopOrThrow(stop);
  });
});

// ---------------------------------------------------------------------------
// Outbound queue: order across reconnects, limits, end of the connection
// ---------------------------------------------------------------------------
describe('outbound queue', () => {
  test('a full queue refuses the newest message and says so on every channel', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];
    const events: ConnectorTransportEvent[] = [];
    const errors: Array<{ code?: string }> = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      maxQueuedMessages: 3,
      onBackpressure: info => bpEvents.push(info),
      onTransportEvent: event => events.push(event),
      onError: error => errors.push(error as { code?: string }),
      onEmitter: emit => { for (let i = 0; i < 5; i++) emit(`message-${i}`); },
    });
    const pending = connector('agents', () => {});
    const ws = await socketNumber(instances, 1);
    await open(ws);
    acceptAuth(ws);
    const stop = await pending;
    await waitFor(() => ws.sentMessages.filter(message => message.startsWith('message-')).length === 3);
    expect(ws.sentMessages.filter(message => message.startsWith('message-'))).toEqual(['message-0', 'message-1', 'message-2']);
    expect(bpEvents).toEqual([{ droppedCount: 1, queueLength: 3, queueBytes: 27, reason: 'queue_full' }]);
    expect(events.filter(event => event.type === 'TRANSPORT_BACKPRESSURE')).toHaveLength(1);
    expect(errors.map(error => error.code)).toEqual(['WS_QUEUE_OVERFLOW']);
    stopOrThrow(stop);
  });

  test('a message larger than the byte limit is refused as too large', async () => {
    const { MockWebSocket } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];
    const errors: Array<{ code?: string }> = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      maxQueuedBytes: 8,
      onBackpressure: info => bpEvents.push(info),
      onError: error => errors.push(error as { code?: string }),
      onEmitter: emit => emit('x'.repeat(9)),
    });
    stopOrThrow(await connector('agents', () => {}));
    expect(bpEvents.map(info => info.reason)).toEqual(['message_too_large']);
    expect(errors.map(error => error.code)).toEqual(['WS_FRAME_TOO_LARGE']);
  });

  test('queued messages are sent in order on the socket a reconnect opens', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    let emit!: (data: string) => void;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      reconnect: { ...reconnectOnce, maxAttempts: 3 },
      onEmitter: fn => { emit = fn; },
    });
    const pending = connector('agents', () => {});
    const firstSocket = await socketNumber(instances, 1);
    await open(firstSocket);
    acceptAuth(firstSocket);
    const stop = await pending;
    firstSocket.simulateClose(1006);
    const secondSocket = await socketNumber(instances, 2);
    const held = ['second-0', 'second-1', 'second-2'];
    held.forEach(emit);
    await open(secondSocket);
    acceptAuth(secondSocket);
    await waitFor(() => secondSocket.sentMessages.length >= held.length + 1);
    expect(secondSocket.sentMessages.slice(-held.length)).toEqual(held);
    stopOrThrow(stop);
  });

  test('a connection that failed drops what it held and refuses new messages', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const errors: Array<{ code?: string }> = [];
    let emit!: (data: string) => void;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      onError: error => errors.push(error as { code?: string }),
      onEmitter: fn => { emit = fn; },
    });
    const stop = await connector('agents', () => {});
    const ws = firstInstance(instances);
    emit('held');
    await open(ws);
    ws.simulateMessage(JSON.stringify({ type: 'auth', ok: false, error: 'token revoked' }));
    emit('after');
    expect(ws.sentMessages.filter(message => message === 'held' || message === 'after')).toEqual([]);
    expect(errors.map(error => error.code)).toEqual(['WS_REMOTE_ERROR', 'WEBSOCKET_TRANSPORT_ERROR']);
    stopOrThrow(stop);
  });
});

// ---------------------------------------------------------------------------
// WS error envelope parity
// ---------------------------------------------------------------------------
describe('WS error envelope parity', () => {
  test('createWebSocketRemoteError falls back to fallbackMessage for non-structured body', () => {
    const err = createWebSocketRemoteError('Something went wrong', { some: 'object' });
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Something went wrong');
    expect(err.code).toBe('WS_REMOTE_ERROR');
  });

  test('createWebSocketRemoteError uses body string directly when body is a non-empty string', () => {
    const err = createWebSocketRemoteError('fallback', 'Server said no');
    expect(err.message).toBe('Server said no');
  });

  test('createWebSocketRemoteError unpacks structured daemon error body', () => {
    const body = {
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      category: 'rate_limit',
      recoverable: true,
      hint: 'Wait 60 seconds before retrying.',
      requestId: 'req-abc',
    };
    const err = createWebSocketRemoteError('fallback', body);
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Rate limit exceeded');
    // The transport code is always a canonical WS code ('WS_REMOTE_ERROR');
    // the server's body.code is not used as the error code since Symbol.hasInstance
    // enforces a canonical-code allowlist. The server's metadata (category, recoverable,
    // hint, requestId) is preserved on the error object.
    expect(err.code).toBe('WS_REMOTE_ERROR');
    expect(err.category).toBe('rate_limit');
    expect(err.recoverable).toBe(true);
    expect(err.hint).toBe('Wait 60 seconds before retrying.');
    expect(err.requestId).toBe('req-abc');
  });

  test('createWebSocketRemoteError respects caller code override for non-structured body', () => {
    const err = createWebSocketRemoteError('fallback', null, { code: 'WS_CLOSE_ABNORMAL', hint: 'reconnect' });
    expect(err.code).toBe('WS_CLOSE_ABNORMAL');
    expect(err.hint).toBe('reconnect');
  });

  test('WebSocketTransportError constructor accepts extended options for parity with HttpStatusError', () => {
    const err = new WebSocketTransportError('Auth failed over WS', {
      code: 'WS_REMOTE_ERROR',
      category: 'authentication',
      recoverable: false,
      status: 401,
      requestId: 'req-xyz',
    });
    expect(err.category).toBe('authentication');
    expect(err.recoverable).toBe(false);
    expect(err.status).toBe(401);
    expect(err.requestId).toBe('req-xyz');
  });

  test('WebSocketTransportError defaults to network/recoverable when category/recoverable omitted', () => {
    const err = new WebSocketTransportError('WS error', { code: 'WS_EVENT_ERROR' });
    expect(err.category).toBe('network');
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onTransportEvent: typed events dispatched by connector
// ---------------------------------------------------------------------------
describe('onTransportEvent typed event dispatch', () => {
  test('onTransportEvent receives TRANSPORT_CONNECTION_STATE on each state transition', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // Before open: 'connecting' event from connect()
    expect(stateEvents(events)).toEqual(['connecting']);

    await open(firstInstance(instances));
    acceptAuth(firstInstance(instances));

    // Exact sequence pin: connecting then connected, no duplicates
    expect(stateEvents(events)).toEqual(['connecting', 'connected']);

    stopOrThrow(stop);
    expect(stateEvents(events)).toEqual(['connecting', 'connected', 'disconnected']);
  });

  test('onTransportEvent receives TRANSPORT_RECONNECT_ATTEMPT with full metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 5 },
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));
    firstInstance(instances).simulateClose(1006, 'server error');
    await waitFor(() => events.some((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT'));

    const reconnectEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_RECONNECT_ATTEMPT' } =>
        e.type === 'TRANSPORT_RECONNECT_ATTEMPT',
    );
    expect(reconnectEvents).toHaveLength(1);
    expect(reconnectEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 5, delayMs: 0, reason: 'server error' });

    stopOrThrow(stop);
  });

  test('code 1005 (No Status Received) schedules reconnect: not a clean close per RFC 6455 §7.4.1', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));

    // simulateClose with code 1005 sets wasClean: false (code !== 1000 in the harness)
    firstInstance(instances).simulateClose(1005, '');
    await waitFor(() => states.includes('reconnecting'));

    // 1005 is NOT a clean close, connector must schedule a reconnect
    expect(events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT')).toHaveLength(1);
    stopOrThrow(stop);
  });

  test('clean close (code 1000) does NOT trigger reconnect: state sequence is connecting→connected→disconnected', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { ...reconnectOnce, maxAttempts: 5 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    await open(firstInstance(instances));
    acceptAuth(firstInstance(instances));

    // Simulate clean server-side close; the connector ends the connection synchronously.
    firstInstance(instances).simulateClose(1000, 'normal closure');

    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    expect(events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT')).toHaveLength(0);
    expect(instances).toHaveLength(1);
    stopOrThrow(stop);
  });
});
