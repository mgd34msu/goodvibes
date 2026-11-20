# Retries and reconnect

This applies to both full-surface (Bun) and companion-surface (Hermes/browser) consumers unless otherwise noted.

The platform exposes retry and reconnect as first-class configuration instead of leaving them to ad hoc wrapper code.

## HTTP retry

All runtime-specific entrypoints can take a retry policy:

```ts
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 2_500,
  },
});
```

Use retry for:
- safe/idempotent reads
- transient network failures
- rate-limited or temporarily degraded platform calls

Avoid retrying unsafe mutations blindly unless your application has idempotency guarantees.

## SSE reconnect

SSE reconnect is controlled through `realtime.sseReconnect`:

```ts
const platformClient = createBrowserGoodVibesPlatform({
  realtime: {
    sseReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

Runtime-event feeds (the `platform.events` domains, over SSE or WebSocket) reconnect on their own: reconnect is on unless you set `enabled: false`, and there is no attempt limit unless you set `maxAttempts`. The delay grows from `baseDelayMs` to `maxDelayMs` and then stays there, so a daemon that restarts, updates or sleeps is picked up again whenever it comes back, for as long as the feed has listeners. Removing the last listener is how a client stops. Only an answer no retry can change ends the feed: a refused or revoked credential (401, 403) or another final status. Sign in again and register a listener to reopen it.

The platform preserves `Last-Event-ID` and sends it on reconnect so the server can replay missed events when supported.

A stream whose path dies without a reset (a laptop that slept, a phone that changed networks, a proxy that dropped an idle mapping) is noticed by its silence: the daemon sends a `heartbeat` frame on open and every 15 seconds, and a stream that has sent one and then stays silent for 35 seconds (two intervals plus slack, the same deadline the daemon's own idle timeout uses) is dropped and reconnected from its last event id. Set `idleTimeoutMs` on a raw stream to change the deadline, or `0` to turn it off; a server that never sends a heartbeat is never cut off.

The delay restarts from `baseDelayMs` once a connection delivers a real event: the `ready` greeting does not count. When a reconnect is refused with a `Retry-After` (429, 503), the next attempt waits at least that long, capped at 10 minutes.

## WebSocket reconnect

WebSocket reconnect is controlled through `realtime.webSocketReconnect`. The delay restarts from `baseDelayMs` only after a socket stayed authenticated for 30 seconds, the same window as the SSE stream: a daemon or proxy that accepts the auth frame and then cuts the socket keeps the backoff growing instead of reconnecting every 500 ms.

```ts
const platformClient = createReactNativeGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  realtime: {
    webSocketReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```


## Idempotency keys

A call is retried when one rule holds: the call is marked idempotent, whatever its verb, **or** it is a safe verb listed in `retryOnMethods` (default `GET`, `HEAD`, `OPTIONS`); and the failure is retryable (a status in `retryOnStatuses`: 408, 429, 500, 502, 503, 504, 529, or a connection failure with no response) and attempts remain. A reply whose body says `recoverable: false`, or whose category is `billing`, is never retried, whatever its status.

The operator client marks a method idempotent from the contract: a method the contract marks `idempotent: true`, a method whose replay key is the `Idempotency-Key` header (`contracts.start`), or a method whose replay key is a body field every call must carry. A mutating idempotent call gets one `Idempotency-Key`, generated once and sent on every attempt, so the daemon recognises a repeat. When neither the transport nor the call sets `maxAttempts`, an idempotent call gets 3 attempts (`DEFAULT_IDEMPOTENT_MAX_ATTEMPTS`), so a lost response or a transient 503 does not fail it and does not start the work twice. Safe methods are retried once you raise `maxAttempts`.

`perMethodPolicy` entries tune how a call is retried (attempts and delays per method id). An entry whose `maxAttempts` is above 1 also marks that method idempotent: you state that the server recognises a repeat, so a mutating call to it is retried and carries one generated `Idempotency-Key` on every attempt. Give a method more than one attempt only when its server deduplicates by that key or by a replay field.

To keep your own key across calls (a dispatcher that may send the same work again later), pass it as the `idempotencyKey` call option; a caller-set `Idempotency-Key` header also wins over a generated one.

The daemon acts on the header for `POST /api/contracts` (`contracts.start`): a repeat with the same key from the same caller returns the first contract (header `Idempotent-Replayed: true`) instead of starting another, the same key with a different request is refused with 409 `IDEMPOTENCY_KEY_REUSED`, and a start that failed is not remembered so it can be retried. The daemon keeps keys in memory (up to 1000), so a retry that crosses a daemon restart starts a new contract. Other methods that replay safely do so on a field of the request body; the operator OpenAPI marks each with `x-replay-key` and names the field. Retrying any other mutation could repeat its side effect (a second session, a second message) when the first response was lost after the daemon acted, so a mutation that is not marked idempotent is never retried, even with its verb in `retryOnMethods`.

## Token rotation

If a long-lived client can rotate tokens, prefer `tokenStore` or `getAuthToken` over a static `authToken`. Both let reconnects resolve a fresh credential instead of replaying whatever token the client started up with.

## Default behavior

- **HTTP retry of safe methods is off.** `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` is `1` (one attempt, no retries). When you raise it, safe methods are retried (`retryOnMethods: ['GET', 'HEAD', 'OPTIONS']`) and `retryOnNetworkError` is `true`; default delays are `baseDelayMs: 250`, `maxDelayMs: 2000`, `backoffFactor: 2`. A server-sent `Retry-After` header on a retryable response raises the computed delay to at least that value, but the result is still capped at 10 minutes so a hostile or misconfigured server cannot park a client indefinitely.
- **Idempotent calls are retried.** A call marked idempotent gets 3 attempts unless `maxAttempts` is set (see above).
- **Runtime-event feeds reconnect.** The SSE and WebSocket runtime-event connectors reconnect unless `enabled: false` is set, with no attempt limit (`DEFAULT_STREAM_MAX_ATTEMPTS` and `DEFAULT_WS_MAX_ATTEMPTS` are unlimited), `baseDelayMs: 500` and `maxDelayMs: 30000`. A refused credential ends them at once. A raw stream opened directly with `openRawServerSentEventStream` reconnects only when you pass `reconnect: { enabled: true }`. Its subscriber must handle three things: `onEvent({ name, payload })`, `onGap({ dropped, afterId })` when the daemon dropped frames for a slow reader (resync from a snapshot, or reopen from the last event id), and `onEnd(end)` once when the stream ends: `closed` (you closed it), `source-ended` (`complete: false` with `dropped` when a relay lost chunks no reconnect fetched again) or `failed` with a `refusal` (`refusal.retryable` false when no reconnect can clear it). A response that is not `text/event-stream` is never opened: the open fails, and a reconnect that gets one ends the stream as `failed`. Only frames other than `ready` and `heartbeat` (`STREAM_CONTROL_FRAMES`) reset the reconnect budget, so a server that greets and drops runs out of attempts.

## Recommended defaults

| Surface | Recommendation |
|---|---|
| Bun full-surface service | Retry reads, SSE reconnect enabled |
| Browser web UI | Retry reads, SSE reconnect enabled |
| React Native / Expo | Retry reads, WebSocket reconnect enabled |

## Next reads

- [Transports](./transports.md)
- [Performance and tuning](./performance.md)
- [Observability](./observability.md)
