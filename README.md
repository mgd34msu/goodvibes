# GoodVibes Ecosystem

Central index for the GoodVibes projects hosted under
[mgd34msu on GitHub](https://github.com/mgd34msu). The descriptions below were
verified against each repository's README and the published npm packages in
August 2026.

## Project Map

| Area | Project | Purpose |
| --- | --- | --- |
| SDK | [goodvibes-sdk](https://github.com/mgd34msu/goodvibes-sdk) | TypeScript SDK and contract layer for clients, daemon hosts, remote surfaces, and automation around the GoodVibes daemon. Published as `@pellux/goodvibes-sdk`. |
| Core runtime | [goodvibes-daemon](https://github.com/mgd34msu/goodvibes-daemon) | Standalone control plane for the platform: a long-running process that answers operator verbs over HTTP, manages sessions and data stores, runs scheduled work, and coordinates grouped machines via leader election. Published as `@pellux/goodvibes-daemon`. |
| Core runtime | [goodvibes-tui](https://github.com/mgd34msu/goodvibes-tui) | Terminal-native AI coding, operations, automation, knowledge, and integration console. As of 2.0 it adopts the standalone GoodVibes daemon rather than hosting one in-process. Published as `@pellux/goodvibes-tui`. |
| Operator surface | [goodvibes-agent](https://github.com/mgd34msu/goodvibes-agent) | Installable autonomous operator assistant: chat, planning, memory, research, scheduling, and visible agents over the daemon contract with explicit confirmation gates. Published as `@pellux/goodvibes-agent`. |
| Operator surface | [goodvibes-webui](https://github.com/mgd34msu/goodvibes-webui) | Browser chat application and operator console with near-parity to the terminal UI. One responsive app for desktop and phone, installable from the browser. |
| Integration | [goodvibes-homeassistant](https://github.com/mgd34msu/goodvibes-homeassistant) | Custom Home Assistant integration for the daemon's Home Assistant surface: Assist plumbing, services, sensors, Home Graph sync, and the GoodVibes Home sidebar panel. |
| Claude tooling | [goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin) | Claude Code plugin: three MCP servers and 25 tools for structure-aware code intelligence, session cost analytics, and an API/DB workbench. |
| Codex tooling | [goodvibes-codex](https://github.com/mgd34msu/goodvibes-codex) | Codex CLI port of `goodvibes-plugin`: the same three MCP servers and 25 tools without any Claude-specific dependencies. Early-stage. |

## Published Packages

Current npm versions as of August 2026:

- `@pellux/goodvibes-sdk` — 2.0.10
- `@pellux/goodvibes-daemon` — 1.28.12
- `@pellux/goodvibes-tui` — 2.0.10
- `@pellux/goodvibes-agent` — 2.0.9

`goodvibes-webui`, `goodvibes-homeassistant`, `goodvibes-plugin`, and
`goodvibes-codex` install from their repositories or GitHub Releases rather than
npm.

## Quick Orientation

- Build against the daemon contract with `goodvibes-sdk`.
- Run the platform control plane as its own long-running process with
  `goodvibes-daemon` — the backbone every other surface connects to.
- Run the main terminal product with `goodvibes-tui`; as of 2.0 it adopts the
  standalone daemon rather than hosting one itself.
- Use `goodvibes-agent` for an assistant-first operator surface with confirmation
  gates and receipts.
- Use `goodvibes-webui` or `goodvibes-homeassistant` for browser or
  Home Assistant surfaces onto the same daemon.
- Use `goodvibes-plugin` for Claude Code and `goodvibes-codex` for the Codex
  CLI; both are independent of the daemon stack.

## Project Details

### goodvibes-sdk

`goodvibes-sdk` is the contract and client foundation for the daemon-centered
GoodVibes ecosystem. It ships client SDKs for operator, peer, browser, web,
React Native, Expo, and Cloudflare Worker environments, typed contracts for
operator methods and peer endpoints, auth and token storage across memory,
browser localStorage, iOS Keychain, Android Keystore, and Expo Secure Store,
realtime transports over SSE and WebSocket with reconnect, and daemon embedding
helpers for Bun hosts.

It also carries the daemon-side runtime: provider and model routing across
OpenAI, Codex, Anthropic, Gemini, Bedrock, Vertex, GitHub Copilot, Inception
Labs, Ollama, and OpenAI-compatible endpoints; the agentic session/turn/tool
runtime with WRFC review chains and compaction; the knowledge and wiki system
with SQLite storage, ingest, graph links, and Home Graph support; channel
surfaces for Slack, Discord, Telegram, Signal, WhatsApp, Matrix, Home Assistant,
and others; optional Cloudflare integration; media, voice, and search; and
security and operations tooling.

Client SDK users connect to a reachable daemon for provider calls and runtime
behavior; the SDK client surface is not a direct AI provider wrapper.

Version 2.0 segments the SDK into two tiers: *full* for Bun hosts (TUI, agent,
daemon) and *companion* for browser, React Native, Expo, and Cloudflare Worker
environments. The README advises pinning exact versions and reading
`CHANGELOG.md` before upgrading across releases.

### goodvibes-daemon

`goodvibes-daemon` is the backbone of the platform: a standalone long-running
process that lets the control surfaces defined in `goodvibes-agent` and
`goodvibes-tui` exist outside those runtimes. It answers operator verbs over
HTTP, reads channels, manages conversation sessions along with the session,
memory, knowledge, and code-index stores, runs scheduled and triggered work,
provisions local voice and wake-word models, serves the browser UI on loopback
(configurable to LAN), coordinates grouped machines through leader election,
and self-updates with automatic rollback.

Like the TUI and agent, it is a consumer of `@pellux/goodvibes-sdk` rather than
a duplicate of it: the repository keeps the composition root, product-specific
handlers (inbox management, routing, credentials), CLI tooling, and binary
packaging, and deliberately avoids re-implementing SDK functionality.

Install with `curl -fsSL https://goodvibes.sh/install.sh | sh`, or via
`bun add -g @pellux/goodvibes-daemon` / `npm install -g @pellux/goodvibes-daemon`.

### goodvibes-tui

`goodvibes-tui` is the main terminal-native GoodVibes product — a Bun
application with a raw ANSI interface for coding, operations, automation,
knowledge work, provider routing, tools, agents, panels, and runtime control
rooms.

The project follows semver (1.0.0 shipped 2026-07-03): incompatible changes to
CLI flags, config keys, slash commands, key bindings, daemon routes, and
on-disk layouts land only in major releases, with deprecations noted in
`CHANGELOG.md` first. The 2.0 release moved the daemon out of the TUI into the
separate `goodvibes-daemon` package.

Install with `curl -fsSL https://goodvibes.sh/install.sh | sh`, or via
`bun add -g @pellux/goodvibes-tui` followed by
`bun pm trust -g @pellux/goodvibes-tui goodvibes-daemon` (Bun blocks lifecycle
scripts for untrusted global packages). If the trust step is skipped the
`goodvibes` launcher self-heals on first run by fetching and checksum-verifying
its own binary. Runs on Linux, macOS, and Windows via WSL2; native Windows is
beta.

As of 2.0 the TUI adopts a running standalone GoodVibes daemon, or starts one
already installed as a stopped service — it never spawns a new daemon process
itself. This is controlled by the `daemon.enabled` setting (default true), with
the daemon bound to loopback. The TUI owns terminal UX, host wiring, local
configuration, provider/model selection, operational panels, and slash commands
while consuming the SDK platform layer for shared contracts, transports, and
reusable runtime code.

### goodvibes-agent

`goodvibes-agent` is the installable autonomous operator assistant. It keeps the
terminal renderer and workspace foundation it was split from, but targets a
different product goal than a coding harness: one assistant that can chat, plan,
remember, research, schedule, send, generate, run visible agents, and drive the
GoodVibes daemon contract behind explicit confirmation gates.

The daemon is Agent's capability runtime, supplying the operator API, schedules,
channels, knowledge, media, remote execution, service posture, and long-running
automation. Agent consumes published SDK, daemon, and TUI contracts and
contributes the user-first harness, route planning, confirmation gates, and
receipts. It imports shared GoodVibes settings so provider selections, UI
preferences, permissions, subscriptions, surfaces, tools, and daemon endpoints
carry over from `goodvibes-tui` instead of being configured twice.

Install with `bun add -g @pellux/goodvibes-agent`, then
`bun pm trust -g goodvibes-daemon`: the agent depends on the `goodvibes-daemon`
package (default target `http://127.0.0.1:3421`), and it is the daemon's
postinstall that needs trusting — the agent package has none of its own. Each
GitHub release also attaches standalone Linux and macOS binaries with a `SHA256SUMS.txt` manifest.
Semantic, embedding-backed memory search depends on the `sqlite-vec` native
addon, which Bun cannot embed inside a compiled binary; releases ship it as a
per-platform archive to extract beside the binary. Without it the agent still
runs, reports the vector index as unavailable, and falls back to literal memory
matching.

### goodvibes-webui

`goodvibes-webui` (1.12.1) is the browser surface for the GoodVibes daemon: a
full chat application and operator console with feature parity across most of
the terminal UI's surface, spanning Chat, Sessions, Fleet, Memory, Knowledge,
Calendar, Providers, and Admin views, plus Checkpoints (browse, create,
restore, and diff), Voice (batched spoken replies and microphone dictation),
and Approvals, Tasks, and Workstream surfaces for decision queues and
orchestration, with a ⌘K command palette and global hotkeys.

The repo is not published to npm by design; it is versioned with semantic git
tags and distributed as source.

One app serves desktop and phone — the phone gets a drawer-based layout of the
same views rather than a different mental model — and it installs from the
browser as a standalone app with an offline shell and push notifications.

The application stays intentionally thin over the published SDK: browser code
uses the public scoped SDK seams from npm rather than hand-typed wire shapes,
and talks to the daemon through the configured WebUI origin and Vite proxy in
development, or same-origin when the daemon serves the built bundle itself.
Built with Bun, Vite, React, TypeScript, and TanStack Query, with Playwright
phone and desktop end-to-end suites running against a hermetic mock daemon.

### goodvibes-homeassistant

`goodvibes-homeassistant` is the Home Assistant side of the GoodVibes daemon
contract. It installs as a custom integration under
`custom_components/goodvibes` and targets the latest published
`@pellux/goodvibes-sdk`; the exact daemon-contract version it was last
validated against is tracked in the repo's `docs/sdk-compatibility.md`.

The integration provides setup, Assist plumbing, Home Assistant services,
sensors, repairs, event handling, upload proxying, Home Graph snapshot
collection, and the `GoodVibes Home` sidebar panel with a daemon-rendered visual
knowledge map. Selecting the GoodVibes conversation entity in an Assist pipeline
enables spoken and chat Assist turns.

The daemon remains the source of truth for routing, provider and model
selection, remote-chat sessions, knowledge storage, Home Graph search, generated
pages, packets, artifacts, and visual map rendering. The integration stays
deliberately thin: it does not store Home Graph data locally, rank snippets,
synthesize answers, render the daemon wiki, or duplicate daemon search and
projection logic.

### goodvibes-plugin

`goodvibes-plugin` is a Claude Code plugin, separate from the GoodVibes
daemon/client stack. Version 2 is a rewrite around three MCP servers and 25
tools, scoped to capabilities the native harness lacks rather than replacing the
ones it already handles well.

- **intel** (15 tools) — structure-first code reading with outline and range
  modes, multi-query search with AST structural queries, glob with per-file
  stats, TypeScript API-surface and safe-delete analysis on a single compiler
  host, API route/spec/contract analyzers, DB schema intelligence with Prisma
  usage analysis, React component/hook/boundary analyzers, a merged layout
  analyzer, project scaffolding, and `structural_edit` — the one write tool,
  preview-gated.
- **analytics** (7 tools) — per-session and cross-project token and cost
  analytics from transcript actuals with cache-aware per-model pricing, plus
  budgets, tags, export, a self-contained HTML report, and live modes that price
  the running session, surface host load and orphaned processes, and classify
  background agents.
- **connect** (3 tools) — `api_request` for batched HTTP with per-entry error
  isolation, `service` for a credential registry with an allowlisted trust
  boundary and bounded OAuth2 refresh, and `db_query` for live databases under
  the same trust model.

### goodvibes-codex

`goodvibes-codex` is the Codex-native port of `goodvibes-plugin`: the same
structure-aware code intelligence, local usage analytics, and policy-bound
access to HTTP services and databases, delivered as three stdio MCP servers
with 25 tools, plus skills, lifecycle hooks, and scaffolding templates. It does
not read Claude state, install Claude commands, or depend on Claude-specific
hook and transcript formats.

It requires the Codex CLI with plugin support and Node.js 20.19+ or 22.12+,
installing from the repository (marketplace publication is planned). The
project is early-stage; a capability matrix in the repo documents migration
status relative to the Claude plugin.
