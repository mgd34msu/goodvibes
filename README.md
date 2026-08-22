# GoodVibes ecosystem

Central index for the GoodVibes projects hosted under
[mgd34msu on GitHub](https://github.com/mgd34msu). The descriptions below match
each repository's README and the published packages as of August 21, 2026.

The family splits into two groups. The core projects ride the sdk release
train: when `@pellux/goodvibes-sdk` publishes, each of them repins to the new
version and releases in the same cycle. The non-core projects are independent:
they do not depend on the sdk and release on their own schedules, only when
they have something to ship.

## Core projects (sdk release train)

| Project | Purpose |
| --- | --- |
| [goodvibes-sdk](https://github.com/mgd34msu/goodvibes-sdk) | Typed TypeScript platform layer behind the GoodVibes products: sessions, provider/model routing, in-process agents, knowledge and memory, the control-plane HTTP and realtime API, and transports. Published as `@pellux/goodvibes-sdk`. |
| [goodvibes-daemon](https://github.com/mgd34msu/goodvibes-daemon) | Standalone control plane for the platform: a long-running process that answers operator verbs over HTTP, manages sessions and data stores, runs scheduled work, and coordinates grouped machines via leader election. Published as `@pellux/goodvibes-daemon`. |
| [goodvibes-tui](https://github.com/mgd34msu/goodvibes-tui) | Terminal console for coding and operations work with an AI model: permission-gated tools, a live multi-provider model catalog with failover routing, per-turn token and cost accounting, and panel control rooms. Published as `@pellux/goodvibes-tui`. |
| [goodvibes-agent](https://github.com/mgd34msu/goodvibes-agent) | Installable autonomous operator assistant: chat, planning, memory, research, scheduling, and visible agents over the daemon contract with explicit confirmation gates. Published as `@pellux/goodvibes-agent`. |
| [goodvibes-webui](https://github.com/mgd34msu/goodvibes-webui) | Browser chat application and operator console with near-parity to the terminal UI. One responsive app for desktop and phone, installable from the browser as a standalone app. |
| [goodvibes-app](https://github.com/mgd34msu/goodvibes-app) | Native desktop operator console built with Electrobun (Bun and TypeScript, no Electron): one window unifying the terminal console's coding and operations capability with the agent's assistant surfaces, over the daemon's operator contract. |

## Non-core projects (independent)

| Project | Purpose |
| --- | --- |
| [goodvibes-homeassistant](https://github.com/mgd34msu/goodvibes-homeassistant) | Custom Home Assistant integration for the daemon's Home Assistant surface: Assist plumbing, services, sensors, Home Graph sync, and the GoodVibes Home sidebar panel. Vendors a generated client rather than depending on the sdk package. |
| [goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin) | Claude Code plugin: three MCP servers and 25 tools for structure-aware code intelligence, session cost analytics, and an API/DB workbench. Independent of the daemon stack. |
| [goodvibes-codex](https://github.com/mgd34msu/goodvibes-codex) | Codex CLI port of `goodvibes-plugin`: the same three MCP servers and 25 tools without any Claude-specific dependencies. Early-stage. |
| [goodvibes-desktop](https://github.com/mgd34msu/goodvibes-desktop) | Electron desktop application wrapping the Claude CLI with session management, analytics, Git integration, hooks, MCP server management, and a plugin ecosystem. Predates the daemon stack and does not use it. |

The retired Android companion app is no longer part of the family; the webui's
installable browser app is its replacement, including QR pairing with a
phone's camera.

## Current versions

Every release current as of August 21, 2026, with where each one is
distributed from:

| Project | Version | Distributed via |
| --- | --- | --- |
| `@pellux/goodvibes-sdk` | 2.0.21 | npm; `@pellux/goodvibes-contracts` and `@pellux/goodvibes-toolchain` publish from the same workspace at the same version |
| `@pellux/goodvibes-daemon` | 1.28.23 | npm; the daemon binary itself attaches to the GitHub release the publish is gated on |
| `@pellux/goodvibes-tui` | 2.0.18 | npm |
| `@pellux/goodvibes-agent` | 2.0.19 | npm |
| `goodvibes-webui` | 1.13.16 | GitHub release, with the built bundle attached for the suite installer |
| `goodvibes-app` | 0.4.2 | GitHub release |
| `goodvibes-homeassistant` | 0.13.14 | GitHub release; installable through HACS as a custom repository |
| `goodvibes-plugin` | 2.3.4 | the repository's main branch is the distribution channel |
| `goodvibes-codex` | 0.1.1 | GitHub release, via the Codex plugin marketplace |
| `goodvibes-desktop` | 1.1.5 | GitHub release |

## Quick orientation

- Build against the daemon contract with `goodvibes-sdk`.
- Run the platform control plane as its own long-running process with
  `goodvibes-daemon`, the backbone every other surface connects to.
- Run the main terminal product with `goodvibes-tui`.
- Use `goodvibes-agent` for an assistant-first operator surface with confirmation
  gates and receipts.
- Use `goodvibes-webui` or `goodvibes-homeassistant` for browser or
  Home Assistant surfaces onto the same daemon, and `goodvibes-app` for the
  native desktop window over it.
- Use `goodvibes-plugin` for Claude Code and `goodvibes-codex` for the Codex
  CLI; both are independent of the daemon stack, as is `goodvibes-desktop`,
  the Electron wrapper around the Claude CLI.

## Release train

`train-manifest.json` lists every repo in the family and whether it tracks the
sdk. From this directory, `bunx @pellux/goodvibes-toolchain goodvibes-train-status
--manifest train-manifest.json` prints the cycle's status: sdk pins vs the
latest published sdk, unreleased and unpushed commit counts, and the suggested
action per repo. sdk consumers repin and release each cycle; independent repos
(plugin, codex, desktop, homeassistant) release through their own gated paths
only when the table shows a delta, and skip cycles where they show zeros.

## Project details

### goodvibes-sdk

`goodvibes-sdk` is the typed TypeScript platform layer behind the GoodVibes
products: sessions, provider and model routing, in-process agents, a knowledge
and memory store, the control-plane HTTP and realtime API, and the transports
that carry it all. The daemon is its own product, built on this SDK.
The terminal app and the agent embed the runtime directly in a Bun process
and connect to the daemon as clients. The web UI, the native desktop app,
phones through the web UI's installable app, and the Home Assistant
integration connect to the same daemon as thin remote clients over HTTP,
SSE, and WebSocket.

One published package covers both surfaces: `@pellux/goodvibes-sdk` is a
facade over a set of source-of-truth sibling packages (errors, transports,
daemon-sdk, operator-sdk, peer-sdk, and more), so consumers install one
package and import only the entry points they need: the root Bun SDK,
`/daemon` for route dispatch and embedding in a Bun server host, `/browser`
and `/web`, `/react-native` and `/expo` with mobile secure token stores,
`/workers` for the Cloudflare Worker bridge, `/contracts`, and `/auth`. Two
more packages publish from the same workspace: `@pellux/goodvibes-contracts`
(runtime-neutral operator and peer contract artifacts) and
`@pellux/goodvibes-toolchain` (the CI/CD release tooling every GoodVibes
repo's release workflow invokes).

Package versions are aligned across the workspace and always published
together. The repo's semver policy fixes what counts as a major, minor, or
patch change, and a misclassified bump fails the release gate. The README
advises pinning exact versions and reading `CHANGELOG.md` before upgrading.

### goodvibes-daemon

`goodvibes-daemon` is the backbone of the platform: one long-running process
per machine that holds the control plane every GoodVibes client talks to. The
terminal app, the conversational agent, and the web app are clients of this
process. They render, capture input, and call verbs; the work happens here.

What the daemon owns:

- Answers the operator verb families over HTTP.
- Reads and replies on your channels, and elects a leader among grouped
  machines so only one answers a shared inbox.
- Runs scheduled and triggered work.
- Keeps the session, memory, knowledge, and code-index stores.
- Provisions the local voice and wake-word models.
- Serves the browser UI on its own listener, loopback by default;
  `goodvibes-daemon webui --lan` is the deliberate act that widens it.
- Updates itself at an idle moment, with a rollback if the new binary will
  not start.

Like the TUI and agent, it is a product over `@pellux/goodvibes-sdk` rather
than a duplicate of it: the repository keeps the composition root, the product
handlers the SDK does not own (inbox, triage, drafts, routing, remote peers,
credentials), the CLI (`send`, `cluster`, `webui`, `install-service`, and
friends), and binary packaging. Every engine lives in the SDK and is consumed
from the published package.

Install with `curl -fsSL https://goodvibes.sh/install.sh | sh`. The installer
brings the whole suite (daemon, terminal app, agent, and the browser operator
surface) from checksum-verified binaries. Or from npm:
`bun add -g @pellux/goodvibes-daemon`, `bun pm trust -g goodvibes-daemon`,
then `goodvibes-daemon install-service`. The npm package carries the product
source and the launcher; the daemon itself is a compiled binary published as a
GitHub release asset, and the release always lands before the registry publish
so a fresh install can never resolve a version whose binary does not exist
yet.

### goodvibes-tui

`goodvibes-tui` is the main terminal-native GoodVibes product. Running
`goodvibes` in a project directory opens a full-screen terminal app where you
talk to a model that can read and edit your files, run shell commands, search
the web, and hand work off to background agents, asking permission before
anything that writes or executes. You decide workspace trust per directory, and
the default `prompt` permission mode stops on writes, edits, shell commands,
network fetches, agent spawns, and MCP calls, with decisions rememberable at
exact-command, command-shape, project, or session scope.

It talks to many providers through a live model catalog: OpenAI, Anthropic,
Gemini, Bedrock, Copilot, OpenRouter and other OpenAI-compatible gateways,
plus local servers like Ollama and LM Studio discovered on startup. The
catalog routes per role (main chat, helper, tool, TTS, embeddings), with
`synthetic` failover groups that never cross the free, paid, and subscription
boundaries.
Settings, sessions, and secrets stay on your own machine, and the footer keeps
an honest running token and cost total for every turn. Panels turn background
work into live control rooms: Fleet (`F2`) tracks agents, workstreams,
watchers, and scheduled jobs, with attach, detach, pause, resume, and archive.

Install with `curl -fsSL https://goodvibes.sh/install.sh | sh`, or via
`bun add -g @pellux/goodvibes-tui` followed by
`bun pm trust -g @pellux/goodvibes-tui goodvibes-daemon`. `goodvibes-daemon`
is a dependency of the package, so one install brings both commands, and the
trust step lets both postinstalls place their binaries. If it is skipped the
`goodvibes` launcher self-heals on first run by fetching and checksum-verifying
its own binary. Runs on Linux, macOS, and Windows via WSL2; native Windows is
beta.

Like every other surface, the TUI is a client of the standalone
`goodvibes-daemon`: it adopts a running daemon, or starts one already
installed as a stopped service; it never spawns a new daemon process itself
(`daemon.enabled`, on by default, loopback-bound). The TUI consumes the published `@pellux/goodvibes-sdk` platform layer, pinned in
`package.json`, for shared contracts, daemon routes, and transports, and keeps
the terminal UI, host wiring, and product composition in its own repo. From
1.0.0 the project follows semver: incompatible changes to CLI flags, config
keys, slash commands, key bindings, daemon routes, and on-disk layouts land
only in major releases, with deprecations noted in `CHANGELOG.md` first.

### goodvibes-agent

`goodvibes-agent` is the installable autonomous operator assistant. It builds
on the GoodVibes platform's terminal renderer and workspace foundations, but
targets a different product goal than a coding tool: one workspace for chat,
planning, memory, research, scheduling, and confirmation-gated automation. It
leads with route planning, plain-language confirmations, and redacted
receipts for anything it sends, spends, or writes, instead of raw daemon
plumbing.

The connected daemon is Agent's capability runtime, supplying the operator
API, schedules, channels, knowledge, media, and remote-execution routes; Agent
consumes the bundled GoodVibes platform runtime, pinned in `package.json`, and
keeps the workspace, local behavior library, and Agent Knowledge boundary in
its own repo. Local behavior lives under the Agent home: a `VIBE.md`
personality file, memory, notes, personas, skills, and routines. Named
profiles give separate, isolated config, sessions, memory, and personas per
household or project, and Agent Knowledge never falls back to another
product's knowledge store. It can also import shared GoodVibes settings so provider
selections, permissions, surfaces, and daemon endpoints carry over from
`goodvibes-tui` instead of being configured twice.

Install with `bun add -g @pellux/goodvibes-agent`, then
`bun pm trust -g goodvibes-daemon`. The trust step is for the daemon's
postinstall, not the agent's: the agent package ships no install scripts, but
it depends on `goodvibes-daemon` (default target `http://127.0.0.1:3421`),
whose postinstall needs your approval to run.

Prefer a standalone binary? Each GitHub release attaches Linux and macOS
builds with a `SHA256SUMS.txt` manifest. A directly-downloaded binary keeps
itself current: it swaps in updates after a checksum check, at launch and at
idle moments, and keeps the replaced file beside it as `.previous` so
`/update rollback` can undo the swap.
Package-managed installs never self-swap and defer to `bun add -g` instead.

Semantic, embedding-backed memory search depends on the `sqlite-vec` native
addon, which Bun cannot embed inside a compiled binary; releases ship it as a
per-platform archive to extract beside the binary. Without it the agent still
runs and falls back to literal memory matching. On macOS the addon stays
unavailable regardless, because the system SQLite refuses to load extensions.

### goodvibes-webui

`goodvibes-webui` is the browser surface for the GoodVibes daemon: a
full chat application and operator console with feature parity across most of
the terminal UI's surface. It spans Chat, Sessions, Fleet, Memory, Knowledge,
Calendar, Providers, and Admin views, plus Checkpoints (browse, create,
restore, and diff) and Voice (batched spoken replies and microphone
dictation). Approvals, Tasks, and Workstream surfaces cover decision queues
and orchestration, with a ⌘K command palette and global hotkeys.

The repo is not published to npm by design; it is versioned with semantic git
tags and distributed as source. A green CI run on `main` tags the commit and
opens a GitHub Release with notes cut from `CHANGELOG.md`, with no build
artifacts attached.

One app serves desktop and phone; the phone gets a drawer-based layout of the
same views rather than a different mental model. It installs from the browser
as a standalone app with an offline shell and push notifications. It
does not need to run on the same machine as the daemon: point it at a daemon
reachable over Tailscale or the local network, or let the daemon serve the
built bundle itself, same-origin.

The application stays intentionally thin over the published SDK: browser code
uses the public scoped SDK seams from npm rather than hand-typed wire shapes,
and talks to the daemon through the configured WebUI origin and Vite proxy in
development, or same-origin in production.
Built with Bun, Vite, React, TypeScript, and TanStack Query, with Playwright
phone and desktop end-to-end suites running against a hermetic mock daemon.

### goodvibes-app

`goodvibes-app` is the native desktop operator console: chat, fleet,
automation, knowledge, code, and observability in one window. It unifies the
capability of `goodvibes-tui` and `goodvibes-agent` on top of
`@pellux/goodvibes-sdk`, built with Electrobun in Bun and TypeScript with no
Node, no Rust, and no Electron. The daemon does the work; the app is a
control surface over its operator contract, plus a handful of process-local
features (git, terminal, file-based registries) implemented directly in the
Bun main process.

The Bun main process adopts an already-running daemon at its default local
address or spawns one detached, serves the built UI from a loopback port, and
reverse-proxies API calls to the daemon while stamping the bearer token
server-side, so the webview never holds the credential. The UI is a React
single-page app in the system webview, with server state managed through
query caching and realtime invalidation over SSE. From 0.4.0 the app also
carries the wake-word stack for its own surface, serving the daemon's
verified voice models same-origin from the Bun side.

### goodvibes-homeassistant

`goodvibes-homeassistant` is the Home Assistant side of the GoodVibes daemon
contract. It installs as a custom integration under
`custom_components/goodvibes` and targets the latest published
`@pellux/goodvibes-sdk`; the exact daemon-contract version it was last
validated against is tracked in the repo's `docs/sdk-compatibility.md`.

It adds a `GoodVibes` conversation entity selectable as the agent in an Assist
pipeline (and usable as the agent behind a Wyoming voice satellite), an
admin-only `GoodVibes Home` sidebar panel for browsing and feeding the
daemon's Home Graph knowledge base, diagnostic sensors and repairs, a
GitHub-release-backed update entity, mail and calendar services backed by the
daemon's own accounts, and Home Assistant services for prompting, running
agents, and working with Home Graph facts and pages. Perception triggers,
habit mining, and causal provenance are opt-in extras, off by default, and
they only ever propose, never silently act. It installs via HACS as a custom
repository, or manually from each release's `goodvibes.zip`.

The daemon owns the model, routing, knowledge storage, and answer synthesis;
the integration stays deliberately thin: setup, Assist plumbing, services,
sensors, upload proxying, and the panel bridge. It implements no provider
routing, no local Home Graph storage, no wiki rendering, and no local graph
layout.

### goodvibes-plugin

`goodvibes-plugin` is a Claude Code plugin, separate from the GoodVibes
daemon/client stack. Version 2 is a rewrite around three MCP servers and 25
tools, scoped to capabilities Claude Code itself lacks rather than replacing
the ones it already handles well.

- **intel** (15 tools): structure-first code reading with outline and range
  modes, multi-query search with AST structural queries, glob with per-file
  stats, TypeScript API-surface and safe-delete analysis on a single compiler
  host, API route/spec/contract analyzers, DB schema intelligence with Prisma
  usage analysis, React component/hook/boundary analyzers, a merged layout
  analyzer, project scaffolding, and `structural_edit`, the one write tool,
  preview-gated.
- **analytics** (7 tools): per-session and cross-project token and cost
  analytics from transcript actuals with cache-aware per-model pricing, plus
  budgets, tags, export, a self-contained HTML report, and live modes that price
  the running session, surface host load and orphaned processes, and classify
  background agents.
- **connect** (3 tools): `api_request` for batched HTTP with per-entry error
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
and installs through Codex's plugin marketplace pointed at the repository
(`codex plugin marketplace add mgd34msu/goodvibes-codex`) or at a local
checkout. Setup is deliberate: workspaces must be registered from an
interactive terminal before intel's filesystem tools will touch them, and
authority-changing operations (services, credentials, trust mode) stay in
the interactive control utility, unavailable through MCP. A capability matrix
in the repo documents migration status relative to the Claude plugin.

### goodvibes-desktop

`goodvibes-desktop` is an Electron desktop application that wraps the Claude
CLI in a richer interface: multiple terminal sessions with tabs, session
analytics with token and usage tracking, a Git panel with staging, commits,
branches, and GitHub PR and issue management, a hooks system for customizing
Claude behavior, MCP server management, a skills library, agent templates, a
multi-project registry, and CLAUDE.md memory editing. It predates the daemon
stack and does not use it; like the plugin and the Codex port, it releases on
its own schedule through GitHub Releases.
