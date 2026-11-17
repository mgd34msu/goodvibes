# Performance and tuning

> **Surface scope:** This document covers performance tuning for the **full surface (Bun runtime)**. Code examples use `createGoodVibesPlatform` from the full-surface entry point. Companion-surface consumers (React Native, browser) use surface-specific constructors. See [Published surface matrix](./surfaces.md) for the full breakdown.

This guide covers the tuning knobs, runtime contracts, and internal subsystems that govern platform performance across provider calls, context management, component rendering, and tool execution.

## Provider optimization

### Retry strategy

The platform uses deterministic exponential backoff (no jitter) for all retryable HTTP failures. The top-level `retry` config is an `HttpRetryPolicy` resolved by the transport-http retry layer (`resolveHttpRetryPolicy`) and applied via `computeBackoffDelay` in the HTTP transport loop; it is not handled by the `platform/utils` `withRetry` helper, which has a different config shape and is not wired to this config.

```ts
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    maxAttempts: 4,       // 1 initial attempt + 3 retries
    baseDelayMs: 250,     // starting delay before first retry
    maxDelayMs: 2_500,    // ceiling regardless of attempt count
  },
});
```

Delay for a one-based attempt `n` is: `min(baseDelayMs * backoffFactor^(attempt-1), maxDelayMs)`. So attempt 1 waits `baseDelayMs`, attempt 2 applies one backoff factor, and so on. `backoffFactor` defaults to `2` and is configurable. There is no jitter. When a server sends a `Retry-After` header on a retryable response, it raises the computed delay to at least that value, but the result is still capped at 10 minutes so a hostile or misconfigured server cannot park a client indefinitely.

Retries are only triggered for retryable errors. In the transport-http retry loop an error is retryable when:
- Its HTTP status is in `RETRYABLE_STATUS_CODES` (408, 429, 500, 502, 503, 504, 529) and the call may be repeated: it is marked `idempotent` in the contract (the daemon recognises a repeat by its idempotency key or replay field), whatever its verb, or it is a safe verb listed in `retryOnMethods` (default `GET`, `HEAD`, `OPTIONS`). A mutation that is not marked idempotent is never retried, even with its verb in `retryOnMethods`; `perMethodPolicy` only tunes attempts and delays. A reply whose body says `recoverable: false`, or whose category is `billing`, is not retried; or
- It is a network-level failure (status `0`) surfaced as a `GoodVibesError` with `recoverable: true` (the transport flags every connection failure recoverable except a deliberate abort), on a call that may be repeated by the same rule.

Never retry unsafe mutations blindly. Only idempotent reads and operations with application-level idempotency guarantees are safe to retry.

### Adaptive execution planner

The `AdaptivePlanner` selects an execution strategy each turn based on risk, latency budget, and task shape. It supports five strategies. `single` makes one LLM call with no parallelism. `cohort` fans out to a coordinated agent group. `background` defers the work to an async task. `remote` delegates to a remote provider or agent endpoint. `auto` is never a result of a settled selection; it is the mode that asks the planner to choose, and it appears on a decision only when the choice was held.

`select` resolves in this order:

1. An active user override (`planner.override(...)`) is returned as the selected strategy, reason `OVERRIDE_IN_EFFECT`.
2. A pinned mode other than `auto` (`planner.setMode(...)`) is returned, reason `PINNED_MODE`.
3. In Classic operation (decision models off) the result is `single`, reason `CLASSIC_SINGLE`. No reading is taken.
4. Otherwise a Jev reading chooses from the actual task, its risk, latency budget and the available capabilities. A settled reading returns that strategy with reason `JUDGMENT_SELECTED`, plus the reading's `outcome` and `decisionId`. A `remote` or `background` choice whose capability is not available counts as unsettled.
5. If the reading does not settle, `select` records a decision with `selected: 'auto'` and reason `JUDGMENT_UNSETTLED` in the audit log and then throws `PlannerJudgmentError` (`reason` is `unsettled` or `unavailable-strategy`). No strategy is guessed and no work starts; the owner decides, for example by pinning a mode or setting an override. Callers must handle this error.

Each decision lists its `candidates` with a 0-100 weight taken from the reading's probabilities. These weights describe the reading; they are not a score table the planner applies.

```ts
import { AdaptivePlanner, PlannerJudgmentError } from '@goodvibes-jev/engine/platform/platform/core';

const planner = new AdaptivePlanner();

try {
  const decision = await planner.select({
    riskScore: 0.3,         // supply the normalized risk reading, not a hand-selected score
    latencyBudgetMs: Infinity,
    isMultiStep: true,
    taskDescription: 'Refactor auth module',
    remoteAvailable: false,
    backgroundEligible: false,
  });
  console.log(decision.selected);    // a strategy the reading settled on, or 'single' in Classic operation
  console.log(decision.reasonCode);  // 'JUDGMENT_SELECTED' or 'CLASSIC_SINGLE'
  console.log(decision.decisionId);  // set when a reading was taken
} catch (error) {
  if (!(error instanceof PlannerJudgmentError)) throw error;
  // The reading held: nothing was selected. error.reason says why.
}
```

The planner keeps a rolling audit log of the last 100 decisions (`MAX_HISTORY`). Use `planner.explain()` to see a human-readable breakdown of the most recent decision, or `planner.getHistory(limit = 20)` to retrieve the most recent decisions. The default `limit` is `20`. Pass a higher value (up to the 100-entry cap) to read further back.

User overrides take absolute precedence over automatic scoring:

```ts
planner.override('single');   // force single-agent execution
planner.clearOverride();      // return to automatic selection
```

### Circuit breaker

`ConsecutiveErrorBreaker` guards against runaway error loops. It tracks consecutive all-failed turns and returns graduated signals:

```ts
import { ConsecutiveErrorBreaker } from '@goodvibes-jev/engine/platform/platform/core';

const breaker = new ConsecutiveErrorBreaker();

const result = breaker.recordAllFailed();
// 'ok'    - under warning threshold (< 5 consecutive)
// 'warn'  - approaching break threshold (>= 5)
// 'break' - at break threshold (>= 10)

breaker.recordSuccess(); // resets counter to 0
```

Default thresholds: warn at 5 consecutive failures, break at 10.

Every turn runs through the one turn loop (`runTurn`, `core/turn-loop.ts`):
the main session, sub-agents, contract units and the companion chat apply the
same rules. From the warning on, the model is told on its next request to
change its approach, and the person sees a notice. At the break the model gets
one final reply, with any tool call in it left unrun, to report what it was
trying to do. A sub-agent keeps that reply as its output and its run ends
failed with the `circuit_breaker` reason; the main session's turn ends with a
`tool_loop_circuit_breaker` error after the reply is shown.

Successful calls cannot loop forever either. When one call has run 8 times in
the turn's last 20 calls with the same arguments and the same result each
time, the turn stops the same way, one final reply and then failed, with the
`repeated_call` reason for a sub-agent and a message naming the tool. This is
decided from the turn's own call history; no model is asked. "The same result"
compares what the call returned (success, output, error), never the per-call
ids. From 3 identical calls whose runs all returned the same thing, a reading of
whether they are stuck may add a request to the model to review its history or
take a different action. Runs that returned different things (a poll, a test run
after an edit) are progress and are not read. The reading runs beside the next
request, never ahead of it, sees only that call's runs and is dropped after ten
seconds.

---

## Connection management

### SSE vs WebSocket

Choose based on runtime environment:

| Scenario | Recommendation |
|---|---|
| Bun service | SSE (`realtime.viaSse()`) |
| Browser dashboard | SSE (`realtime.viaSse()`) |
| React Native / Expo | WebSocket (`realtime.viaWebSocket()`) |
| Android / iOS native | WebSocket |

SSE is simpler (standard HTTP, firewall-friendly, works in all browser environments). WebSocket provides bidirectional communication and lower overhead for high-frequency event streams on mobile.

### SSE and WebSocket reconnect

The runtime-event feeds (SSE and WebSocket) reconnect unless
`realtime.sseReconnect` / `realtime.webSocketReconnect` sets `enabled: false`;
a raw stream opened directly reconnects only when asked. The underlying HTTP
retry policy is off by default (`maxAttempts: 1`). Reconnect attempts are
unlimited unless you set `maxAttempts` (`DEFAULT_STREAM_MAX_ATTEMPTS` /
`DEFAULT_WS_MAX_ATTEMPTS` are unlimited), using exponential backoff with the same
`baseDelayMs * backoffFactor^(attempt-1)` formula as HTTP retry, the delay capped
at 30 s. A refused or revoked credential ends the stream at once. On SSE reconnect the platform sends `Last-Event-ID` so the server can replay
missed events when supported.

For the configuration shapes, per-surface examples, and the full default table,
see [Retries and reconnect](./retries-and-reconnect.md).

### SSE backpressure

The control-plane gateway's SSE `ReadableStream` is constructed with a bounded `CountQueuingStrategy` to prevent slow subscribers from consuming unbounded memory:

```ts
new ReadableStream(..., new CountQueuingStrategy({ highWaterMark: 256 }));
```

When a subscriber falls behind, the stream stops queuing new chunks for it rather than buffering indefinitely: events that arrive while 256 chunks are already waiting are dropped for that subscriber only. Producers (the event bus) are not blocked and the connection stays open. Nothing is sent at the moment of the drop; the next frame that fits is preceded by a `gap` event (`{ dropped, afterId }`) giving the number of events missed and the id of the last event delivered before the gap. A client that sees `gap` should reconnect with `Last-Event-ID: <afterId>` (or refresh its state); the server replays what it still retains. The platform's SSE connector does this itself: it reopens the stream from its last event id and the dropped events arrive in the replay. Only when the position cannot be replayed does it report a recoverable error asking you to re-read current state. The gateway logs the first drop of each stream.

Startup events (initial snapshot, recent-event replay) are delivered before the `highWaterMark` gate engages in practice, but high-volume workloads should still prefer domain-filtered subscriptions to reduce the event rate per subscriber.

### WebSocket outbound-queue backpressure

The control-plane strategy above governs the **server → client** SSE stream. The
transport-realtime WebSocket connector applies separate **client → server**
outbound queue. Messages enqueued while the socket is connecting, reconnecting
or authenticating are held in order across reconnects and flushed when the
socket is ready, up to `maxQueuedMessages` (default 1024) and `maxQueuedBytes`
(default 8 MiB). A message that does not fit is dropped: `queue_full` when the
queue is at either limit, `message_too_large` when the message alone is over
the byte limit. The connector reports it through `onBackpressure(info)` and a
`TRANSPORT_BACKPRESSURE` event on the first drop since the queue drained and on
every tenth after, and through `onError` (`WS_QUEUE_OVERFLOW` or
`WS_FRAME_TOO_LARGE`) on the first. A connection that has ended drops what it
held and refuses new messages; the next connection hands over a new sender.

### Token rotation on long-lived connections

For long-lived clients where tokens expire, use `tokenStore` or `getAuthToken` instead of a static `authToken`. Reconnects automatically pick up the latest token:

```ts
import { createMemoryTokenStore } from '@goodvibes-jev/engine/platform/auth';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(), // refreshed externally via tokenStore.setToken()
});
```

---

## Token management

### Context window limits

The platform tracks token usage continuously against the active model's context window. Key constants:

| Constant | Value | Purpose |
|---|---|---|
| `COMPACTION_BUFFER_TOKENS` | 15,000 | Safety buffer kept free below the window ceiling |
| `SMALL_WINDOW_THRESHOLD` | 12,000 | Models with windows below this use simplified compaction |

Automatic compaction is controlled by `behavior.autoCompactThreshold`, a
percentage of the active context window. The default is `80`, meaning
compaction becomes eligible at 80% context usage. A remaining-token safety
buffer backstops the percentage threshold. `shouldAutoCompact` returns true
when the configured percentage is crossed **or** when remaining tokens fall
to or below the effective buffer.

The effective buffer is not a flat `COMPACTION_BUFFER_TOKENS` (15,000) on
every window. It is `min(COMPACTION_BUFFER_TOKENS, contextWindow × 0.125)`,
so a fixed 15,000-token buffer never reserves an outsized share of a small
or medium context window. On a 128k window the full 15,000-token buffer
applies (128k × 0.125 = 16k, above the 15k cap). On a 20k window the buffer
scales down to 2,500 tokens; without that scaling a flat 15,000-token buffer
would trip at roughly 25% usage and fire on nearly every request, even an
almost-empty conversation. The buffer still fires independently of the
percentage threshold, which matters when that threshold is set high or
disabled, since the buffer is the only backstop standing between usage and
the window edge in that case.

Preflight checks run before provider calls, including follow-up calls inside
tool loops. They use the same percentage/buffer decision so a turn can compact
before the next model request rather than waiting for post-turn maintenance
after the conversation has already exceeded the practical provider budget.

### Compaction strategies

Compaction collapses conversation history into a structured return-context document that preserves essential context while reducing token count.

**Automatic compaction** fires when token usage crosses the configured
percentage threshold or the safety buffer:

```ts
import {
  checkAndCompact,
  getAutoCompactDecision,
} from '@goodvibes-jev/engine/platform/platform/core';

const decision = getAutoCompactDecision({
  currentTokens,
  contextWindow,
  isCompacting: false,
  thresholdPercent: 80,
});

const result = await checkAndCompact(
  {
    currentTokens,
    contextWindow,
    isCompacting: false,
    thresholdPercent: 80,
  },
  compactionContext,
  providerRegistry,
);

if (result) {
  // result.messages: new compacted message list
  // result.tokensBeforeEstimate / result.tokensAfterEstimate
  // result.event: CompactionEvent for telemetry
}
```

**Manual compaction** bypasses the threshold check:

```ts
import { compactMessages } from '@goodvibes-jev/engine/platform/platform/core';

const result = await compactMessages(ctx, providerRegistry);
```

**Small-window compaction** handles models with tight context windows (a window below 12,000 tokens). It uses a simpler keep-recent strategy (`compactSmallWindow`) that retains the last N messages without an LLM extraction pass.

### Compaction section budgets

The compacted output is assembled from named sections, each with its own token budget:

| Section | Default Budget |
|---|---|
| Recent conversation | 3,000 tokens |
| Tool results | 1,500 tokens |
| Agent activity table | 1,500 tokens |
| Older agent summary | 500 tokens |
| Resolved problems | 300 tokens |
| **Total ceiling** | **6,500 tokens** |

Which messages fill the recent-conversation, tool-results and resolved-problems sections is decided in bounded chunks: one decision-model request per chunk of about 8,000 tokens (24 messages at most) asks which of that chunk's messages to keep, and the call behind a kept tool result or the user turn behind a kept reply comes along from code. A pass needing more than 24 requests, running past 30 seconds, or unable to reach the decision model quotes the sections mechanically instead, so compaction still completes. A selected tool call is quoted as its name, the path it touched and the size of its arguments; the arguments stay in saved history. When a section's selected lines exceed its budget the newest are kept and the rest are named in an `[n earlier lines omitted]` marker. The quality score is taken once per compaction, over views of the conversation capped at 80,000 characters, and travels on the compaction receipt.

`CompactionConfig` is an exported type with that shape, but structured compaction (`compactMessages` / `checkAndCompact`) always runs against `DEFAULT_COMPACTION_CONFIG` internally. `CompactionContext` has no `config` field, so there is currently no supported way to override these budgets per call; the type exists for the internal section builders, not as a public override surface.

### Token estimation

`estimateConversationTokens` scans the current message list and uses a 4-chars-per-token heuristic. It is fast and non-blocking, designed to be called every turn.

```ts
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';

const estimate = estimateConversationTokens(messages); // number
```

---

## Tool execution

### Performance budgets

Entry-file gzip diagnostics and runtime SLO gates measure different things.

`bun run bundle:check` reports the gzip size of each built platform entry file,
excluding imported dependencies. Historical references are advisory; this
report does not enforce a consumer bundle-size limit. Actual package and
browser/RN compatibility checks remain separate required checks.

**Runtime SLO gates** use consecutive-violation counting. A budget fails only when the threshold is exceeded on `tolerance` consecutive samples, which prevents transient spikes from failing the gate.

| Metric | Threshold | Tolerance |
|---|---|---|
| Frame render latency (p95) | 16 ms | 3 |
| Event queue depth | 1,000 events | 5 |
| **Tool executor overhead (p95)** | **5 ms** | 3 |
| Memory growth rate | 50 MiB/hr | 2 |
| Compaction latency (p95) | 500 ms | 3 |
| SLO: turn start, cancel, permission decision | see the SLO gates table below | 3 each |
| Integration delivery success rate | 95% (over a 100-delivery window) | 3 |
| Integration dead-letter queue depth | 10 entries | 3 |

Tool executor overhead measures scheduling, dispatch, and teardown phases only, not the tool's own execution time. The three end-to-end SLO gates and the two integration-delivery gates share this same default-budget list and consecutive-violation tolerance mechanism; the SLO gates are broken out separately below because `SloCollector` computes their p95 values from the runtime event stream rather than from a single measured duration per sample.

### SLO gates

Three end-to-end SLO latencies are measured at runtime by `SloCollector` and reported by `/doctor` and `ops.doctor` against these budgets:

| SLO | Target (p95) |
|---|---|
| Turn start (TURN_SUBMITTED → first STREAM_DELTA) | 2,000 ms |
| Cancel latency (cancel request → TURN_CANCEL) | 500 ms |
| Permission decision (GATE_REQUESTED → DECISION_EMITTED) | 2,500 ms |

SLO metrics are computed over a rolling window of 200 samples. The permission decision target is wider than the others because the span includes one Jev stakes reading for a side-effecting call. A measurement still waiting for its end event after 60 seconds is dropped by a sweep that runs every 30 seconds, so stale correlation entries cannot distort p95 values. An SLO with no samples yet reads as no data, not as 0 ms.

---

## State management

### Store domains

The runtime store partitions state into typed domains, each with a writer in `createDomainDispatch` and a `revision`/`lastUpdatedAt`. Read a domain from `store.getState()` directly; there is no selector layer. A fact another owner keeps is read from that owner, not copied into the store: provider health from `ProviderRegistry.health()`, code intelligence from `CodeIntelligence.readiness()`, trace export from `readTraceExportState()`, the execution mode from the `permissions.mode` setting.

```ts
const state = runtimeStore.getState();
const turnActive = state.conversation.turnState !== 'idle';
const pendingTasks = state.tasks.queuedIds.length;
```

The health read model (`models.health` below) composes the overall status from the provider registry, the MCP and integrations domains, the daemon listener, the ACP connections and session recovery.

### Read model pattern

Use read models for derived UI state rather than subscribing to raw domain state. Read models are pre-computed projections that compose multiple selectors and expose stable surface contracts:

```ts
import { createObservabilityReadModels } from '@goodvibes-jev/engine/platform/platform/runtime/ui';

const models = createObservabilityReadModels(runtimeServices);
// Each property is a UiReadModel<TSnapshot>: { getSnapshot(), subscribe(listener) }.
// The object is flat, not grouped under system/security/remote/maintenance keys:
// models.health, models.intelligence, models.marketplace, models.cockpit: system-level status
// models.security, models.mcp, models.localAuth: security and permission state
// models.remote: transport and connection health
// models.settings, models.continuity, models.worktrees: compaction, sessions, maintenance state
```

---

## Latency budgets

`DEFAULT_BUDGETS` (`runtime/perf/budgets.ts`) states the latency each critical path should keep, as p95: time to first output after a turn is submitted, time to stop after a cancel, and time from a call reaching the gate to its decision. Each process that answers `/doctor` (both terminal apps) or `ops.doctor` (the daemon) keeps one `SloCollector` on its runtime event bus and compares the measured p95 with the budget in the stuck-turn and permission-deadlock runbooks. The measurement harness (`bun packages/engine/scripts/measure/run.ts`) reports the same p95 values (`turnStartP95Ms`, `permissionDecisionP95Ms`) for the tool and turn scenarios. A budget is an upper bound unless it says `direction: 'min'` (a success rate).

---

## Batch patterns

### Event feed subscription

Subscribe to multiple event types within a domain in a single feed to avoid per-event subscription overhead:

```ts
const feed = platformClient.realtime.viaSse();

// Subscribe per event type, all share the same underlying connection
const stopTurns = feed.turn.on('TURN_COMPLETED', (ev) => { /* ... */ });
const stopAgents = feed.agents.on('AGENT_COMPLETED', (ev) => { /* ... */ });
const stopTools = feed.tools.on('TOOL_SUCCEEDED', (ev) => { /* ... */ });

// Each on() returns an unsubscribe function
// Cleanup:
stopTurns();
stopAgents();
stopTools();
```

Filter to only the domains you need using the SSE `domains` query parameter to reduce server-side fan-out:

```
GET /api/control-plane/events?domains=turn,agents,tools
```

### Parallel tool execution

Configure `cohort` strategy via the adaptive planner to fan tasks out across agent cohorts. A Jev reading selects the strategy from the actual task, its recorded risk and current capabilities; uncertainty holds the selection (`select` throws `PlannerJudgmentError`) rather than guessing, and the example below assumes the reading settled on `cohort`:

```ts
const decision = await planner.select({
  riskScore: 0.2,
  latencyBudgetMs: 30_000,
  isMultiStep: true,
  taskDescription: 'Implement and integrate the independent client and server changes.',
  remoteAvailable: false,
  backgroundEligible: false,
});
// decision.selected === 'cohort' when the reading settles on it
```

### Background execution

Defer latency-insensitive work to background execution to avoid blocking the conversation loop. The reading may choose another strategy, or hold the choice, in which case `select` throws `PlannerJudgmentError`; handle it as shown above.

```ts
const decision = await planner.select({
  riskScore: 0.1,
  latencyBudgetMs: Infinity,
  isMultiStep: false,
  taskDescription: 'Reindex the saved library using the background queue.',
  remoteAvailable: false,
  backgroundEligible: true,
});
// decision.selected === 'background' when the reading settles on it
```

---

## Next reads

- [Retries and reconnect](./retries-and-reconnect.md)
- [Observability](./observability.md)
- [Error handling](./error-handling.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Runtime events reference](./reference-runtime-events.md)
