# ACP agent: drive GoodVibes from ACP-capable editors

GoodVibes ships an **agent-side** adapter for the Agent Client Protocol (ACP),
the editor-agnostic protocol used by Zed and other clients. An editor spawns the
adapter over stdio and drives a GoodVibes session through the protocol. (This is
the counterpart of the existing client side under `platform/acp`, where GoodVibes
itself spawns ACP subagents.)

## Running it

From an installed GoodVibes, point the editor's agent-server command at:

```
goodvibes acp
```

(for Zed: `{ "agent_servers": { "GoodVibes": { "command": "goodvibes", "args": ["acp"] } } }`).
Stdout carries only protocol frames, messages go to stderr, and the process ends
when the editor closes stdin. From a repository checkout the same agent starts with:

```
bun packages/engine/scripts/acp-agent.ts
```

Environment: `GOODVIBES_HOME` sets the embedded daemon's home directory
(default `$HOME`).

Programmatic use (exported from `@goodvibes-jev/engine/platform/platform/acp`):

```ts
import { serveAcpAgent, GoodVibesAcpAgent } from '@goodvibes-jev/engine/platform/platform/acp';
const { connection, dispose } = await serveAcpAgent({ homeDirectory: process.env.HOME! });
// Optional second argument: { input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array> }
// replaces process stdin/stdout.
```

## What it maps

The base is the platform embedding API (`@goodvibes-jev/engine/platform/embed`).
The ACP sessions of one working directory (with the same declared MCP servers)
share one embedded GoodVibes daemon; each ACP session is one shared session in
it. The adapter is a protocol mapping over that surface:

| ACP                           | GoodVibes                                              |
| ----------------------------- | ------------------------------------------------------ |
| `initialize` / `authenticate` | capability report; no auth (process-local daemon)      |
| `session/new` (cwd)           | the cwd's embedded daemon (booted on first use) and a new shared session in it |
| `session/prompt` (text)       | `session.submit({ body, sessionId })`; the submission's `completion` follows the agent that took the input |
| `agent_message_chunk`         | the agent's streamed text                              |
| `tool_call` / `tool_call_update` | the agent's tool calls starting and settling        |
| stop reason                   | how the agent's run ended (see mapping below)          |
| `session/request_permission`  | the platform permission callback (allow once / always / reject) |
| `session/cancel`              | aborts the agents the session started, then resolves the prompt `cancelled` |
| `session/close`               | cancels the session's work, closes its shared session, and stops the daemon when no other session uses it |

Stop-reason mapping: a completed run is `end_turn`, a cancelled one `cancelled`;
a failed run, or an input no agent took (queued behind other work), is `refusal`
with one message chunk saying why. A completed run that streamed no text sends
its final output as the message.

## Honest capability surface

Anything the platform does not support is reported `false`, never stubbed:

- `loadSession: false`: no session restore over ACP.
- `promptCapabilities.image`, `audio`, and `embeddedContext` are all `false`: prompt input is
  text (text blocks plus `resource_link` URIs folded in as text references).
- `mcpCapabilities.http` and `sse` are both `false`, the adapter's MCP client is stdio
  JSON-RPC only. Stdio `mcpServers` entries declared in `session/new` are translated
  and wired into the embedded session's tool surface. An `http` or `sse` entry is
  never silently dropped; `session/new` throws, naming the unsupported server, since a
  compliant client should not send one given the advertised capabilities.
- Cancellation is real, not best-effort. `session/cancel` aborts the session's active
  agent in-flight (the agent's cancellation signal is threaded into the provider call),
  so an already-executing call is stopped mid-flight and the turn emits its cancelled
  outcome. A still-queued input, one not yet delivered to an agent, is additionally
  cancelled through the broker's `cancelInput`.

## Event attribution

Each prompt follows only the agent its own input started (`EmbeddedSubmission.completion`),
so events never cross between ACP sessions. A permission ask goes to the ACP
session whose agent raised it; an ask from an agent no session started goes to
the one session with a prompt running, or to the daemon's only session, and is
refused when more than one session could have raised it.
