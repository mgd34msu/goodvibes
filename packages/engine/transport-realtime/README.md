# @goodvibes-jev/engine/transport-realtime

Public GoodVibes realtime transport package for event-domain connectors over SSE and WebSocket.

Most applications should install `@goodvibes-jev/engine` and import `@goodvibes-jev/engine/platform/transport-realtime`. These modules are subpath exports of the engine package.

Consumer import:

```ts
import {
  createEventSourceConnector,
  createRemoteRuntimeEvents,
} from '@goodvibes-jev/engine/platform/transport-realtime';

const events = createRemoteRuntimeEvents(
  createEventSourceConnector('https://goodvibes.example.com', 'token', fetch),
);
```

Use this surface when you want runtime-event subscriptions without pulling in the full main platform.

## WebSocket connector

`createWebSocketConnector(baseUrl, token, WebSocket, options?)` returns a connector with the same shape as the SSE connector but adds WebSocket-only lifecycle hooks (the SSE connector does not fire them):

- `onConnectionStateChange(state: ConnectionState)`: `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'`. `'failed'` is final: disposing a connector that has given up reconnecting does not emit `'disconnected'` afterwards.
- `onReconnectAttempt(info: ReconnectAttemptInfo)`: `{ attempt, maxAttempts, delayMs, reason }`. The legacy `onReconnect(attempt, delayMs)` is deprecated but still fired.
- `onBackpressure(info: BackpressureInfo)`: accepted for compatibility but never called. The outbound queue is unbounded: messages sent while the socket is connecting, reconnecting or authenticating are held in order and flushed when it is ready, none dropped. A single message over 64M characters is refused when sent.

`DEFAULT_WS_MAX_ATTEMPTS` (10) is the default reconnect ceiling, chosen to avoid infinite auth-failure loops. `WebSocketTransportError` and `createWebSocketRemoteError` carry typed WebSocket failure detail. A plain `ws://` URL is accepted only for loopback, private-network and `.local` hosts, the same rule as the HTTP transport, and refused otherwise with a `ConfigurationError`; use `wss://` or `https://` for public hosts. Inbound frames arrive in chunks of at most 64 KiB, and one reassembled message is capped at 64M characters; a larger one is refused and the partial message dropped, which protects the client from an oversized message sent by the server.

## Domain events

The domain-event layer provides session- and domain-scoped feeds:

- `createRemoteDomainEvents(domains, connector, options?)`: multi-domain feed over any `DomainEventConnector`.
- `forSession(...)` and `forSessionRuntime(...)`: scope a feed to a single session.
- Types: `DomainEventConnector`, `RemoteDomainEventsOptions`, `SerializedEventEnvelope`, `ConnectionState`, `ReconnectAttemptInfo`, `BackpressureInfo`.

## Turn lifecycle gate

`createTurnLifecycleGate(options?)` filters a reconnecting stream so it cannot deliver another turn's leftover frames. A client that opens a fresh SSE or WebSocket stream without resuming from `Last-Event-ID` is replayed the tail of whatever turn was running before it connected, terminal frames included; without a guard, that prior turn's `TURN_COMPLETED` lands in the new consumer and prematurely finishes a turn it never started. The gate binds per session to whichever turn each session is seen to start (`TURN_SUBMITTED`), then accepts only frames carrying that turn's ID; while unbound it drops replayed terminal frames (`TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, `PREFLIGHT_FAIL`) but still accepts non-terminal frames so a client attaching mid-turn can render it. Pass `turnId` explicitly when the consumer already knows which turn it submitted; omit it to let the gate infer the binding from the stream itself.

```ts
import { createTurnLifecycleGate, readTurnLifecycleFrame } from '@goodvibes-jev/engine/platform/transport-realtime';

const gate = createTurnLifecycleGate();
const frame = readTurnLifecycleFrame(envelope.sessionId, envelope.payload);
if (frame && !gate.accepts(frame)) {
  // frame belongs to a turn this consumer is not rendering; drop it.
}
```

## Relay client

`createRelayClient(options)` opens a WebSocket tunnel through the zero-knowledge, self-hostable relay described in `transport-core`'s `./relay` subpath. The relay operator can read the hop-level protocol frames but not the end-to-end encrypted payload. `options.pairing` accepts a `RelayPairingPayload` or its encoded string form; `webSocketImpl` lets non-browser runtimes supply a WebSocket implementation. The returned `RelayClient` exposes a `fetch`-compatible function, `connect()`/`close()`, and a `ready` flag, so relay-tunneled requests can be issued the same way as a direct HTTP call.
