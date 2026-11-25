# GoodVibes Agent (`goodvibes-agent`)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GoodVibes Agent is a personal assistant that runs in your terminal. It gives you one workspace for chat, research, mail and calendar, reminders and schedules, notes, memory and document drafts, and it can send messages through your chat channels. It works through the GoodVibes daemon on your machine, which keeps the schedules, channels and knowledge it uses; the installer sets the daemon up for you. Anything it sends, spends or writes comes with a plain-language confirmation and a receipt with private details removed. It can reuse the provider and permission settings you already made for the `goodvibes` terminal app, so setup does not start from zero.

<img src="docs/assets/operator-workspace.png" alt="The fullscreen Agent workspace, titled Agent workspace › Home · 10 actions, with Agent home default, model rt-1 (rtfake) and daemon on this computer beside it. The left column lists areas in groups: get things done (Inbox and calendar, Research, Documents and Files, Conversation, Work and Approvals, Schedules), memory and habits, tools and knowledge, where it runs, then set up. The right pane is an Action and Command table, from Just start typing (selected) and Set up GoodVibes /setup to Work and Approvals /agent work and Set how much the app prints /verbosity set, with Just start typing and Home explained below it. The footer reads a-z ask the assistant (Esc comes back), then move, pane, open, / search and ctrl+r refresh." width="900">

## Install and start

Install with the [suite installer](../../docs/installation.md), which installs the Agent together with the `goodvibes` terminal app, the daemon and the web UI:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

Then run `goodvibes-agent`. When no model is ready, it runs the same three-step first run as `goodvibes`: choose how to get a model (a ChatGPT subscription, an API key for Anthropic, OpenRouter or another provider, or a model server found on this computer), sign in or paste the key, and start the conversation. `/setup` sets up everything else one topic at a time (`/setup import-settings` brings over what you set in `goodvibes`), and `/agent` or `Ctrl+G` opens the workspace at any time. The [getting started guide](docs/getting-started.md) covers the rest. How often you are asked, and the optional decision model, are explained in the [decision-model policies](../../docs/decision-model-policy.md).

---

## A short tour

**The workspace and the commands are one.** `goodvibes-agent` starts on a conversation. The fullscreen workspace opens with `/agent` or `Ctrl+G`; each of its rows names a slash command action and opens the same guided form that command opens, and its side pane says what the selected row does and shows that command's own report. The workspace reads its reports by itself: what is waiting is read at every start, each area's reports as soon as it is shown, and the work list stays live; `Ctrl+R` reads everything again now. Press `/` inside the workspace to search every action by name, category, command, or detail. `Ctrl+P`, `?` or `/help` opens the one list of every command and key.

**One assistant, several jobs.** Beyond normal chat, the workspace gives you read-only web research with explicit hand-off into Agent Knowledge, versioned document drafting with blind model comparison, an Inbox & calendar area for inbox/agenda/task/reminder/note requests, and an Operator Runtime view of the connected host's own methods and service posture.

<img src="docs/assets/chat.png" alt="A chat turn in the Agent, titled GoodVibes Agent v3.5.0 with the question beside it. The user asks to explain the frost-date table and how to extend it; the reply, headed rt-1 · 1 tool, says Reading the table first, shows the folded tool line Reading files src/frost-dates.ts with a checkmark, then a syntax-highlighted TypeScript line, two bullets and the question Want me to add zones 5b to 7a? The status bar reads Permissions: Ask me, shift+tab, 3 notices (the newest saying it is not connected to a GoodVibes host), model rt-1 and ctrl+g workspace." width="900">

**Local behavior is yours to shape.** A friendly `VIBE.md` personality file, separate from project instruction files (`AGENTS.md`, `CLAUDE.md`, and similar), plus local memory, notes, personas, and skills all live under the Agent home and are scanned for secret-looking content before they ever reach a prompt. Personas capture a reusable voice or role; skills capture a reusable capability; routines capture a reusable sequence you can start in chat and, as a separate explicit and confirmation-gated step, promote to a connected schedule.

**Automation stays visible, and you decide what is yours to decide.** What waits for you, what is running, what finished and what is scheduled show in Your agents (`F2`, `Ctrl+O` or `/agents`), the same panel as in the terminal app; a scheduled run that failed while the Agent was closed is named in one line when it starts. Who approves the rest follows `permissions.mode`, as in the terminal app: owner-only items (granting access, loosening a security, judgment or payment setting, a call your own "always ask me" rule covers, a change asked for from a channel, a deletion nothing keeps a copy of, sending to a new recipient, sending content derived from untrusted text, and changing what a contract requires) come to you in every mode but `yolo` (asked, or held for the end of the run in `just-vibes`), and Jev never answers them; in the default `jev-decides` mode Jev, the decision model, answers the judgment calls, and with no working decision model you are asked instead. Purchases inside the limits you set go ahead after a veto window. See [decision-model policies](../../docs/decision-model-policy.md#how-much-you-are-asked).

**The model can plan its own route.** Ask a plain question like "email the team a summary" or "what's blocked in setup" and the underlying model can call a route planner that maps the request to the right tool and confirmation boundary before doing anything. It does not have to guess at internal tool names, and ambiguous requests come back as candidates instead of a wrong guess.

<img src="docs/assets/model-picker.png" alt="The model picker, titled Models › Main chat › Model list, with Main chat selected and Other jobs (optional) beside it. Under a search field reading only models you can use · 1 of 2 and the filters ctrl+t price: any, ctrl+k needs: any, ctrl+a usable only, ctrl+b sort: off and ctrl+g by: provider, rt-1 is listed under not described by the catalog, marked tools and not in the catalog. The detail pane names its provider rtfake, says it is not described by the model catalog and is usable as a text model, and lists what it serves, its status configured, its sign-in and 200k context. The footer keys read move, select, tab next job, ctrl+f pin, ctrl+r refresh catalog and space context cap." width="900">

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

### Work on the host

`/work open` opens the work view (`/work open <project id>` for another project);
`/work start`, `status` (check), `cancel` (stop) and `resume <work id>` act on one
work. Opening the view never starts anything, and no key approves anything for
you. See [the terminal app's work page](../tui/docs/native-work.md).

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

To give Agent its own key for a daemon on another computer (with
`daemon.connectedHost.url` set and the host's shared operator token given to
the Agent), type `/setup pair` in the Agent's own terminal. It is one step: the
Agent checks the host, says what pairing allows (lasting administrator access
to that host, kept only in this Agent home), and asks you to type the code it
shows, such as `PAIR 3f9a1c0b2d4e`, then Enter. Enter alone or Esc cancels; a
different code cancels too and says so (`That is not the code shown…`), and
each code works once, so `/setup pair` again gives a new one.
The code is typed rather than a single `y` because the access lasts until you
revoke it: a `y` pressed by habit can never grant it.

Use `--name Agent` to choose the device name. Only you can confirm: a model or
another command gets the summary and nothing else. Opening Agent or finishing
setup does not create a key, and pairing does not revoke the shared token. For
the daemon on the Agent's own computer no pairing is needed: the operator token
file the Agent already reads is your key there. From a shell,
`goodvibes-agent setup pair` shows the summary and
`goodvibes-agent setup pair --apply` asks for the code.

If pairing is interrupted, run `/setup pair` again to see where it got to. When
the host's answer was lost, the same request is repeated and the host answers it
with the key it already made, never a second one. A key that was kept but not
yet confirmed by the host is kept and checked with `/setup status`. A key set in
the environment is used before the saved one; the result says so
(`paired-shadowed` in JSON) and leaves the environment as it is.

### Asking for work and recovering a lost request

`/work new` asks for new work with what done means, `/work request` in your own
words, `/work submit-file <path>` from a JSON file (a path with spaces needs no
quoting). A request whose answer was lost is recovered with `/work submission`,
`submission-retry` and `submission-discard`; input waiting to be admitted with
`/work intake` and its steps. The same command in both programs:
[the terminal app's work page](../tui/docs/native-work.md).

---

## How it fits with the rest of GoodVibes

How the Agent, the terminal app, the daemon and the web UI fit together, what
runs where and why: [How GoodVibes works](../../docs/how-goodvibes-works.md).

---

## Stability

GoodVibes ships as one suite version. Changes are recorded in the [suite changelog](../../packages/engine/CHANGELOG.md) and the [release notes](../../docs/releases/), one file per release.

## License

MIT
