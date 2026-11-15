# Realtime and telemetry

> **Surface scope:** This document covers realtime transport and telemetry for both the **full surface (Bun runtime)** and the **companion surface** (React Native, Expo, browser). Full-surface consumers use `createGoodVibesPlatform`; companion consumers use their surface-specific constructors. See [Published Surface Matrix](./surfaces.md) for the full breakdown.

> **Scope vs. [Observability](./observability.md):** This document is the consumer-facing quick reference for realtime feeds and basic telemetry consumption. For the complete event-domain catalog, observer-pipeline internals, redaction, correlation context, and metric-label allowlist, see [Observability](./observability.md). Content overlap is intentional but kept minimal here.

Use realtime feeds for live UI updates and operator monitoring.

## Runtime events

```ts
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const unsubscribe = platformClient.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

The realtime layer supports:
- SSE stream resume via `Last-Event-ID`
- SSE reconnect
- WebSocket reconnect
- dynamic auth token resolution during reconnects

### Realtime connectors

The realtime transport (`@goodvibes-jev/engine/platform/transport-realtime`) exposes two low-level connector factories plus a domain-event layer. Wrap either connector with `createRemoteRuntimeEvents(connector)` for the typed runtime-event feed.

- `createEventSourceConnector(baseUrl, token, fetch, options?)`: SSE connector. Supports `Last-Event-ID` stream resume, reconnect (via the stream reconnect policy), and dynamic auth-token resolution on reconnect.
- `createWebSocketConnector(baseUrl, token, WebSocket, options?)`: WebSocket connector. The connection-lifecycle hooks below are passed via the `options` object. Adds connection-lifecycle hooks that the SSE connector does **not** fire:
  - `onConnectionStateChange(state)` where `state` is `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'`.
  - `onReconnectAttempt(info)` with `{ attempt, maxAttempts, delayMs, reason }` (the legacy `onReconnect(attempt, delayMs)` is deprecated but still fired).
  - `onBackpressure(info)`: accepted but never called (deprecated), because the outbound queue is unbounded.

**Domain events.** The domain-event module scopes feeds by session and domain:
- `createRemoteDomainEvents(domains, connector, options?)` builds a multi-domain feed over any `DomainEventConnector`.
- `forSession(...)` / `forSessionRuntime(...)` scope a feed to a single session.
- `SerializedEventEnvelope` is the wire-envelope type delivered by connectors.

**Outbound queue (WebSocket).** Messages queued while the socket is reconnecting or not yet authenticated are held in order in an unbounded queue and flushed once the daemon accepts the authentication. Nothing is dropped or rejected, and no backpressure signal is raised, so a client that sends during a long disconnect should bound what it sends.

**Insecure-transport guard.** The WebSocket connector follows the same rule as the HTTP transport: a plain `ws://` (or `http://`) URL is accepted for loopback (`localhost`, `127.0.0.0/8`, `[::1]`), private-network (10/8, 172.16/12, 192.168/16) and `.local` hosts, and refused for any other host with a `ConfigurationError`, unless the server-side `GOODVIBES_ALLOW_INSECURE_TRANSPORT=true` override is set. Use `wss://` (or `https://`, which is upgraded to `wss://`) for public hosts. The token is sent in clear text over `ws://`, as it is over `http://`.

**Connection ends.** When the daemon refuses the WebSocket authentication, the auth-token resolver has no token and reconnect is off or spent, or the socket cannot be created, the connection ends in `failed` and the feed forgets it: registering a listener again opens a new connection. A clean server close ends in `disconnected` the same way. The SSE feed does the same when its stream closes with reconnect off or spent.

**Turn lifecycle gate.** A client that opens a fresh stream (rather than resuming from `Last-Event-ID`), or whose WebSocket reconnects, can be replayed the tail of whatever turn was running before, including that turn's terminal event. Without protection, a previous turn's `TURN_COMPLETED` lands in the new consumer and prematurely finishes a turn it never started. Both the SSE and the WebSocket connector apply `createTurnLifecycleGate()` from `transport-realtime` to guard against this (`turnScope` in the connector options). It binds per session to whichever turn is seen to start (`TURN_SUBMITTED`) and then accepts only that turn's frames, silently dropping replayed terminal frames while unbound, and it does not let a turn it already saw complete start or complete again. A connection that never saw the previous turn cannot tell its replayed start frame from a live one, so pass an explicit `turnId` when the consumer already knows which turn it submitted.

**Lost-event notices.** Over SSE, a gateway `ready` frame saying it could not resume the stream position (`resume: 'unresolved'`, after a daemon restart or a position that aged out) and a relay `relay-overflow` notice (a slow consumer's event chunks were dropped) are reported through `onError` as recoverable protocol errors. The stored position is dropped so the next connection replays the daemon's recent events. Re-read current state when you see one: a turn's end may have been among the lost events.

## Telemetry APIs

Telemetry APIs live on the operator client:

```ts
// snapshot: returns { generatedAt, view, rawAccessible, version, service, capabilities, runtime, sessionMetrics, aggregates,
// recent: { events, errors, spans } }. `recent` holds one page of each list, newest entries, bounded by `limit` (default 20);
// use events, errors and traces for full paging.
// The filter input is an inline per-method shape (there is no exported TelemetrySnapshotOptions type):
// { limit?; since?; until?; domains?; types?; severity?; traceId?; sessionId?; turnId?; agentId?; taskId?; cursor?; view? }
const snapshot = await platformClient.operator.telemetry.snapshot({ since: Date.now() - 3_600_000 });
// errors: filter by severity ('debug' | 'error' | 'info' | 'warn'), domains, time range
// (since/until), and a cursor for pagination
const errors = await platformClient.operator.telemetry.errors({ severity: 'error' });
```

The same filter shape works across the sibling list methods. `platformClient.operator.telemetry.events(filter)` returns the raw runtime-event records, a superset of what `errors` returns, unfiltered by severity. `platformClient.operator.telemetry.traces(filter)` returns OTel-shaped spans, and `platformClient.operator.telemetry.metrics(filter)` returns an aggregate metrics snapshot. `platformClient.operator.telemetry.stream(handlers, filter)` opens a live server-sent stream of telemetry records, for consumers that want a push feed instead of polling `snapshot`. It returns a promise that resolves to the unsubscribe function, so `await` it: `const stop = await platformClient.operator.telemetry.stream(handlers, filter);`.

Every telemetry read needs the `read:telemetry` scope (or an admin session). `view: 'raw'` additionally needs the `read:telemetry-sensitive` scope or an admin session, and the daemon setting `telemetry.includeRawPrompts` turned on; without them it answers `403`.

## OTLP exports

The operator platform exposes the OTLP-shaped daemon endpoints:

```ts
await platformClient.operator.telemetry.otlp.traces();
await platformClient.operator.telemetry.otlp.logs();
await platformClient.operator.telemetry.otlp.metrics();
```

The OTLP `GET` endpoints return JSON-encoded OTLP responses (`application/json` with OTLP export response shape). Binary protobuf encoding is not used for these exports.

### Ingest

The same paths, `/api/v1/telemetry/otlp/v1/{traces,logs,metrics}`, also accept `POST`, so an OpenTelemetry exporter can send to the daemon:

- Content types: `application/json`, or `application/x-protobuf` (also `application/protobuf`). Any other type answers `415`.
- Scope: `ingest:telemetry` or `write:telemetry`, or an admin session.
- Size: a body over 4 MiB answers `413`. A body that is not valid JSON or protobuf answers `400`.
- Response: `200` with an OTLP `partialSuccess` object.
- When the daemon has no ingest sink wired, the request answers `503` `TELEMETRY_UNAVAILABLE` and nothing is accepted. Authentication is checked first, then availability, then the body.

The operator client has no method for ingest; point the exporter at the daemon directly.

## Recommended use

- use HTTP operator APIs to load initial snapshots
- use realtime events to keep the UI current
- use telemetry endpoints for historical views, diagnostics, and filtered error/event exploration
- use OTLP endpoints when you are exporting platform telemetry into another observability tool
