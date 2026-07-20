# GoodVibes Ecosystem

Central index for the GoodVibes projects hosted under
[mgd34msu on GitHub](https://github.com/mgd34msu). The descriptions below were
verified against each repository's README and the published npm packages in
July 2026.

## Project Map

| Area | Project | Purpose |
| --- | --- | --- |
| SDK | [goodvibes-sdk](https://github.com/mgd34msu/goodvibes-sdk) | TypeScript SDK and contract layer for clients, daemon hosts, remote surfaces, and automation around the GoodVibes daemon. Published as `@pellux/goodvibes-sdk`. |
| Core runtime | [goodvibes-tui](https://github.com/mgd34msu/goodvibes-tui) | Terminal-native AI coding, operations, automation, knowledge, and integration console. Runs the daemon/API host that every other surface connects to. Published as `@pellux/goodvibes-tui`. |
| Operator surface | [goodvibes-agent](https://github.com/mgd34msu/goodvibes-agent) | Installable autonomous operator assistant: chat, planning, memory, research, scheduling, and visible agents over the daemon contract with explicit confirmation gates. Published as `@pellux/goodvibes-agent`. |
| Operator surface | [goodvibes-webui](https://github.com/mgd34msu/goodvibes-webui) | Browser chat application and operator console with near-parity to the terminal UI. One responsive app for desktop and phone, installable from the browser. |
| Companion app | [goodvibes-apk](https://github.com/mgd34msu/goodvibes-apk) | React Native Android companion app for the daemon: approvals, sessions, tasks, provider state, model changes, and companion-only remote chat. |
| Integration | [goodvibes-homeassistant](https://github.com/mgd34msu/goodvibes-homeassistant) | Custom Home Assistant integration for the daemon's Home Assistant surface: Assist plumbing, services, sensors, Home Graph sync, and the GoodVibes Home sidebar panel. |
| Claude tooling | [goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin) | Claude Code plugin: three MCP servers and 25 tools for structure-aware code intelligence, session cost analytics, and an API/DB workbench. |
| Claude tooling | [goodvibes-desktop](https://github.com/mgd34msu/goodvibes-desktop) | Electron desktop application for Claude CLI workflows: terminal sessions, analytics, Git/GitHub integration, hooks, MCP servers, skills, agent templates, and memory management. |

## Published Packages

Current npm versions as of July 2026:

- `@pellux/goodvibes-sdk` — 1.11.4
- `@pellux/goodvibes-tui` — 1.19.5
- `@pellux/goodvibes-agent` — 1.12.5

`goodvibes-webui`, `goodvibes-apk`, `goodvibes-homeassistant`, `goodvibes-plugin`,
and `goodvibes-desktop` install from their repositories or GitHub Releases rather
than npm.

## Quick Orientation

- Build against the daemon contract with `goodvibes-sdk`.
- Run the main terminal product and local daemon/runtime with `goodvibes-tui`.
- Use `goodvibes-agent` for an assistant-first operator surface with confirmation
  gates and receipts.
- Use `goodvibes-webui`, `goodvibes-apk`, or `goodvibes-homeassistant` for
  browser, Android, or Home Assistant surfaces onto the same daemon.
- Use `goodvibes-plugin` and `goodvibes-desktop` for Claude Code and Claude CLI
  workflows; both are independent of the daemon stack.

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

### goodvibes-tui

`goodvibes-tui` is the main terminal-native GoodVibes product — a Bun
application with a raw ANSI interface for coding, operations, automation,
knowledge work, provider routing, tools, agents, panels, and runtime control
rooms.

**1.0.0 shipped 2026-07-03.** The project now follows semver: incompatible
changes to CLI flags, config keys, slash commands, key bindings, daemon routes,
and on-disk layouts land only in major releases, with deprecations noted in
`CHANGELOG.md` first.

Install globally with `bun add -g @pellux/goodvibes-tui`, then
`bun pm trust -g @pellux/goodvibes-tui` so the postinstall can place the matching
TUI and daemon binaries. Only that one package needs trusting; if the trust step
is skipped the launcher self-heals on first run by fetching and
checksum-verifying the binaries. `npm install -g` is supported on Linux, macOS,
and WSL when Bun is already installed. Windows runs through WSL2 as an ordinary
Linux install; native Windows is beta.

The TUI can run as a local terminal application, with an in-process daemon/API
host, or as a headless daemon. That daemon surface is what the browser, mobile,
Home Assistant, channel, automation, and remote peer clients connect to. It owns
terminal UX, host wiring, local configuration, provider/model selection,
operational panels, and slash commands while consuming the SDK platform layer
for shared contracts, transports, and reusable runtime code.

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

Install with `bun add -g @pellux/goodvibes-agent`. Each GitHub release also
attaches standalone Linux and macOS binaries with a `SHA256SUMS.txt` manifest.
Semantic, embedding-backed memory search depends on the `sqlite-vec` native
addon, which Bun cannot embed inside a compiled binary; releases ship it as a
per-platform archive to extract beside the binary. Without it the agent still
runs, reports the vector index as unavailable, and falls back to literal memory
matching.

### goodvibes-webui

`goodvibes-webui` (1.7.1) is the browser surface for the GoodVibes daemon: a
full chat application and operator console with feature parity across most of
the terminal UI's surface, spanning Chat, Sessions, Fleet, Memory, Knowledge,
Calendar, Providers, and Admin views.

One app serves desktop and phone — the phone gets a drawer-based layout of the
same views rather than a different mental model — and it installs from the
browser as a standalone app with an offline shell and push notifications.

The application stays intentionally thin over the published SDK: browser code
uses the public scoped SDK seams from npm rather than hand-typed wire shapes,
and talks to the daemon through the configured WebUI origin and Vite proxy in
development, or same-origin when the daemon serves the built bundle itself.
Built with Bun, Vite, React, TypeScript, and TanStack Query, with Playwright
phone and desktop end-to-end suites running against a hermetic mock daemon.

### goodvibes-apk

`goodvibes-apk` is the React Native Android companion app for the GoodVibes
TUI/daemon, built on the published SDK. It stores the daemon URL and bearer
token in secure storage and supports Android QR onboarding for daemon URL,
credential, and token payloads.

The app is a remote control-plane client organized as Overview, Models,
Sessions, Approvals, Tasks, and Activity. It authenticates with username and
password or an existing shared bearer token, loads control-plane snapshots over
HTTP, keeps a lightweight realtime feed open while foregrounded, reviews and
acts on pending approvals, inspects shared sessions and transcripts, sends
replies and follow-ups, switches models, surfaces provider state and warnings,
and creates companion-only remote chat sessions.

GitHub Releases publishes an installable `app-release.apk` for each semver tag;
release pages label each build `release-signed` or `debug-signed`, and only the
former is intended for normal phone use. There is no iOS build artifact. The
GoodVibes runtime does not run on the phone — the device must be able to reach
the daemon over LAN or another reachable network.

### goodvibes-homeassistant

`goodvibes-homeassistant` is the Home Assistant side of the GoodVibes daemon
contract. It installs as a custom integration under
`custom_components/goodvibes` and is validated against `@pellux/goodvibes-sdk`
1.10.1.

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

### goodvibes-desktop

`goodvibes-desktop` (1.1.1) is an Electron desktop application for Claude CLI
workflows. It provides a graphical shell around the CLI rather than acting as a
GoodVibes daemon surface.

The desktop app focuses on terminal session management with tabs, session
history and analytics, Git and GitHub operations including staging, commits,
branches, pull requests, and issues, hook configuration for PreToolUse,
PostToolUse, and Stop events, MCP server management, a skills library, agent
templates, a multi-project registry, settings, and CLAUDE.md memory editing.

It uses a standard Electron main/renderer architecture and can be used alongside
`goodvibes-plugin` for a richer Claude Code and Claude CLI workflow.
