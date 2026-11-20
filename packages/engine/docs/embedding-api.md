# platform embedding API 1.0

`@goodvibes/engine/platform/embed` is the supported, stability-marked surface for
embedding a GoodVibes session in another application. It is a curation of
existing runtime machinery. It adds no new engine. It names the minimal stable
contract: **create a session against a workspace, send input, receive typed
events, inject a permission callback, and shut down.**

## Quick start

```ts
import { createEmbeddedSession } from '@goodvibes/engine/platform/embed';

const session = await createEmbeddedSession({
  workspace: process.cwd(),
  homeDirectory: process.env.HOME!,
  requestPermission: async (request) => ({ approved: request.category === 'read' }),
});

const stop = session.events.onDomain('turn', (envelope) => {
  console.log(envelope.type, envelope.payload.type);
});

await session.submit('Summarize the README.');

stop();
await session.stop();
```

See `examples/embed-session-quickstart.ts` (compile-checked in CI).

## The contract

`createEmbeddedSession(options)` returns an `EmbeddedSession` on the one
in-process daemon of the home directory. The first session of a home boots it;
a later session joins it when its workspace is the daemon's working directory or
inside it and it gives the same `token` and `boot` settings, so it starts
without a boot and cannot disturb the first session's work. A session that does
not fit (a workspace elsewhere, other daemon settings, or a different MCP server
under a name a live session already declared) gets a daemon of its own. The
daemon stops when its last session stops.

| member                  | purpose                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `workspace`               | the project root the session operates against                 |
| `url`                     | base URL of the daemon's HTTP surface (the same for every session of the daemon) |
| `events`                  | the daemon's `RuntimeEventBus`: `.on(type, cb)` or `.onDomain(dom, cb)`; it carries every session of the daemon |
| `approvals`               | the `ApprovalBroker` permission asks flow through             |
| `sessions`                | the `SharedSessionBroker` backing the session                 |
| `submit(in)`              | send input; resolves with the broker's submission record and a `completion` handle on the run it started. When the broker answers in spawn mode, the text starts a contract in the session's workspace through the daemon's `contracts` surface and `activeAgentId` is the contract's owner agent, bound to the session |
| `cancelActive(agentIds)`  | cancel one or more in-flight agent turns this session started, by the agent id a submission reported as `activeAgentId`; returns the number actually cancelled |
| `stop()`                  | end the session (its runs end as cancelled, its agents are cancelled); the daemon stops and releases its port when no other session uses it. Idempotent |

**Permission callback injection.** When `requestPermission` is provided, the
session's pending approvals are routed to it and resolved with its decision: an
ask from an agent the session's submissions started, else (when the agent is
not known) the ask of the one session with a run in flight, or of the daemon's
only session. An ask no session can be named for is refused with that reason
when every session answers by callback, and left to the other approval routes
otherwise. An embedder answers permission asks with a callback instead of
driving the HTTP approvals routes.

**Cancelling in-flight work.** `cancelActive` is a real cancellation, not a
courtesy flag: it aborts the agent's in-flight provider call so the turn stops
mid-flight and emits its cancelled outcome, rather than only cancelling a
still-queued input. Agent ids this session did not start are ignored.

**Connecting MCP servers.** `EmbedSessionOptions.mcpServers` lets an embedder
declare MCP servers (for example, the servers an ACP client passes in
`session/new`) to connect into the daemon's live tool surface; their tools join
it namespaced as `mcp:<name>:<tool>`. A server several sessions declare is
connected once and stays connected for the daemon's life. Only the stdio
transport is supported; the registry spawns a process for each server. A
server that fails to connect is logged and skipped (the next session that
declares it tries again); it never aborts session creation.

**Receiving events.** Subscribe to the typed `RuntimeEventBus`. Each envelope
carries `type`, `payload` (the typed event), and correlation ids
(`sessionId`, `turnId`, …).

## Stability guarantees

The surface is **frozen at 1.0** and pinned by an api-extractor report
(`etc/goodvibes-platform-embed.api.md`) so an accidental breaking change fails the
`api:check` gate. Frozen:

- `createEmbeddedSession` and the `EmbeddedSession` shape;
- `EmbedSessionOptions`, `EmbeddedSessionInput`;
- the re-exported `bootDaemon` / `BootDaemonOptions` / `BootedDaemon`;
- the permission-callback contract (`PermissionRequestHandler`,
  `PermissionPromptRequest`, `PermissionPromptDecision`);
- the event-subscription contract (`RuntimeEventBus`, `AnyRuntimeEvent`,
  `RuntimeEventDomain`).

**Internal** (reachable through these types but not part of the frozen contract,
may change in a minor): the full member surface of `DaemonServer`,
`ApprovalBroker`, and `SharedSessionBroker` beyond the members named above, and
the concrete per-domain event payload fields.
