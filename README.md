# GoodVibes

GoodVibes is an AI agent you run on your own computer. In a terminal, it works
on your code: it reads and edits files, runs commands and tests, searches the
web and hands side jobs to helper agents. As a personal assistant, it handles
your mail and calendar, reminders and scheduled jobs, answers you in Telegram,
Slack and other chat apps, and can buy things within limits you set. A
background service keeps that work going when no terminal is open and serves a
web app you can use from your phone.

You bring the model: Anthropic, OpenAI (API key or ChatGPT subscription),
Google Gemini, OpenRouter, GitHub Copilot, AWS Bedrock and many others, or a
model server on your own machine such as Ollama or LM Studio. Your settings,
sessions and keys stay on your machine.

What you will notice:

- **It asks you less.** Reading, searching and editing inside your project just
  happen. You are asked only what is yours to decide, and you choose how often
  ([How much it asks you](#how-much-it-asks-you)).
- **It is quick.** Measured for release 3.3.0 with scripted models that answer
  instantly, a turn with twelve tool calls spent 62 ms in GoodVibes itself,
  against 228 ms before that release
  ([measurements](docs/releases/3.3.0.md#speed)).
- **A second model can make routine calls for you, and it is optional.**
  Everything works without it ([The decision model](#the-decision-model)).

## Install

Linux or macOS, x64 or arm64. On Windows, use WSL2 ([notes](docs/windows.md)).

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer downloads the prebuilt release, checks every file against the
release's checksums and puts these in `~/.local/bin`:

| Program | What it is for |
| --- | --- |
| `goodvibes` | The terminal app for working in a project. |
| `goodvibes-agent` | The personal assistant: mail, calendar, reminders, research, notes. |
| `goodvibes-daemon` | The background service the other programs connect to. |
| Web UI | The browser app, served by the daemon. |

It also installs a browser driver for the agent's browser tools, sets the
daemon up as a user service (systemd on Linux, launchd on macOS) and starts it,
and adds `~/.local/bin` to your `PATH` when it is missing. It needs no Bun,
Node, Git or compiler. When it finishes, it prints the command to start with
and the web app's address.

- **Pick a version:** `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.4.3 sh`
- **Skip the service:** add `GOODVIBES_DAEMON_SERVICE=0` the same way.
- **Updates** install themselves: the daemon checks hourly and waits until no
  work is running, and the terminal apps check when they start. Running the
  install command again also updates.
- **Uninstall:** `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh`
  removes the programs and the service and keeps your settings, sessions and
  memory in `~/.goodvibes`.

All options, and what happens when an install fails: [installation guide](docs/installation.md).
To build from a source checkout instead, run `./scripts/install-from-checkout.sh`.

## First run

Open a terminal in a project and start the terminal app:

```sh
cd ~/code/my-project
goodvibes
```

1. **Set up a model, in three steps.** When the model it would use is not
   ready, **Welcome to GoodVibes** asks **Which model should answer you?**:
   a ChatGPT subscription, Anthropic, OpenRouter, a model found on this
   computer (Ollama, LM Studio and the like), or another provider. Next, sign
   in with your browser or paste the API key; a key the provider refuses is
   not kept. Then the conversation opens with one sentence saying when
   GoodVibes asks before acting. When a key
   in your environment already makes a provider usable, `a` uses it and skips
   the sign-in step; with `OPENROUTER_API_KEY` set (the default model is
   OpenRouter's free one), it asks nothing and opens the conversation. `/setup`
   sets up the rest one topic at a time, `/model` switches models and `/scan`
   finds model servers on your machine and network.
2. **Ask about the project.** Type `What does this project do, and how do I run
   its tests?` and press Enter. It reads the files it needs and answers.
3. **Ask for a change.** Type `Add a --verbose flag to the CLI and run the
   tests.` The first time it wants to write or run something in a folder, it
   asks whether to trust the folder: **Trust this workspace** lets it work,
   **Keep restricted** keeps it read-only. When it asks before running a
   command, you can allow it once, allow it and remember the rule, or deny it
   with a reason it reads.

`?`, `/help` or `Ctrl+P` lists every command and key, `Esc` interrupts a reply
and `Ctrl+C` twice quits. `goodvibes doctor` checks the setup. The personal
assistant starts with `goodvibes-agent`, which runs the same three-step first
run.

## What you can do

- **Work on code.** Run `goodvibes` in a project and say what you want done.
  ([terminal app](products/tui/README.md))
- **Hand off a task and keep working.** Ask `spawn an agent to write tests for
  src/parser.ts`. It runs beside your conversation, in its own git worktree
  when you want one; `F2` shows everything running.
  ([agents](products/tui/docs/tools-and-commands.md#spawning-an-agent))
- **Have it check something on a schedule.** `/schedule add --every 30m check
  that https://example.com/health answers` runs that request every 30 minutes.
  The daemon runs it, so no terminal needs to be open; `/schedule list` shows
  your schedules. ([commands](products/tui/docs/commands-reference.md))
- **Reach it from your phone or a chat app.** `goodvibes pair` prints a QR
  code that signs your phone in to the web app (run
  `goodvibes-daemon webui enable --lan` first so your phone can reach it).
  `/devices pair channel telegram` connects a Telegram bot; Slack, Discord, Signal,
  WhatsApp, Matrix and others work the same way.
  ([web app](products/webui/docs/operator-guide.md#signing-in-and-pairing),
  [channels](products/tui/docs/channels-remote-and-api.md#channels-command))
- **Mail and calendar.** In `goodvibes-agent`, `/google connect` links Gmail and
  Google Calendar. Then ask `what's on my calendar tomorrow?`.
  ([Google setup](packages/engine/docs/google-setup-runbook.md))
- **Search what it knows.** `/knowledge ingest-url <url>` saves a page, and
  `/knowledge search <words>` or `/knowledge ask <question>` finds it later.
  The assistant keeps its own store: `goodvibes-agent search "release checklist"`.
  ([knowledge](products/tui/docs/knowledge-artifacts-and-multimodal.md))
- **Buy something within limits.** Purchases are off until you set
  `payments.enabled`. Add a card with `/payments add-card`, then set your limits:
  a daily budget for item prices (`payments.budget.dailyItem`), a ceiling per
  purchase (`payments.budget.perPurchaseCeiling`) and a daily allowance for
  tax, fees and delivery (`payments.budget.dailyOverage`). All three start at
  0: until you set the first two, every purchase asks you, and a purchase whose
  tax, fees and delivery do not fit the third is refused. Inside your limits a
  purchase goes ahead after a 10-minute window in which one word stops it;
  over a limit, it asks you and says by how much.
  ([purchases](packages/engine/docs/payments.md))
- **Use the web app.** Open the address the installer printed (on a default
  install, `http://127.0.0.1:3421`). It has chat, running work, what is waiting
  for you, what GoodVibes remembers, and your mail and calendar.
  ([operator guide](products/webui/docs/operator-guide.md))
- **Run it from a script.** `goodvibes run "summarize the last commit" --output json`
  runs one request without the interface and prints a JSON result;
  `--timeout` and `--max-turns` bound it. ([flags](products/tui/docs/cli-flags.md),
  [exit codes](docs/exit-codes.md))
- **Use it from your editor.** `goodvibes acp` runs it as an Agent Client
  Protocol agent for editors such as Zed.

## The four programs

**`goodvibes`**, the terminal app. Use it to work in a project: code, commands,
tests and helper agents. [More](products/tui/README.md)

**`goodvibes-agent`**, the personal assistant in the terminal. Use it for chat,
research, mail and calendar, reminders, notes and memory; it hands coding work
to `goodvibes` with `/agents hand-off`. [More](products/agent/README.md)

**`goodvibes-daemon`**, the background service. It holds schedules, channels,
knowledge and web sessions, and lets your other devices connect. The installer
runs it as a service; `goodvibes-daemon status` shows what it is doing.
[More](products/daemon/README.md)

**The web UI**, the browser app the daemon serves. Use it from any browser, or
install it on your phone's home screen. [More](products/webui/README.md)

## How much it asks you

An agent that can run commands, edit files and spend money has to stop and ask
you sometimes. How often is up to you.

Each action the agent wants to take goes one of three ways:

- **Plainly safe actions just run:** reading and searching, editing files
  inside the project, and commands you have already allowed with a remembered
  rule.
- **Actions only you can decide come to you:** for example deleting something
  nothing keeps a copy of (`rm`, `git reset --hard`), sending a message as you
  to someone new, giving a device, tool or person access, or loosening a
  security or spending setting. This holds in every mode except `yolo`.
  Purchases over your limits come to you in every mode.
  ([Full list](docs/decision-model-policy.md#how-much-you-are-asked))
- **Everything in between**, such as a command no rule covers yet, is either
  put to you or decided by a second, small, fast model, so you are not
  interrupted.

That second model is called the **decision model**; the one GoodVibes is built
around is **Jev**. The setting `permissions.mode` is a dial from "ask me" to
"don't ask":

| Mode | What you experience |
| --- | --- |
| `ask-me` | You are asked about the risky in-between actions: those the decision model reads as critical, hard to undo or weakening security. With no decision model, you are asked about all of them. |
| `jev-decides` (default) | The decision model settles the in-between actions, and you are asked only what is yours alone. With no working decision model, you are asked as in `ask-me`. |
| `just-vibes` | Nothing stops to ask you. Anything that needs you is set aside and listed at the end of the run, where `/held` approves or drops it. |
| `yolo` | No permission questions, except about a change requested from a chat channel. Spending limits, sign-in, the project boundary and secret storage still apply, and the agent can never answer an approval for you. |

In `goodvibes`, `Shift+Tab` changes the mode for the current session.
`--just-vibes` or `--yolo` sets it for one launch of either terminal app, and
`/settings` (Permission Mode) saves it. Plan mode, `/decisions` and the rest:
[permission modes](docs/decision-model-policy.md#permission-modes).

## The decision model

The decision model makes routine calls so you are asked less. It is optional:
coding, commands, tests, chat and the rest work without one, and you are asked
instead. To set one up, choose it in `/settings` under Judgment; the
[decision model guide](docs/decision-model-policy.md) walks through the
choices. By default, GoodVibes lets a decision model answer for you only when
its accuracy has been checked, which today means the hosted Jev. To let a
different one answer, choose the `jev-decides` mode yourself in `/settings`.

The `judgment.policy` setting says what happens when a decision model is set:

- **Hybrid** (default): when it fails, work carries on without it, and you are
  told once.
- **Decision Model Only**: when it fails, work that needs it stops and says why.
- **No Decision Model**: no decision model is used.

You are always told when no decision model is in use: once in the
conversation, in `goodvibes status` and `goodvibes-agent status`, in headless
JSON results, and in the permission mode chip in the web app's header. A few features need a decision model
and say so when none is in use. How much you are asked under each mode and
policy: [decision model guide](docs/decision-model-policy.md).

## Running on more than one machine

- **Other devices:** `goodvibes-daemon webui enable --lan` makes the web app
  reachable from your network, and `goodvibes pair` signs a phone or laptop in.
  ([pairing](packages/engine/docs/pairing.md))
- **An always-on machine:** run the daemon on a home server and reach it from
  any browser, or from the terminal app over SSH
  ([remote access](products/tui/docs/remote-access.md)). A terminal app on
  another machine connects with `goodvibes host pair`
  ([host pairing](products/tui/docs/host-pairing.md)).
- **Several daemons:** `goodvibes-daemon cluster create` on one machine and
  `goodvibes-daemon cluster join` on the others share incoming channel messages
  among the machines on your network
  ([cluster](packages/engine/docs/cluster-operations.md)).

## Documentation

Start here:

- [Installation, updates and uninstall](docs/installation.md)
- [Terminal app](products/tui/README.md) and its [getting started guide](products/tui/docs/getting-started.md)
- [Personal assistant](products/agent/README.md) and its [getting started guide](products/agent/docs/getting-started.md)
- [Daemon](products/daemon/README.md) and [web app](products/webui/README.md)

By topic:

- [Providers and models](products/tui/docs/providers-and-routing.md)
- [Permission modes and the decision model](docs/decision-model-policy.md)
- [Every slash command](products/tui/docs/commands-reference.md) and [settings](products/tui/docs/configuration.md)
- [Chat channels and the daemon's API](products/tui/docs/channels-remote-and-api.md)
- [Headless runs](products/agent/docs/headless-run.md) and [exit codes](docs/exit-codes.md)
- [Purchases](packages/engine/docs/payments.md)
- [Release notes for 3.4.3](docs/releases/3.4.3.md)
- [Building on the platform](packages/engine/README.md) and [the Jev decision layer](packages/judgment/README.md)
- [Security policy](SECURITY.md)

## License

MIT. Each program and package carries its own copy, for example
[the terminal app's](products/tui/LICENSE).
