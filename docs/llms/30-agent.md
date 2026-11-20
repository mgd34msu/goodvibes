# The Agent (`goodvibes-agent`)

The Agent is the GoodVibes personal assistant: chat, research, mail and calendar, reminders, notes, memory, personas, skills, routines and documents in one terminal workspace.
It is built on the same terminal shell as the terminal app, so most of the previous part applies to it unchanged.
This part first lists what the Agent shares, by the heading in the terminal-app part where it is described, and then describes in full everything that differs and everything only the Agent has.

## What the Agent shares with the terminal app

These work in the Agent exactly as described under the named heading of the terminal-app part, with `goodvibes-agent` in place of `goodvibes` and `~/.goodvibes/agent/` and `<project>/.goodvibes/agent/` in place of `~/.goodvibes/tui/` and `<project>/.goodvibes/tui/`:

| Topic | Heading in the terminal-app part |
| --- | --- |
| Option parsing, `--`, typo refusal, run-only flags | "Rules of the command-line parser" |
| `-m`, `--provider`, `-C`, `-c`, `--enable`, `--disable`, `-p`, `--print`, `-o`, `--json`, `--just-vibes`, `--yolo`, `--no-alt-screen`, `-r`, `-s`, `--timeout`, `--max-turns`, `--omit-accumulated`, `--answer-permissions`, `-h`, `-v` | "Global options" |
| `models`, `providers`, `subscription`, `secrets`, `sessions`, `pair`/`qrcode`, `completion`, `help`, `version`, `plugin bundles` | "Command-line commands" (the matching command) |
| Composer markers `!`, `!#`, `# `, `@model:`, `!@<path>`, paste folding | "What the composer does with typed text" |
| Screen layout, session chips, opened agents and processes | "Screen layout" and "Views" |
| Keys inside lists and forms | "Keys inside lists and forms" |
| How slash commands are typed and quoted | "How slash commands work" |
| Saved sessions, crash snapshots, session locks, branches | "Sessions" |
| Provider model lists (`/model refresh` reads every provider's list again, as in the terminal app), providers, API-key and subscription sign-in, local servers, custom providers, routing roles, reasoning effort, synthetic failover, the OpenAI sign-in move, `provider.fallbackModels` | "Models and providers" and "Failover" (the Agent moves a failed turn along `provider.fallbackModels` the same way) |
| Tools and the permission gate | "Tools" |
| Helper agents, archetypes, worktrees | "Helper agents and worktrees" |
| Contracts and workstreams | "Contracts, workstreams and work plans" |
| Durable memory records, classes, scopes, review states | "Memory and knowledge" |
| MCP servers and `/mcp`, read from the same server files | "MCP servers" (one description: the same actions, guided questions and lines in both programs) |
| Plugin manifests, directories, trust tiers, capability bundles | "Plugins" (enabling differs; see "Plugins in the Agent") |
| Headless frames, final frame fields, answering permission prompts, crash recovery in runs, exit codes | "Headless runs" |
| System instruction files (`SYSTEM.md`, `GOODVIBES.md`, `AGENTS.md`, `provider.systemPromptFile`) | "Project instructions" |

## How the Agent differs

### What the Agent does with and without a daemon

The connected host is the daemon the Agent talks to.

Without a reachable daemon, or without a credential for it, the Agent still works for:

- Chatting interactively. Each message runs in the Agent's own process, and one line says why, for example `No connected host is set up for this terminal, so messages run in this process.` (shown once while the reason stays the same).
- Its tools that act on this machine: files, shell commands, the browser, MCP servers, plugins.
- `goodvibes-agent memory`: with no credential found (or no daemon answering, when the daemon is on this machine) it reads and writes the shared memory store file on this machine, `~/.goodvibes/shared/memory.sqlite`. (A daemon on another machine that does not answer: reads use this machine's file, and a write is refused with `The connected host <url> did not answer; nothing was stored. ...`.)
- Personas, Agent skills, routines (except promotion), notes, VIBE.md, profiles, sessions and settings.

When a credential is found and the daemon answers, `goodvibes-agent memory` works on the daemon's store over the network instead of the file. If the daemon refuses that credential, every `memory` subcommand fails with the daemon's refusal (for example `Authentication required`, exit `1`) and does not fall back to the file. Fix the credential (see the lookup order below), or remove the credential that is being refused (an environment variable such as `GOODVIBES_CONNECTED_HOST_TOKEN`) so the command uses the file.

These need the daemon and a credential, and refuse without them:

- `goodvibes-agent run` (no local fallback: exit `1`, `stopReason` `native-unavailable`).
- Agent Knowledge (`knowledge`, `ask`, `search`, `/knowledge`), `delegate`, `owner-profile` (`/about-me` inside the Agent), `ci`, `principals`, `channel-profiles`, `fleet`, `relay`, `tasks`, `compat`.
- Schedules and reminders (`/schedule`, `routines promote`), approvals, channels and deliveries, `/work`.

The Agent dials the connected host at `http://<controlPlane.host>:<controlPlane.port>`. The two values are settled in this order at start; each step that applies replaces the one before:

1. The settings `controlPlane.host` (default `127.0.0.1`) and `controlPlane.port` (default `3421`). They are daemon settings, shared by every program on the machine; the daemon part describes them.
2. The environment variable `GOODVIBES_AGENT_RUNTIME_URL`; when it is not set, `GOODVIBES_AGENT_BASE_URL` (an older name). Only one of the two is read.
3. `-c controlPlane.host=<host>` and `-c controlPlane.port=<port>` on the command line.
4. `--runtime-url <url>` on the command line.

A runtime URL (from step 2 or 4) must be `http://host[:port]` with no path, query or fragment; a bare `host:port` is read as `http://host:port`, and a missing port means `3421`. It sets `controlPlane.host`, `controlPlane.port` and `controlPlane.hostMode` for this launch only and saves nothing.
A bad value stops the Agent before it starts, with exit `2`:

```text
$ goodvibes-agent --runtime-url https://host.example compat
--runtime-url must use http:// because Agent connects to the local GoodVibes API.

$ goodvibes-agent --runtime-url http://127.0.0.1:3421/api compat
--runtime-url must point at the connected GoodVibes API root, not a path, query, or hash.
```

The same messages name `GOODVIBES_AGENT_RUNTIME_URL` or `GOODVIBES_AGENT_BASE_URL` when the bad value came from the environment. Other refusals: `requires a non-empty http://host:port value`, `must be a valid http://host:port URL`, `must include a hostname`, `port must be from 1 to 65535`.
When the dialed host would be a wildcard bind address (`0.0.0.0`, `::`) or empty, the Agent dials `127.0.0.1` instead; an IPv6 host is put in brackets; a port that is not a whole number from 1 to 65535 becomes `3421`.

The Agent picks its credential for the connected host in this order, taking the first that is present:

1. the environment variable `GOODVIBES_CONNECTED_HOST_TOKEN`;
2. the environment variable `GOODVIBES_DAEMON_TOKEN`;
3. the Agent's own pairing with that host, created by `goodvibes-agent setup pair --apply` and kept per host address. A pairing whose reply was lost reports `The reply to this Agent's pairing request was lost. Run goodvibes-agent setup pair to repeat the same request; the host answers it with the credential it made, or makes it now.`;
4. the daemon's token file, `<daemon home>/operator-tokens.json`, only when the host address is this machine (a loopback address, or an address of one of this machine's network interfaces); for a host elsewhere this step gives no token and says `This machine's daemon token is never sent to <address>, which is not this machine.` with the pairing step. The daemon home is `~/.goodvibes/daemon/`, or the value of `GOODVIBES_DAEMON_HOME` when set; a relative value is resolved against the directory the Agent was started in (not `-C`). The file must be a JSON object whose top-level `token` is a non-empty string, as the daemon writes it (`{"token":"...","peerId":"...","createdAt":...}`; only `token` is read here).

Step 4 gives no token, and the Agent reports the token missing (`access token: missing (<path>)` in `status`, `Not connected to a GoodVibes host: there is no host token at <path>.` from daemon-backed commands), when:

- the file does not exist at the resolved path (`status` prints the path it looked at; check it, especially for a relative `GOODVIBES_DAEMON_HOME`);
- the file cannot be read by this user (for example mode `000`, or a daemon running as another user), or is not valid JSON;
- `token` is missing, empty, not a string, or nested (`{"tokens":{...}}`, `{"operatorToken":...}`).

Step 4 is never reached when an earlier step applies: an environment variable from step 1 or 2 (even a stale one) wins, and a pairing record for that host address in `~/.goodvibes/agent/connected-host-pairings/pairings.json` that is pending (reply lost) or unreadable stops the lookup with its own message instead of falling through to the file.
A token from step 4 is used for native work only when the host address is loopback (any `127.x.x.x`, `localhost` or a name ending in `.localhost`, `::1`). For a daemon on another machine `status` still shows `access token: present`, but native work is refused with `This Agent has no device credential for <url>, a daemon on another machine; pair it with goodvibes-agent setup pair.`

`goodvibes-agent doctor` reports `[warning:auth:external-runtime-token-missing]` when none is found.
Without a credential a daemon-backed command refuses and says how to get one; `run` prints:

```text
$ goodvibes-agent run "hello"
Not connected to a GoodVibes host: there is no host token at /home/me/.goodvibes/daemon/operator-tokens.json.
  Start the host on this machine with goodvibes-daemon serve (it writes the token), or pair with a host: goodvibes-agent setup pair shows the plan and goodvibes-agent setup pair --apply pairs.
  goodvibes-agent setup status shows the connection.
```

The fix, in order:

1. Make sure the daemon is installed and running ("The daemon's background service" in the install part, "Starting the daemon" in the daemon part).
2. Inside the Agent, open the workspace (`/agent`), go to Start, and run the connected-host token repair; or ask the Agent "repair my connected host token" and confirm.
3. Or pair this Agent with the daemon from the command line: `goodvibes-agent setup pair` (review) then `goodvibes-agent setup pair --apply` (asks for fresh confirmation).
4. Check with `goodvibes-agent compat` and `goodvibes-agent status`.

At start the Agent starts a daemon that is installed on this machine but stopped: one start through the service manager, a bounded wait, and a receipt line.
It never restarts a running daemon.
Setting `daemon.enabled` to `false` turns that start off. When `daemon.enabled` is `false` and the service is stopped or missing, the Agent asks on screen whether to repair it (default "Leave it as it is"); choosing repair sets the flag back, installs the service when there is none, starts it and connects.
Without a person at the keyboard, run `goodvibes-daemon start-service` (or `install-service`), then set `daemon.enabled` to `true`.

### Commands the Agent does not have

These terminal-app commands are refused by the Agent with a line saying why: `tui`, `app`, `launch`, `start`, `web`, `service`, `services`, `surfaces`, `surface`, `listener`, `http-listener`, `webhook`, `control-plane`, `controlplane`, `cp`, `remote`, `bridge`, `daemon`, `serve`, `server`.

```text
$ goodvibes-agent web
Unsupported command: web. GoodVibes Agent does not start web servers or expose browser routes.
```

`goodvibes-agent` has no `acp`, `open`, `hooks validate`, `host pair` (it uses `setup pair`), `support-bundle` (it uses `bundle`), `plugin init`, `plugin validate`, or `plugin trust` on the command line (trust is set with `/plugin-trust trust` inside the Agent).
`goodvibes-agent tasks submit` is refused with exit code `2`:

```text
GoodVibes Agent blocks CLI task submission from the host-owned task workflow.
  policy do normal assistant work in the main Agent conversation or use `goodvibes-agent run <prompt>` for an explicit one-shot run.
  build/fix/review use `goodvibes-agent delegate <task>` for explicit GoodVibes TUI handoff.
  result no local task was started.
```

### Where the Agent keeps its state

| What | Where |
| --- | --- |
| User settings, keybindings, providers, services | `~/.goodvibes/agent/` (`settings.json`, `keybindings.json`, `providers/`, `services.json`) |
| Sessions | `<project>/.goodvibes/agent/sessions/` |
| Personas, Agent skills, routines | `~/.goodvibes/agent/personas/personas.json`, `~/.goodvibes/agent/skills/skills.json`, `~/.goodvibes/agent/routines/routines.json` |
| Durable memory | `~/.goodvibes/shared/memory.sqlite`, shared with every GoodVibes program |
| Named profiles | `~/.goodvibes/agent/profile-homes/<name>/` (a whole home of its own) |
| Settings import undo | `~/.goodvibes/agent/settings-import-undo.json` |

The Agent's home is the GoodVibes tree root: `GOODVIBES_HOME` when set (the same tree as the terminal app and the daemon, with one `secrets.key`), else the login home. `GOODVIBES_AGENT_HOME=<dir>` moves the Agent alone to `<dir>`, ahead of `GOODVIBES_HOME`, so all of the above move under `<dir>/.goodvibes/`.
`GOODVIBES_WORKING_DIR=<dir>` sets the default working directory.
`GOODVIBES_AGENT_DEBUG=1` prints a fatal start-up error with its details.

### Headless runs go through the daemon

`goodvibes-agent run` (alias `exec`, `e`) captures the exact prompt and sends it through native admission on the connected host. When the host decides the input is a conversation turn, the turn runs in the `run` process and its answer is printed.
So, unlike the terminal app, an Agent run needs the connected host and its token; without them it exits `1` with `stopReason` `native-unavailable` and `kind` `unavailable`, and nothing was sent.
In `stream-json` the final frame's `type` is always `NATIVE_INTAKE_RESULT`.
Exit code `0` also covers input the host admitted as work and recorded with its execution state.
Exit code `3` means the input may have taken effect on the host; run `goodvibes-agent run --intake-status` before retrying.
Every other flag, frame and field is as described under "Headless runs" in the terminal-app part.

```sh
goodvibes-agent run "summarize the current project"
goodvibes-agent run --output json "list risks"
goodvibes-agent exec --output stream-json --omit-accumulated --timeout 10m "check runtime status"
goodvibes-agent run --intake-status --output json
```

### Composer differences

In the Agent, a typed `@<path>` (at the start of the message or after a space) that names an existing text file inside the project is replaced by the file's text, read as UTF-8, inside `<context-file path="<relative path>" bytes="<size>">` ... `</context-file>`.
A folder becomes `<context-folder path="...">` with one line per entry (`dir <name>` or `file <name>`).
`@https://...` becomes a `<context-url href="...">` note telling the model it may fetch the page; nothing is fetched by the composer.
Trailing punctuation (`),.;:!?`) after the reference is kept outside it, and `@model:...` is never a reference.
Each file or listing is cut at 100,000 characters, at a line end when one is near, with a note `[File cut: kept the first N of M characters. Ask for the rest with the read tool.]`.
An `@word` that names nothing stays as typed. A path that exists but cannot be read stops the send: `Not sent: could not read @<path> (permission denied). Your message is still in the composer; fix or remove the reference, then press Enter`.
In the terminal app `@<path>` stays plain text. `!@<path>` puts the file's text in place of the reference in both.
A referenced file is judged by its bytes, not its name. An image (PNG, JPEG, WebP or GIF) becomes an image attachment, as a pasted image does. Any other file that is not UTF-8 text stops the send: `Not sent: could not read @<path> (a binary file is not sent as text; images are PNG, JPEG, WebP or GIF)`, or `(the file is not UTF-8 text and is not sent)` for text in another encoding. A file's bytes never reach the model as text.

The Agent sends text only. A message carrying an image (a pasted clipboard image, a pasted path of an image file, a typed `@photo.png` or `!@photo.png`, or `/image <file>`) is not sent:

```text
Not sent: a conversation turn carries text only, and this message has [IMAGE: img1, photo.png, 812KB]. Your text is back in the composer; to send it, remove the image and describe it in words, then press Enter
```

For a typed reference the message names the reference (`@photo.png`); for `/image`, it names `attached image`.

The text goes back into the composer; remove the image marker or reference and describe the image in words.

### What the conversation shows besides messages

Other notices go to toasts and `/notifications`; these lines are drawn in the conversation itself, where they happened:

- Why a turn ended without an answer, with what to do next, for example `sample chat request failed 500: ...` then `Hint: ...`, or `openrouter chat request failed: Connection error.` then `Next: send it again, or choose another provider or model with /model.`
- The first time a model request fails and is retried, why, and how long the retries can take: `Retrying up to 5 times over about 2 minutes. Next: wait, press Esc to stop, or choose another model with /model.`, or, when a fallback model is open (see "Failover" in the terminal app part), `Retrying once in about 2 s, then moving to the next model of your fallback order. Next: wait, or press Esc to stop.` The row under the conversation counts the attempts (`Retrying (attempt 2/5)...`).
- Why a message was not sent and what to do, for example when the connected host refuses it because the workspace is not registered. The text stays in the composer.
- The output of a `!` command: the command, its output and its exit status.

The status bar is the terminal app's (see "Screen layout"): `Asks:` and the mode in force in words with the `shift+tab` key, the unread notices with `ctrl+n`, `context 34%`, `branch main, changed` and `model <name>`; a click on a segment opens its view, except the branch (the Agent has no changes view). The header names the program, its version and the session. A hosted session's mode is its host's: the segment shows it, and `Shift+Tab` sends the change to the host. The status bar keeps one short chip for the power state (`sleep disabled`, `sleep held` or `keep-awake refused`); the full note, and a warning such as the sleep-edge hooks being off, is a notice in `/notifications`, posted when it changes.

### Keys

The Agent's rebindable keys differ from the terminal app's. Its file is `~/.goodvibes/agent/keybindings.json`, in the format described under "Changing a key".

| Action | Default key | What it does |
| --- | --- | --- |
| `copy-selection` | `Ctrl+Shift+C` | Copy selected text. |
| `clear-cancel` | `Ctrl+C` | Clear the composer, cancel generation, twice to exit. |
| `screen-clear` | `Ctrl+L` | Repaint. |
| `command-palette` | `Ctrl+P` | Open help: every command and keyboard shortcut in one searchable list (the same as `?` and `/help`). |
| `workspace-picker` | `Ctrl+G` | Open the Agent workspace. |
| `workspace-close` | `Ctrl+X` | Close the Agent workspace. |
| `workspace-close-all` | `Ctrl+Shift+X` | Close the Agent workspace. |
| `workspace-tab-next` | `Ctrl+]` | Next workspace category. |
| `workspace-tab-prev` | `Ctrl+[` | Previous workspace category. |
| `open-agents` | `Ctrl+O` | Open Your agents: what is running, what waits for the owner, what is scheduled, the background services. |
| `history-search` | `Ctrl+R` | Reverse search of input history. |
| `search` | `Ctrl+F` | Search the transcript. |
| `block-copy` | `Ctrl+Y` | Copy the nearest block. |
| `bookmark` | `Ctrl+B` | Bookmark the nearest block. |
| `block-save` | `Ctrl+S` | Save the nearest block to a file. |
| `delete-word` | `Ctrl+W` | Delete the word before the cursor. |
| `line-start` | `Ctrl+A` | Start of line. |
| `next-error-line-end` | `Ctrl+E` | End of line, or the next error on an empty composer. |
| `kill-line` | `Ctrl+K` | Kill to the end of the line. |
| `clear-prompt` | `Ctrl+U` | Clear the composer. |
| `undo`, `redo` | `Ctrl+Z`, `Ctrl+Shift+Z` | Undo or redo a composer edit. |
| `paste` | `Ctrl+V` | Paste. |
| `focus-work-tree` | `Alt+Up`, `Ctrl+Up` | Move onto the work tree. |
| `cycle-permission-mode` | `Shift+Tab` | Cycle this session's permission mode, as in the terminal app. |
| `open-notifications` | `Ctrl+N` | Open the notifications; the status bar counts the unread ones. |
| `failure-other-model` | `Alt+O` | On the newest failed turn: choose another model and send the prompt again. |
| `failure-details` | `Alt+I` | On the newest failed turn: show what the provider said. |
| `failure-retry` | `Alt+R` | On the newest failed turn: send the prompt again (a turn that already ran tools continues from their results). |
| `failure-sign-in` | `Alt+S` | On the newest failed turn whose provider refused its key: open the provider sign-ins (`/auth`). |

The Agent has no command palette key, no `Alt` word-movement or kill-ring keys, and no `Alt+C`, `Alt+A`, `Alt+M` or `Alt+V`.
The old action names `panel-picker`, `panel-close`, `panel-close-all`, `panel-tab-next`, `panel-tab-prev` and `sidebar-toggle` are read as `workspace-picker`, `workspace-close`, `workspace-close-all`, `workspace-tab-next`, `workspace-tab-prev` and `open-agents`.
`Ctrl+PageUp` and `Ctrl+PageDown` scroll by a page like `PageUp` and `PageDown`.

### Checkpoints need a registered workspace

The terminal app checkpoints any workspace. The Agent takes automatic checkpoints only in a registered workspace (or a subdirectory or git worktree of one).
`goodvibes-agent workspaces register --yes` registers the current directory; `goodvibes-agent workspaces list` shows the registrations.
Setting `checkpoints.unregisteredWorkspaces` to `guarded` checkpoints unregistered workspaces too, under the root and size guards (`checkpoints.preferGitRoot`, `checkpoints.allowBroadRoot`, `checkpoints.allowLargeFirstSnapshot`, `checkpoints.maxFirstSnapshotFiles`, `checkpoints.autoRetention`).
`goodvibes-agent status` and `doctor` say `checkpoints off: workspace not registered` when this applies.
Undoing a file change and restoring a checkpoint use the same lines as the terminal app (see "Undo, rewind and checkpoints" and "Undoing file changes and turns" in the terminal-app part):

- `/undo file` reverts every file the most recent not-yet-undone `write` or `edit` call changed; `/redo file` re-applies it. An entry a later change to one of its files blocks is kept; `/undo set-aside` (or `/redo set-aside`) sets it aside without changing a file. `/undo` and `/redo` alone work on conversation turns. `/undo rewind` is refused: the Agent does not go back to a turn.
- `/checkpoint list` lists the Agent's checkpoints, newest first and numbered from 1. `/checkpoint restore <n|id>` shows the files that would change in a question and restores them once you confirm; it always asks, whoever runs it. Files only: the conversation is unchanged, and the current files are first kept in a safety checkpoint, which `/checkpoint restore` can bring back. The receipt is `[Checkpoint] Restored files from checkpoint <id> ("<label>"). Files only: the conversation is unchanged.`
- `/checkpoint make` and `/checkpoint rewind` are refused with the reason: the Agent creates checkpoints only automatically, in a registered workspace, and does not go back to a turn. The terminal app's `/checkpoint` lists only the terminal app's own checkpoints (kept under `<project>/.goodvibes/tui/`), not the Agent's.

### Hooks in the Agent

The Agent loads hooks exactly as the terminal app does (see "Hooks" in the terminal-app part): from the file its own setting `tools.hooksFile` names, resolved against the working directory, `<project>/hooks.json` by default, with the same event paths, command hook contract, rules in every mode and trust rules. A hooks file in a workspace that is not trusted waits for trust, and the Agent says so once at start; `/security trust-folder` trusts the workspace and loads the waiting file at once, with no restart.
The Agent has no `/hooks` command and no `hooks validate`. To manage its hooks:

1. Edit `<project>/hooks.json` by hand (the terminal app's `/hooks scaffold` writes the same file when both programs use the default `tools.hooksFile`).
2. Check it with the terminal app: `goodvibes hooks validate` in the same directory, and `goodvibes doctor hooks`.
3. Restart the Agent after editing the file: it reads the hooks file at start (and when the workspace becomes trusted), and has no `/hooks reload`.

Besides `exec`, the Agent runs commands through `terminal` (`args.command`), `process` (`args.command` for `action: "start"`, and `args.data` written to a running process's standard input for `action: "write"`), `agent_harness` (for example `mode: "run_background_process"`) and `agent_operator_method` (daemon methods that run a command on a paired peer or backend). A hook fires for the tool called, whether the model called it or another tool ran it, in every permission mode, so a hook that guards commands needs an entry for each tool that runs one. The `git push` example under "Hooks" in the terminal-app part registers all of them. To make sure a command never runs, use a never-run rule instead: `/permissions never git push` (see "Never-run rules" in "Permissions and decisions"); the rule is kept in the one rules file every program reads (`~/.goodvibes/shared/permission-rules.json`), so it holds for the Agent's own turns, the terminal app and turns the Agent hands to a hosted session on the daemon.

### Plugins in the Agent

The Agent loads plugins from the same two directories as the terminal app (`<project>/.goodvibes/plugins/` and `~/.goodvibes/plugins/`), with the same manifest, entry file and trust tiers (see "Plugins" in the terminal-app part). The trust tier is shared by both programs (`~/.goodvibes/plugin-trust.json`); the enabled list is not: the Agent starts only the plugins enabled in its own `~/.goodvibes/agent/plugins.json`.
The Agent's `/plugin-trust` takes `list`, `enable <plugin>`, `disable <plugin>`, `reload`, `quarantine <plugin> [reason]`, `lift <plugin>`, `trust`, `trust-key`, `verify` and `capabilities`, the same actions and answers as the terminal app's `/plugin`. `goodvibes-agent plugin` on the command line has only `bundles`. To run a plugin in the Agent:

1. Set its tier if it needs one: `/plugin-trust trust word-count limited` (or `goodvibes plugin trust word-count limited`).
2. `/plugin-trust enable word-count` loads and starts it at once and records the choice, with the directory it was enabled from, in `~/.goodvibes/agent/plugins.json`: `Plugin 'word-count' switched on and started.`, or the reason it did not start.
3. `/plugin-trust list` marks each plugin `[active]` (loaded and running), `[enabled]` (enabled but not running: still starting, refused, or failed to load; the start-up warnings say why) or `[disabled]`, followed by its name, version and `tier <tier>`. The terminal app's `[loading]` mark does not appear in the Agent. `/plugin-trust disable word-count` stops it.

### Instructions and personality

On top of the files under "Project instructions", the Agent applies:

- VIBE.md, the personality file. Candidates, in order: `~/.goodvibes/VIBE.md`, `~/.goodvibes/agent/VIBE.md`, then in each directory from the git root down to the working directory `VIBE.md`, `.goodvibes/VIBE.md` and `.goodvibes/agent/VIBE.md`. Up to 16,000 characters of each are applied (a longer file is cut and shown as truncated); a file over 1 MB is not loaded. Every file is scanned for secret-looking content and blocked when it holds any. The files are read for each turn, so an edit applies on the next turn.
- Project context files, applied in this order: `$HERMES_HOME/SOUL.md` (only when `HERMES_HOME` is set); `.hermes.md`, `HERMES.md`, `AGENTS.md` and `CLAUDE.md` in every directory from the project root down to the target directory; `.cursorrules` and `.cursor/rules/*.mdc` in the working directory. Each is secret-scanned and bounded.
- Reviewed, high-confidence memory and reviewed, ready personas, skills and routines. Unreviewed, stale, low-confidence or blocked records are not applied; they are listed as review work.

VIBE.md is managed with `/personas`: `vibe` (which files apply and which are blocked), `vibe-show [project|global|<file>]`, `vibe-create [project|global] [--force]` (writes the starter; `--force` replaces an existing file and asks first) and `vibe-import [project|global|<file>] [--name <name>] [--description <summary>] [--review] [--use]` (makes it a persona; `--review` loosens a protection, so it asks first and a model cannot).

### Commands that exist in both but behave differently

| Command | In the Agent |
| --- | --- |
| `status`, `doctor` | Also report the connected host, its compatibility, Agent Knowledge readiness, relay settings, the Agent's role and checkpoint registration. `doctor` findings read `[warning:<area>:<id>]` with `cause`, `impact` and `action`; it exits `1` only for a must-fix finding, and `--strict` (not in the help) exits `1` on any finding. `status` always exits `0`. |
| `setup` / `onboarding` | Opens the Agent on `/setup`. `setup pair [--name <device-name>] [--apply]` and `setup unpair` replace `host pair` and `host unpair`. |
| `auth` | Read only: `auth`, `auth status`, `auth review`, `auth users`, `auth sessions`. User administration is done with `goodvibes auth` or in the daemon. |
| `tasks` | `tasks list` and `tasks show <taskId>` read the connected host's tasks; submission is refused. |
| `bundle` | `bundle export [path]`, `bundle inspect <path>`, `bundle import <path> [--yes]`. Import checks every value before changing any and without `--yes` lists what it would set and exits `2`. A host on another machine (`controlPlane.host`) gets its settings with its own pairing or `GOODVIBES_CONNECTED_HOST_TOKEN`, never this machine's daemon token; with neither the import is refused and nothing is sent. |
| `/model`, `/effort`, `/provider` | The same commands as the terminal app's. `/provider sign-in` always finishes with `/provider finish <provider> <code or address>` (the Agent does not listen for the browser), and `/provider open` refuses because the Agent has no sign-ins screen. |
| `/settings` | A guided command, the same in both programs: `open [where]` (the report: the settings screen at a topic, setting or search), `list [words]`, `get <setting>`, `set <setting> <value>` and `reset <setting>`; a setting is chosen by its name. A model changes a setting through the settings tool, which asks the owner for a loosening change. |
| `/agents` | The same description as the terminal app's. `open` opens Your agents; `hand-off <the work>` (with `--review`, `--reason`, `--success`, `--workspace`, `--priority`) hands build, fix or review work to the terminal app through a shared session, and `handed-off [<session>]` lists what was handed off or shows one's progress and latest answer. `hostable` and `host <agent> [folder]` list and host a coding agent on the connected host, as `n` in the panel does. Team modes, recipes, archetypes and work contracts are refused and name the terminal app. `open --target <id>` selects that row. |
| `/memory` | The same command as the terminal app's `/memory` (see "Memory and knowledge" in the terminal app's part): bare, it opens the list of actions, "See your memory" first; `open` opens the workspace's Memory page; `injections` refuses, because the Agent records no per-turn memory. |
| `/session` | The same command as the terminal app's `/session`. It reads the cross-session task graph (`graph`) and refuses `link-task`, `hand-off`, `accept`, `withdraw` and `cancel` (hand work over with `/agents hand-off <the work>`); `save-file` writes Markdown or text only; `save-saved` prints the redacted transcript here and writes no file (`goodvibes-agent sessions export <id> <path>` writes JSON); `upload` and the branch actions are refused. |
| `/my-skills` | The Agent's own skills (see "`goodvibes-agent skills` (aliases `skill`, `agent-skills`)" below); the terminal app's `/skills` lists skill files instead. |
| `/plugin-trust` | The terminal app's plugin actions without `dirs`, `inspect`, `review`, publishing or the plugins screen: `list`, `enable`, `disable`, `reload`, `quarantine`, `lift`, `trust <plugin> <untrusted|limited|trusted> [note]`, `trust-key`, `verify`, `capabilities`. |
| `/schedule` | The same description as the terminal app's, on the connected host's schedules: `list`, `add`, `run`, `pause`, `resume`, `change`, `remove`, `stop-run <run>` and `retry-run <run>` (see "Automation and host actions" below). |
| `/calendar` | The same command as the terminal app's, on the Agent's own events, its calendar feeds and its calendar accounts; `change` and `status` (the daemon's calendar) are the terminal app's (see "Personal operations" below). |
| `/payments` | Adds `address <billing|shipping>`. |
| `/devices` | The terminal app's command: device tokens on the connected host (`list`, `rename`, `revoke`), "Pair something" (`pair device [--name <name>]` mints a named device token and shows its link and QR), and the paired phones (`nodes`, `grants`, `revoke-grant`, `captures`, `delete-capture`). Pairing this terminal, the relay, channel setup and the shared token are the terminal app's and are refused here saying so. |
| `/intelligence` | The same description as the terminal app's: the lookups (`symbols`, `outline`, `definition`, `references`, `hover`) and `install`; `review` and `diagnostics` are the terminal app's and are refused here. |
| `/voice` | The same description as the terminal app's (`speak`, `stop`, `on`, `off`, the local voice runtime, the wake word and the settings file); the runtime and the wake word are read and set up through the Agent's own voice service. |
| `/undo`, `/redo`, `/retry` | The same descriptions as the terminal app's; `rewind` is refused, since the Agent does not go back to a turn; `/retry` re-sends the last message. |
| `/checkpoint` | The same description as the terminal app's: `list` and `restore` as there; `make` is refused (the Agent takes checkpoints by itself, at the end of each turn, in a registered workspace) and so is `rewind`. |
| `/notes` | The same description as the terminal app's; here every action works (see "Personas, skills, routines, memory and personality" below). |
| `/media` | The same description as the terminal app's (see "Media and devices" below); what is made is kept as an artifact and saved as a file, which is not opened. |
| `/approval` | The same description as the terminal app's: `kinds [<kind>]` and `waiting` (opens Work & Approvals). An approval is answered with `/questions answer`; a request you raised is withdrawn with `/questions withdraw`. |
| `/health` | The same description as the terminal app's. `check` reads `setup`, `services` (the connected host's integrations), `provider`, `accounts`, `auth`, `settings`, `remote`, `mcp`, `memory`, `continuity`, `maintenance` and `approvals`; the other areas, the failure reports and `stop-agent` are refused and name the terminal app. `/health compat [--json]` is `goodvibes-agent compat`. |
| `/status` | The same description as the terminal app's; here it shows the current model and its context window with where the window came from, and the worktrees the start-up pass removed or kept. |
| `/services` | The same command as the terminal app's; `open` refuses because the Agent has no services screen. |
| `/tasks` | The same description as the terminal app's; tasks are read only here (`list`, `open`, `show`, `output`), and a change is refused with the reason. |
| `/workstream` | `start` is refused: work is started by planning it (`/workstream plan`, `approve`, `launch`), by asking for it in a message, or with `/work submit-file`. |
| `/setup` | A guided command with the same topics as the terminal app's `/setup`. `Choose a model`, `Sign in or out of a provider`, `Store a password or key`, `History and privacy` and `Bring over settings from the terminal app` open the workspace with only that topic's rows; `Add a provider of your own` runs `/provider add <name> <address>`; `Connect chat apps and services`, `How GoodVibes works with you`, `Safety and sandboxing`, `Memory and context`, `Paired devices and voice` and `Scheduled routines, watchers and triggers` open the matching workspace area; the topics marked `on the daemon` say to run `goodvibes setup` where the daemon runs. `Pair the Agent with a GoodVibes host` (`/setup pair [--name <name>] [--apply]`) and `Unpair the Agent from the GoodVibes host` (`/setup unpair`) (applying a pairing and unpairing only when the owner types it); `Run first-run again` opens the three steps. |
| `/auth` | `review`, `show <provider>`, `repair <provider>`, `bundle export <path>`, `bundle inspect <path>` only; no daemon sign-in or local users. |
| `/update` | The same description as the terminal app's; `review`, `save-review` and `read-review` are refused and name the terminal app. |
| `/save` | Saves to `<project>/.goodvibes/agent/sessions/`. |
| `/security` | The same description as the terminal app's; folder trust here decides whether the folder's hooks file loads and the MCP servers its files name start. Sandbox sessions and the screens are refused and name the terminal app. |
| `/help`, `?` | Open help: every command as a plain title with its slash name, grouped by task, and the keyboard shortcuts as the last group; the same list as `Ctrl+P`. `/help <command>` prints one command's actions and lines. |

Every command the Agent has is on its first screen (the bare `/` list) and in `/help`.

Terminal-app slash commands the Agent does not have: `/changes`, `/checkin`, `/cluster`, `/codebase`, `/communication`, `/deeplink`, `/editor`, `/eval`, `/git`, `/graph`, `/guidance`, `/helpers`, `/hooks`, `/hosted`, `/local-auth`, `/managed`, `/marketplace`, `/plan`, `/plugin`, `/power`, `/presets`, `/queue`, `/release`, `/remote`, `/replay`, `/review`, `/scan`, `/settings-sync`, `/skills`, `/startup`, `/template`, `/test`, `/tools`, `/usage`, `/web-search`, `/worktree`. Their nearest Agent equivalents: `/network-scan` for `/scan`, `/my-skills` for `/skills`, `/plugin-trust` for `/plugin`, `goodvibes-agent relay` for the relay actions of `/devices`.

## The Agent's command line

The complete help of every Agent command, as the program prints it, is under "Command line: `goodvibes-agent`" in the reference part.

Options only the Agent has:

| Option | Effect |
| --- | --- |
| `--agent-profile <name>` | Use a named profile's isolated home for this launch. An unknown name is refused with the existing names and the create command. |
| `--runtime-url <url>` | The connected host's address for this launch. |
| `--port <n>`, `--hostname <h>` | With `pair`: the endpoint to print in the pairing payload. |

`goodvibes-agent` has no `--daemon-home`, `--fork`, `--non-interactive` or `-y`; `--yes` confirms a command that changes state. `--open` is accepted and opens the sign-in page in a browser for `goodvibes-agent subscription login <provider> start --open`. `--runtime` is a shorter spelling of `--runtime-url`.
`--continue` works only with `run` (`goodvibes-agent run --continue "<prompt>"`). Without `run` it is refused with exit `2`: `--continue is only supported with run in goodvibes-agent. Use --resume to reopen a session in the interactive shell.` To reopen the last session interactively, run `goodvibes-agent --resume` (or `-r`), which opens the last session of this working directory; `goodvibes-agent --resume <id>` opens a named one.
In the Agent, `--output-format <format>` is the same option as `--output` and `-o` and prints no deprecation warning (the terminal app prints one).

### Commands only the Agent has

#### `goodvibes-agent profiles` (alias `profile`)

A profile is an isolated Agent home: its own settings, sessions, VIBE.md, memory, notes, personas, skills, routines and setup state. The connected host is not changed.

| Form | Effect |
| --- | --- |
| `profiles list` | Profiles. |
| `profiles default` | The default profile. `profiles default clear --yes` clears it. |
| `profiles use <name> --yes` | Make a profile the default. |
| `profiles templates` | Starter templates. |
| `profiles create <name> [--template <id>] --yes` | Create a profile. |
| `profiles show <name>` | One profile. |
| `profiles delete <name> --yes` | Delete a profile. |
| `profiles templates export <id> <path> [--include-vibe] --yes`, `profiles templates import <path> --yes` | Move a starter template. |
| `profiles templates from-discovered <id> [--include-vibe] [--replace] --yes`, `profiles create-from-discovered <name> --yes` | Build a starter or a profile from the current personas, skills and routines. |

Built-in templates: `household`, `research`, `travel`, `operations`, `personal-productivity`. Each seeds one persona, two skills and one routine.

```text
$ goodvibes-agent profiles create household --template household
Refusing to create Agent profile household without --yes.

$ goodvibes-agent profiles create household --template household --yes
Agent profile created: household
  home /home/me/.goodvibes/agent/profile-homes/household
  starter: household (Household Operator)
  seeded: 1 persona, 2 skills, 1 routine
  use goodvibes-agent --agent-profile household
```

The refusal exits `2`.

#### `goodvibes-agent personas` (alias `persona`)

A persona is a named set of instructions for the main conversation; one is active at a time. Personas do not start separate jobs.

| Form | Effect |
| --- | --- |
| `personas list`, `personas active`, `personas search <query>`, `personas show <id>` | Read. |
| `personas create --name <name> --description <summary> --body <instructions> [--tags a,b] [--triggers a,b] [--use]` | Create one; `--use` makes it active. |
| `personas update <id> [--name ...] [--description ...] [--body ...] [--tags a,b] [--triggers a,b]` | Change one. |
| `personas use <id>`, `personas clear` | Make one active, or none. |
| `personas review <id>`, `personas stale <id> <reason>` | Mark it reviewed (so it is applied) or stale. |
| `personas discover`, `personas import-discovered <name> [--use] --yes` | Find persona files on this machine and import one. |
| `personas delete <id> --yes` | Delete one. |

```text
$ goodvibes-agent personas create --name "Travel Planner" --description "Plan trips" --body "Compare options before booking" --use
Agent persona created
  id travel-planner
  active yes
```

Creating a persona with an id that exists prints `Persona already exists <id>` and exits `1`.
A new persona shows `review: Needs review` until `personas review <id>`.

#### `goodvibes-agent skills` (aliases `skill`, `agent-skills`)

An Agent skill is a stored procedure the Agent can follow, with optional requirements; skill bundles group skills.

| Form | Effect |
| --- | --- |
| `skills list`, `skills enabled`, `skills active`, `skills attention`, `skills search <query>`, `skills show <id>` | Read; `attention` lists skills with missing requirements or review work. |
| `skills create --name <name> --description <summary> --procedure <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]` | Create one. |
| `skills update <id> [...]`, `skills enable <id>`, `skills disable <id>`, `skills review <id>`, `skills stale <id> <reason>`, `skills delete <id> --yes` | Manage one. |
| `skills discover`, `skills import-discovered <name> [--enabled] --yes` | Import skills found on this machine. |
| `skills bundle [list|enabled|attention|show|create|update|enable|disable|review|stale|delete]` | Skill bundles, for example `skills bundle create --name "Ops Pack" --description "Daily operations bundle" --skills daily-brief --enabled`. |

Inside the Agent, `/my-skills import-standard <path/to/SKILL.md>` imports a standard skill file and `/my-skills export-standard <skill> <folder> [--overwrite]` writes one (replacing an existing SKILL.md asks first).

```text
$ goodvibes-agent skills create --name "Daily Brief" --description "Summarize operator state" --procedure "Review Agent Knowledge, work plans, approvals, and routines" --requires-env GOODVIBES_AGENT_TOKEN --requires-command gh --enabled
```

A skill is applied to the prompt only when it is enabled, reviewed and its requirements are present.

#### `goodvibes-agent routines` (alias `routine`)

A routine is a named list of steps the Agent runs in the main conversation; it can be promoted to a daemon schedule.

| Form | Effect |
| --- | --- |
| `routines list`, `enabled`, `attention`, `discover`, `show <id>` | Read. |
| `routines create --name <name> --description <summary> --steps <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]` | Create one. |
| `routines update <id> [...]`, `enable <id>`, `disable <id>`, `review <id>`, `stale <id> <reason>`, `delete <id> --yes` | Manage one. An update marks it for review again. |
| `routines import-discovered <name> [--enabled] --yes` | Import a routine found on this machine. |
| `routines receipts`, `routines receipt <receipt-id>`, `routines reconcile` | Promotion receipts, and a check of them against the host's schedules. |
| `routines promote <id> (--cron <expr>|--every <interval>|--at <iso-time>) [--timezone <tz>] [--name <schedule-name>] [--provider <id>] [--model <model>] [--delivery-channel <channel[:route][ | label]>|--delivery-route <route[ | label]>|--delivery-webhook <url>|--delivery-link <name>] [--disabled] --yes` | Promote it to a daemon schedule. |

Promotion happens only for a routine that is enabled, reviewed and has no missing requirements; without `--yes` it prints the preview and changes nothing:

```text
$ goodvibes-agent routines promote weekly-review --every 7d
GoodVibes schedule preview for Agent routine
  routine Weekly-Review (weekly-review)
  route automation.schedules.create /api/automation/schedules
  name Agent routine: Weekly-Review
  schedule every 7d
  ...
  confirmationRoutes
    cli /routines promote "weekly-review" --every "7d" --name "Agent routine: Weekly-Review" --yes
```

Inside the Agent, `/routines start <routine>` sends the routine's steps as your next message in the main conversation.

#### `goodvibes-agent memory` (alias `memories`)

Agent memory uses the durable memory store (`~/.goodvibes/shared/memory.sqlite`) and never falls back to other knowledge.

| Form | Effect |
| --- | --- |
| `memory list [class] [--scope session|project|team] [--limit <n>]` | Records. |
| `memory search <query> [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]` | Search. |
| `memory add <class> <summary> [--scope <scope>] [--detail <text>] [--tags a,b] [--confidence <0-100>] [--review-state <fresh\|reviewed\|stale\|contradicted>] [--session <id>] [--turn <id>] [--task <id>] [--file <path>] [--label <text>]` | Add one. `--review-state` sets its review state at once (`reviewed` makes it eligible for the prompt). `--session`, `--turn`, `--task` and `--file` record where the fact came from (its provenance); `--label` names that link and is the one option not shown in the program's help. |
| `memory show <id>`, `memory queue [limit]` | One record; the review queue (records not yet reviewed, flagged ones first). |
| `memory review <id> <fresh|reviewed|stale|contradicted> [--confidence <0-100>] [--by <name>] [--reason <text>]`, `memory stale <id> <reason>`, `memory contradict <id> <reason>` | Review. |
| `memory edit <id> [--summary <text>] [--detail <text>] [--tags a,b] [--scope <scope>] --yes` | Correct a record in place. |
| `memory promote <id> <session|project|team> --yes`, `memory link <fromId> <toId> <relation> --yes`, `memory delete <id> --yes` | Change. |
| `memory export <path> [--scope <scope>] [--cls <class>] --yes`, `memory import <path> --yes`, `memory handoff-inspect <path>` | Move records. |
| `memory vector [status|doctor|rebuild]` | The vector index. |

```text
$ goodvibes-agent memory add fact "Prefers concise morning briefings" --scope project --tags preference
Agent memory added
  id <record-id>

$ goodvibes-agent memory search "morning briefings"
Agent memory matching "morning briefings" (1)
  store /home/me/.goodvibes/shared/memory.sqlite
  <record-id>  project/fact  Needs review  60%  Prefers concise morning briefings
```

A new record starts at `Needs review`; only reviewed records with enough confidence are applied to the prompt.

To correct a fact, edit the record in place:

1. Find it: `goodvibes-agent memory search "office"` (or `/memory search office`), and note its id.
2. Correct it: `goodvibes-agent memory edit <id> --summary "Office is in Denver" --yes` (prints `Agent memory edited` with the id and the new summary), or in the Agent `/memory edit <id> --summary Office is in Denver`. `--detail <text>`, `--tags a,b` and `--scope <scope>` change those fields; what is not given is kept, and the record keeps its id, class, provenance and links.

To keep the old fact on record instead, mark it wrong and add the new one: `memory contradict <old-id> "Office moved to Denver"` (or `memory stale <old-id> <reason>` for a fact that is merely out of date), then `memory add fact "Office is in Denver" --scope project` and `memory review <new-id> reviewed --confidence 90` so it is applied. Inside the Agent these are `/memory review <id> contradicted --reason <reason>`, `/memory add fact <summary>`, `/memory review <id> reviewed --confidence 90`, `/memory remove <id>`.
The model can also change a record's text in place: ask it (for example "correct the memory about my office: it is in Denver now"); its `memory` tool has an `update` action, which needs your request and the permission gate's admission like any change.

#### `goodvibes-agent knowledge` (aliases `know`, `kb`), `ask`, `search` (alias `find`)

Agent Knowledge is the Agent's own knowledge store on the connected host, under `/api/goodvibes-agent/knowledge/*`. It never reads the terminal app's knowledge or any other space.

| Form | Effect |
| --- | --- |
| `knowledge status` | Readiness. |
| `knowledge ask <question> [--limit <n>] [--mode concise|standard|detailed]`, or `ask <question>` | A source-backed answer. |
| `knowledge search <query> [--limit <n>]`, or `search <query>` | Search. |
| `knowledge list [--kind sources|nodes|issues] [--limit <n>]`, `knowledge get <id>`, `knowledge map [query] [--limit <n>]` | Read. |
| `knowledge connectors [connectorId|doctor <connectorId>]` | Ingest connectors and their checks. |
| `knowledge ingest-url <url> [--title <title>] [--tags a,b] --yes` | Ingest a page. |
| `knowledge ingest-file <path> [--title <title>] [--tags a,b] --yes` | Ingest a file inside the workspace; its bytes are sent, so a remote host ingests exactly that file. |
| `knowledge ingest-artifact <artifactId> [--title <title>] [--tags a,b] --yes` | Ingest a saved artifact. |
| `knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes` | Ingest through a connector. |
| `knowledge import-urls <path> --yes`, `knowledge import-bookmarks <path> --yes`, `knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] --yes` | Bulk import (browser history is capped at 500 rows). Exits `0` only when every item was imported; a partial batch exits `1` and lists each failed item with its reason (JSON: `outcome.failed`). `--browsers` and `--sources` left out read every installed browser and both kinds. |
| `knowledge reindex --yes` | Rebuild the index. |

Options that would target another space (`--space`, `--knowledge-space`, `--knowledge-space-id`, `--include-all-spaces`) are refused.
Without a token: `Agent Knowledge error auth_required (authorization required)`, the route tried and the repair step; exit `1`.
Inside the Agent, `/knowledge` is the terminal app's command on Agent Knowledge (a question naming another knowledge space is refused), plus `ingest-file <file>`, `ingest-artifact <artifact>`, `import-browser-history [--browsers <list>] [--sources history|bookmark] [--limit <n>] [--since-days <n>]` (the owner's only), `ingest-connector <connector> [--input ...|--path ...|--content ...]`, `map [words]`, `connectors`, `connector <connector>` and `connector-doctor <connector>`; bare, it opens the workspace's Knowledge section from `open`.

#### `goodvibes-agent delegate` (alias `build`)

`delegate` hands build, fix or review work to the terminal app through a shared session on the connected host. It is an owner command only: the model has no tool named `delegate` (in either program); the model hands work to helpers with `agent`.

```sh
goodvibes-agent delegate "fix the failing tests in this repo"
goodvibes-agent delegate --review "implement the settings screen and review it"
```

Inside the Agent: `/agents hand-off [--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <the work...>` and `/agents handed-off [<session>]`.
Each hand-off is recorded in the Agent home; `/agents handed-off` lists them (`No work handed off yet. Hand some on: /agents hand-off <the work>.`), and `/agents handed-off <session>` shows the session's input state and latest answer.
A hand-off whose task could not be delivered removes the empty session it created.

#### `goodvibes-agent owner-profile` (aliases `owner-profiles`, `about-me`)

The owner profile is one Markdown file the daemon keeps: name, contact, location, commerce, preferences, people, places, work and notes, with where each fact came from.

| Form | Effect |
| --- | --- |
| `owner-profile read` | The whole document with provenance on every learned line. On a terminal it lists the People section; when output is captured it only counts the people. |
| `owner-profile get <fieldId>`, `owner-profile person <name>` | One field; one person. |
| `owner-profile provenance <fieldId>` | Where a fact came from, including values it replaced. |
| `owner-profile set <fieldId> <value> [--said "<your words>"] --yes` | Replace a field and keep the old value. |
| `owner-profile note --section <section> --text "<the line>" [--said "<your words>"] --yes` | Add a line to a prose section. |
| `owner-profile undo <fieldId> --yes` | Put the previous value back. |
| `owner-profile forget <fieldId> --yes`, `owner-profile forget --section <section> --text "<the line, exactly>" --yes` | Delete a field or a line and its history; a field that is not there is reported, not claimed. |
| `owner-profile status` | Load state, path, counts and fields that did not parse; never values. |

A prose line is named by its section and exact text, never by position.
Inside the Agent the same is `/about-me`, the same command as the terminal app's.

#### `goodvibes-agent ci`, `principals`, `channel-profiles`

| Command | Forms |
| --- | --- |
| `ci` | `ci status <repo> [--ref <ref>] [--pr <number>]`; `ci watches list`; `ci watches create <repo> --delivery-channel <channel> [--ref <ref>] [--pr <number>] [--trigger-fix-session] --yes`; `ci watches delete <watchId> --yes`; `ci watches run <watchId>`. Status is always per job. |
| `principals` (alias `principal`) | `principals list`; `principals get <id>`; `principals create --name <name> --kind <user|bot|service|token> [--identity channel:value,channel:value] --yes`; `principals update <id> [...] --yes`; `principals delete <id> --yes`; `principals resolve --channel <channel> --value <value>` (reports `known: false` when nothing is mapped). |
| `channel-profiles` (alias `channel-profile`) | `channel-profiles list`; `get <surfaceKind> [--channel-id <id>]`; `set <surfaceKind> [--channel-id <id>] [--model <model>] [--provider <provider>] [--permission-mode <ask-me|jev-decides|just-vibes|yolo|plan>] --yes`; `delete <surfaceKind> [--channel-id <id>] --yes`. A binding sets the model, provider and permission mode of sessions a channel starts. |

```sh
goodvibes-agent ci status my-org/my-repo --pr 42
goodvibes-agent ci watches create my-org/my-repo --ref main --delivery-channel slack:C123 --yes
goodvibes-agent principals create --name "Mike Davis" --kind user --identity slack:U123,email:mike@example.com --yes
goodvibes-agent channel-profiles set slack --model openai:gpt-5.4 --permission-mode plan --yes
```

CI watches are described under "CI watch" and channels under "Chat channels" in the automation part.

#### `goodvibes-agent workspaces` (alias `workspace`)

| Form | Effect |
| --- | --- |
| `workspaces list` | Registered workspaces and whether the current one is registered. |
| `workspaces register [path] [--label <label>] --yes` | Register a workspace for automatic checkpoints (default: the current directory). |
| `workspaces unregister [path] --yes` | Unregister one. |

Without `--yes`: `Refusing to register workspace <path> for automatic checkpoints without --yes.` and exit `2`.

#### `goodvibes-agent browser`

`browser` drives a real browser through the same tool the model uses, without a model or a provider.

| Form | Effect |
| --- | --- |
| `browser status` | Whether the driver and a browser are present, and what to do when not. |
| `browser provision [--repair]` | Install what is missing, showing each step. |
| `browser open <url> [--visible]` | Open a page and report its title (headless unless `--visible`). |
| `browser read <url> [--visible]` | Open a page and print its text. |

```text
$ goodvibes-agent browser status
GoodVibes Agent browser
  browser available  yes
  driver version     1.62.0
  browser executable /usr/bin/chromium
  browser source     system-browser
  ...
  display            none (headless only)
```

#### `goodvibes-agent relay` and `fleet`

`relay status` reads the connected host's relay registration and the Agent's imported `relay.*` settings; `relay pair [name]` mints the payload one phone scans to reach the host through the relay, carrying a relay code for that phone alone; `relay codes` lists the phones' relay codes (id, name, created, last used; never the code) and `relay revoke <id>` cuts one phone off the relay at its next request while every other keeps working.
`fleet attempts list [--workstream <id>]` lists best-of-N attempt groups held for a winner pick; `fleet attempts judge <groupId>` asks the judge model to propose a winner (labelled as a proposal); `fleet attempts pick <groupId> <winnerItemId> --yes` merges the winner and removes the losing worktrees, waiting up to ten seconds for each and reporting it as seen: cleaned, still cleaning (with `git worktree list` to check), or not cleaned with the reason (a worktree holding work that exists nowhere else is kept); a loser that was not cleaned makes the command exit 1.
Both need the connected host; without it they print the reason and exit `1`.

#### `goodvibes-agent compat` (alias `compatibility`)

`compat [--json]` checks the connected host's compatibility and Agent Knowledge readiness. It exits `1` when the host is not compatible or not reachable:

```text
$ goodvibes-agent compat
GoodVibes Agent compatibility
  package 3.3.2
  connected host http://127.0.0.1:3421 (unreachable)
  host compatible no
  operator token missing (/home/me/.goodvibes/daemon/operator-tokens.json)
  Agent Knowledge route not ready (connected host unavailable)
  error Unable to connect. Is the computer able to access the url?
  next start the GoodVibes daemon (goodvibes-daemon) or check controlPlane.host and controlPlane.port.
```

#### `goodvibes-agent import openclaw` (alias `migrate`)

`import openclaw [path] [--apply] [--apply-permissions]` migrates an OpenClaw workspace (default `~/.openclaw`) into the Agent. Options are read only before `--`: a word after it is the path, never `--apply` (the same holds for every `goodvibes-agent` command's own options, such as `--yes`).
Without `--apply` it prints the personas, memory records, skills and permission categories it would create, and the files it would skip with reasons.
`--apply` writes memory records (to the connected host's store when it answers, else to this machine), personas and skills; records already imported are reported as unchanged.
`--apply-permissions` also grants the permission categories; each grant pre-allows every tool in the category for this profile, and the output lists the `/settings reset` commands that undo it.
With no workspace at the default place: `No OpenClaw workspace found at the default location <home>/.openclaw. Pass a path: goodvibes-agent import openclaw <path>.` and exit `1`.

## The Agent workspace

The Agent workspace is a full-screen view of categories, each a list of rows grouped by what a person does. It has no forms of its own: a row that does something names a slash command's action (shown in its Command column, such as `/memory add`), and `Enter` closes the workspace and opens that action's guided form, the same one the slash command opens (a row may fill some blanks in, such as the account of `/calendar use-app google`); a row's name is the action's own label. The pane beside the rows says in one sentence what the area is for, then what the selected row will do (the action's sentence, or a setting's own description with its value and default as `/settings get` shows them) and, where the row's command has a report, that report's first lines, read by running it exactly as the command does. Only a report that reads nothing past this machine runs when its row is selected (once per opening); one that reaches a mailbox, a daemon or remote host, or a provider shows "Press ctrl+r to check now", and `Ctrl+R` runs it for the selected row. Work & Approvals also shows the work view `/work open` shows. Nothing else is shown there. A setting row cycles a yes/no or a choice in place and opens the settings screen at that setting for a typed value or a `permissions.*` change; an area whose rows are all settings shows Setting, Default and Current columns, and a setting among action rows shows `now <value>`. The other rows open a picker, another category, or say what to ask in the conversation.
It opens with `/agent [section]` or `Ctrl+G`. `/setup` opens one topic's rows of it at a time (below).
`Ctrl+]` and `Ctrl+[` move between categories; `/` searches actions by name, category, command or detail; `Ctrl+X` or `Esc` closes it.
Typing a letter on Home closes the workspace and puts the letter in the composer.

The workspace has these 26 categories, in this order, in eight groups; there are no others.

| Group | Category id | Label | Actions | Holds |
| --- | --- | --- | --- | --- |
| START | `home` | Home | 10 | Lanes into Start, Personal Ops, Research, Documents, Automation, Messaging, Memory and Work; the interaction mode (quiet, balanced, operator). |
| SETUP | `setup` | Setup | 11 | Not listed: `/setup` opens it with only one topic's rows. `Choose a model`: local model, main model, reasoning effort. `Sign in or out of a provider`: sign-in start and finish, sign-out, see a sign-in. `Store a password or key`: credentials, secret policy. `History and privacy`: save history. `Bring over settings from the terminal app`: settings import. |
| ONBOARDING | `account-model` | Models | 19 | Provider and model choice, reasoning, pins, and the advanced routes (helper, tool, TTS, embeddings, system prompt, cache). |
| ONBOARDING | `assistant-behavior` | Behavior | 11 | How chat behaves during normal work and long-running tasks. |
| ONBOARDING | `tools-permissions` | Tools & Permissions | 13 | The permission mode and tool settings. |
| ONBOARDING | `onboarding-display` | Interface | 9 | Display settings. |
| ONBOARDING | `onboarding-channels` | Messaging | 74 | Chat channels (Slack, Discord, Telegram and others): enable each and fill in its credentials. Its description ends with the channels' readiness. |
| ONBOARDING | `onboarding-voice-media` | Voice & Media | 21 | Voice, TTS, image input, media generation and telephony. |
| ONBOARDING | `onboarding-context` | Local Context | 16 | Personas, starter memories, skills, routines, notes and knowledge, and importing their files; VIBE.md. |
| DAY-TO-DAY | `personal-ops` | Personal Ops | 25 | The daily operations hub: inbox, calendar, reminders, briefing, Google connection. |
| DAY-TO-DAY | `research` | Research | 21 | `/research` (a question or a page into the conversation, research runs, sources, sourced reports), what goes into Agent Knowledge. |
| DAY-TO-DAY | `documents` | Documents & Files | 42 | `/documents` (drafts, review comments and suggestions, review packets), `/artifacts`, `/compare` (blind model comparison), uploads, exports, media. |
| DAY-TO-DAY | `conversation` | Conversation | 16 | Context review, compaction, prompt helpers, transcript navigation, session continuity, title, export, undo, redo, retry. |
| CAPABILITIES | `tools` | Tools & MCP | 10 | Task tools and MCP servers; changes need typed confirmation. |
| CAPABILITIES | `knowledge` | Knowledge | 16 | Agent Knowledge status, ask, search and ingest. |
| LOCAL BEHAVIOR | `profiles` | Profiles | 10 | Named Agent profiles and starter templates. |
| LOCAL BEHAVIOR | `owner-profile` | Your Profile | 9 | The owner profile kept by the daemon. |
| LOCAL BEHAVIOR | `memory` | Memory | 23 | Memory records, the prompt plan and the learning curator. |
| LOCAL BEHAVIOR | `notes` | Notes | 12 | Scratchpad notes (not memory, not Agent Knowledge): `/notes`. |
| LOCAL BEHAVIOR | `personas` | Personas | 9 | Personas and VIBE.md. |
| LOCAL BEHAVIOR | `skills` | Skills | 20 | Agent skills and bundles with their requirements. |
| LOCAL BEHAVIOR | `routines` | Routines | 13 | Routines and their promotion to schedules. |
| OPERATIONS | `work` | Work & Approvals | 15 | Active operator state, pending approvals, background processes, the work plan. |
| OPERATIONS | `host` | Connected Host | 17 | Read-only views of the connected host: health, remote routes, host tasks and their output, sessions and the session graph, channels, schedules, knowledge, media, MCP, provider detail, routes and repair, provider auth, support bundles. |
| OPERATIONS | `automation` | Automation | 20 | Confirmed reminders, routine promotion, and run, pause and resume of schedules and automation jobs on the connected host. |
| FINISH | `finish` | Finish | 1 | Apply & close: writes the onboarding completion marker, so later launches start in the conversation. |

Until setup is applied, the workspace opened for setup (`goodvibes-agent setup`) shows only the ONBOARDING group, and reveals its categories as setup reaches them; `/agent` shows all 26. A start whose model is not ready opens first run, not the workspace (see the install part of this file).
`/agent <section>` opens a section (category) by its id; the guided form lists them by label.

`/agent-home` manages separate Agent homes from inside the Agent (`goodvibes-agent profiles` from the shell): `list` (the report), `show <home>`, `next`, `use <home>`, `use-base`, `create <name> [--starter <starter>]`, `create-learned <name>`, `delete <home>` (asks first), and the starters `starters`, `starter <starter>`, `guide`, `export-starter <starter> <file> [--include-vibe] [--overwrite]`, `import-starter <file> [--replace]` and `starter-learned <id>`.
`/agents open`, `Ctrl+O` and `F2` (and a click on the running indicator) open Your agents, the same panel as the terminal app's (see "Views" there): waiting rows first, one line per running agent, the agents finished this session, `Scheduled`, and `Background services  N healthy ›` (`b` opens it; an unhealthy service is listed by itself). `Enter` opens an agent full screen, where the composer steers it (a background process opens in the process monitor when it cannot open full screen), `s` stops it (asks first), `n` hosts a coding agent found on `PATH` on the connected host. It reads this process's agents and the connected host's. Notices that used to collect in the Activity view's recent list are in the notices (`Ctrl+N`, `/notifications`), as in the terminal app. The calendar events the Activity view listed as coming up are in `/calendar upcoming`; on a day with events the panel shows `N events today ›` under `Scheduled`, and `Enter` on it prints `/calendar upcoming --days 1`.
`/brief` (one action) prints a briefing with next actions: the model in use, what is ready (including spoken replies and whether this device is paired with its host), the work plan and schedules.
`/context files` lists the project instruction files (AGENTS.md, CLAUDE.md and the like) read into each turn, any cut short and any held back with why; `/context given` shows what the last turns were given (memories, persona, skills, routines, what was left out, roughly how many tokens). `/tasks processes` lists the commands running in the background and whether a running one can be given input, a terminal or sudo. The terminal app refuses these three with the reason.
The `/setup` topic's "Import GoodVibes settings" row reads the terminal app's settings once, shows the plan (counts per family, every permission and provider change, sign-ins by name) and asks in the confirm dialog; "Import them" writes exactly that plan, and previous values are saved to `~/.goodvibes/agent/settings-import-undo.json`.

## The Agent's slash commands

The complete list of the Agent's slash commands, with usage, aliases and descriptions, is under "Slash commands: Agent" in the reference part.

The commands listed in the table under "Commands that exist in both but behave differently" behave as described there; every other command shared with the terminal app behaves as described under "Slash commands" in the terminal-app part. The commands only the Agent has:

### Work

`/work` is the terminal app's command (see "Native work and work requests" there) on the connected host; `open [<project>]` opens the Work section, which shows native work, intent, attention, evidence and history, read only.
`/work submit-file <JSON-file>` submits original owner source from a file; `submission`, `submission-retry` and `submission-discard` follow up on it.
`/work intake`, `intake-retry`, `intake-resume` and `intake-cancel` inspect or move forward a captured conversation input (the same as the `run --intake-*` flags). A message whose intake did not answer (it may have been recorded) is not counted as sent and is not sent again on its own: the Agent says `Your message may have been sent`, keeps the text in the composer (a message from the phone or a plan is kept aside instead of being retried every few seconds), and `/work intake` tells whether it arrived before it is sent again.
`/work start|status|cancel|resume <work>` acts on one native attempt. `request`, the planner and past plans are the terminal app's and are refused here.

`/todo` is the project's to-do list, the same command and the same list as in the terminal app (the model's `agent_work_plan` tool keeps the same list); it records items and their state and runs nothing.
Its actions are `list`, `markdown`, `export`, `add <title> [--owner ...] [--notes ...] [--source ...]`, `edit <item> <title>`, `mark <item> <state>`, `next <item>`, `remove <item>` and `clear-done` (the last two ask first); `open` (the panel) is the terminal app's only and is refused here.
Changes are the owner's own: a model running a `/todo` change is refused. Items are not native work: submit native work with `/work submit-file <JSON-path>`.

`/work import-preview <project>`, `import <project>`, `import-status <project>`, `import-reconsider`, `import-recover`, `import-cancel` and `import-restart <project> [request]` import old planning records into the native work ledger, with safe retry of a lost request.

### Personas, skills, routines, memory and personality

`/personas` (`list`, `active`, `show`, `search`, `create`, `update`, `use`, `stop-using`, `review`, `stale`, `delete`, `discover`, `import`, and the VIBE.md actions), `/my-skills` and `/routines` (`list [--only enabled|attention]`, `show`, `search`, `create`, `update`, `enable`, `disable`, `start`, `review`, `stale`, `delete`, `discover`, `import`, `promote`, `receipts`, `receipt`, `reconcile`) take the actions of the matching `goodvibes-agent` commands above, plus `/routines start <routine>`, `/my-skills import-standard` and `/my-skills export-standard`; `/my-skills` names the bundle verbs `bundle-create`, `bundle-show` and so on, and its options are named (`create --name ... --description ... <steps>`). `/memory` is the same command as the terminal app's `/memory`.
`/personas vibe` lists the VIBE.md candidates and which loaded; `/personas vibe-create` writes a starter (asks first before replacing one); `/personas vibe-show` prints the text; `/personas vibe-import` makes it a persona.

`/notes` is the scratchpad: working context that is neither memory nor Agent Knowledge, kept in the Agent's home (bare, from a model, it runs `list`). It is the same description as the terminal app's `/notes`, where notes last for one session. `list`, `show <note>`, `search <words>`, `create [--title <title>] [--url <address>] [--tags ...] <text>` (without a title, its first words are the title), `edit <note> [--title ...] [--url ...] [--tags ...] [<text>]` (an edit clears its reviewed mark), `review <note>`, `stale <note> <why>`, `delete <note>` (asks first). Making something from a note leaves the note and records on it what was made, and a second of the same kind is refused: `to-memory <note> [--kind ...] [--scope ...]` (title the summary, text the detail), `to-persona <note>` (not in use), `to-skill <note> [--enable]`, `to-routine <note> [--enable]` (both off until enabled, unless `--enable`), and `to-knowledge <note>` (adds the note's web page to Agent Knowledge, as `/knowledge ingest-url`; refused when the note has none).

### Documents, artifacts, comparisons and research

Each of these runs one call of an Agent tool as the owner's own act (the same tool the model calls, with a deny rule or plan mode still refusing); a model running the command is refused and pointed at the tool. Blanks that name a draft, comment, suggestion or artifact offer the current ones.

`/documents` works on the Agent's Markdown drafts (`agent_documents`): `list [<words>] [--limit N]`, `show <draft> [--no-versions]`, `create --title <title> <text> [--tags ...] [--note ...]`, `revise <draft> [--title ...] [--body ...] [--tags ...] [--status draft|reviewed|archived] [--note ...]`, `mark-reviewed <draft>`, `comment <draft> <comment>`, `resolve-comment <draft> <comment>`, `suggest <draft> <text> [...] [--why ...]`, `accept-suggestion <draft> <suggestion>`, `reject-suggestion <draft> <suggestion>`, `insert-artifact <draft> <artifact> [--at append|prepend|replace] [--heading ...] [--reference-only]`, `attach-artifact <draft> <artifact> [--label ...] [--why ...]` and `export <draft>` (a Markdown artifact). The review packet: `readiness` (what stands in the way of review, each with the line that settles it), `packet-steps` (the six steps in order, which are done, and the line for the next) and `timeline` (dated, oldest first) print short reports in plain words; a model or script reads the same lanes as JSON through `agent_harness mode:"document_ops_lane" laneId:"reviewer_readiness|review_packet_wizard|review_packet_timeline"`; `save-preset <name> [--document ... --export ... --comparison ... --judgment ... --revealed ... --decision ... --outcome ... --handoff ... --archive ... --related ... --summary ...]`, `refresh-preset <preset> [--name ...] [--summary ...]`, and `share-packet <archive> channel|route|webhook --to <target> [--title ...] [--message ...]` (sends something outside this machine; asks first).

`/artifacts` (`agent_artifacts`): `list [<words>] [--kind ...] [--type ...] [--purpose ...] [--source ...] [--limit N]`, `show <artifact> [--no-preview] [--bytes N]`, `export <artifact> <file> [--overwrite]` (byte for byte into this workspace) and `package <ids> <folder-or-zip> [--as directory|zip] [--overwrite]`. Adding an artifact to Agent Knowledge is `/knowledge ingest-artifact`.

`/compare` (`agent_model_compare`): `review [<comparison>] [--view review|side-by-side] [--related ...] [--bytes N] [--reveal]` (bare, from a model), `run <prompt> [--models ...] [--count 2-4] [--source <artifact>] [--rubric ...] [--system ...] [--max-tokens N] [--tag ...] [--task ...] [--document ...] [--reveal]` and `benchmark [<task>] [...]` (the local models on the standard task, tagged `local-model-route`); both spend money and ask first. Then `judge <comparison> <winner> <why> [--notes ...] [--reveal]`, `apply <judgment>` (the main model becomes the winner), `record-decision <judgment>` (keeps the model and records why), `export <source> [--as report|handoff|archive] [--related ...] [--reveal]`, `diff-handoffs [<older>] [<newer>] [--section ...]` and `analytics [--view analytics|synthesis] [--limit N] [--tag ...] [--task ...] [--document ...] [--no-reasons]`.

`/research`: `ask <question> [--sources <hints>]` and `inspect <address> [<what you want>]` send a message to the conversation, where the Agent researches with read-only web tools and adds nothing to Agent Knowledge; `start-run --title <name> <question> [--goal ... --plan ... --next ... --sources ... --note ...]` (`agent_research_runs`, a visible resumable run; nothing runs in the background), `add-source --title <source> --question <question> <summary> [--url ... --publisher ... --published ... --evidence ... --credibility ... --score ... --tags ... --note ...]` (`agent_research_sources`) and `save-report --title ... --question ... --sources <one per line: title | address | trust | note> [--report ... --summary ... --findings ... --gaps ... --recommendations ... --method ... --confidence ... --plain --require-citations --tags ...]` (`agent_research_report`).

### Personal operations

`/mail` is the terminal app's command with the Agent's mail service behind it (see "Mail" in the automation guide): `status`, `list [n]` (the unread messages), `read <message>`, `draft <to> --subject <subject> <message>`, `send <to> --subject <subject> <message>` (asks first), and the mailbox settings `settings`, `set <setting> <value>` and `password` (asked for masked). For example `/mail send ada@example.com --subject "Lunch on Friday" Are you free at noon?` answers `Email sent to ada@example.com with subject "Lunch on Friday".`

`/google` connects Gmail and Google Calendar (bare in the terminal it opens its list; from a model it runs `status`):

| Form | Effect |
| --- | --- |
| `connect` | Picks the shortest route and asks for at most one thing, approving a consent link. |
| `status` | What is connected, proven by reading mail and calendar. |
| `reauthorize` | Fresh consent covering mail and calendar together. |
| `forget` | Shows which stored Google credentials would go, asks, then removes exactly those. |
| `adopt [--replace]` | Take up Google credentials from files on this machine (`~/.gmail-mcp`); `--replace` replaces stored ones. |
| `client-file <path>`, `client <client-id> <client-secret>` | Store an OAuth client, then ask for consent. |
| `account <address>` | Set the Gmail address. |
| `calendar-address <url>` | Store the private iCal address and subscribe to it for read-only calendar access. |
| `setup [--path app-password|oauth|existing-client]` | Run one specific path. |
| `runbook` | Print the written instructions. |
| `waiting` | The sends the content check refused, exactly as they would go out. |
| `approve [<n>]` | Shows a refused send, asks, and sends it exactly as shown, good once and for five minutes; without a number, the one the last `waiting` showed. Only the owner typing it counts. |
| `drop <n>` | Drops a refused send. |

`/calendar` is the terminal app's command; here it works on the Agent's own events, its feeds and its accounts:

| Line | Effect |
| --- | --- |
| `upcoming [--days N]`, `all`, `get <event>` | Events: the days ahead (with the feeds and the connected accounts), every event, one event. |
| `use-app <google|outlook> <client-id> [--secret]` | Keeps your own OAuth app (no client id ships with the product): the id as a setting, a client secret (asked for masked) in the secret store. `connect` uses it. |
| `connect <google|outlook> [--with browser|device|code]`, `disconnect <google|outlook>`, `accounts` | Connected calendar accounts; `connect --with code` asks for the address the browser landed on, masked. |
| `subscribe <ics-url> [--name N] [--every MIN] [--allow-private-host]`, `unsubscribe <feed>`, `subscriptions`, `refresh [<feed>]` | iCal feeds; the address is kept as a secret. |
| `add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>]`, `delete <event>`, `import <path>`, `export [<path>]` | Local events; `delete` asks first. |

`/calendar add --title "Dentist" --start 2026-12-03T15:00` adds a local event.

`/about-me` reads and corrects the owner profile, the same command as the terminal app's (see `goodvibes-agent owner-profile`).
`/payments address` writes the address to the connected host's settings; the actions of `/payments` are the same as the terminal app's.

### Channels and delivery

`/channels` is the terminal app's command (one description for both; see "Chat channels"). Here the daemon's channel methods go to the connected host, and the Agent adds what it keeps itself: `readiness [--show all|ready|attention]` (the channels it can send to and what each lacks), `configured <channel>`, `guide [<channel>]`, `triage [--limit n]`, `send`, and `deliveries [--limit n]` (the stored receipts). Channel profiles are `/channels profiles`, `profile`, `set-profile` and `remove-profile`.

`/channels send` sends one message through one delivery target and asks first:

```text
/channels send [--channel <surface[:route][ | label]> | --route <route[ | label]> | --webhook <http(s)-url> | --link <name>] [--title <title>] <message>
```

- Exactly one target is required: `--channel` (a channel surface such as `slack`, optionally with a route and a label), `--route` (a bound route), `--webhook` (an `http` or `https` address, asked for masked in the guided path and never shown) or `--link`. None, or more than one, is refused: `No delivery target was given, so nothing was sent. Give exactly one of channel, route, webhook or link.` or `2 delivery targets were given, so the recipient is unclear and nothing was sent.`
- The message is the words after the options; `--title` defaults to `GoodVibes Agent message`.
- The message is checked for payment-card details (a message carrying them is refused before it reaches any provider), then delivered, and a receipt is stored:

```text
/channels send --channel slack Deploy finished
Agent channel delivery sent
  title GoodVibes Agent message
  target slack
  strategies 3
  response <provider response id>
  receipt <receipt id>
```

- A delivery that fails is refused with `Send failed: <reason>`. `/channels deliveries` lists the stored receipts.
- When the model runs `/channels send`, the call still needs the owner's explicit request and a recorded admission from the permission gate.
`/principals` and `/ci` are the terminal app's commands, the same description in both apps, their methods called on the connected host.

### Automation and host actions

`/schedule` takes the same actions and lines as in the terminal app, and keeps each schedule on the connected host: `/schedule add --at 2026-12-01T09:00 Renew the passport` makes one; `/schedule change <schedule> --cron "0 8 * * 1"` changes one (it also takes `--every`, `--at`, `--tz`, `--stagger`, `--name`, new words for what it does, or `--task` with `--success-criteria`; the change is bound to the schedule as the host has it when it is read); `/schedule pause`, `resume`, `run` and `remove` act on one; `stop-run <run>` (asks first) and `retry-run <run>` act on one of its runs.
`/routines promote <routine> --how cron --when "0 9 * * 1-5"` promotes a routine; `/routines receipts`, `/routines receipt <receipt>` and `/routines reconcile` read promotion receipts.

### Media and devices

`/media` is the same description as the terminal app's: `providers` lists the media providers (what `/media` alone gives a model or script); `make [--as image|video] [--provider <id>] [--model <id>] [--out <file>] <description>` asks a provider to make an image or a video (it may charge, so it asks first), keeps it as an artifact and saves it as a file (`generated/<words>-<time>.<ext>`, or `--out`); `collect <provider> <job> [--out <file>] [key=value ...]` collects a job that had not finished. A collect with `waitSeconds=0` checks the job once and answers at once. A generation cancelled after the provider accepted the job still answers with the job's task id (`pending`), and the job is cancelled at the provider when the provider allows it, so it can be found, collected or cancelled; a submission whose answer was lost is reported as of unknown outcome (`MEDIA_SUBMIT_OUTCOME_UNKNOWN`), never as not sent: look for it in the provider's console before submitting again.
`/network-scan [on|off|status]` turns local-network scanning for model servers on or off; when on, the Agent scans at each start and `/provider` shows what it found. `off` prints `Local network scanning is now off. Nothing on your network will be probed.`

### Support

`/bundle` (Agent only) is described: `preview` ("See what a support bundle would hold", the report a bare `/bundle` runs where no list can be shown: it builds one in a temporary place, shows it and keeps nothing), `export [<file>] [--replace]` ("Save a support bundle": settings and setup with every secret taken out; an existing file is kept unless `--replace`, which asks first), `inspect <file>` (what it holds and which settings loading it would change) and `import <file> [--include-security]` ("Load settings from a support bundle"; a model cannot run it, and loading security settings loosens a protection and asks first).
`/health compat [--json]` is `goodvibes-agent compat`.

## The model's tools in the Agent

The Agent's main conversation registers 83 tools: 27 of the terminal app's 28 platform tools and 56 Agent tools.
The platform tool the Agent does not register is `work_plan`; the Agent has `agent_work_plan`, its local todo list, instead.
The other 27 platform tools (`agent`, `analyze`, `channel`, `context_accounting`, `contract_self_check`, `control`, `edit`, `exec`, `fetch`, `find`, `goodvibes_context`, `goodvibes_settings`, `inspect`, `mcp`, `profile`, `query`, `read`, `registry`, `remote`, `repl`, `repo_map`, `state`, `task`, `trigger`, `web_search`, `workflow`, `write`) are described under "Tools" in the terminal-app part. In the Agent they pass, in order, the Agent's tool policy guard, its execution-safety wrapper and definition compaction: every tool except the most used ones is shown to the model with a short summary and its full description is one `agent_harness mode:"tool"` lookup away.

The 56 Agent tools:

| Tool | What it does |
| --- | --- |
| `accounts` | The register of accounts created for the owner: list, alias, record, forget, sweep. |
| `agent_artifacts` | Browse, preview, export, package and archive saved Agent artifacts. |
| `agent_autonomy_schedule` | Schedule one visible autonomous Agent task. |
| `agent_channel_send` | Preview or deliver one message through one configured target (the rules of `/channels send`). |
| `agent_documents` | Create document drafts, review suggestions, attach artifacts, export. |
| `agent_harness` | Inspect or operate Agent harness surfaces; `mode:"modes"` lists every mode, `mode:"summary"` is the map. |
| `agent_knowledge` | Read Agent Knowledge: status, ask, search, sources, nodes, issues, item, map, connectors. |
| `agent_knowledge_ingest` | Ingest one source into Agent Knowledge. |
| `agent_learning_consolidation` | Preview, apply, roll back or recreate one duplicate-consolidation phase of local learning records. |
| `agent_local_registry` | Inspect or update Agent-local memory, notes, personas, skills, bundles and routines. |
| `agent_media_generate` | Preview or generate one image or video artifact, or collect a pending job. |
| `agent_model_compare` | Blind-compare models on a prompt or artifact, judge, and apply the winner. |
| `agent_model_compare_candidate` | Run one metered blind-comparison candidate with an exact model and bounded output. |
| `agent_notify` | Preview or send one plain-text notification. |
| `agent_operator_action` | Run one allowlisted approval, automation or schedule action on the connected host. |
| `agent_operator_briefing` | Native work counts, historical planning, approvals, automation, schedules and capacity. |
| `agent_operator_method` | Invoke one daemon operator method. |
| `agent_reminder_schedule` | Schedule one reminder on the connected host. |
| `agent_research_report` | Save one sourced research report artifact. |
| `agent_research_runs` | Track visible research runs and their checkpoints. |
| `agent_research_sources` | Manage the research source review queue. |
| `agent_review_packet_presets` | Save and refresh reusable review packet presets. |
| `agent_review_packet_share` | Share one reviewer archive through a channel, route or webhook. |
| `agent_schedule_edit` | Edit one connected schedule. |
| `agent_work_plan` | The Agent's todo list for this project. It records work and does not run it. |
| `audit` | Release readiness and packaged release evidence. |
| `autonomy` | Choose the route for ongoing work and inspect the visible autonomy queue. |
| `browser` | Drive a real browser: open, read, click, type, sign in, screenshot, tabs. |
| `capability_status` | What this build can do now, read from its live state. |
| `channels` | Channel readiness, setup guide, triage and delivery receipts. |
| `computer` | Browser, desktop and computer-use readiness and routes; opens the browser cockpit. |
| `connected_calendar` | The Google and Microsoft calendars connected with `/calendar connect`. |
| `context` | The applied project instructions and prompt context, with receipts. |
| `delegation` | Delegation routes and policy, including the hand-off to the terminal app. |
| `device` | Device, voice and browser routes. |
| `execution` | Local work routes, execution history and file recovery. |
| `google` | Read and send Gmail; read and write Google Calendar. |
| `host` | Connected-host status, capabilities, service endpoints and the operator method catalog. |
| `import_goodvibes_settings` | Preview or apply the import of the terminal app's settings. |
| `memory` | Memory posture, external memory providers, the learning curator and records. |
| `models` | Model routes, providers, the local model cookbook and local server checks. |
| `occasions` | Occasions and trips: raise one, answer yes, no or later, the gift interview, capture facts. |
| `personal_ops` | The daily briefing, inbox and calendar review queue, connector readiness, request intake. |
| `phone` | Use a paired phone: camera, screen, location, clipboard, alerts. |
| `process` | List, poll, read logs of, wait on, stop and write to tracked background processes. |
| `research` | Plan, track, source and save research. |
| `route` | Choose the best visible route for a task without running anything. |
| `schedule` | List, create, remind, edit, run, pause, resume and delete schedules. |
| `security` | Security posture, findings, and how the gate would decide one action. |
| `sessions` | Saved sessions, bookmarks and transcript continuity. |
| `settings` | List, get, set, reset and import settings. |
| `setup` | First-run setup: status, next repair, checkpoints, token repair, smoke checks, finishing. |
| `support` | Support-bundle routes and redacted bundle summaries. |
| `terminal` | Start one tracked background shell command (`background:true` is required). |
| `vibe` | Inspect and manage VIBE.md files. |
| `workspace` | Inspect and run workspace actions, views, slash commands and keybindings. |

Every tool that changes something outside the conversation (a message, a reminder, a schedule, a setting, a delivery, a media generation, a daemon method) needs the owner's explicit request and a recorded admission from the permission gate; a `confirm` field alone never grants it.
`terminal` refuses a call without `background:true` (`terminal is the tracked-background adapter. Use exec for bounded foreground shell commands, or call terminal with background:true.`). A background start whose program is `sudo`, `su`, `doas` or `pkexec` is blocked; a command that only mentions one of them in its arguments is read once by the decision model, and is blocked when that reading does not settle or no decision model is in use.

## Agent settings

Settings work as in the terminal app (`/settings`, `goodvibes-agent -c key=value`), stored under `~/.goodvibes/agent/`.
A project settings file cannot change permission, approval, provider, tool, surface, automation or helper settings.
The settings the Agent adds or uses most:

<!-- generated: settings:checkpoints -->

<!-- generated: settings:daemon -->

<!-- generated: settings:profile -->

<!-- generated: settings:occasions -->

<!-- generated: settings:calendar -->

<!-- generated: settings:google -->
