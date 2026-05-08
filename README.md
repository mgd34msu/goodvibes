# GoodVibes Ecosystem

This repository is the central index for the GoodVibes projects hosted under
[mgd34msu on GitHub](https://github.com/mgd34msu). The descriptions below are
based on the current README files in the linked repositories.

## SDK

| Project | Purpose |
| --- | --- |
| [goodvibes-sdk](https://github.com/mgd34msu/goodvibes-sdk) | TypeScript SDK for building clients, daemon hosts, remote surfaces, and automation around the GoodVibes daemon. Published as `@pellux/goodvibes-sdk`. |

## Core Runtime

| Project | Purpose |
| --- | --- |
| [goodvibes-tui](https://github.com/mgd34msu/goodvibes-tui) | Terminal-native AI coding, operations, automation, knowledge, and integration console. It can run the GoodVibes daemon/API host and exposes runtime surfaces for channels, remote peers, web clients, automation, and companion apps. |

## Operator And Companion Surfaces

| Project | Purpose |
| --- | --- |
| [goodvibes-webui](https://github.com/mgd34msu/goodvibes-webui) | Browser operator surface for the GoodVibes daemon, built with Bun, Vite, React, TypeScript, and the public SDK browser/auth/contracts surfaces. |
| [goodvibes-apk](https://github.com/mgd34msu/goodvibes-apk) | React Native Android companion app for the GoodVibes TUI/daemon. It is a remote control-plane client for daemon connection, approvals, sessions, tasks, provider state, model changes, and companion-only remote chat. |
| [goodvibes-homeassistant](https://github.com/mgd34msu/goodvibes-homeassistant) | Custom Home Assistant integration for the GoodVibes daemon Home Assistant surface. Home Assistant supplies Assist plumbing, services, sensors, repairs, sidebar UI, and Home Graph context while the daemon owns routing, knowledge, graph storage, wiki rendering, and model/provider behavior. |

## Claude Code And Desktop Tooling

| Project | Purpose |
| --- | --- |
| [goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin) | Claude Code plugin that adds precision tool replacements, MCP tools, specialized agents, hooks, output styles, persistent memory, and WRFC quality workflows. |
| [goodvibes-desktop](https://github.com/mgd34msu/goodvibes-desktop) | Electron desktop application that provides an enhanced interface for Claude CLI with terminal sessions, session analytics, Git/GitHub integration, hooks, MCP server management, skills, agent templates, project registry, and memory management. |

## Quick Orientation

- Start with `goodvibes-sdk` when building a client, integration, daemon host, or
  automation against the daemon contract.
- Use `goodvibes-tui` when you want the main terminal product and local
  daemon/runtime.
- Use `goodvibes-webui`, `goodvibes-apk`, or `goodvibes-homeassistant` when you
  need a browser, Android, or Home Assistant surface for the daemon.
- Use `goodvibes-plugin` and `goodvibes-desktop` for Claude Code and Claude CLI
  workflows.

## Project Details

### goodvibes-sdk

`goodvibes-sdk` is the contract and client foundation for the daemon-centered
GoodVibes ecosystem. It publishes TypeScript entry points for operator, peer,
browser, web, React Native, Expo, Cloudflare Worker, auth, contracts, daemon,
runtime, and knowledge/Home Graph use cases.

The SDK provides typed operator and peer contracts, authenticated transports,
SSE/WebSocket realtime events, token storage helpers, daemon embedding helpers,
and runtime-neutral contract artifacts. It also contains daemon-side runtime
modules for providers, sessions, tools, orchestration, channels, memory,
knowledge, Home Assistant Home Graph, Cloudflare, media, voice, search,
security, and operations. Client SDK users connect to a reachable daemon for
provider calls and runtime behavior; the SDK client surface is not a direct AI
provider wrapper.

### goodvibes-tui

`goodvibes-tui` is the main terminal-native GoodVibes product. It is a Bun
application with a raw ANSI interface for coding, operations, automation,
knowledge work, provider routing, tools, agents, panels, and runtime control
rooms.

The TUI can run locally as a terminal application, run with an in-process
daemon/API host, or run the daemon headlessly from source. That daemon surface is
what browser, mobile, Home Assistant, channel, automation, and remote peer
clients connect to. The TUI owns terminal UX, host wiring, local configuration,
runtime visibility, provider/model selection, operational panels, slash commands,
and product composition while consuming the SDK platform layer for shared
contracts, transports, daemon routes, and reusable runtime code.

### goodvibes-webui

`goodvibes-webui` is the browser operator surface for the GoodVibes daemon. It
is built with Bun, Vite, React, TypeScript, and the published SDK browser/auth
contracts.

The WebUI is meant to operate against the daemon control plane rather than
reimplement daemon behavior in the browser. In development it runs on the
GoodVibes web surface port and proxies same-origin API, login, status, task,
config, and WebSocket routes to the configured control-plane daemon. Browser
auth is daemon-owned: username/password login goes through the daemon, pasted
operator tokens are validated by the daemon, and the WebUI does not read local
GoodVibes state files such as `~/.goodvibes`.

### goodvibes-apk

`goodvibes-apk` is the React Native Android companion app for the GoodVibes
TUI/daemon. It uses the published SDK and stores daemon connection details and
bearer tokens in secure storage.

The app is a remote control-plane client. It can authenticate with
username/password or an existing token, import connection data through Android QR
onboarding, load daemon snapshots, keep a lightweight realtime feed, review
approvals, inspect shared sessions, read transcripts, send replies and
follow-ups, switch models, view provider state, track daemon activity, and create
companion-only remote chat sessions. It does not run the GoodVibes runtime on
the phone; the Android device must be able to reach the daemon over LAN or
another reachable network.

### goodvibes-homeassistant

`goodvibes-homeassistant` is the Home Assistant side of the GoodVibes daemon
contract. It installs as a custom Home Assistant integration under
`custom_components/goodvibes`.

The integration provides setup, Assist integration, Home Assistant services,
sensors, repairs, event handling, a GoodVibes Home sidebar panel, upload
proxying, Home Graph snapshot collection, and a daemon-rendered visual knowledge
map. Home Assistant supplies the local home context and UI bridge, while the
daemon remains the source of truth for GoodVibes routing, provider/model
selection, tool catalogs, remote-chat sessions, knowledge storage, graph search,
artifacts, packets, automatic Home Graph pages, visual map layout, and wiki
rendering. The integration intentionally stays thin: it does not store Home
Graph data locally, rank snippets, synthesize answers, render the daemon wiki,
or duplicate daemon search/projection logic.

### goodvibes-plugin

`goodvibes-plugin` is a Claude Code plugin. It is separate from the GoodVibes
daemon/client stack and focuses on making Claude Code sessions more efficient,
structured, and autonomous.

The plugin replaces native Claude Code tools with token-efficient precision
equivalents, adds MCP tools across specialized engines, provides specialized
agents, installs lifecycle hooks, supports interactive and autonomous output
styles, and persists cross-session memory. Its major pieces include precision
file/edit/search/exec/fetch tools, project analysis tools, frontend analysis
tools, analytics, an event-driven runtime engine, a registry for skills and
agents, WRFC review/fix/check workflows, and session-start context injection.

### goodvibes-desktop

`goodvibes-desktop` is an Electron desktop application for Claude CLI workflows.
It provides a graphical shell around Claude CLI rather than acting as a
GoodVibes daemon surface.

The desktop app focuses on terminal session management, session history,
analytics, Git and GitHub operations, hook configuration, MCP server management,
skills, agent templates, project registry, settings, and memory file editing. It
uses a standard Electron main/renderer architecture with React, TypeScript, Vite,
SQLite, `node-pty`, `xterm.js`, Zustand, TanStack Query, and Tailwind CSS. It can
be used alongside `goodvibes-plugin` for a richer Claude Code/Claude CLI
workflow.
