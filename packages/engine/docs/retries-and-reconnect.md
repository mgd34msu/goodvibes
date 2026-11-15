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

The platform preserves `Last-Event-ID` and sends it on reconnect so the server can replay missed events when supported.

The retry budget refills only after a connection delivers a real event: the `ready` greeting does not count, so a stream the daemon greets and drops at once still runs out of attempts. When a reconnect is refused with a `Retry-After` (429, 503), the next attempt waits at least that long, capped at 10 minutes.

## WebSocket reconnect

WebSocket reconnect is controlled through `realtime.webSocketReconnect`:

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

For non-GET mutations, the platform injects an `Idempotency-Key` header when the call has a `perMethodPolicy` entry or the contract marks the route `idempotent: true`. The same UUID is sent on every attempt of one call.

**The header is advisory, except on `POST /api/contracts` (`contracts.start`), the one route where the daemon reads it (see below). Everywhere else it does not deduplicate retried requests.** Otherwise only the methods that carry a replay key in their request body deduplicate: sending the same body key again returns the original result instead of repeating the work. The operator OpenAPI marks each such method with `x-replay-key` and names the field. Retrying any other mutation can repeat its side effect (a second session, a second message) when the first response was lost after the daemon acted.

**When a mutation is retried (all must hold):**

1. The call has a `perMethodPolicy[methodId]` entry, or the contract marks the route `idempotent: true`. No method in the current catalog sets `idempotent: true`, so in practice this means a `perMethodPolicy` entry.
2. The verb is listed in `retryOnMethods`. The default is `['GET', 'HEAD', 'OPTIONS']`, so add the mutation verb (for example `'POST'`) or the call fails on its first error.
3. The attempt budget allows it (`maxAttempts` above 1) and the failure is retryable: a status in `retryOnStatuses` (408, 429, 500, 502, 503, 504, 529), or a connection failure with no response.

Safe methods (`GET`, `HEAD`, `OPTIONS`) are retried by default once `maxAttempts` is raised. A reply whose body says `recoverable: false`, or whose category is `billing`, is never retried, whatever its status.

There is no per-call `idempotencyKey` request option. The per-call options accepted by the transport layer (`ContractInvokeOptions`) are `signal`, `headers`, and `responseSchema` only. The `Idempotency-Key` is generated internally (`generateIdempotencyKey`) and is attached only when the resolved method is a mutation (POST/PUT/PATCH/DELETE) **and** either the contract marks the route `idempotent: true` or a `perMethodPolicy` entry exists for that method ID.

The daemon acts on the key for `POST /api/contracts` (`contracts.start`): a repeat with the same key from the same caller returns the first contract (header `Idempotent-Replayed: true`) instead of starting another, the same key with a different request is refused with 409 `IDEMPOTENCY_KEY_REUSED`, and a start that failed is not remembered so it can be retried. The daemon keeps keys in memory (up to 1000), so a retry that crosses a daemon restart starts a new contract.

To retry a mutation that has a body replay key (or `contracts.start`, which honours the header), register a `perMethodPolicy` entry for its method ID and add its verb to `retryOnMethods`, and send the same replay key value on every attempt. For a mutation without one, do not enable retries: the daemon cannot tell a repeat from a new request.

Never retry unsafe mutations blindly. Only operations whose repeat is harmless, because the body replay key deduplicates it or because the operation is naturally idempotent, are safe to retry.

## Token rotation

If a long-lived client can rotate tokens, prefer `tokenStore` or `getAuthToken` over a static `authToken`. Both let reconnects resolve a fresh credential instead of replaying whatever token the client started up with.

## Default behavior

Out of the box the platform is conservative. Retries and reconnect are **off** by default and must be opted into:

- **HTTP retry is off.** `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` is `1` (one attempt, no retries). When you enable retries, only safe methods are retried by default (`retryOnMethods: ['GET', 'HEAD', 'OPTIONS']`) and `retryOnNetworkError` is `true`; default delays are `baseDelayMs: 250`, `maxDelayMs: 2000`, `backoffFactor: 2`. A server-sent `Retry-After` header on a retryable response raises the computed delay to at least that value, but the result is still capped at 10 minutes so a hostile or misconfigured server cannot park a client indefinitely.
- **Stream / SSE reconnect is off.** `DEFAULT_STREAM_RECONNECT_POLICY.enabled` is `false`. When enabled, `maxAttempts` defaults to `10` (`DEFAULT_STREAM_MAX_ATTEMPTS`), with `baseDelayMs: 500` and `maxDelayMs: 30000`.
- **WebSocket reconnect** likewise defaults to a finite `maxAttempts` of `10` (`DEFAULT_WS_MAX_ATTEMPTS`) when enabled, to prevent infinite auth-failure loops.

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
