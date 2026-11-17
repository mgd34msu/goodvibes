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

- `createEventSourceConnector(baseUrl, token, fetch, options?)`: SSE connector. Carries every subscribed domain on one stream (`?domains=a,b,c`); a changed set reopens it from the last event id. Supports `Last-Event-ID` stream resume, reconnect (via the stream reconnect policy), and dynamic auth-token resolution on reconnect.
- `createWebSocketConnector(baseUrl, token, WebSocket, options?)`: WebSocket connector. Carries every subscribed domain on one socket; a domain added or dropped later is a `subscribe` or `unsubscribe` frame on it. The connection-lifecycle hooks below are passed via the `options` object. Adds connection-lifecycle hooks that the SSE connector does **not** fire:
  - `onConnectionStateChange(state)` where `state` is `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'`. `'connected'` comes when the daemon accepts the credential, so a stale token reads `connecting` then `failed`.
  - `onReconnectAttempt(info)` with `{ attempt, maxAttempts, delayMs, reason }` (the legacy `onReconnect(attempt, delayMs)` is deprecated but still fired).
  - `onBackpressure(info)`: a message was dropped because the outbound queue was full (see below).

**Domain events.** The domain-event module scopes feeds by session and domain:
- `createRemoteDomainEvents(domains, connector, options?)` builds a multi-domain feed over any `DomainEventConnector`.
- `forSession(...)` / `forSessionRuntime(...)` scope a feed to a single session.
- `SerializedEventEnvelope` is the wire-envelope type delivered by connectors.

**Outbound queue (WebSocket).** Messages queued while the socket is reconnecting or not yet authenticated are held in order and flushed once the daemon accepts the authentication, up to `maxQueuedMessages` (default 1024) and `maxQueuedBytes` (default 8 MiB). A message that does not fit is dropped and reported through `onBackpressure`, a `TRANSPORT_BACKPRESSURE` event and, for the first drop, `onError` (`WS_QUEUE_OVERFLOW`, or `WS_FRAME_TOO_LARGE` for one message over the byte limit). When the connection ends, what it held is dropped and its sender refuses new messages.

**Insecure-transport guard.** The WebSocket connector follows the same rule as the HTTP transport: a plain `ws://` (or `http://`) URL is accepted for loopback (`localhost`, `127.0.0.0/8`, `[::1]`), private-network (10/8, 172.16/12, 192.168/16) and `.local` hosts, and refused for any other host with a `ConfigurationError`, unless the server-side `GOODVIBES_ALLOW_INSECURE_TRANSPORT=true` override is set. Use `wss://` (or `https://`, which is upgraded to `wss://`) for public hosts. The token is sent in clear text over `ws://`, as it is over `http://`.

**Connection ends.** When the daemon refuses the WebSocket authentication, the auth-token resolver has no token and reconnect is off or spent, or the socket cannot be created, the connection ends in `failed` and the feed forgets it: registering a listener again opens a new connection. A clean server close ends in `disconnected` the same way. The SSE feed does the same when its stream closes with reconnect off or spent.

**Turn lifecycle gate.** A client that opens a fresh stream (rather than resuming from `Last-Event-ID`), or whose WebSocket reconnects, can be replayed the tail of whatever turn was running before, including that turn's terminal event. Without protection, a previous turn's `TURN_COMPLETED` lands in the new consumer and prematurely finishes a turn it never started. Both the SSE and the WebSocket connector apply `createTurnLifecycleGate()` from `transport-realtime` to guard against this (`turnScope` in the connector options). It binds per session to whichever turn is seen to start (`TURN_SUBMITTED`) and then accepts only that turn's frames while it runs, silently dropping another turn's replayed terminal frames while unbound or after the bound turn ended, and it does not let a turn it already saw complete start or complete again. Once the bound turn has ended, a non-terminal frame of a new turn binds even if that turn's `TURN_SUBMITTED` was lost, so the running turn still appears and finishes. A connection that never saw the previous turn cannot tell its replayed start frame from a live one, so pass an explicit `turnId` when the consumer already knows which turn it submitted.

**Stream deltas on the wire.** A live `STREAM_DELTA` carries `accumulated` (the turn's text so far) only at a resync point: the first delta a connection receives for a turn, a restart of the text (a retried or redrafted request streams again from empty), after the daemon dropped frames for a slow SSE consumer, and once the text has about doubled since the last frame that carried it (at least 4 KiB more). Every other delta carries only its new `content`, so the bytes sent grow with the answer's length, not its square. Replayed deltas always carry `accumulated`. Both connectors and the scoped browser client fill `accumulated` back in before a listener sees the event, so `e.payload.accumulated` is always the text so far. A client that reads the raw stream itself keeps one `createStreamTextAssembler()` (from `transport-core`) per connection and passes every `turn` payload through `complete()`.

**Lost-event notices.** Over SSE, the daemon's `gap` notice (it dropped events for a slow consumer) and the relay's `relay-overflow` notice (its send buffer for this client overflowed) make the connector reopen the stream from its last event id, and the daemon replays the dropped events: nothing is reported. When that cannot work (no position yet, or the replay itself overflowed), and when a gateway `ready` frame says it could not resume the stream position (`resume: 'unresolved'`, after a daemon restart or a position that aged out), the connector reports a recoverable protocol error through `onError`, drops the stored position so the next connection replays the daemon's recent events, and unbinds the turn gate. Re-read current state when you see one: a turn's end may have been among the lost events.

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

The default `safe` view withholds content: prompts, streamed text, tool arguments and output, and message bodies read `[REDACTED_TEXT]`, and credential or owner-profile fields read `[REDACTED]` / `[REDACTED_PROFILE]`. Everything needed to see what happened and why stays readable: the tool, provider and model, ids, statuses, counts, durations, span names, and error text with credential-shaped parts masked. The `raw` view carries everything.

Streamed chunks (`STREAM_DELTA`, `AGENT_STREAM_DELTA`) are counted in `aggregates.byEventType` but not kept in the event history or sent on the stream, so the history (500 records) covers what happened rather than the last answer's chunks.

`traces` lists the spans this process records when `telemetry.otelMode` is `in-process` or `remote-export` (turns, tool calls, model requests, agents, tasks, plugins, MCP servers, permission checks, sessions, compaction): the same spans a collector receives. With `otelMode: off` no spans are recorded and the list holds only spans posted to the OTLP traces receiver. For `remote-export`, the collector's address comes from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) and its request headers from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (or `OTEL_EXPORTER_OTLP_HEADERS`, `key=value,key=value`).

A stream reconnect sends `Last-Event-ID` and receives the records after it (up to `limit`, default 100) before going live. Its `ready` event says `resumedFrom` when the id was still held; `gap: true` when it was not (the stream resumes from the oldest record held, and some records may be missing); `truncated: true` when more than `limit` were missed. Stream handlers may also take `onError`, `onReconnect` and `onTerminate`; `onTerminate` means no more records will arrive.

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
- Traces become spans in the `traces` list. Each log record becomes an event record with the log's severity (from `severityNumber`, else `severityText`), time and body as its message; an error log is also in the `errors` list. Metrics: the latest posting of each metric (by name) is served by `GET /api/v1/telemetry/otlp/v1/metrics` under the `otlp-ingest` scope, beside the daemon's own.
- When the daemon has no ingest sink wired, the request answers `503` `TELEMETRY_UNAVAILABLE` and nothing is accepted. Authentication is checked first, then availability, then the body.

The operator client has no method for ingest; point the exporter at the daemon directly.

## Recommended use

- use HTTP operator APIs to load initial snapshots
- use realtime events to keep the UI current
- use telemetry endpoints for historical views, diagnostics, and filtered error/event exploration
- use OTLP endpoints when you are exporting platform telemetry into another observability tool
