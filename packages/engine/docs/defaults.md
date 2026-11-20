# Network defaults reference

This document records every timeout, retry, and backoff default in the platform.
All values are in milliseconds unless stated otherwise.

## HTTP transport (`@goodvibes/engine/platform/transport-http`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` | 1 | Single attempt (no retry) by default; callers opt-in via `retry.maxAttempts` |
| `DEFAULT_HTTP_RETRY_POLICY.baseDelayMs` | 250 | Base delay between retry attempts |
| `DEFAULT_HTTP_RETRY_POLICY.maxDelayMs` | 2 000 | Backoff cap per retry |
| `DEFAULT_HTTP_RETRY_POLICY.backoffFactor` | 2 | Exponential multiplier |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses` | `[408, 429, 500, 502, 503, 504]` | HTTP statuses eligible for retry |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnMethods` | `['GET', 'HEAD', 'OPTIONS']` | Safe methods only |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnNetworkError` | `true` | Network-level failures are retried |
| Request timeout | None (platform fetch default) | Use `AbortSignal` with timeout on the call site |

**Rationale:** Single-attempt default keeps latency predictable for interactive workloads. Callers
increase `maxAttempts` for batch/background operations.

## SSE stream reconnect (`@goodvibes/engine/platform/transport-http`, `reconnect.ts`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_STREAM_RECONNECT_POLICY.enabled` | `false` | Off for a raw stream opened directly; the runtime-event connectors turn it on unless told not to |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxAttempts` | unlimited | `DEFAULT_STREAM_MAX_ATTEMPTS`; set `maxAttempts` for a limit |
| `DEFAULT_STREAM_RECONNECT_POLICY.baseDelayMs` | 500 | Initial reconnect delay |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxDelayMs` | 30 000 | Hard backoff cap (30 s) |
| `DEFAULT_STREAM_RECONNECT_POLICY.backoffFactor` | 2 | Exponential multiplier |

**Rationale:** the daemon is a long-lived local service that comes back after a
restart or a sleep, so a stream keeps trying; `maxDelayMs: 30 000` caps the wait
between attempts to 30 seconds. A refused or revoked credential (401, 403) ends
the stream at once, so a persistent auth failure never loops; closing the stream
is how a caller gives up.

## Daemon batch processing

| Config key | Default | Notes |
|------|---------|-------|
| `batch.mode` | `off` | Provider Batch APIs are opt-in. |
| `batch.queueBackend` | `local` | The daemon stores jobs locally unless a client explicitly uses the Cloudflare Worker bridge. |
| `batch.tickIntervalMs` | `60 000` | Local daemon batch scheduler interval. |
| `batch.maxDelayMs` | `300 000` | Max queued-job wait before local submission on a scheduler tick. |
| `batch.maxJobsPerProviderBatch` | `100` | platform grouping limit before upstream provider-specific limits. |
| `batch.maxQueuePayloadBytes` | `16 384` | Cloudflare queue messages should be small signals, not full prompts. |
| `batch.maxQueueMessagesPerDay` | `1 000` | Free-tier-oriented client guardrail. |
| `cloudflare.enabled` | `false` | Cloudflare is optional and never required for daemon value. |
| `cloudflare.freeTierMode` | `true` | Prefer small queue signals and bounded daily usage. |
| `cloudflare.accountId` | empty string | Cloudflare account id used by platform-owned provisioning and by the `cloudflare-ai-gateway` provider (which falls back to `CLOUDFLARE_ACCOUNT_ID`). |
| `cloudflare.aiGatewayId` | empty string | Cloudflare AI Gateway id the `cloudflare-ai-gateway` provider sends through; empty falls back to `CLOUDFLARE_AI_GATEWAY_ID`. A change to either id rebuilds the provider at once. |
| `cloudflare.apiTokenRef` | empty string | Secret reference for the Cloudflare API token; empty falls back to `CLOUDFLARE_API_TOKEN`. |
| `cloudflare.zoneId` | empty string | Optional Cloudflare zone id used by DNS and Access automation. |
| `cloudflare.zoneName` | empty string | Optional Cloudflare zone name used during onboarding/discovery. |
| `cloudflare.workerName` | `goodvibes-batch-worker` | Worker script name managed by platform provisioning. |
| `cloudflare.workerSubdomain` | empty string | Account workers.dev subdomain used to infer the Worker URL. |
| `cloudflare.workerHostname` | empty string | Optional custom Worker hostname managed through DNS automation. |
| `cloudflare.workerBaseUrl` | empty string | Public Worker URL clients use for batch proxy/queue calls. |
| `cloudflare.daemonBaseUrl` | empty string | Daemon origin URL the Worker or Tunnel uses for Worker-to-daemon calls. |
| `cloudflare.daemonHostname` | empty string | Optional daemon hostname managed through Tunnel, DNS, and Access automation. |
| `cloudflare.workerTokenRef` | empty string | Secret reference for the Worker-to-daemon bearer token. |
| `cloudflare.workerClientTokenRef` | empty string | Secret reference for the client-to-Worker bearer token. |
| `cloudflare.workerCron` | `*/5 * * * *` | Worker cron trigger for batch scheduler ticks. |
| `cloudflare.queueName` | `goodvibes-batch` | Cloudflare Queue name for GoodVibes batch signals. |
| `cloudflare.deadLetterQueueName` | `goodvibes-batch-dlq` | Cloudflare DLQ name for exhausted batch signal retries. |
| `cloudflare.tunnelName` | `goodvibes-daemon` | Zero Trust Tunnel name managed by optional provisioning. |
| `cloudflare.tunnelId` | empty string | Zero Trust Tunnel id selected or created by provisioning. |
| `cloudflare.tunnelTokenRef` | empty string | Secret reference for the cloudflared Tunnel token. |
| `cloudflare.accessAppId` | empty string | Zero Trust Access application id for the daemon hostname. |
| `cloudflare.accessServiceTokenId` | empty string | Zero Trust Access service token id. |
| `cloudflare.accessServiceTokenRef` | empty string | Secret reference for Access service-token client id/secret JSON. |
| `cloudflare.kvNamespaceName` | `goodvibes-runtime` | Optional KV namespace name for edge runtime state. |
| `cloudflare.kvNamespaceId` | empty string | KV namespace id bound to the Worker as `GOODVIBES_KV`. |
| `cloudflare.durableObjectNamespaceName` | `GoodVibesCoordinator` | Durable Object class/namespace name for edge coordination. |
| `cloudflare.durableObjectNamespaceId` | empty string | Durable Object namespace id discovered after Worker migration. |
| `cloudflare.r2BucketName` | `goodvibes-artifacts` | R2 Standard bucket name for optional artifacts. |
| `cloudflare.secretsStoreName` | `goodvibes` | Name of the Cloudflare Secrets Store that optional provisioning creates and manages. |
| `cloudflare.secretsStoreId` | empty string | Cloudflare Secrets Store id selected or created by provisioning. |
| `cloudflare.maxQueueOpsPerDay` | `10 000` | Free-tier-oriented queue operation budget. |

See [Daemon batch processing](./daemon-batch-processing.md) for provider support, routes, and Worker bridge behavior.

## Artifact storage

| Config key | Default | Notes |
|------|---------|-------|
| `storage.artifacts.maxBytes` | `536 870 912` | Maximum stored artifact size for JSON path/URI acquisition, direct multipart upload, and raw binary upload. |

The default is `512 MiB`. JSON control bodies remain intentionally small; send
large content through multipart or raw binary upload routes.

## Home Assistant surface

| Config key | Default | Notes |
|------|---------|-------|
| `surfaces.homeassistant.remoteSessionTtlMs` | `1 200 000` | Home Assistant remote conversation sessions close after 20 minutes of inactivity. |

See [Home Assistant integration](./homeassistant-integration.md) for the Assist conversation route and event delivery contract.

## OpenAI-compatible daemon ingress

| Config key | Default | Notes |
|------|---------|-------|
| `controlPlane.openaiCompatible.enabled` | `true` | Exposes authenticated `/v1/models` and `/v1/chat/completions` OpenAI-style routes on the daemon. |
| `controlPlane.openaiCompatible.pathPrefix` | `/v1` | Path prefix used by OpenAI-compatible clients as their base URL suffix. |

See [Runtime orchestration](./runtime-orchestration.md#openai-compatible-ingress) for the contract and scope.

## Web UI bundle serving and cross-origin access

Both capabilities default off; the daemon stays loopback-only until you opt in explicitly.

| Config key | Default | Notes |
|------|---------|-------|
| `controlPlane.webui.serve` | `false` | Serve a built web UI bundle same-origin from the daemon at `/`. The bundle is public; the app token-authenticates its own API calls. This flag is the only on/off switch; neither directory key below turns serving on by itself. |
| `controlPlane.webui.bundleDir` | `''` | Directory holding the built bundle (`index.html` + assets). Wins whenever it names a directory. When empty, serving falls back to `web.staticAssetsDir`. |
| `web.staticAssetsDir` | `dist/web` | The web surface's own assets directory, used when `controlPlane.webui.bundleDir` is empty. Ships with the build's conventional output path, so a host that lays the bundle down where the build puts it only needs to flip `controlPlane.webui.serve`. |
| `controlPlane.cors.enabled` | `false` | Answer OPTIONS preflight and emit `Access-Control-Allow-*` for allowlisted origins. Never wildcards; credentials are allowlist-gated. |
| `controlPlane.cors.allowedOrigins` | `''` | Comma-separated explicit origin allowlist (e.g. `http://localhost:5173`). Empty refuses every cross-origin request. |

See [Web UI Integration → Deployment topology](./web-ui-integration.md#deployment-topology-same-origin-vs-cross-origin).

## Spoken output and TTS

| Config key | Default | Notes |
|------|---------|-------|
| `tts.provider` | `elevenlabs` | Default streaming TTS provider when a request omits `providerId`. |
| `tts.voice` | empty string | Default voice id when a request omits `voiceId`; providers may still apply their own fallback. |
| `tts.llmProvider` | empty string | Reserved optional spoken-output LLM provider override; empty means use the active chat provider. |
| `tts.llmModel` | empty string | Reserved optional spoken-output LLM model override; empty means use the active chat model. |

See [Voice and streaming TTS](./voice.md) for the provider-agnostic streaming route and TUI integration contract.

## WebSocket reconnect (`@goodvibes/engine/platform/transport-realtime`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_WS_MAX_ATTEMPTS` | unlimited | Shared constant in `@goodvibes/engine/platform/transport-realtime`; passed to `normalizeStreamReconnectPolicy`. A refused or revoked credential ends the connection at once |
| `reconnect.baseDelayMs` | 500 (inherited from SSE policy) | |
| `reconnect.maxDelayMs` | 30 000 (inherited from SSE policy) | |
| `reconnect.backoffFactor` | 2 | |

**Rationale:** Matches SSE for a symmetric schedule. Finite cap prevents infinite auth-failure loops.

## Auth (`@goodvibes/engine/platform/auth`)

| Path | Timeout | Max Retries | Notes |
|------|---------|-------------|-------|
| `SessionManager.login` / `current` | None explicit | Delegates to HTTP transport | HTTP retry policy applies |
| `TokenStore.getToken / setToken / clearToken` | None | N/A | Synchronous-ish; no network I/O |

**Rationale:** Auth calls go through the HTTP transport layer which applies `DEFAULT_HTTP_RETRY_POLICY`.
There is no separate auth-specific timeout; callers should pass an `AbortSignal` for bounded waits.

## Session auth (`@goodvibes/engine/platform/daemon`, daemon embedders)

| Constant | Default | Notes |
|----------|---------|-------|
| `DEFAULT_SESSION_TTL_MS` | `3 600 000` (1 hour) | Session tokens expire after 1 hour of creation; expired sessions are rejected and pruned on access |

**Source:** `packages/engine/platform/src/platform/security/user-auth.ts`. Not a public configurable and not a daemon config key. A daemon embedding can override it only by passing `sessionTtlMs` when constructing the user-auth manager.

## Rate limits (daemon built-in)

| Limiter | Default | Notes |
|---------|---------|-------|
| General rate limiter | 60 requests / minute / IP | Applied to all routes except login; configurable via `rateLimit` daemon option |
| Login rate limiter | 5 requests / minute / IP | Applied to `POST /login` only; configurable via `loginRateLimit` daemon option |

## Outbound producer queue (`@goodvibes/engine/platform/transport-realtime`, `runtime-events.ts`)

The WebSocket connector's outbound queue holds up to 1024 messages and 8 MiB (`maxQueuedMessages`, `maxQueuedBytes`). Messages sent while the socket is connecting, reconnecting or still authenticating are held in order and flushed when the socket is ready; one that does not fit, or is alone over 8 MiB, is dropped and reported through `onBackpressure`, a `TRANSPORT_BACKPRESSURE` event and `onError`. Inbound runtime-event frames arrive in chunks of at most 64 KiB; a reassembled message is capped at 64M characters (a longer one is refused and the partial message dropped), and sending a message over that cap throws.
