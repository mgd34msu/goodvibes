# GoodVibes Agent (`goodvibes-agent`)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GoodVibes Agent is a personal assistant that runs in your terminal. It gives you one place for chat, research, mail and calendar, reminders and schedules, notes, memory and document drafts, and it can send messages through your chat channels. It works through the GoodVibes daemon on your machine, which keeps the schedules, channels and knowledge it uses; the installer sets the daemon up for you. Anything it sends, spends or writes comes with a plain-language confirmation and a receipt with private details removed. It can reuse the provider and permission settings you already made for the `goodvibes` terminal app, so setup does not start from zero.

## Install and start

Install with the [suite installer](../../docs/installation.md), which installs the Agent together with the `goodvibes` terminal app, the daemon and the web UI:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

Then run `goodvibes-agent`. When no model is ready, it runs the same three-step first run as `goodvibes`: choose how to get a model (a ChatGPT subscription, an API key for Anthropic, OpenRouter or another provider, or a model server found on this computer), sign in or paste the key, and start the conversation. The Setup tab of System (`Ctrl+G` `m` opens the menu of every place) sets up everything else one topic at a time (its row `Import settings` brings over what you set in `goodvibes`), and the menu reaches every place at any time. The [getting started guide](docs/getting-started.md) covers the rest. How often you are asked, and the optional decision model, are explained in the [decision-model policies](../../docs/decision-model-policy.md).

---

## A short tour

**Everything is a place in one menu.** `goodvibes-agent` starts on a conversation. `Ctrl+G` then `m` opens the menu of every place (the leader `Ctrl+G` starts a two-key shortcut and the screen lists what can follow), the same places as the `goodvibes` terminal app: Work and agents, Memory and knowledge, Mail, calendar and channels, Automation, System and the rest. Each place reads what it shows by itself and keeps it up to date, and a key on the selected row does each thing; typing in the menu finds a place, a tab or an action by name. `Ctrl+P`, `?` or `/help` opens the one list of the few commands that remain and every key.

**One assistant, several jobs.** Beyond normal chat, the places give you read-only web research with explicit hand-off into Agent Knowledge (Work and agents), versioned document drafting (Memory and knowledge) with blind model comparison (Models and providers), and your inbox, calendar and channels (Mail, calendar and channels).

<img src="docs/assets/chat.png" alt="A chat turn in the Agent, titled GoodVibes Agent v3.5.0 with the question beside it. The user asks to explain the frost-date table and how to extend it; the reply, headed rt-1 · 1 tool, says Reading the table first, shows the folded tool line Reading files src/frost-dates.ts with a checkmark, then a syntax-highlighted TypeScript line, two bullets and the question Want me to add zones 5b to 7a? The status bar reads Permissions: Ask me, shift+tab, 3 notices (the newest saying it is not connected to a GoodVibes host), model rt-1 and ctrl+g workspace." width="900">

**Local behavior is yours to shape.** A friendly `VIBE.md` personality file, separate from project instruction files (`AGENTS.md`, `CLAUDE.md`, and similar), plus local memory, notes, personas, and skills all live under the Agent home and are scanned for secret-looking content before they ever reach a prompt. Personas capture a reusable voice or role; skills capture a reusable capability; routines capture a reusable sequence you can start in chat and, as a separate explicit and confirmation-gated step, promote to a connected schedule.

**Automation stays visible, and you decide what is yours to decide.** What waits for you, what is running, what finished and what is scheduled show in Your agents (`F2`, `Ctrl+O` or `/agents`), the same panel as in the terminal app; a scheduled run that failed while the Agent was closed is named in one line when it starts. Who approves the rest follows `permissions.mode`, as in the terminal app: owner-only items (granting access, loosening a security, judgment or payment setting, a call your own "always ask me" rule covers, a change asked for from a channel, a deletion nothing keeps a copy of, sending to a new recipient, sending content derived from untrusted text, and changing what a contract requires) come to you in every mode but `yolo` (asked, or held for the end of the run in `just-vibes`), and Jev never answers them; in the default `jev-decides` mode Jev, the decision model, answers the judgment calls, and with no working decision model you are asked instead. Purchases inside the limits you set go ahead after a veto window. See [decision-model policies](../../docs/decision-model-policy.md#how-much-you-are-asked).

**The model can plan its own route.** Ask a plain question like "email the team a summary" or "what's blocked in setup" and the underlying model can call a route planner that maps the request to the right tool and confirmation boundary before doing anything. It does not have to guess at internal tool names, and ambiguous requests come back as candidates instead of a wrong guess.

<img src="docs/assets/model-picker.png" alt="The model picker, titled Models › Main chat › Model list, with Main chat selected and Other jobs (optional) beside it. Under a search field reading only models you can use · 1 of 2 and the filters ctrl+t price: any, ctrl+k needs: any, ctrl+a usable only, ctrl+b sort: off and ctrl+g by: provider, rt-1 is listed under not described by the catalog, marked tools and not in the catalog. The detail pane names its provider rtfake, says it is not described by the model catalog and is usable as a text model, and lists what it serves, its status configured, its sign-in and 200k context. The footer keys read move, select, tab next job, ctrl+f pin, ctrl+r refresh catalog and space context cap." width="900">

**Isolated by design.** Agent Knowledge is its own segment. Agent only talks to `/api/goodvibes-agent/knowledge/*` and never falls back to another product's knowledge store. Named Agent profiles (`goodvibes-agent profiles create ...`) give you separate, isolated config, sessions, memory, and personas per household, project, or role.

---

## What's in the box

Each row links to the page that documents it; the full list, including the pairing and legacy import procedures, is in [docs/README.md](docs/README.md). The menu (`Ctrl+G` then `m`; typing there finds a place, a tab or an action) and `/help` are always the current authority.

| Area | What you get | Docs |
| --- | --- | --- |
| Getting started | Requirements, install paths, first-run areas, model-visible route table, isolated profiles | [getting-started.md](docs/getting-started.md) |
| Connected host | The one required daemon dependency, its knowledge routes, override env vars, product-boundary rules | [connected-host.md](docs/connected-host.md) |
| Providers and routing | Provider/model visibility, local provider definitions, the local model cookbook | [providers-and-routing.md](docs/providers-and-routing.md) |
| Tools and commands | The places, slash commands, CLI mirrors, model-tool catalog, settings and keybinding writes | [tools-and-commands.md](docs/tools-and-commands.md) |
| Knowledge, artifacts, and multimodal | Isolated Agent Knowledge, document/image/media artifacts, ingest and review routes | [knowledge-artifacts-and-multimodal.md](docs/knowledge-artifacts-and-multimodal.md) |
| Channels, remote access, and API | Slack, Discord, Telegram, Matrix, webhook, and other configured channels; setup/triage/delivery; companion pairing; the operator method catalog | [channels-remote-and-api.md](docs/channels-remote-and-api.md) |
| Voice and live TTS | Spoken playback, TTS/STT provider setup | [voice-and-live-tts.md](docs/voice-and-live-tts.md) |
| Google setup | The generated step-by-step runbook for connecting Gmail and Google Calendar (also shown by "the written steps" on the Google tab of Mail, calendar and channels), plus which OAuth scopes the integration requests and why | [google-setup-runbook.md](../../packages/engine/docs/google-setup-runbook.md), [google-scope-strategy.md](docs/google-scope-strategy.md) |

Full index: [docs/README.md](docs/README.md).

---

## Configuration

Settings live in a layered `settings.json`, editable through the settings screen (`/settings`) or by hand:

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
- `Import settings` on the Setup tab of System (or a model's `capability_run id:"settings.copy-from-terminal-app"`): each setting you set in the terminal app that the Agent holds differently is set the same in the Agent, and the answer names every one; a setting that loosens a protection is copied only when you choose to copy those too. The terminal app's settings are not changed; sign-ins are already shared by both programs.

The full settings catalog, the checkpoint-guard keys, and the shared-settings-import contract are in [docs/tools-and-commands.md](docs/tools-and-commands.md) and [docs/getting-started.md](docs/getting-started.md).

---

## Reference

The sections below describe specific commands and requirements in detail.

### Purchase approval and veto windows

The purchases waiting for you are on the Purchases tab of Waiting for you (the
menu of places): select one, read its notice and deadline, then press the
answer it offers (approve or deny, go ahead now or cancel), stop a checkout, or
type a card's security code on the hidden line. An answer already sent may
still complete on the host.

Cards, the billing and shipping addresses and the purchases you allow ahead of
time are in Money. On its Cards tab, `n` ("Add a card") is a form with every
card field hidden, sent to the daemon in one `payments.cards.create` request;
the tab lists the cards the daemon holds (never the number, CVV or name), and
`Enter` on the Addresses tab writes an address.

### Work on the host

The Work place (the menu's "Work and agents" row, or `/work`) shows your work,
held and run by the daemon, the same as in the terminal app: start, stop, go on,
answer what it asks, run a failed step again, change what it may spend, and the
project's checklist. Opening it never starts anything, and no key approves
anything for you. See [the terminal app's work page](../tui/docs/native-work.md).

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

The exact original and delivery mode survive restart. In the Work place, the input
waiting to be admitted can be seen, sent again, gone on with or dropped: the same
original each time. A lost reply never creates
fresh IDs or switches delivery modes. An input whose journal save failed never
reached the host; dropping it lets the next input be sent.
The intake journal holds only inputs in flight (see below) and never refuses a
new input for being full.

To make Agent your own device on a daemon on another computer (with
`daemon.connectedHost.url` set), start it yourself where you are signed in as
yourself (that daemon's web UI with your password, or your terminal app on that
computer: Devices and network, Pair something, A phone or another device, "Show
the sign-in code once"). Then press Pair something, "This program with its
daemon", in Devices and network (the menu, `Ctrl+G` then `m`) in the Agent's
own terminal and type that code under Sign-in code (hidden as you type). The
host confirms it as a device and the Agent keeps it in this Agent home. Each
code works once and for 15 minutes. With no code the control says how the Agent
reaches its daemon: for the daemon on the Agent's own computer there is nothing
to pair, the Agent is your own program there.

Its form's Name field chooses the device name. Only you can pair: a model or
another command cannot. From a shell, `goodvibes-agent setup pair --with-code`
reads the code from the terminal. `goodvibes-agent setup pair --apply` asks
that host for an administrator key from its shared operator token, put to you
there; on your yes it is an ordinary key, never your device.

If a `setup pair --apply` request is interrupted, run it again to see where it got to. When
the host's answer was lost, the same request is repeated and the host answers it
with the key it already made, never a second one. A key that was kept but not
yet confirmed by the host is kept and checked with `goodvibes-agent setup status`. A key set in
the environment is used before the saved one; the result says so
(`paired-shadowed` in JSON) and leaves the environment as it is.

### Asking for work and recovering a lost request

In the Work place, New work asks for new work with what done means, and Work
from a file takes a JSON file; in the chat, what you say is the request. A request
whose answer was lost, and input waiting to be admitted, can be seen, sent again or
dropped there too. The same in both programs:
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
