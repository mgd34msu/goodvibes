# GoodVibes: overview, terms, architecture and where everything is stored

This file describes GoodVibes release {{release}} completely. It is written for a language model that operates GoodVibes for a person. Everything a person or an automated client can reach is described here: installing, every program and command, every setting, every slash command, every model tool, every environment variable, every file GoodVibes writes, the operator API and every error. Nothing outside this file is needed.

How to read this file:

- Each part starts with a heading of the form `# Part title`. Sections inside a part use `##` and `###`.
- A reference to another place in this file names its heading in quotes, for example "Settings: layers, scopes and how to change them".
- Text in backticks is exact: a command, a file path, a setting key, a value. Type it as shown.
- `<name>` in a command stands for a value you supply. `[x]` is optional. `a|b` is a choice of one.
- `~` is the home directory of the person whose installation it is.
- The complete lists (settings, commands, slash commands, tools, variables, methods, events, errors, providers) are in the part "Reference" at the end. They are built from the programs themselves.

## Table of contents

<!-- generated: toc -->

## What GoodVibes is

GoodVibes is an AI coding and personal-assistant platform that runs on the owner's own machine. It has a terminal coding app, a personal-assistant app, a background daemon and a browser interface. A person talks to a model; the model reads and edits files, runs commands, delegates work to helper agents, answers messages on chat channels, keeps memory and runs scheduled work. Every action the model takes passes a permission check, and a second model (the decision model) can make routine judgment calls so the person is asked less often.

GoodVibes works with many model providers (OpenAI, Anthropic, Gemini, OpenRouter, local servers such as Ollama and LM Studio, and others); see "Providers" in the reference. The person brings their own API keys or signs in with a subscription where a provider offers one.

## The programs and how they connect

GoodVibes is four programs. They share one engine and one set of files on the machine.

| Program | Command | What it is |
| --- | --- | --- |
| terminal app | `goodvibes` | The terminal coding app: a full-screen interface for working in a project with a model. Also a command line (`goodvibes run`, `goodvibes status`, `goodvibes service`, and more). |
| Agent | `goodvibes-agent` | The personal-assistant app: a terminal interface and command line for knowledge, memory, routines, reminders, channels and personal operations. It hands coding work to the terminal app (`/agents hand-off`). |
| daemon | `goodvibes-daemon` | The one long-running background program on a machine. It hosts the control plane (the HTTP operator API), the chat channels, cluster membership, scheduled work, the knowledge and memory stores, hosted sessions and the web UI. |
| web UI | none (a page in a browser) | The browser interface, served by the daemon at the same address as the operator API (by default `http://127.0.0.1:3421`). |

How they talk to each other:

- The daemon listens for HTTP on the control-plane address: host `127.0.0.1` and port `3421` by default (settings `controlPlane.host` and `controlPlane.port`). Until `controlPlane.enabled` is `true`, it answers only requests from the same machine.
- The terminal app and Agent are clients of the daemon. They call the daemon's operator API over HTTP, receive its events as a server-sent event stream, and send it the settings it owns. Each app runs its own conversations and model requests in its own process.
- The terminal app uses the daemon on the same machine by default. `daemon.connectedHost.url` points it at a daemon on another machine. Agent uses the daemon on the same machine unless `daemon.connectedHost.url` (or, for one run, `--runtime-url` or `GOODVIBES_AGENT_RUNTIME_URL`) names another origin.
- The credential each app presents to its daemon: for its operator calls the terminal app sends the daemon on the same machine `GOODVIBES_DAEMON_TOKEN` when it is set, otherwise the daemon's own operator token (`operator-tokens.json`); a daemon on another machine gets only the token stored for that address in `~/.goodvibes/tui/connected-daemons.json` (or a session from "Sign in to a daemon or listener" in Devices and network, kept in the same file), never this machine's token or `GOODVIBES_DAEMON_TOKEN`. Agent looks, in this order, at `GOODVIBES_CONNECTED_HOST_TOKEN`, `GOODVIBES_DAEMON_TOKEN`, its own pairing with that daemon (`~/.goodvibes/agent/connected-host-pairings/pairings.json`), and then the daemon's `operator-tokens.json`, which it presents only when the host address is this machine (a loopback address or one of its own interface addresses).
- The web UI is a built set of static files. The daemon serves them from its own control-plane listener after `goodvibes-daemon webui enable`, so the web UI and the API share one origin.
- Phones and other computers reach a daemon after pairing (`goodvibes pair`, `goodvibes-daemon pair`), through remote access, or through a relay; see the part on the daemon and networking.
- Several daemons on one network can form a cluster and share inbound channel work (`goodvibes-daemon cluster`). One daemon in a cluster is a node.
- Editors that speak the Agent Client Protocol (ACP) drive the terminal app with `goodvibes acp`. MCP clients use `goodvibes-daemon mcp serve`.

The daemon is installed as a user service by default, so it starts at login (Linux: a systemd user service named `goodvibes.service`; macOS: a launchd agent labelled `sh.goodvibes.daemon`). It can also run in the foreground with `goodvibes-daemon` or `goodvibes-daemon serve`.

The engine package also contains a `goodvibes-contract` command for driving contracts from a script. The installers do not install it; its exit codes are listed under "Exit codes" in the reference.

## Glossary

Each term below is used with exactly this meaning everywhere in this file.

| Term | Meaning |
| --- | --- |
| owner | The person whose installation it is. Some decisions (spending money, loosening security, owner-only actions) are always the owner's. |
| terminal app | The `goodvibes` program. |
| Agent | The `goodvibes-agent` program. |
| daemon | The `goodvibes-daemon` program, the long-running background host. |
| web UI | The browser interface the daemon serves. |
| app | The terminal app or Agent. |
| provider | A model service: OpenAI, Anthropic, OpenRouter, a local Ollama server, and so on. Each has an id such as `openai`. |
| model | A model offered by a provider, named `provider:model`, for example `openai:gpt-5.2`. This full name is the model's registry key. |
| sign-in | One way of authenticating to a provider: an API key, a subscription sign-in (OAuth), or none for a local server. |
| session | One saved conversation between the owner and the model, with its tool calls. Sessions are saved per project and can be resumed. |
| turn | One request from the owner and everything the model does to answer it. |
| tool | An action the model can call: read a file, edit a file, run a command, fetch a page, spawn a helper agent. The list is under "Model tools" in the reference. |
| slash command | A command typed into an app's prompt starting with `/`, such as `/model` or `/settings`. |
| helper agent | A second model run the main model starts to do part of the work (the `agent` tool). |
| contract | Work handed to helper agents as a set of units, each checked against acceptance criteria until it passes. |
| the gate | The permission check every tool call passes before it runs. It allows the call, asks the owner, asks the decision model, or refuses. |
| permission mode | Who settles what ordinary rules do not: `ask-me` (the owner is asked about dangerous actions), `jev-decides` (the decision model decides judgment calls; the default), `just-vibes` (work without interrupting; anything that needs the owner is held to the end), `yolo` (every action runs without safety denials; containment, secret storage and payment limits still apply). Setting `permissions.mode`. |
| plan mode | The read-only planning posture (`permissions.mode` value `plan`): the model plans and changes nothing. |
| decision model | The second, small model the gate and other parts ask for routine judgment calls. Jev is the hosted decision model; a local one can be configured (settings `judgment.*`). |
| If Jev can't answer | A choice in the decision model settings (`judgment.policy`) that matters only in `jev-decides` and `just-vibes`: while the decision model fails, a call Jev would decide comes to the owner (Ask me, stored `Hybrid`, the default) or is refused (Refuse the action, stored `Decision Model Only`). |
| setting | A named value that changes behaviour, written as a dotted key such as `display.stream`. The list is under "Settings" in the reference. |
| project | The directory an app works in (its working directory). Per-project state is kept in `<project>/.goodvibes/`. |
| channel | A chat surface the daemon answers on: Slack, Discord, Telegram, email, and others. |
| node | One daemon in a cluster. |
| operator API | The daemon's HTTP API, used by the apps, the web UI and scripts. Its methods are under "Operator API methods" in the reference. |
| operator token | A bearer token that authorises a client to the operator API. |
| pairing | Giving another device or app a named token for a daemon, usually by a link or QR code. |
| checkpoint | A snapshot of a project's files taken before the model changes them, so a change can be undone. |
| memory | Facts and notes GoodVibes keeps across sessions. |
| knowledge | Documents and sources GoodVibes has read and can search. |
| secret store | Where GoodVibes keeps credentials, encrypted; see "Credentials and the secret store". |

## Architecture

### The daemon

The daemon is the one process on a machine that keeps running when no app is open. It is the home of everything that must work unattended: channels, schedules and triggers, watchers, the owner inbox, payments, pairing, remote access, hosted sessions (conversations whose loop runs inside the daemon), the web UI, and the shared memory and knowledge stores. Settings that the daemon acts on are stored in the daemon's own settings file, and every app reads and writes that one value (see "Settings: layers, scopes and how to change them").

When the daemon is not running, features that live in the daemon report that they are unavailable instead of failing silently.

### Sessions and turns

A turn starts when the owner sends a message. The app sends the conversation to the selected model; the model answers with text, tool calls, or both. Each tool call passes the gate, runs, and its result goes back to the model, until the model answers without asking for more tools. The session is saved under the project (`<project>/.goodvibes/tui/sessions/` for the terminal app) and can be listed and resumed (`goodvibes sessions`, `goodvibes --resume`).

### The gate

Every tool call is classed by its permission category: `read`, `write`, `execute` or `delegate`. The gate weighs the call's category and what it touches against the owner's remembered rules, the per-tool settings (`permissions.tools.*`) and the permission mode. Judgment calls go to the decision model; owner-only decisions, and anything still unsettled, go to the owner. Some actions always ask the owner whatever the mode. The full rules are in the part on permissions and decisions.

### The decision model

The decision model answers short structured questions (is this command safe here, does this message need the owner) so the owner is asked less. By default it is Jev at the hosted address; `judgment.endpoint` and `judgment.model` choose another. With no decision model set or reachable, every decision takes its fallback, which is usually to ask the owner.

### Stores

GoodVibes keeps its state in plain files and SQLite databases under two roots: the home tree `~/.goodvibes/` and each project's `<project>/.goodvibes/`. Settings are JSON files. Credentials are in encrypted secret stores. Memory, the owner inbox, knowledge, the code index and the decision log are SQLite databases. Checkpoints are a separate git repository inside the project's `.goodvibes/` directory, never the project's own git history. The next section lists every location.

## Files and directories GoodVibes creates

### The home tree

The home tree is `~/.goodvibes/`. `GOODVIBES_HOME=<dir>` moves it to `<dir>/.goodvibes/` for the terminal app, the daemon and the Agent; `GOODVIBES_AGENT_HOME=<dir>` moves the Agent alone. An installation made with `scripts/install-from-checkout.sh` sets `GOODVIBES_HOME` to its data directory (default `~/.local/share/goodvibes-data`), so its home tree is `~/.local/share/goodvibes-data/.goodvibes/`. `GOODVIBES_DAEMON_HOME=<dir>` (or `goodvibes-daemon --daemon-home <dir>`) moves only the `daemon/` directory below.

"Edit by hand" says whether a person may change the file with a text editor. A settings file is read again when it changes on disk, so a hand edit takes effect without a restart. Every other file is written by the programs; change it only through the commands named.

| Path (under the home tree) | What it holds | Edit by hand |
| --- | --- | --- |
| `tui/settings.json` | The terminal app's own settings. | Yes. JSON; see "Settings: layers, scopes and how to change them". |
| `agent/settings.json` | Agent's own settings. | Yes. |
| `shared/settings.json` | The five text-to-speech keys `tts.provider`, `tts.voice`, `tts.speed`, `tts.llmProvider` and `tts.llmModel`, shared by all three programs. Nothing else is read from this file. | Yes. |
| `shared/subscriptions.json` | Provider subscription sign-ins (such as a ChatGPT subscription signed in from Models and providers) and their tokens, one file read and written by all three programs, so a sign-in made in one is used by the others. Written with permissions `0600`. | No. Sign in and out on the Providers tab of Models and providers, or with `goodvibes subscription`. |
| `daemon/settings.json` | The daemon's settings: every key the daemon acts on (channels, control plane, schedules, payments, the decision model, and more). | Yes, or use `goodvibes-daemon config set`, which checks the value before writing it. |
| `daemon-host/settings.json` | The daemon's own value of every key that each program keeps separately (for example `service.*`, `update.*`, `permissions.mode` for the daemon's own sessions). The daemon reads it; `goodvibes-daemon config set` writes it. | Yes. |
| `daemon/operator-tokens.json` | The daemon's operator tokens. | No. Manage tokens with the commands in the daemon part. |
| `daemon/secrets.enc` | Credentials the daemon uses (channel tokens, provider keys it needs, card material references), encrypted. | No. Use `goodvibes secrets` or the apps' secret commands. |
| `tui/secrets.enc`, `agent/secrets.enc` | Each app's own encrypted credentials. | No. |
| `tui.secrets.json`, `agent.secrets.json` | Plain-text credential stores, used only when the secret policy allows plain text. | No. |
| `secrets.key` | The random key that encrypts every `secrets.enc`. Without it those stores cannot be read. | Never. Do not delete, move or share it. |
| `tui.json`, `agent.json` | A configuration file each app creates when it starts (`{}` when new). | No. |
| `tui/keybindings.json`, `agent/keybindings.json` | Custom key bindings. | Yes. |
| `tui/guidance.json`, `agent/guidance.json` | Which one-time guidance notices were shown. | No. |
| `tui/discovered-providers.json` | Local model servers found on this machine. | No. |
| `tui/auth-users.json` | Local user accounts for signing in to the daemon and the web UI. | No. Use `goodvibes auth`. |
| `tui/auth-bootstrap.txt` | The first-run bootstrap sign-in credential. Its password signs in only while this file holds it: deleting or clearing the file withdraws it. Setting `admin`'s password deletes the file. | No. `goodvibes auth clear-bootstrap` deletes it (and so withdraws the password). |
| `tui/connected-daemons.json` | The token the terminal app presents to each daemon on another machine, keyed by that daemon's address (written by the setup choice "Connect to an existing running daemon"). | No. |
| `agent/connected-host-pairings/pairings.json` | Agent's pairing with each daemon it connects to. | No. |
| `tui/control-plane/` | Control-plane state: pairing tokens, daemon lifecycle, notification dead letters, occasion state, announcements. | No. |
| `tui/knowledge-*.sqlite` | Knowledge stores. | No. |
| `tui/crashes.jsonl`, `agent/crashes.jsonl` | A record of crashes, one JSON object per line. | No. Read it when reporting a crash. |
| `tui/browser/`, `agent/browser/` | The browser tools' driver (`driver/`), browser profiles with their sign-ins (`profiles/`) and saved screenshots (`screenshots/`). | No. |
| `shared/memory.sqlite`, `shared/memory.vec.sqlite` | Memory records and their search index. | No. Use the memory commands. |
| `shared/owner-inbox.sqlite` | The owner inbox: questions, held actions, purchase windows and reports of unattended runs waiting for the owner. | No. |
| `hosted-sessions/` | Conversations the daemon hosts. | No. |
| `companion-chat/sessions/` | Companion chat conversations (web UI and phone). | No. |
| `project-identities/` | Which project directory has which project id. | No. |
| `voice/` | The managed voice tree, one copy for every program: speech engines and models, with the wake-word classifiers in `voice/wake/models/` and the wake-word front end in `voice/wake/front-end/`. | No. `goodvibes-daemon provision-wake-model` fetches missing wake-word files. |
| `daemon/service/` | The service manager's state for the daemon (process id file, the definition used on a platform without a service manager). | No. |

### The project tree

Each project an app works in gets `<project>/.goodvibes/`. It contains a `.gitignore` holding `*`, so git ignores everything in it and none of it is committed. On first use in a git project the terminal app also adds the line `.goodvibes/` (under the comment `# goodvibes-tui transient state`) to the clone's own exclude file, `.git/info/exclude`, which git does not track, unless the project's `.gitignore` or that file already has it, and prints `[goodvibes] git now ignores '.goodvibes/' in this clone (.git/info/exclude; your .gitignore is unchanged): it holds transient TUI state (logs, session cache, exec output), not project source.` The project's `.gitignore` is never edited.

| Path (under `<project>/.goodvibes/`) | What it holds | Edit by hand |
| --- | --- | --- |
| `tui/settings.json`, `agent/settings.json` | Project settings: values for this project only. A repository can carry them, so only presentation, behaviour, contract and some permission keys are honoured, and a permission key only when it is stricter (see the reference entry of each setting). | Yes. |
| `tui/sessions/`, `agent/sessions/` | Saved sessions of this project. | No. Use `goodvibes sessions`. |
| `tui/recovery/` | Journals used to recover an interrupted session. | No. |
| `tui/state/` | Session state the tools keep. | No. |
| `tui/checkpoints/git/` | The checkpoint repository: a separate git repository holding snapshots of the project's files. | No. Use the checkpoint and undo commands. |
| `tui/secrets.enc` | Credentials that belong to this project. A key first found here is used only after the owner confirms it once. | No. |
| `tui/code-index.sqlite` | The project's code search index. | No. |
| `tui/decisions.sqlite` | The decision log: every reading asked of the decision model in this project, answered or failed. | No. |
| `tui/watchers.json` | Watchers defined for this project. | No. |
| `project-index.json` | The project's file index. | No. |
| `worktrees.json` | Git worktrees GoodVibes created for parallel work. | No. |
| `logs/activity.md` | The activity log of programs working in this project, in Markdown; the previous one is kept as `activity.md.1`. | Read only. |

The daemon keeps none of its own records in a project folder: its shared sessions, approvals, watchers, channel policies and routes, drafts and inbox cursors, supervised triggers (`triggers.db`), device grants, cluster identity, remote nodes, plans waiting to run, decision log and activity log are under `<daemon home>/records/.goodvibes/` (by default `~/.goodvibes/daemon/records/.goodvibes/`), the same whatever folder it was started from. A 3.5.0 daemon kept them in the folder it was started in; the first start of this version carries them once from every such folder (merging what two folders both held), leaves the old files as they were, and says what it carried in Waiting for you.

### Programs, service files and installation records

| Path | What it is |
| --- | --- |
| `~/.local/bin/goodvibes`, `~/.local/bin/goodvibes-agent`, `~/.local/bin/goodvibes-daemon` | The commands (both installers; `--bin-dir` or `GOODVIBES_INSTALL_DIR` change the directory). |
| `~/.local/bin/webui/` | Web UI bundles installed by `scripts/install.sh`, one directory per version. |
| `~/.local/share/goodvibes/` | A checkout installation's programs, its releases and its receipt `installation.json` (`--prefix` changes it). |
| `~/.local/share/goodvibes-data/` | A checkout installation's data directory (`--data-dir` changes it); its `environment` file is read by the installed `goodvibes`, `goodvibes-agent` and `goodvibes-daemon` commands before they start, which is where `TYPESAFE_API_KEY` and other variables go. |
| `~/.config/systemd/user/goodvibes.service` | The daemon's service definition on Linux. |
| `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` | The daemon's service definition on macOS. |

Installing, updating and removing are described step by step in the part on installing. Uninstalling a release installation never removes the home tree; remove `~/.goodvibes` by hand to erase all data. Uninstalling a checkout installation keeps its data directory unless `--purge` is given.

### Credentials and the secret store

A credential (an API key, a bot token, a password) is looked up in this order, and the first one found is used:

1. An environment variable of the same name.
2. The daemon's stores (`daemon/secrets.enc`, then a plain-text daemon store).
3. The app's own encrypted store (`tui/secrets.enc` or `agent/secrets.enc`).
4. The app's plain-text store (`tui.secrets.json` or `agent.secrets.json`), when the secret policy allows plain text.
5. The project's stores, only after the owner confirmed that key once.

A stored value can be a reference to a password manager (1Password, Bitwarden, Vaultwarden, Bitwarden Secrets Manager) or a command; it is resolved when it is used. Settings files never hold a credential: a setting that names one holds a `goodvibes://secrets/...` reference. Store, list and test credentials with `goodvibes secrets` (and the same command in Agent).

## Settings: layers, scopes and how to change them

### Which file a setting lives in

Each setting key is stored in one of three ways, decided by the key. The "Stored in" of each key's reference entry says which.

| Stored in | Terminal app reads | Agent reads | Daemon reads | Written by |
| --- | --- | --- | --- | --- |
| the daemon file (keys the daemon acts on) | `~/.goodvibes/daemon/settings.json` | the same file | the same file | `goodvibes-daemon config set`; a change made in an app is sent to the running daemon, which writes it, or written by the app itself when no daemon is running |
| the shared file (only `tts.provider`, `tts.voice`, `tts.speed`, `tts.llmProvider`, `tts.llmModel`) | `~/.goodvibes/shared/settings.json` | the same file | the same file | any program that changes one of these keys |
| each program's own file (every other key) | `~/.goodvibes/tui/settings.json` | `~/.goodvibes/agent/settings.json` | `~/.goodvibes/daemon-host/settings.json` | the terminal app's `/settings` and `/settings set`; Agent's `/settings`; `goodvibes-daemon config set` |

Keys stored in each program's own file have one value per program. `provider.model` set with `/model` in the terminal app does not change Agent's model, and `service.enabled` set with `goodvibes-daemon config set` changes the daemon's own value, not the one `goodvibes doctor` reads in the terminal app. To change such a key for a program, change it in that program or in its file. `GOODVIBES_DAEMON_HOME` moves the daemon file to `<GOODVIBES_DAEMON_HOME>/settings.json`.

### How a value is resolved

When a program reads a setting, the value comes from the highest layer that sets it:

1. The default built into the program (lowest).
2. The program's own settings file in the home tree (`tui/`, `agent/` or `daemon-host/settings.json`).
3. The program's project settings file (`<project>/.goodvibes/tui/settings.json`, `<project>/.goodvibes/agent/settings.json`, or for the daemon `<working directory>/.goodvibes/daemon-host/settings.json`), for keys a project may set.
4. The shared settings file, for the five `tts.*` keys it holds.
5. The daemon settings file, for daemon-owned keys.
6. Launch options, for this run only (highest): `-c <key>=<value>` (or `--config`), `--enable <feature>`, `--disable <feature>`, `--model`, `--provider`, `--just-vibes`, `--yolo`, and the daemon's `--hostname` and `--port`.

A change to a key the project file already holds is written to the project file; otherwise it is written to the file the table above names.

Launch options are never saved. A project settings file may set only presentation, behaviour, contract, worktree and some checkpoint and agent keys; for permission keys it is honoured only when it is stricter than the owner's own value. Keys that send data off the machine, run a command, name a credential or a model are ignored in a project file, with a notice.

Some environment variables stand in for a setting when the setting is empty, for example `TYPESAFE_DEFAULT_MODEL` for `judgment.model`. Each such variable is named in that setting's reference entry and in "Environment variables".

### Reading and writing a setting

A settings file is JSON with each dotted key written as nested objects. The key `controlPlane.port` with value `3999` is written as:

```json
{
  "controlPlane": {
    "port": 3999
  }
}
```

From the daemon's command line (works whether or not the daemon is running; a running daemon applies most keys at once):

```sh
goodvibes-daemon config get controlPlane.port
goodvibes-daemon config set controlPlane.port 3999
goodvibes-daemon config list
```

`config set` prints:

```text
controlPlane.port = 3999
  written to disk. A running daemon applies most keys live, including a changed control-plane
  host or port; a key that is only read when the daemon starts applies the next time it starts.
```

A value that does not fit the key is refused, nothing is written, and the command exits `1`:

```text
config: could not write controlPlane.port: expected number (integer port in [1, 65535]).
```

A key that does not exist is refused the same way with `not a settings key. Run \`goodvibes-daemon config list\` to see them.` Values are read as JSON first, then `true`, `false` or a number, then as plain text: `config set judgment.model "jev-latest"` stores the text, `config set display.stream false` stores the boolean. A daemon-owned key (`controlPlane.port`) goes to the daemon file; any other key (`display.stream`) goes to `~/.goodvibes/daemon-host/settings.json` and changes only the daemon's own value.

When the terminal app or Agent writes a daemon-owned key while a daemon runs, the write goes to that daemon. A daemon that cannot be reached (refused connection, unknown host) gets nothing: the message says the setting was NOT applied. A write that was sent but whose answer was lost or could not be read (a timeout, a dropped connection, an answer this version cannot read) may have been applied, so the app reads the key back once from the daemon: the value it sent is there, and the write is reported done; otherwise the message says the outcome is not known, what the daemon holds now, and to read it back with `goodvibes-daemon config get <key>` (on the daemon's machine when it runs elsewhere) before setting it again. Several keys sent as one update are settled the same way, and the update reports the value the daemon holds for each key.

When the app is attached to a daemon on another machine (`daemon.connectedHost.url`), this machine's daemon settings file is never read or written: daemon-owned settings are read from that daemon (when the app attaches, and again when it reattaches), and a change while it is down is refused, nothing written locally: `<key> was not changed: the daemon at <origin> is not reachable, and its settings are kept on that machine, so nothing was changed. Try again once it answers.` The settings screens show each setting's default as the program's own default, and "reset" removes the stored value, in both programs.

Inside the terminal app:

- `/settings` lists what it does; `/settings open [topic|key|words]` opens the settings screen there, and `/settings list`, `get <key>`, `set <key> <value>` and `reset <key>` read and change settings without the screen, as in the Agent.
- `/settings set <key> <value>` sets a key directly.

Inside Agent:

- `/settings` opens the settings screen. `/settings list`, `/settings get <key>`, `/settings set <key> <value>` and `/settings reset <key>` read and change settings without the screen.

For one launch only:

```sh
goodvibes -c display.stream=false
goodvibes-agent --config provider.model=openai:gpt-5.2
goodvibes-daemon -c update.auto=false serve --port 39421
```

By editing the file: open the settings file named in the key's reference entry, add or change the nested key, and save. A running app or daemon reads the file again when it changes. A settings file that is not valid JSON is never skipped, because it may hold permission or safety settings: the program refuses to start and names the file, for example:

```text
Settings file ~/.goodvibes/tui/settings.json refused: could not be read as JSON: JSON Parse error: Unexpected EOF. fix or move the file; a settings file that cannot be parsed may hold permission or safety settings, so it is not skipped
goodvibes failed to start: Global config load failed for /home/me/.goodvibes/tui/settings.json: JSON Parse error: Unexpected EOF
```

Fix the JSON (or move the file away to start from defaults) and start the program again.

A single stored value that a setting rejects never stops a program. An ordinary setting is skipped and resolves to its default (`Setting <key> ignored (<file>): <why>.`). A setting whose default would permit more than what was stored holds its own feature closed instead, and the program says so once: `Setting <key> could not be read (<file>): it <why>. Fix it with /settings or in <file>; until it is fixed, <what is held>.` These settings and what they hold: `permissions.tools.<tool>` (every call of that tool is refused), `permissions.mode` and `policy.bundleSource`/`policy.bundlePath` (you are asked as in Ask me), `permissions.engine` (the policy engine decides), `policy.registryEnabled` and `policy.requireSignedBundles` (on), `judgment.backend`, `judgment.fallbacks` and `judgment.keyName` (no key is sent to a decision model and no backup model is asked), `provider.decisionRouter` (you are asked as in Ask me), `relay.requireStepUpForMutations` (on), `fetch.blockedHosts` (fetch refuses every website), `conversationGate.mode` (`confirm-all`), `sandbox.mcpIsolation` (`contained`), `storage.secretPolicy` (`require_secure`), `runtime.toolBudget.*` (enforced, the unreadable limit at its tightest), and `payments.majorRetailersExcluded` (every purchase asks you while an entry names no shop). A new value a setting rejects is refused when it is saved, naming the key and the values it takes.

What an earlier release left in a program's own settings file is carried forward once, when the program (or the daemon, for its own file) loads it: a key only the daemon's settings file sets (`service.*`, `judgment.*`, `power.keepAwake` and the other daemon settings) is moved to the daemon's settings file when that file does not set it, and is removed from the program's file either way; a key that a release since 3.0.0 had and this release no longer has (for example `behavior.suggestAlternativeOnProviderFail`, `judgment.decisionDeadlineMs`) is removed. Before the file is rewritten, it is copied as it was to `<file>.before-<version>` beside it (with the same permissions; a `.2`, `.3` and so on is added when that name is taken), so a value taken out is never lost. The file is rewritten once and one notice says what moved, what was removed and where the copy is: `Settings an earlier version left in ~/.goodvibes/tui/settings.json were carried forward; moved to the daemon's settings (~/.goodvibes/daemon/settings.json): service.enabled, service.autostart; removed because this version no longer has them: behavior.suggestAlternativeOnProviderFail. The file as it was is kept as ~/.goodvibes/tui/settings.json.before-3.5.0.` After that start there is nothing to say. A project's settings file is repository content and is never rewritten.

Any other key the program does not know (a misspelling, or a key from a newer release), or a daemon setting in a project's file, is skipped and the rest of the file applies; so is a value that is not one the setting allows (a renamed value from an earlier release included: it is not read under its new name). It is left in the file and said once on this machine, in one short line naming the key and the file, for example `Setting display.bogusKey ignored (~/.goodvibes/tui/settings.json): not a setting this build knows.`; later starts, and other commands and programs reading the same file, do not repeat it (the announce-once store in the control-plane directory records what was said, and `<tree>/.goodvibes/settings-notices.json` the stderr copy). Fixing the key and breaking it again says it again. A running terminal app or Agent shows it on its own screen and writes nothing to stderr for it, and when the attached daemon reports the same key in the same file, the line is shown once. The full reason and its remedy are in the activity log.

Which value is in effect, and from which layer, is shown on the settings screen and by `goodvibes status` for the main keys. The full list of keys, with each one's type, default, allowed values and file, is under "Settings" in the reference.
