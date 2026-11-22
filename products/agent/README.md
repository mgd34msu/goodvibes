# GoodVibes Agent (`goodvibes-agent`)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GoodVibes Agent is a personal assistant that runs in your terminal. It gives you one workspace for chat, research, mail and calendar, reminders and schedules, notes, memory and document drafts, and it can send messages through your chat channels. It works through the GoodVibes daemon on your machine, which keeps the schedules, channels and knowledge it uses; the installer sets the daemon up for you. Anything it sends, spends or writes comes with a plain-language confirmation and a receipt with private details removed. It can reuse the provider and permission settings you already made for the `goodvibes` terminal app, so setup does not start from zero.

<img src="docs/assets/operator-workspace.png" alt="The fullscreen Agent workspace, titled Home · 10 actions · home default · account rtfake. The left column lists areas in groups ordered by an ordinary day: start, get things done (Inbox and calendar, Research, Documents and Files, Conversation, Work and Approvals, Schedules), remember and teach, tools and knowledge, homes and host, then set up. The right pane explains Home and Just start typing, then an Action and Command table: Set up GoodVibes /setup, Inbox, calendar and reminders /agent personal-ops, Research something /agent research and the other areas with their /agent commands. The footer keys read move, pane, open, / search, ctrl+] next area and ctrl+r refresh." width="900">

## Install and start

Install with the [suite installer](../../docs/installation.md), which installs the Agent together with the `goodvibes` terminal app, the daemon and the web UI:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

Then run `goodvibes-agent`. When no model is ready, it runs the same three-step first run as `goodvibes`: choose how to get a model (a ChatGPT subscription, an API key for Anthropic, OpenRouter or another provider, or a model server found on this computer), sign in or paste the key, and start the conversation. `/setup` sets up everything else one topic at a time (`/setup import-settings` brings over what you set in `goodvibes`), and `/agent` or `Ctrl+G` opens the workspace at any time. The [getting started guide](docs/getting-started.md) covers the rest. How often you are asked, and the optional decision model, are explained in the [decision-model policies](../../docs/decision-model-policy.md).

---

## A short tour

**The workspace and the commands are one.** `goodvibes-agent` starts on a conversation. The fullscreen workspace opens with `/agent` or `Ctrl+G`; each of its rows names a slash command action and opens the same guided form that command opens, and its side pane says what the selected row does and shows that command's own report. Browsing the workspace never reaches the network: a report that reads a mailbox, a provider or the daemon runs only when you ask for it with `Ctrl+R`. Press `/` inside the workspace to search every action by name, category, command, or detail. `Ctrl+P`, `?` or `/help` opens the one list of every command and key.

**One assistant, several jobs.** Beyond normal chat, the workspace gives you read-only web research with explicit hand-off into Agent Knowledge, versioned document drafting with blind model comparison, an Inbox & calendar area for inbox/agenda/task/reminder/note requests, and an Operator Runtime view of the connected host's own methods and service posture.

<img src="docs/assets/chat.png" alt="A chat turn in the Agent, titled GoodVibes Agent v3.4.5 with the question beside it. The user asks to explain the frost-date table and how to extend it; the reply, headed rt-1 · 1 tool, says Reading the table first, shows the folded tool line Reading files src/frost-dates.ts with a checkmark, then a syntax-highlighted TypeScript line, two bullets and the question Want me to add zones 5b to 7a? The status bar reads Asks: you, for now · you chose Jev decides, 3 notices, context 0%, branch main, changed and model rt-1." width="900">

**Local behavior is yours to shape.** A friendly `VIBE.md` personality file, separate from project instruction files (`AGENTS.md`, `CLAUDE.md`, and similar), plus local memory, notes, personas, and skills all live under the Agent home and are scanned for secret-looking content before they ever reach a prompt. Personas capture a reusable voice or role; skills capture a reusable capability; routines capture a reusable sequence you can start in chat and, as a separate explicit and confirmation-gated step, promote to a connected schedule.

**Automation stays visible, and you decide what is yours to decide.** What waits for you, what is running, what finished and what is scheduled show in Your agents (`F2`, `Ctrl+O` or `/agents`), the same panel as in the terminal app; a scheduled run that failed while the Agent was closed is named in one line when it starts. Who approves the rest follows `permissions.mode`, as in the terminal app: owner-only items (granting access, loosening a security, judgment or payment setting, a call your own "always ask me" rule covers, a change asked for from a channel, a deletion nothing keeps a copy of, sending to a new recipient, sending content derived from untrusted text, and changing what a contract requires) come to you in every mode but `yolo` (asked, or held for the end of the run in `just-vibes`), and Jev never answers them; in the default `jev-decides` mode Jev, the decision model, answers the judgment calls, and with no working decision model you are asked instead. Purchases inside the limits you set go ahead after a veto window. See [decision-model policies](../../docs/decision-model-policy.md#how-much-you-are-asked).

**The model can plan its own route.** Ask a plain question like "email the team a summary" or "what's blocked in setup" and the underlying model can call a route planner that maps the request to the right tool and confirmation boundary before doing anything. It does not have to guess at internal tool names, and ambiguous requests come back as candidates instead of a wrong guess.

<img src="docs/assets/model-picker.png" alt="The model picker, titled Models › Main chat › Model list, with a tab for each job: Main chat (selected), Side work (off), Tool work (off), Spoken replies and Decision model. The list, 1 of 2, holds rt-1 under not described by the catalog, marked tools and kind unknown. The detail pane names the target, the current model, the selected model's context and tools, kind unknown: the model catalog does not say what it reads and writes, its sign-in and the filters in use. The footer keys cover select, target, pin, refresh catalog, price, caps, available, benchmark, group and the context cap." width="900">

**Isolated by design.** Agent Knowledge is its own segment. Agent only talks to `/api/goodvibes-agent/knowledge/*` and never falls back to another product's knowledge store. Named Agent profiles (`goodvibes-agent profiles create ...`) give you separate, isolated config, sessions, memory, and personas per household, project, or role.

---

## What's in the box

Each row links to the page that documents it; the full list, including the pairing and legacy import procedures, is in [docs/README.md](docs/README.md). The workspace's own `/` search and `/help` are always the current authority.

| Area | What you get | Docs |
| --- | --- | --- |
| Getting started | Requirements, install paths, first-run areas, model-visible route table, isolated profiles | [getting-started.md](docs/getting-started.md) |
| Connected host | The one required daemon dependency, its knowledge routes, override env vars, product-boundary rules | [connected-host.md](docs/connected-host.md) |
| Providers and routing | Provider/model visibility, local provider definitions, the local model cookbook | [providers-and-routing.md](docs/providers-and-routing.md) |
| Tools and commands | Workspace actions, slash commands, CLI mirrors, model-tool catalog, settings and keybinding writes | [tools-and-commands.md](docs/tools-and-commands.md) |
| Knowledge, artifacts, and multimodal | Isolated Agent Knowledge, document/image/media artifacts, ingest and review routes | [knowledge-artifacts-and-multimodal.md](docs/knowledge-artifacts-and-multimodal.md) |
| Channels, remote access, and API | Slack, Discord, Telegram, Matrix, webhook, and other configured channels; setup/triage/delivery; companion pairing; the operator method catalog | [channels-remote-and-api.md](docs/channels-remote-and-api.md) |
| Voice and live TTS | Spoken playback, TTS/STT provider setup | [voice-and-live-tts.md](docs/voice-and-live-tts.md) |
| Google setup | The generated step-by-step runbook for connecting Gmail and Google Calendar (also printed by `/google runbook`), plus which OAuth scopes the integration requests and why | [google-setup-runbook.md](../../packages/engine/docs/google-setup-runbook.md), [google-scope-strategy.md](docs/google-scope-strategy.md) |

Full index: [docs/README.md](docs/README.md).

---

## Configuration

Settings live in a layered `settings.json`, editable through the `/settings` workspace or by hand:

- global: `~/.goodvibes/agent/settings.json`
- project: `.goodvibes/agent/settings.json`

A few keys worth knowing up front:

| Key | Default | What it does |
| --- | --- | --- |
| `update.autoUpdateAtLaunch` | `true` | Check for and install a newer release at launch (standalone binaries only) |
| `update.launchCheckTimeoutMs` | `2500` | How long that launch check may take before it is skipped; clamped to 250–30000 |
| `update.auto` | follows `update.autoUpdateAtLaunch` | Keep checking WHILE the agent runs, and install at an idle moment: no turn, sub-agent, background process or open approval, and nothing typed or open on screen. The new version replaces the running process and reopens the same session (standalone binaries only); an explicit value always wins over the inherited one |
| `update.intervalMinutes` | `60` | Minutes between those periodic checks; clamped to 5–1440 |
| `update.firstCheckSeconds` | `30` | Seconds after start before the first periodic check; clamped to 0–3600 |
| `checkpoints.preferGitRoot` | `true` | Snapshot the enclosing git repository's root rather than the raw working directory |
| `checkpoints.allowBroadRoot` | `false` | Opt in to snapshotting a broad root such as the filesystem root or home directory |
| `checkpoints.autoRetention` | `true` | Run a retention sweep automatically after each checkpoint |

Other useful overrides:

- `GOODVIBES_AGENT_HOME=/path/to/agent-home`: run with an isolated Agent home instead of the default one.
- `GOODVIBES_AGENT_RUNTIME_URL=https://host:port` (or the `--runtime-url` flag; `http://` is accepted too): point at a GoodVibes host on a different address for one run, as `daemon.connectedHost.url` does persistently; `GOODVIBES_AGENT_BASE_URL` is accepted as a legacy alias.
- `~/.goodvibes/agent/providers/*.json`: local, hot-reloaded custom provider definitions.
- `/setup import-settings` (or the model tool `import_goodvibes_settings`): preview, then apply, provider/UI/permission/subscription/surface/tool/daemon-endpoint settings already configured for goodvibes-tui or another published GoodVibes platform store, without mutating the source.

The full settings catalog, the checkpoint-guard keys, and the shared-settings-import contract are in [docs/tools-and-commands.md](docs/tools-and-commands.md) and [docs/getting-started.md](docs/getting-started.md).

---

## Reference

The sections below describe specific commands and requirements in detail.

### Purchase approval and veto windows

Type `/payments pending` in the owner terminal to read purchase notices from
the selected paired daemon. Select a purchase, read its notice and deadline,
then choose approve/deny or proceed-now/cancel. The menu retains that host and
window reference; changing the connection requires reopening it. Escape closes
the local view. An answer already sent may still complete on the host.

This requires a paired administrative credential with `read:payments` and
`write:payments`. `/payments` opens its list of actions. "Add a card" asks for
the card field by field, each hidden, and sends it to the selected daemon in one
`payments.cards.create` request; "Set your billing or shipping address" writes
the addresses, and "See your cards" (`/payments cards`) lists the cards the
daemon holds (never the number, CVV or name) and the addresses.

### Native work controls (local Jev implementation)

`/work open` discovers the authenticated daemon's native project without legacy
planning lookup; `/work open <daemon-project-id>` selects it explicitly.
`/work start|status|cancel|resume <work-id>` operates an existing native work
item. Commands derive attempt identity and revisions from the live ledger.

Start/resume require an existing active attempt and the daemon's current paired
operator authority. Execution controls do not create work or edit original criteria. Explicit source
submission is described below; ordinary text uses the native intake described next. Opening a view never starts or resumes
execution. Status/cancel retain the last observed attempt across a handoff within
that view; older attempts cannot be rediscovered after reopening this surface.

Reported work state, verified evidence, execution progress, admitted/current
revisions and recovery state remain distinct. A lost response leaves the server
outcome unknown. Closing or replacing host, token or workspace only aborts local
requests and discards their results; use Cancel to request host cancellation.
Pending and refused admissions, and cancellation before admission, have no
execution receipt or progress. They display requested revisions, separately from
admitted executions. Refused/interrupted admission recovery requires explicit
resume; a cancelled intent requires a new native attempt.
No control asks for owner approval or automatically retries/resumes execution.

### Ordinary conversation and first-start prerequisites

Ordinary owner text passes through the selected daemon's original-source intake
before any model receives it. With hosted routing enabled, conversational
results use identity-only native hosted delivery and later inputs retain the
same daemon-owned conversation. This requires an already paired operator,
`read:work-ledger`, `write:work-ledger` and `write:sessions`, a registered host
workspace, and a configured decision model when decision processing is enabled.
Turning hosted routing off selects the local native permit
path. Neither path uses a second legacy classification or source-less work
start. Missing authority, unsupported attachments or an unknown dispatch
produce a visible diagnostic; there is no legacy conversation fallback.

The exact original and delivery mode survive restart. `/work intake`
inspects and reopens observation; `intake-retry`, `intake-resume` and
`intake-cancel` recover or cancel that same original. A lost reply never creates
fresh IDs or switches delivery modes. An input whose journal save failed never
reached the host; `intake-cancel` discards it so the next input can be sent.
The intake journal holds only inputs in flight (see below) and never refuses a
new input for being full.

With connected-host dialing enabled and the shared operator credential configured,
pair Agent from its live terminal:

1. Run `/setup pair` to preview the selected host and pairing state.
2. Run `/setup pair --apply` to review the persistent administrative access being
   granted, then type the fresh confirmation phrase shown by the terminal.

Use `--name Agent` to choose the device name. Pairing invokes
`pairing.tokens.migrate` once, stores the returned per-device credential privately
for that host, and verifies its live principal. It requires the existing shared
operator's `write:control-plane` authority. Model, harness and nested commands
cannot confirm this grant. Opening Agent or finishing ordinary onboarding does
not create a credential, and pairing does not revoke the shared token. For the
daemon on the Agent's own machine no pairing is needed: the operator token file
the Agent already reads is the owner's credential there.

If pairing is interrupted, rerun `/setup pair` to inspect its saved state before
taking another action. An unknown outcome is preserved for review rather than
automatically minting another token. A stored but unverified credential is kept
for verification. Explicit token environment overrides take precedence over the
host-bound store; a `paired-shadowed` result identifies that condition without
changing the environment.

### Explicit native source submission

Both products use the same command contract:

- `/work submit-file <path>` reads a regular UTF-8 JSON file containing exactly
  `goal` (a string) and `criteria` (an ordered array of strings).
- `/work submission` looks up the retained request without writing work.
- `/work submission-retry` first looks up that same request. Only a `not-found`
  result can lead to replay of the exact retained request.
- `/work submission-discard` first looks up that same request. When the host
  has it, its receipt is shown and nothing is dropped; otherwise the retained
  request is removed and nothing is sent, so a corrected source can be
  submitted.

Example source file:

```json
{"goal":"  Deliver the original goal\nwithout rewriting it  ","criteria":["First criterion","Second criterion","First criterion"]}
```

Decoded goal/criterion strings are preserved verbatim, including whitespace,
line breaks, order and duplicates. No model generates or changes criteria.
Blank/whitespace-only values and missing criteria are rejected locally. Each
string is limited to 20,000 UTF-16 code units; 1–100 criteria are required. Both
the source file and complete encoded submission must fit 262,144 UTF-8 bytes.
For paths containing spaces, use a file URL such as
`file:///tmp/my%20source.json`, which survives both slash-command parsers.

Initial submission generates request/input IDs and captures the live whole-ledger
revision once. Before sending, the app durably publishes the exact source, IDs and
revision in its private `native-work-submission.json` journal under its product
state directory. The journal binds each request to the exact daemon endpoint,
canonical workspace, project and live server-verified paired principal. It stores
no bearer token. The conversation intake journal beside it holds only inputs in
flight: a record exists from submit until the host gives a terminal answer
(blocked, refused or cancelled, including `/work intake-cancel`), the work receipt
exists and its execution was requested, the hosted turn finishes, or the local
turn that was dispatched has ended; then it is removed. It has no record cap and
never refuses a new input for being full. Corrupt, oversized, symlink-backed or
unconfirmable state fails closed without a submission. The work-submission
journal has no record cap (the file is bounded at 2 MiB): a binding is removed
once its submission has a validated receipt, or when `submission-discard` drops
it after the host reported it does not have it, and one whose outcome is not
yet known is never evicted.

After a restart, use `submission` or `submission-retry` to recover the
original request. Both first look it up using that same identity. Retry does not
reread the source file, generate new IDs or refresh the revision. Only an explicit
retry after `not-found` can send the identical durably confirmed request. A
`not-found` lookup is not proof that a lost in-flight request cannot still arrive.
A persistence failure sends nothing and retains any uncertain journal publication
for inspection/recovery; it never deletes or silently replaces that identity.
Changing credentials to another principal cannot replay the old principal's
journal. Host, token, project and canonical-workspace changes or cleanup discard
in-flight results; overlapping submission commands remain single-flight.

A definite stale-ledger conflict permits an explicitly new `submit-file` command
to capture a new identity/revision. An unresolved retained request must be looked
up before submitting a new source. Submission/replay never starts execution.

Submission requires an existing paired operator with native ledger read/write
scopes. It never grants scopes, stores credentials or starts execution. The
receipt identifies the created work/current attempt and preserves the original
source; inspect `/work` and use its separate explicit Start control.

---

## Development

Agent builds on the existing terminal renderer and workspace foundations of the GoodVibes platform; what differs is the product layer composed on top of them.

```sh
git clone https://github.com/mgd34msu/goodvibes.git
cd goodvibes
bun install
bun run build
bun run --cwd products/agent dev
```

Run these commands from `products/agent` after preparing the monorepo:

| Command | Does |
| --- | --- |
| `bun run dev` | Run the Agent TUI from source |
| `bun run test` | Run this product's tests except `src/test/e2e/` through the shared runner, `packages/engine/scripts/test.ts` (`bun run test:e2e` runs the end-to-end files) |
| `bun run typecheck` | Type-check the source tree |
| `bun run build` | Bundle the workspace package entrypoint into `dist/package/main.js` |
| `bun run build:binary` | Compile the native Agent executable and stage its sqlite-vec library in `dist/lib` |

Source layout, in brief:

```text
src/
├── main.ts, core/       terminal entrypoint, orchestrator
├── agent/               channel, calendar, document, and automation domain logic
├── tools/               agent-owned model tools (harness, workspace, channels, knowledge, work plans, ...)
├── permissions/         approval posture and confirmation prompts
├── input/               slash commands, workspace actions, command routing, MCP server management
├── renderer/            terminal UI
├── cli/, cli-flags.ts   CLI subcommands and flags, package verification
├── config/              settings, secrets, checkpoint and update policy
├── runtime/             update checks, release-artifact resolution
├── audio/               spoken-turn playback and routing
└── verification/        release-readiness and evidence checks
```

Tests live under `src/test/`, mirroring the source tree, and cover runtime contracts, security boundaries and workspace/tool/CLI behavior. Use the declared workspace scripts above or the root product checks; package publication commands from the upstream product are not part of this private workspace.

The Agent consumes `@goodvibes/engine` and `@goodvibes/daemon` through `workspace:*` dependencies for shared contracts, daemon routes, and transports, and keeps the workspace, local behavior library, and Agent Knowledge boundary here. GoodVibes Agent owns the autonomous assistant harness; the connected GoodVibes host owns the platform capabilities Agent presents.

---

## Stability

GoodVibes ships as one suite version. Changes are recorded in the [suite changelog](../../packages/engine/CHANGELOG.md) and the [release notes](../../docs/releases/); the current release is [3.3.2](../../docs/releases/3.3.2.md).

## License

MIT
