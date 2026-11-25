# The Agent (`goodvibes-agent`)

The Agent is the GoodVibes personal assistant: chat, research, mail and calendar, reminders, notes, memory, personas, skills, routines and documents in one terminal workspace.
It is built on the same terminal shell as the terminal app, so most of the previous part applies to it unchanged.
This part first lists what the Agent shares, by the heading in the terminal-app part where it is described, and then describes in full everything that differs and everything only the Agent has.

## What the Agent shares with the terminal app

These work in the Agent exactly as described under the named heading of the terminal-app part, with `goodvibes-agent` in place of `goodvibes` and `~/.goodvibes/agent/` and `<project>/.goodvibes/agent/` in place of `~/.goodvibes/tui/` and `<project>/.goodvibes/tui/`:

| Topic | Heading in the terminal-app part |
| --- | --- |
| Option parsing, `--`, typo refusal, run-only flags | "Rules of the command-line parser" |
| `-m`, `--provider`, `-C`, `-c`, `--enable`, `--disable`, `-p`, `--print`, `-o`, `--json`, `--just-vibes`, `--yolo`, `--no-alt-screen`, `-r`, `-s`, `--timeout`, `--max-turns`, `--omit-accumulated`, `--answer-permissions`, `--prompt-file`, `-h`, `-v` | "Global options" |
| `models`, `providers`, `subscription`, `secrets`, `sessions`, `pair`/`qrcode`, `completion`, `help`, `version`, `plugin bundles` | "Command-line commands" (the matching command) |
| Composer markers `!`, `!#`, `# `, `@model:`, `!@<path>`, paste folding, what input history keeps of a fold | "What the composer does with typed text" |
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

- Chatting interactively. Each message runs in the Agent's own process, and one line says why, for example `No connected host is set up for this terminal, so messages run in this process.` (said once on this machine for each reason; after that it goes to the activity feed only, and it is said again once a host has taken a message and later cannot).
- Its tools that act on this machine: files, shell commands, the browser, MCP servers, plugins.
- `goodvibes-agent memory`: with no credential found (or no daemon answering, when the daemon is on this machine) it reads and writes the shared memory store file on this machine, `~/.goodvibes/shared/memory.sqlite`. (A daemon on another machine that does not answer: reads use this machine's file, and a write is refused with `The connected host <url> did not answer; nothing was stored. ...`.)
- Personas, Agent skills, routines (except promotion), notes, VIBE.md, profiles, sessions and settings.

When a credential is found and the daemon answers, `goodvibes-agent memory` works on the daemon's store over the network instead of the file. If the daemon refuses that credential, every `memory` subcommand fails with the daemon's refusal (for example `Authentication required`, exit `1`) and does not fall back to the file. Fix the credential (see the lookup order below), or remove the credential that is being refused (an environment variable such as `GOODVIBES_CONNECTED_HOST_TOKEN`) so the command uses the file.

These need the daemon and a credential, and refuse without them:

- `goodvibes-agent run` (no local fallback: exit `1`, `stopReason` `native-unavailable`).
- Knowledge (`knowledge`, `ask`, `search`, and Memory and knowledge inside the Agent), `delegate`, `owner-profile` (the About you tab inside the Agent), `ci`, `principals`, `channel-profiles`, `fleet`, `relay`, `tasks`, `compat`.
- Schedules and reminders (Automation, in the menu; `routines promote`), approvals, channels and deliveries, `/work`.

The Agent dials its connected host at one origin, settled in this order at start; each step that applies replaces the one before:

1. The setting `daemon.connectedHost.url` (empty by default), an origin with its scheme such as `https://10.0.0.7:3421`. When it is empty, the daemon on this machine, at the address its bind settings give: `controlPlane.hostMode`, `controlPlane.host` (default `127.0.0.1`), `controlPlane.port` (default `3421`), with `https` when `controlPlane.tls.mode` is not `off`. Those are daemon settings, shared by every program on the machine; the daemon part describes them. With `controlPlane.hostMode` `local` the address is `127.0.0.1`; a wildcard bind host (`0.0.0.0`, `::`) is dialled as `127.0.0.1`.
2. The environment variable `GOODVIBES_AGENT_RUNTIME_URL`; when it is not set, `GOODVIBES_AGENT_BASE_URL` (an older name). Only one of the two is read.
3. `-c daemon.connectedHost.url=<origin>` on the command line.
4. `--runtime-url <url>` on the command line.

When no origin is stated and `controlPlane.host` names another machine, the Agent does not dial it: every connected-host feature refuses with `controlPlane.host names <host>, which is another machine, and how to reach it was not stated. Set daemon.connectedHost.url to https://<host>:<port> (encrypted), or to http://<host>:<port> to send this Agent's credentials unencrypted over the network; ...`. Nothing is sent.

A runtime URL (from step 2 or 4) must be `http://host[:port]` or `https://host[:port]` with no path, query, fragment or user name; a bare `host:port` is read as `http://host:port`, and a missing port means `3421`. It sets `daemon.connectedHost.url` for this launch only and saves nothing.
A bad value stops the Agent before it starts, with exit `2`:

```text
$ goodvibes-agent --runtime-url ftp://host.example compat
--runtime-url must use http:// or https://.

$ goodvibes-agent --runtime-url http://127.0.0.1:3421/api compat
--runtime-url must point at the connected GoodVibes API root, not a path, query, hash or user name.
```

The same messages name `GOODVIBES_AGENT_RUNTIME_URL` or `GOODVIBES_AGENT_BASE_URL` when the bad value came from the environment. Other refusals: `requires a non-empty http(s)://host:port value`, `must be a valid http(s)://host:port URL`, `must include a hostname`, `port must be from 1 to 65535`.

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

`goodvibes-agent` has no `acp`, `open`, `hooks validate`, `host pair` (it uses `setup pair`), `support-bundle` (it uses `bundle`), `plugin init`, `plugin validate`, or `plugin trust` on the command line (trust is set with `/plugin trust` inside the Agent).
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

The Agent sends text only. A message carrying an image (a pasted clipboard image, a pasted path of an image file, a typed `@photo.png` or `!@photo.png`, or "Send an image with a message" in This conversation) is not sent:

```text
Not sent: a conversation turn carries text only, and this message has [IMAGE: img1, photo.png, 812KB]. Your text is back in the composer; to send it, remove the image and describe it in words, then press Enter
```

For a typed reference the message names the reference (`@photo.png`); for an image sent from This conversation, it names `attached image`.

The text goes back into the composer; remove the image marker or reference and describe the image in words.

### What the conversation shows besides messages

Other notices are never drawn over the conversation: the status bar counts the unread ones and `Ctrl+N` (or `/notifications`) opens them, newest first. What is a notice follows the same rule as in the terminal app (see "Notifications" in the terminal app part): only what needs you or tells you what you could not otherwise see; work in flight, routine successes and things already said are not. These lines are drawn in the conversation itself, where they happened:

- Why a turn ended without an answer, with what to do next, for example `sample chat request failed 500: ...` then `Hint: ...`, or `openrouter chat request failed: Connection error.` then `Next: send it again, or choose another provider or model with /model.`
- The first time a model request fails and is retried, why, and how long the retries can take: `Retrying up to 5 times over about 2 minutes. Next: wait, press Esc to stop, or choose another model with /model.`, or, when a fallback model is open (see "Failover" in the terminal app part), `Retrying once in about 2 s, then moving to the next model of your fallback order. Next: wait, or press Esc to stop.` The row under the conversation counts the attempts (`Retrying (attempt 2/5)...`).
- Why a message was not sent and what to do, for example when the connected host refuses it because the workspace is not registered. The text stays in the composer.
- The output of a `!` command: the command, its output and its exit status.

The status bar is the terminal app's (see "Screen layout"): `Permissions:` and the mode in force in words with the `shift+tab` key, the unread notices with `ctrl+n`, `context 34%`, `branch main, changed` (only in a folder registered as a project with `goodvibes-agent workspaces register`; read at start and after each turn), `model <name>` and, as in the terminal app, the `ctrl+g m menu` keycap (the menu of every place); a click on a segment opens its view, except the branch (the Agent has no changes view). A provider warning (a model you use stopped being free, a custom provider file that did not load) is said in the conversation, as in the terminal app. The header names the program, its version and the session. A hosted session's mode is its host's: the segment shows it, and `Shift+Tab` sends the change to the host. The status bar keeps one short chip for the power state (`sleep disabled`, `sleep held` or `keep-awake refused`); the full note, and a warning such as the sleep-edge hooks being off, is a notice in `/notifications`, posted when it changes.

### Keys

The Agent's rebindable keys differ from the terminal app's. Its file is `~/.goodvibes/agent/keybindings.json`, in the format described under "Changing a key".

| Action | Default key | What it does |
| --- | --- | --- |
| `leader` | `Ctrl+G` | Start a two-key shortcut, as in the terminal app ("The leader and the menu"). |
| `open-menu` | `Ctrl+G` `m` | Open the menu of every place. |
| `next-field`, `choose`, `back` | `Tab`, `Enter`, `Esc` | As in the terminal app. |
| `move-up`, `move-down`, `move-left`, `move-right` | the arrows | Move. |
| `copy-selection` | `Ctrl+G` `c`, `F5`, `Ctrl+Shift+C` | Copy selected text. |
| `clear-cancel` | `Ctrl+C` | Clear the composer, cancel generation, twice to exit. |
| `screen-clear` | `Ctrl+L` | Repaint. |
| `command-palette` | `Ctrl+P` | Open help: every command and keyboard shortcut in one searchable list (the same as `?` and `/help`). |
| `workspace-picker` | `Ctrl+G` `w` | Open the Agent workspace. |
| `workspace-close` | `Ctrl+X` | Close the Agent workspace. |
| `workspace-close-all` | `Ctrl+G` `x`, `Ctrl+\` | Close the Agent workspace. |
| `workspace-tab-next` | `Ctrl+]` | Next workspace category. |
| `workspace-tab-prev` | `Ctrl+[` | Previous workspace category. |
| `open-agents` | `F2`, `Ctrl+O` | Open Your agents: what is running, what waits for the owner, what is scheduled, the background services. |
| `scroll-page-up`, `scroll-page-down` | `PageUp`, `Ctrl+PageUp`; `PageDown`, `Ctrl+PageDown` | Scroll the transcript by a page. |
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
| `undo`, `redo` | `Ctrl+Z`; `Ctrl+G` `z`, `Ctrl+^` | Undo or redo a composer edit. |
| `paste` | `Ctrl+V` | Paste. |
| `focus-work-tree` | `Ctrl+G` `Up`, `Ctrl+Up` | Move onto the work tree. |
| `cycle-permission-mode` | `Shift+Tab` | Cycle this session's permission mode, as in the terminal app. |
| `open-notifications` | `Ctrl+N` | Open the notifications; the status bar counts the unread ones. |
| `failure-other-model` | `Ctrl+G` `o`, `F9` | On the newest failed turn: choose another model and send the prompt again. |
| `failure-details` | `Ctrl+G` `i`, `F3` | On the newest failed turn: show what the provider said. |
| `failure-retry` | `Ctrl+G` `r`, `F12` | On the newest failed turn: send the prompt again (a turn that already ran tools continues from their results). |
| `failure-sign-in` | `Ctrl+G` `s`, `F4` | On the newest failed turn whose provider refused its key: open the provider sign-ins (`/auth`). |
| `next-session` | `Ctrl+G` `n`, `Ctrl+Q` | While the session chips show: the next session (agent or process). |
| `previous-session` | `Ctrl+G` `p`, `Ctrl+_` | While the session chips show: the previous session. |
| `contract-question-ordinary` | `Ctrl+G` `q` | While a contract's question is on offer: send the next message as an ordinary one. |
| `model-picker-group` | `Ctrl+G` `g` | In the model list: group it another way. |

As in the terminal app, the actions that sat on an `Alt` or `Ctrl+Shift` chord are a leader shortcut by default, beside a second key every terminal sends; a chord can be bound back in `keybindings.json`. The leader is read over every screen, the places' keys are groups of the table (`place.<place>.<action>`), the model changes keys as the System place's Keys tab does (`keys.bind`, `keys.reset`, `keys.reset-all`), and rows, tabs and menu rows of a place can be clicked, as in the terminal app. The System place is the terminal app's: This session (the Agent's own status report, `q` to close the Agent, the print level), Setup (the checklist with "Who decides" first, and the System topics the Agent sets up itself), Sleep, Updates, Voice and Sign-in (read from the daemon the Agent connects to), and Keys; `/status` typed opens it.

The Agent has no word-movement or kill-ring keys, and no cancel-tool, keep-awake, memories-used or voice key.
The old action names `panel-picker`, `panel-close`, `panel-close-all`, `panel-tab-next`, `panel-tab-prev` and `sidebar-toggle` are read as `workspace-picker`, `workspace-close`, `workspace-close-all`, `workspace-tab-next`, `workspace-tab-prev` and `open-agents`.

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
The Agent has the terminal app's `/hooks` command, with the same actions: `contracts` lists the hook points and the managed hooks file, `scaffold`, `chain`, `enable`, `disable` and `remove` change managed hooks, `simulate` shows which hooks an event would run, `reload` reads a hand-edited file again, and `export`, `inspect` and `import` move hooks between machines. `open` is refused: the hooks screen is the terminal app's, and `/hooks contracts` lists the same. The Agent has no `hooks validate` on the command line; check a file with the terminal app's `goodvibes hooks validate` in the same directory, or `goodvibes doctor hooks`.

Besides `exec`, the Agent runs commands through `terminal` (`args.command`), `process` (`args.command` for `action: "start"`, and `args.data` written to a running process's standard input for `action: "write"`), `agent_harness` (for example `mode: "run_background_process"`) and `agent_operator_method` (daemon methods that run a command on a paired peer or backend). A hook fires for the tool called, whether the model called it or another tool ran it, in every permission mode, so a hook that guards commands needs an entry for each tool that runs one. The `git push` example under "Hooks" in the terminal-app part registers all of them. To make sure a command never runs, use a never-run rule instead: `/permissions never git push` (see "Never-run rules" in "Permissions and decisions"); the rule is kept in the one rules file every program reads (`~/.goodvibes/shared/permission-rules.json`), so it holds for the Agent's own turns, the terminal app and turns the Agent hands to a hosted session on the daemon.

### Plugins in the Agent

The Agent loads plugins from the same two directories as the terminal app (`<project>/.goodvibes/plugins/` and `~/.goodvibes/plugins/`), with the same manifest, entry file and trust tiers (see "Plugins" in the terminal-app part). The trust tier is shared by both programs (`~/.goodvibes/plugin-trust.json`); the enabled list is not: the Agent starts only the plugins enabled in its own `~/.goodvibes/agent/plugins.json`.
The Agent's `/plugin` takes `list`, `enable <plugin>`, `disable <plugin>`, `reload`, `quarantine <plugin> [reason]`, `lift <plugin>`, `trust`, `trust-key`, `verify` and `capabilities`, the same actions and answers as the terminal app's `/plugin`. `goodvibes-agent plugin` on the command line has only `bundles`. To run a plugin in the Agent:

1. Set its tier if it needs one: `/plugin trust word-count limited` (or `goodvibes plugin trust word-count limited`).
2. `/plugin enable word-count` loads and starts it at once and records the choice, with the directory it was enabled from, in `~/.goodvibes/agent/plugins.json`: `Plugin 'word-count' switched on and started.`, or the reason it did not start.
3. `/plugin list` marks each plugin `[active]` (loaded and running), `[enabled]` (enabled but not running: still starting, refused, or failed to load; the start-up warnings say why) or `[disabled]`, followed by its name, version and `tier <tier>`. The terminal app's `[loading]` mark does not appear in the Agent. `/plugin disable word-count` stops it.

### Instructions and personality

On top of the files under "Project instructions", the Agent applies:

- VIBE.md, the personality file. Candidates, in order: `~/.goodvibes/VIBE.md`, `~/.goodvibes/agent/VIBE.md`, then in each directory from the git root down to the working directory `VIBE.md`, `.goodvibes/VIBE.md` and `.goodvibes/agent/VIBE.md`. Up to 16,000 characters of each are applied (a longer file is cut and shown as truncated); a file over 1 MB is not loaded. Every file is scanned for secret-looking content and blocked when it holds any. The files are read for each turn, so an edit applies on the next turn.
- Project context files, applied in this order: `$HERMES_HOME/SOUL.md` (only when `HERMES_HOME` is set); `.hermes.md`, `HERMES.md`, `AGENTS.md` and `CLAUDE.md` in every directory from the project root down to the target directory; `.cursorrules` and `.cursor/rules/*.mdc` in the working directory. Each is secret-scanned and bounded.
- Reviewed, high-confidence memory and reviewed, ready personas, skills and routines. Unreviewed, stale, low-confidence or blocked records are not applied; they are listed as review work.

VIBE.md is managed on the Personas tab of Memory and knowledge: "VIBE.md files" (`personas.vibe`: which files apply and which are blocked), "Read a VIBE.md" (`personas.vibe-show`: project, global or a file), "Make a VIBE.md" (`personas.vibe-create`: writes the starter; putting it in place of an existing file loses that file) and "Use a VIBE.md as a persona" (`personas.vibe-import`, with a name, a summary, reviewed now and use it now; "reviewed now" loosens a protection, so a model's call is put to you, opening on No).

### Commands that exist in both but behave differently

| Command | In the Agent |
| --- | --- |
| `status`, `doctor` | Also report the connected host, its compatibility, Agent Knowledge readiness, relay settings, the Agent's role and checkpoint registration. `doctor` findings read `[warning:<area>:<id>]` with `cause`, `impact` and `action`; it exits `1` only for a must-fix finding, and `--strict` (not in the help) exits `1` on any finding. `status` always exits `0`. |
| `setup` / `onboarding` | Opens the Agent on `/setup`. `setup pair [--name <device-name>] [--apply]` and `setup unpair` replace `host pair` and `host unpair`. |
| `auth` | Read only: `auth`, `auth status`, `auth review`, `auth users`, `auth sessions`. User administration is done with `goodvibes auth` or in the daemon. |
| `tasks` | `tasks list` and `tasks show <taskId>` read the connected host's tasks; submission is refused. |
| `bundle` | `bundle export [path]`, `bundle inspect <path>`, `bundle import <path> [--yes]`. Import checks every value before changing any and without `--yes` lists what it would set and exits `2`. A host on another machine (`controlPlane.host`) gets its settings with its own pairing or `GOODVIBES_CONNECTED_HOST_TOKEN`, never this machine's daemon token; with neither the import is refused and nothing is sent. |
| `/model`, `/provider` | The same commands as the terminal app's; how hard the model thinks is set in This conversation, as there. `/provider sign-in` always finishes with `/provider finish <provider> <code or address>` (the Agent does not listen for the browser), and `/provider open` refuses because the Agent has no sign-ins screen. |
| `/settings` | A guided command, the same in both programs: `open [where]` (the report: the settings screen at a topic, setting or search), `list [words]`, `get <setting>`, `set <setting> <value>` and `reset <setting>`; a setting is chosen by its name. A model changes a setting through the settings tool, which asks the owner for a loosening change. |
| `/agents` | The same description as the terminal app's. `open` opens Your agents; `hand-off <the work>` (with `--review`, `--reason`, `--success`, `--workspace`, `--priority`) hands build, fix or review work to the terminal app through a shared session, and `handed-off [<session>]` lists what was handed off or shows one's progress and latest answer. `hostable` and `host <agent> [folder]` list and host a coding agent on the connected host, as `n` in the panel does. Team modes, recipes, archetypes and work contracts are refused and name the terminal app. `open --target <id>` selects that row. |
| `/memory` | The same command as the terminal app's `/memory` (see "Memory and knowledge" in the terminal app's part): bare, it opens the list of actions, "See your memory" first; `open` opens the workspace's Memory page; `injections` refuses, because the Agent records no per-turn memory. |
| `/session` | The same command as the terminal app's `/session`. It reads the cross-session task graph (`graph`) and refuses `link-task`, `hand-off`, `accept`, `withdraw` and `cancel` (hand work over with `/agents hand-off <the work>`); `save-file` writes Markdown or text only; `save-saved` prints the redacted transcript here and writes no file (`goodvibes-agent sessions export <id> <path>` writes JSON); `upload` and the branch actions are refused. |
| Tools and extensions (the menu) | The same place as the terminal app's. Its Skills, Skill bundles and Published skills tabs are the one skill store both programs read (the Agent's own `~/.goodvibes/agent/skills/skills.json` of 3.5.0 is carried into it once, at the first start of this version, and left as it was), its Presets and Managed settings tabs act on the Agent's own settings (see "Skills" in the terminal app's part). |
| `/hooks` | The terminal app's hook actions without its screen: `contracts`, `scaffold`, `chain`, `enable`, `disable`, `remove`, `simulate`, `reload`, `export`, `inspect`, `import`. |
| `/plugin` | The same description as the terminal app's: `list`, `dirs`, `inspect <name>`, `review`, `enable`, `disable`, `reload`, `quarantine`, `lift`, `trust <plugin> <untrusted|limited|trusted> [note]`, `trust-key`, `verify`, `capabilities` work here. `open` (the plugins screen), `publish-local` and `unpublish` (the terminal app's local catalog, which its `/marketplace` installs from) are refused here saying so and naming the terminal app. |
| Automation (the menu) | The same place as the terminal app's, on the connected host's schedules and their runs, triggers and the commands they may run, CI watches and check-ins (see "Automation and host actions" below). |
| `/calendar` | The same command as the terminal app's, on the Agent's own events, its calendar feeds and its calendar accounts; `change` and `status` (the daemon's calendar) are the terminal app's (see "Personal operations" below). |
| `/payments` | Adds `address <billing|shipping>`. |
| `/devices` | The terminal app's command: device tokens on the connected host (`list`, `rename`, `revoke`), "Pair something" (`pair device [--name <name>]` mints a named device token and shows its link and QR, or, when the host on this machine serves only this machine, its link and sign-in code for a browser here and no QR (see `goodvibes pair` in the terminal-app part); the link and code are printed masked, the address readable, as one transcript block whose block-copy key (`Ctrl+Y`, named on the block's last line) copies the real link (the block holds the transcript's focus until you scroll or the conversation moves on, so the key acts on it wherever it sits), and when nothing reaches a clipboard and no QR is shown the link is printed in clear once, saying why; `pair host [--apply]` pairs this Agent with its connected host, the same owner-checked flow as `/setup pair`), `host-status` and `unpair-host` (as `/setup pair` preview and `/setup unpair`), the relay through the connected host's relay verbs (`pair relay [--name <name>]`, `relay-status`, `relay-codes`, `relay-revoke <code>`, as `goodvibes-agent relay`), the devices waiting to pair as nodes (`requests`, `approve <request> [--replace]`, `reject <request>`, the owner's own act), and the paired phones (`nodes`, `grants`, `revoke-grant`, `captures`, `delete-capture`). Channel setup and the shared token are the terminal app's and are refused here saying so. |
| Code and changes (the menu) | The same place as the terminal app's: changed files, commits, worktrees, code intelligence (what is ready, the files with problems, the lookups and installing a language server) and the results of the last lookup. The Agent keeps no code index, runs no test command, has no Changes view and does not commit for you, so those controls are not shown here. |
| `/voice` | The same description as the terminal app's (`speak`, `stop`, `on`, `off`, the local voice runtime, the wake word and the settings file); the runtime and the wake word are read and set up through the Agent's own voice service. |
| `/undo`, `/redo`, `/retry` | The same descriptions as the terminal app's; `rewind` is refused, since the Agent does not go back to a turn; `/retry` re-sends the last message. |
| `/checkpoint` | The same description as the terminal app's: `list` and `restore` as there; `make` is refused (the Agent takes checkpoints by itself, at the end of each turn, in a registered workspace) and so is `rewind`. |
| `/media` | The same description as the terminal app's (see "Media and devices" below); what is made is kept as an artifact and saved as a file, which is not opened. |
| Waiting for you (the menu) | The same place as the terminal app's: questions, approvals, held calls, decisions, Telegram messages, answered items and the kinds of approval, each answered or changed with its own keys. It adds Sends: the sends the content check refused in this Agent, exactly as they would go out, while they wait (five minutes). |
| `/health` | The same description as the terminal app's. `check` reads `setup`, `services` (the connected host's integrations), `provider`, `accounts`, `auth`, `settings`, `remote`, `mcp`, `memory`, `continuity`, `maintenance` and `approvals`; the other areas, the failure reports and `stop-agent` are refused and name the terminal app. `/health compat [--json]` is `goodvibes-agent compat`. |
| `/status` | The same description as the terminal app's; here it shows the current model and its context window with where the window came from, and the worktrees the start-up pass removed or kept. |
| `/services` | The same command as the terminal app's; `open` refuses because the Agent has no services screen. |
| `/setup` | A guided command with the same topics as the terminal app's `/setup`. `Choose a model`, `Sign in or out of a provider`, `Store a password or key`, `History and privacy`, `Bring over settings from the terminal app` and `Use a daemon on another computer` (the connected-daemon address `daemon.connectedHost.url`, whether the Agent may dial it, and `/setup pair`) open the workspace with only that topic's rows; `Add a provider of your own` runs `/provider add <name> <address>`; `Connect chat apps and services`, `How GoodVibes works with you`, `Safety and sandboxing`, `Memory and context`, `Paired devices and voice` and `Scheduled routines, watchers and triggers` open the matching workspace area; the topics marked `on the daemon` say to run `goodvibes setup` where the daemon runs. `Pair the Agent with a GoodVibes host` (`/setup pair [--name <name>] [--apply]`) and `Unpair the Agent from the GoodVibes host` (`/setup unpair`) (only when the owner types it in the Agent's own terminal: `/setup pair` there shows what pairing allows and asks for the displayed `PAIR <code>` in the same step, `--apply` changing nothing; any other caller gets the summary); `Run first-run again` opens the three steps. |
| `/auth` | `review`, `show <provider>`, `repair <provider>`, `bundle export <path>`, `bundle inspect <path>` only; no daemon sign-in or local users. |
| `/update` | The same description as the terminal app's, and every action works here: `check`, `apply`, `rollback`, `daemon [--check]`, and the install review `review`, `save-review <file> [--replace]` and `read-review <file>` (the same review file the terminal app writes). |
| This conversation | The same controls as the terminal app's, without the ones on what the Agent does not keep: no message queue, no guidance, no editor, no rewind and no checkpoint made on request. "Save this session under a name" saves to `<project>/.goodvibes/agent/sessions/`. |
| `/security` | The same description as the terminal app's; folder trust here decides whether the folder's hooks file loads and the MCP servers its files name start. Sandbox sessions and the screens are refused and name the terminal app. |
| `/help`, `?` | Open help: every command as a plain title with its slash name, grouped by task, and the keyboard shortcuts as the last group; the same list as `Ctrl+P`. `/help <command>` prints one command's actions and lines. |

Every command the Agent has is on its first screen (the bare `/` list) and in `/help`.

Terminal-app slash commands the Agent does not have: `/changes`, `/cluster`, `/communication`, `/deeplink`, `/eval`, `/helpers`, `/hosted`, `/local-auth`, `/marketplace`, `/plan`, `/release`, `/remote`, `/replay`, `/scan`, `/settings-sync`, `/startup`, `/tools`, `/usage`, `/web-search`. Their nearest Agent equivalent: `/network-scan` for `/scan`.

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

Built-in templates: `household`, `research`, `travel`, `operations`, `personal-productivity`. Each seeds one persona, two skills and one routine. A local or imported template's persona, skills and routines are held for review, and its VIBE text is written as `VIBE.md.pending` (not read) until it is renamed to `VIBE.md`.

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
| `skills list`, `skills enabled`, `skills active`, `skills attention`, `skills search <query>`, `skills show <id>` | Read; `active` lists the skills and bundles applied to turns (enabled or in an applied bundle, reviewed and setup-ready; a bundle also needs every member reviewed); `attention` lists skills with missing requirements or review work. |
| `skills create --name <name> --description <summary> --procedure <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]` | Create one. |
| `skills update <id> [...]`, `skills enable <id>`, `skills disable <id>`, `skills review <id>`, `skills stale <id> <reason>`, `skills delete <id> --yes` | Manage one. |
| `skills discover`, `skills import-discovered <name> [--enabled] --yes` | Import skills found on this machine. |
| `skills bundle [list|enabled|attention|show|create|update|enable|disable|review|stale|delete]` | Skill bundles, for example `skills bundle create --name "Ops Pack" --description "Daily operations bundle" --skills daily-brief --enabled`. |

These commands act on the one skill store every program reads, the skill files in the project's and your skill folders (see "Skills" in the terminal app's part); a skill file found there that nobody took in yet is listed by `skills discover`. Inside the Agent, the Skills tab of Tools and extensions (the menu) imports a shared SKILL.md and saves a skill as one (an existing SKILL.md is replaced only when you choose to, and is not kept).

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
    cli goodvibes-agent routines promote "weekly-review" --every "7d" --name "Agent routine: Weekly-Review" --yes
```

Inside the Agent (and the terminal app), "Run a routine now" (`g` on a routine, Routines tab of Memory and knowledge) sends the routine's steps as your next message in the main conversation.

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

1. Find it: `goodvibes-agent memory search "office"` (or, inside the Agent, `s` on the Memory tab of Memory and knowledge), and note its id.
2. Correct it: `goodvibes-agent memory edit <id> --summary "Office is in Denver" --yes` (prints `Agent memory edited` with the id and the new summary), or inside the Agent `e` on the record. `--detail <text>`, `--tags a,b` and `--scope <scope>` change those fields; what is not given is kept, and the record keeps its id, class, provenance and links.

To keep the old fact on record instead, mark it wrong and add the new one: `memory contradict <old-id> "Office moved to Denver"` (or `memory stale <old-id> <reason>` for a fact that is merely out of date), then `memory add fact "Office is in Denver" --scope project` and `memory review <new-id> reviewed --confidence 90` so it is applied. Inside the Agent these are `v` on the old record (contradicted, with the reason), `n` (remember something), `v` on the new one (reviewed and right, 90) and `x` (forget a record), on the Memory tab of Memory and knowledge.
The model can also change a record's text in place: ask it (for example "correct the memory about my office: it is in Denver now"); its `memory` tool has an `update` action, which needs your request and the permission gate's admission like any change.

#### `goodvibes-agent knowledge` (aliases `know`, `kb`), `ask`, `search`

(`goodvibes-agent find <need>` is not a knowledge search: it finds the GoodVibes capability that does what you need, see `do` and `find` below.)

These forms reach the connected host's knowledge under `/api/goodvibes-agent/knowledge/*`: the daemon's one knowledge store, the same the terminal app and the web app's Library use. What the Agent kept in its own Agent Knowledge before (`~/.goodvibes/agent/knowledge-agent.sqlite`) was carried into it once, at the daemon's first start of this version; the old file is left as it was.

| Form | Effect |
| --- | --- |
| `knowledge status` | Readiness. |
| `knowledge ask <question> [--limit <n>] [--mode concise|standard|detailed]`, or `ask <question>` | A source-backed answer. |
| `knowledge search <query> [--limit <n>]`, or `search <query>` | Search. |
| `knowledge list [--kind sources|nodes|issues] [--limit <n>]`, `knowledge get <id>`, `knowledge map [query] [--limit <n>]` | Read. |
| `knowledge connectors [connectorId|doctor <connectorId>]` | Ingest connectors and their checks. |
| `knowledge ingest-url <url> [--title <title>] [--tags a,b] --yes` | Ingest a page. |
| `knowledge ingest-file <path> [--title <title>] [--tags a,b] --yes` | Ingest a file on this machine; it is read here and its bytes are sent, so a remote host ingests exactly that file. A file that cannot be read exits `1` with nothing sent. |
| `knowledge ingest-artifact <artifactId> [--title <title>] [--tags a,b] --yes` | Ingest a saved artifact. |
| `knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes` | Ingest through a connector; a `--path` file is read here and sent as the connector's content. |
| `knowledge import-urls <path> --yes`, `knowledge import-bookmarks <path> --yes`, `knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] --yes` | Bulk import (browser history is capped at 500 rows). Exits `0` only when every item was imported; a partial batch exits `1` and lists each failed item with its reason (JSON: `outcome.failed`). `--browsers` and `--sources` left out read every installed browser and both kinds. A URL or bookmarks list is read here and sent as its content, never as a path the host opens. `--home <dir>` (a browser profile home) is refused with exit `2` when the knowledge host is another machine. |
| `knowledge reindex --yes` | Rebuild the index. |

Options that would target another space (`--space`, `--knowledge-space`, `--knowledge-space-id`, `--include-all-spaces`) are refused.
Without a token: `Agent Knowledge error auth_required (authorization required)`, the route tried and the repair step; exit `1`.
Inside the Agent, knowledge is the Sources, Entries, Issues, Jobs and Connectors tabs of **Memory and knowledge** (the menu, `Ctrl+G` then `m`, or `/memory`), the same place as the terminal app's: add a page, a list of pages, bookmarks, a file, a saved artifact, your browser history (the owner's only) or something through a connector; ask, search, the map; review, tidy, rebuild (see "Memory and knowledge" in the terminal app part).

#### `goodvibes-agent find`, `goodvibes-agent do`

`find "<what you need>" [--output json]` names the three to five GoodVibes capabilities that do it (from the function group that serves the need), each with its id, inputs and risk; nothing runs. `do <capability id> [--input key=value ...] [--output json]` runs one by id through the connected daemon. A command you typed is the request, so it runs at once and prints what it did; a capability that acts on a conversation (clear, compact, undo) is refused in one line, since it runs inside the Agent's open chat. Exit `0` done (or found), `1` refused or failed, `2` bad usage. The same two verbs exist in `goodvibes` and `goodvibes-daemon`. `find` is not a knowledge search; that is `search`.

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
Inside the Agent the same is the About you tab of Memory and knowledge, the same place as the terminal app's.

#### `goodvibes-agent ci`, `principals`, `channel-profiles`

| Command | Forms |
| --- | --- |
| `ci` | `ci status <repo> [--ref <ref>] [--pr <number>]`; `ci watches list`; `ci watches create <repo> --delivery-channel <channel> [--ref <ref>] [--pr <number>] [--trigger-fix-session] --yes`; `ci watches delete <watchId> --yes`; `ci watches run <watchId>`. Status is always per job. |
| `principals` (alias `principal`) | `principals list`; `principals get <id>`; `principals create --name <name> --kind <user|bot|service|token> [--identity channel:value,channel:value] --yes`; `principals update <id> [...] --yes`; `principals delete <id> --yes`; `principals resolve --channel <channel> --value <value>` (reports `known: false` when nothing is mapped). `create`, `update` or `delete` without `--yes` changes nothing and exits `2`; with `--json` it prints `{ ok: false, kind: "confirmation_required", error, next: ["repeat the command with --yes"] }`. |
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

`relay status` reads the connected host's relay registration and the Agent's imported `relay.*` settings; `relay pair [name]` mints the payload one phone scans to reach the host through the relay, carrying a relay code for that phone alone. When the host's relay is off it asks first, opening on No: "Devices cannot reach this machine through the relay yet. Turn the relay on so they can?" (`[y/N]` in a terminal; the same ask in `/devices pair relay`); when no relay address is set, the same step has a field for it (`Relay address:`, its `wss://` shape checked as it is typed, under one line saying what a relay is and where its address comes from; `Turn the relay on` stays unpressable until the shape is right; in a terminal the address is asked after the `y`). Yes saves the address, turns the relay on and pairs in the same run (`relay.pairing.mint` with `turnOn` and `url`). While the relay does not answer yet, `/devices pair relay` says `The relay is on at <address>, and it is not answering yet. The pairing shows here as soon as it does; you can carry on meanwhile.` and prints the pairing when it comes; No answers "No relay pairing was made: the relay is off on the connected host, and it was left off." A host that could not register says so with its relay status; `relay codes` lists the phones' relay codes (id, name, created, last used; never the code) and `relay revoke <id>` cuts one phone off the relay at its next request while every other keeps working.
`fleet attempts list [--workstream <id>]` lists best-of-N attempt groups held for a winner pick; `fleet attempts judge <groupId>` asks the judge model to propose a winner (labelled as a proposal); `fleet attempts pick <groupId> <winnerItemId> --yes` merges the winner and removes the losing worktrees, waiting up to ten seconds for each and reporting it as seen: cleaned, still cleaning (with `git worktree list` to check), or not cleaned with the reason (a worktree holding work that exists nowhere else is kept); a loser that was not cleaned makes the command exit 1. A pick that times out, gets a 5xx or loses its connection is reported as `fleet_attempts_outcome_unknown` (exit 1): the winner may already be merged, so run `fleet attempts list` first; a group no longer listed was picked. `connected_host_unavailable` is used only when no request reached the host.
Both need the connected host; without it they print the reason and exit `1`.

#### `goodvibes-agent compat` (alias `compatibility`)

`compat [--json]` checks the connected host's compatibility and Agent Knowledge readiness. It exits `1` when the host is not compatible or not reachable:

```text
$ goodvibes-agent compat
GoodVibes Agent compatibility
  package 3.5.0
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

The Agent workspace is a full-screen view of categories, each a list of rows grouped by what a person does. It has no forms of its own: a row that does something names a slash command's action (shown in its Command column, such as `/memory add`), and `Enter` closes the workspace and opens that action's guided form, the same one the slash command opens (a row may fill some blanks in, such as the account of `/calendar use-app google`); a row's name is the action's own label. The rows come first; the pane under them says what the selected row will do (the action's sentence, or a setting's own description with its value and default as `/settings get` shows them) and, where the row's command has a report, that report's first lines, read by running it exactly as the command does, then in one sentence what the area is for. Every report is read by itself, in the background: those of Home and Work & Approvals at each start of the Agent (after the first frame), and those of any area as soon as it is shown. The screen is drawn at once, a report not in yet says `<command>: reading…`, and it fills in when it arrives. A reading is shared for 5 minutes, so moving between areas or opening the workspace again does not read it again; an older one is read again on the next opening; nothing runs on a timer. `Ctrl+R` reads every report, the host check and the work list again now. Coming back from a row's guided form that changed something reads that command's report again. An action's result names the time it arrived (`Action Result: Opened Research · 14:05`). A report that reaches past this computer (questions waiting on you, host tasks and processes, a mailbox, a provider) changes on its own, so once its reading is more than 5 minutes old its heading says so in the warning colour: `As /status showed it, read at 22:03, may be out of date: ctrl+r to read again:`. It is decided each time the screen is drawn (any key redraws it); nothing ticks. A report that reads only this computer (notes, skills, routines, personas, Agent homes, secrets, settings) lists stored things that change only when you change them, and a change made from the workspace reads it again, so it is never marked. The connected host's setup check runs on each opening (once its last reading is more than 5 minutes old), for a host on this computer or another, and the work list in Work & Approvals is kept live by its subscription from the moment the workspace opens, so it is never marked. The status line under the rows shows only once something has happened in the area. The heading of the rows (`Action  Command`) is in the accent colour while the arrow keys move in them, muted while they move in the area column. The report is in one of three states, each said in its own words: `<command>: reading…`, `As <command> showed it, read at 14:05:` with its lines (or "Nothing to show."), and `<command>: could not read it (tried at 14:05)` in the warning colour. When the connected daemon did not answer, it says `The daemon at <url> did not answer.` (a list that fell back says `Showing only what is held on this computer. Approvals and questions held by that daemon are not included.` and then `On this computer:` or `Nothing is waiting on this computer.`) and `GoodVibes reads this again when that daemon answers.`: the Agent's existing daemon check (every `watchers.heartbeatIntervalMs`, 30 s by default) sees it answer and every failed report is read again. Any other failure gives its reason and `GoodVibes reads this again the next time you open this area; ctrl+r to try now.`: a failed reading is never held as fresh, so it is read again when its area is shown again, when the workspace is opened and at the next start. Work & Approvals also shows the work view `/work open` shows. Nothing else is shown there. A setting row cycles a yes/no or a choice in place and opens the settings screen at that setting for a typed value or a `permissions.*` change; an area whose rows are all settings shows Setting, Default and Current columns, and a setting among action rows shows `now <value>`. A row that opens another area shows `/agent <area>` in its Command column, the command that opens that area; the other rows open a picker or say what to ask in the conversation.
The title row names the Agent home the session runs in, the model it answers with and its provider, and the daemon it works with (`Agent home default · model rt-1 (rtfake) · daemon on this computer`; `, signed in with a subscription` after the provider for a stored sign-in; `daemon at <host:port>` when `daemon.connectedHost.url` is set). In a home other than the default one, the status bar shows `home <name>` too.
It opens with `/agent [section]` or `Ctrl+G` `w` (the leader, then `w`); the Agent's status bar ends with the `ctrl+g m menu` keycap, the menu of every place, which the places replace this workspace's rows with as they are built. `/setup` opens one topic's rows of it at a time (below).
`Ctrl+]` and `Ctrl+[` move between categories; `/` searches actions by name, category, command or detail; `Ctrl+X` or `Esc` closes it. The footer reads `a-z ask the assistant (Esc comes back)`, then move, pane, open, search and refresh.
Typing a letter closes the workspace and puts the letter in the composer; while it is there, a row above the composer reads `Typing to the assistant · Esc: back to <area> (drops this letter)` (`keeps what you typed` once there is more than one letter).

The area column shows every group heading at every size. When every area does not fit, the groups the selection is not in fold to their heading and count (`▸ memory & habits (6)`), the everyday group staying open first while there is room, and moving the selection into a folded group opens it; only a group taller than the column scrolls, with `▲ 2 more areas` / `▼ 2 more areas` in muted text. At 80x24 every heading shows; from about 160x45 every area does.

The workspace has these 26 categories, in this order, in eight groups; there are no others. The everyday work comes first and setting up after; each group is shown by the heading in the second column (the first column is the group's id, which `goodvibes-agent setup` and the harness use). Home has no heading; the setup areas and Finish share the `set up` heading.

| Group | Shown as | Category id | Label | Actions | Holds |
| --- | --- | --- | --- | --- | --- |
| START | (no heading) | `home` | Home | 10 | Lanes into Setup, Inbox & calendar, Research, Documents, Schedules, Messaging, Memory and Work; the interaction mode (quiet, balanced, operator). |
| DAY-TO-DAY | get things done | `personal-ops` | Inbox & calendar | 25 | The daily operations hub: inbox, calendar, reminders, briefing, Google connection. |
| DAY-TO-DAY | get things done | `research` | Research | 21 | `/research` (a question or a page into the conversation, research runs, sources, sourced reports), what goes into Agent Knowledge. |
| DAY-TO-DAY | get things done | `documents` | Documents & Files | 42 | drafts and saved artifacts (Memory and knowledge), `/documents` (review packet reports), `/compare` (blind model comparison), uploads, exports, media. |
| DAY-TO-DAY | get things done | `conversation` | Conversation | 16 | Context review, compaction, prompt helpers, transcript navigation, session continuity, title, export, undo, redo, retry. |
| DAY-TO-DAY | get things done | `work` | Work & Approvals | 15 | Active operator state, pending approvals, background processes, the work plan. |
| DAY-TO-DAY | get things done | `automation` | Schedules | 20 | Confirmed reminders, routine promotion, and run, pause and resume of schedules and automation jobs on the connected host. |
| LOCAL BEHAVIOR | memory & habits | `owner-profile` | Your Profile | 9 | The owner profile kept by the daemon. |
| LOCAL BEHAVIOR | memory & habits | `memory` | Memory | 23 | Memory records, the prompt plan and the learning curator. |
| LOCAL BEHAVIOR | memory & habits | `notes` | Notes | 12 | Scratchpad notes (not memory, not Agent Knowledge): the Notes tab of Memory and knowledge. |
| LOCAL BEHAVIOR | memory & habits | `personas` | How it talks | 9 | Personas and VIBE.md: the Personas tab of Memory and knowledge. |
| LOCAL BEHAVIOR | memory & habits | `skills` | Procedures | 20 | Agent skills and bundles with their requirements: the Skills and Skill bundles tabs of Tools and extensions. |
| LOCAL BEHAVIOR | memory & habits | `routines` | Saved workflows | 13 | Routines (Memory and knowledge) and putting them on a schedule (Memory and knowledge, and Automation). |
| CAPABILITIES | tools & knowledge | `tools` | Tools & MCP | 10 | Task tools and MCP servers. In the MCP screen, Save writes a server and reloads the runtime and `Ctrl+R` (or the "Reload runtime" row) reloads at once, as in the terminal app; removing a server asks y/n. |
| CAPABILITIES | tools & knowledge | `knowledge` | Knowledge | 16 | Agent Knowledge status, ask, search and ingest. |
| OPERATIONS | where it runs | `profiles` | Agent homes | 10 | Named Agent homes and starter templates: `/agent-home`. |
| OPERATIONS | where it runs | `host` | Connected Host | 17 | Read-only views of the connected host: health, remote routes, host tasks and their output, sessions and the session graph, channels, schedules, knowledge, media, MCP, provider detail, routes and repair, provider auth, support bundles. |
| SETUP | set up | `setup` | Setup | 11 | Not listed: `/setup` opens it with only one topic's rows. `Choose a model`: local model, main model, reasoning effort. `Sign in or out of a provider`: sign-in start and finish, sign-out, see a sign-in. `Store a password or key`: credentials, secret policy. `History and privacy`: save history. `Bring over settings from the terminal app`: settings import. |
| ONBOARDING | set up | `account-model` | Models | 19 | Provider and model choice, reasoning, pins, and the advanced routes (helper, tool, TTS, embeddings, system prompt, cache). |
| ONBOARDING | set up | `assistant-behavior` | Behavior | 11 | How chat behaves during normal work and long-running tasks. |
| ONBOARDING | set up | `tools-permissions` | Tools & Permissions | 13 | The permission mode (its row lists each mode in one line, from the presets' short lines) and tool settings. |
| ONBOARDING | set up | `onboarding-display` | Interface | 9 | Display settings. |
| ONBOARDING | set up | `onboarding-channels` | Messaging | 74 | Chat channels (Slack, Discord, Telegram and others): enable each and fill in its credentials. Its description ends with the channels' readiness. |
| ONBOARDING | set up | `onboarding-voice-media` | Voice & Media | 21 | Voice, TTS, image input, media generation and telephony. |
| ONBOARDING | set up | `onboarding-context` | Local Context | 16 | Personas, starter memories, skills, routines, notes and knowledge, and importing their files; VIBE.md. |
| FINISH | set up | `finish` | Finish | 1 | Apply & close: writes the onboarding completion marker, so later launches start in the conversation. |

On the Agent's first launch, when the terminal app on the same computer has settings the Agent would take, the lines under the splash say so once: "The terminal app on this computer has settings. `⏎` brings them over and says what changed (later: /setup import-settings)." Enter on the empty composer takes the offer: it imports at once, and the answer lists what changed and how to put it back; typing a message instead leaves the offer, and `/setup import-settings` does the same later. Later launches do not say it.

Until setup is applied, the workspace opened for setup (`goodvibes-agent setup`) shows only the ONBOARDING group, and reveals its categories as setup reaches them; `/agent` shows all 26. A start whose model is not ready opens first run, not the workspace (see the install part of this file).
`/agent <section>` opens a section (category) by its id; the guided form lists them by label.

`/agent-home` manages separate Agent homes from inside the Agent (`goodvibes-agent profiles` from the shell): `list` (the report), `show <home>`, `next`, `use <home>`, `use-base`, `create <name> [--starter <starter>]`, `create-learned <name>`, `delete <home>` (deleted for good; `create` makes a new one), and the starters `starters`, `starter <starter>`, `guide`, `export-starter <starter> <file> [--include-vibe] [--overwrite]`, `import-starter <file> [--replace]` and `starter-learned <id>`.
`/agents open`, `Ctrl+O` and `F2` (and a click on the running indicator) open Your agents, the same panel as the terminal app's (see "Views" there): waiting rows first, one line per running agent, the agents finished this session, `Scheduled`, and `Background services  N healthy ›` (`b` opens it; an unhealthy service is listed by itself). `Enter` opens an agent full screen, where the composer steers it (a background process opens in the process monitor when it cannot open full screen), `s` stops it (asks first), `n` hosts a coding agent found on `PATH` on the connected host. It reads this process's agents and the connected host's. Notices that used to collect in the Activity view's recent list are in the notices (`Ctrl+N`, `/notifications`), as in the terminal app. The calendar events the Activity view listed as coming up are in `/calendar upcoming`; on a day with events the panel shows `N events today ›` under `Scheduled`, and `Enter` on it prints `/calendar upcoming --days 1`.
`/brief` (one action) prints a briefing with next actions: the model in use, what is ready (including spoken replies and whether this device is paired with its host), the work plan and schedules.
"See the project instruction files" (This conversation) lists the project instruction files (AGENTS.md, CLAUDE.md and the like) read into each turn, any cut short and any held back with why; "See what the last turns were given" (This conversation) shows what the last turns were given (memories, persona, skills, routines, what was left out, roughly how many tokens). The terminal app has neither control. `/tasks processes` lists the commands running in the background and whether a running one can be given input, a terminal or sudo; the terminal app refuses it with the reason.
The `/setup` topic's "Import GoodVibes settings" row reads the terminal app's settings once and imports that plan at once; the answer lists every setting and sign-in that changed and says `To put them back: your settings as they were before this import are kept as <settings file>.before-import-<time>; copy it over <settings file> and start the Agent again.` The previous setting values are also appended to `~/.goodvibes/agent/settings-import-undo.json` (`{ version, imports: [{ createdAt, settings }] }`, oldest first, so each import can be reversed in order). Replaced provider sign-ins are not kept; sign in again to restore one.

## The Agent's slash commands

The complete list of the Agent's slash commands, with usage, aliases and descriptions, is under "Slash commands: Agent" in the reference part.

The commands listed in the table under "Commands that exist in both but behave differently" behave as described there; every other command shared with the terminal app behaves as described under "Slash commands" in the terminal-app part. The commands only the Agent has:

### Work

Work is the same as in the terminal app (see "Work" there): one Work held and run by the daemon, shown in the Work place (the menu's "Work and agents" row, or `/work`), with the same lists (Work, Checklist, the remote runners) and the same keys. In the Agent you ask for work in the chat: the host decides whether it is an answer or a piece of work; "Ask in your own words" in the place says so. New work and work from a file work the same as in the terminal app.
`/work intake`, `intake-retry`, `intake-resume` and `intake-cancel` inspect or move forward a captured conversation input (the same as the `run --intake-*` flags). A message whose intake did not answer (it may have been recorded) is not counted as sent and is not sent again on its own: the Agent says `Your message may have been sent`, keeps the text in the composer (a message from the phone or a plan is kept aside instead of being retried every few seconds), and `/work intake` tells whether it arrived before it is sent again. `/work submission`, `submission-retry` and `submission-discard` follow up on a file submission.

The checklist is the project's running list of things to do, the same list as in the terminal app (the model's `agent_work_plan` tool keeps it); it records items and their state and runs nothing. Changes from the Work place are the owner's own.

### Personas, skills, routines, memory and personality

Notes, personas (and VIBE.md files) and routines are the daemon's: one store each (`~/.goodvibes/agent/notes/notes.json`, `personas/personas.json`, `routines/routines.json`), the ones every Agent turn reads for its prompt, managed for the Agent, the terminal app, the web UI, a model (`capability_run`) and a script (`goodvibes-agent do <id>`) alike. They are the Notes, Personas and Routines tabs of Memory and knowledge (the menu), each action a key on the selected item:
- Personas (`personas.*`): Enter changes it, `u` uses it (or stops using the one in use), `v` marks it reviewed (the owner's own act: a model's request is refused), `t` out of date, `s` reads it in full, `x` deletes it; `c` makes one, `f` searches, `e` shows the one in use, `d` lists the persona files found in this project's and your own persona folders and `i` imports one; `g` shows the VIBE.md files that apply and any that are blocked, `h` reads one, `m` writes a starter (replacing one only when you choose so; the one replaced is not kept) and `b` makes one a persona.
- Routines (`routines.*`): Enter changes it, `g` starts it now (its steps are sent as your next message; a model that starts one reads the steps as its answer), `v` marks it reviewed (the owner's own act), `t` out of date, `s` reads it, `x` deletes it; `c` makes one, `f` searches, `o` lists only those switched on or needing setup, `d` lists the routine files found and `i` imports one; `u` switches it on or off (switching on loosens a protection: a model's call is put to you), `p` runs it on a schedule (the daemon's own schedule; a routine is put on one only when it is switched on, reviewed and has nothing missing, and a repeat after a lost answer finds the schedule already made), `j` lists the routines put on a schedule so far, `k` shows one receipt and `y` checks them against the schedules that exist now (retiring the receipts of schedules that are gone). The same switches and schedule controls are on the Routines tab of Automation.
- Notes (`notes.*`): working context that is neither memory nor Agent Knowledge. Enter changes it (clearing its reviewed mark), `c` writes one (without a title, its first words are the title), `f` searches, `v` marks it reviewed (the owner's own act), `t` out of date, `s` reads it, `x` deletes it for good. Making something from a note leaves the note and records on it what was made, and a second of the same kind is refused: `m` a memory record (title the summary, text the detail), `p` a persona (not in use), `k` a skill and `o` a routine (both off unless you switch them on at once, which a model's call puts to you), and `w` adds the note's web page to your knowledge (refused when the note has none).

Skills and skill bundles have no slash command: they are the Skills and Skill bundles tabs of Tools and extensions (the menu), with every action of `goodvibes-agent skills` above, importing a shared SKILL.md and saving a skill as one. `/memory` is the same command as the terminal app's `/memory`.

### Documents, artifacts, comparisons and research

Drafts and saved artifacts are the daemon's: the drafts of each project (`<project>/.goodvibes/agent/documents/`), and one artifact store for every program (`~/.goodvibes/tui/artifacts/`; at its first start of this version the daemon copies the Agent's own earlier store, `~/.goodvibes/agent/artifacts/`, into it under the same ids and leaves the old folder as it was). Each act runs the Agent tool that does it in a turn (`agent_documents`, `agent_artifacts`, `agent_review_packet_presets`, `agent_review_packet_share`) in the daemon, as the owner's confirmed act (a deny rule still refuses). They are the Drafts and Artifacts tabs of Memory and knowledge; blanks that name a draft, comment, suggestion or artifact offer the current ones.

- Drafts (`documents.*`): Enter revises it (a new version), `s` reads it with its comments, suggestions and versions, `v` marks it reviewed, `c` comments, `o` resolves a comment, `g` suggests a change, `y` takes and `l` leaves a suggestion, `i` puts an artifact into it, `k` attaches one, `e` saves it as a Markdown artifact, `p` saves a review packet preset from it; `w` writes a new draft and `f` searches.
- Artifacts (`artifacts.*`): Enter looks at it (a short preview of a text artifact; binary content is never shown), `e` copies it byte for byte to a file of this project, `k` copies it into a package (a folder or one ZIP file, with a list of what is in it), `u` refreshes a review packet preset, `d` sends a reviewer handoff archive as a review packet through a channel, a route or a web address (it sends something outside this machine); `f` searches. Adding an artifact to your knowledge is "Add a saved artifact" (`j` on the Sources tab).

`/documents` keeps the review packet reports, which read the Agent workspace's own view of the packet: `readiness` (what stands in the way of review, each with what settles it), `packet-steps` (the six steps in order, which are done, and the next) and `timeline` (dated, oldest first); a model or script reads the same lanes as JSON through `agent_harness mode:"document_ops_lane" laneId:"reviewer_readiness|review_packet_wizard|review_packet_timeline"`.

`/compare` (`agent_model_compare`): `review [<comparison>] [--view review|side-by-side] [--related ...] [--bytes N] [--reveal]` (bare, from a model), `run <prompt> [--models ...] [--count 2-4] [--source <artifact>] [--rubric ...] [--system ...] [--max-tokens N] [--tag ...] [--task ...] [--document ...] [--reveal]` and `benchmark [<task>] [...]` (the local models on the standard task, tagged `local-model-route`); both spend money (the answer says what it cost where the provider says). Then `judge <comparison> <winner> <why> [--notes ...] [--reveal]`, `apply <judgment>` (the main model becomes the winner), `record-decision <judgment>` (keeps the model and records why), `export <source> [--as report|handoff|archive] [--related ...] [--reveal]`, `diff-handoffs [<older>] [<newer>] [--section ...]` and `analytics [--view analytics|synthesis] [--limit N] [--tag ...] [--task ...] [--document ...] [--no-reasons]`.

`/research`: `ask <question> [--sources <hints>]` and `inspect <address> [<what you want>]` send a message to the conversation, where the Agent researches with read-only web tools and adds nothing to Agent Knowledge; `start-run <question> --title <name> [--goal ... --plan ... --next ... --sources ... --note ...]` (`agent_research_runs`, a visible resumable run, then started at once: the answer is `Research run "<name>" started. It reports here when it finishes.`, the `research` tool's `runner` collects public web sources into the run and the source queue, and the conversation then says `Research run "<name>" finished: N sources collected into your research queue.` or `… stopped: <why>`). Every free-text option of `/research` (`--title`, `--question`, `--goal`, `--note`, `--sources` and the others) takes every word up to the next option or the end, so `--title Tomato blight notes` needs no quotes (quoting still works); the text the command takes without an option goes first. `add-source` answers `Source "<title>" kept in your research queue for "<question>".` and `save-report` `Report "<title>" saved as an artifact.`, not the tool's own output; `add-source <summary> --title <source> --question <question> [--url ... --publisher ... --published ... --evidence ... --credibility ... --score ... --tags ... --note ...]` (`agent_research_sources`) and `save-report --title ... --question ... --sources <one per line: title | address | trust | note> [--report ... --summary ... --findings ... --gaps ... --recommendations ... --method ... --confidence ... --plain --require-citations --tags ...]` (`agent_research_report`).

### Personal operations

Mail is the daemon's one mailbox (see "Mail" in the automation guide), the same in the Agent as in the terminal app; there is no slash command for it. **Mail, calendar and channels** (the menu, `Ctrl+G` then `m`) lists the inbox by itself; on a message `Enter` opens it, `n` writes a new one (sent when the form is submitted; a sent mail cannot be called back), `d` saves a draft, and `m`, `e` and `p` show the mailbox settings, change one and store the password on a hidden line. The model reaches the same capabilities (`mail.list`, `mail.read`, `mail.send`, ...) through `capability_run`, a script through `goodvibes-agent do`; `goodvibes-agent do mail.send --input to=ada@example.com --input subject="Lunch on Friday" --input body="Are you free at noon?"` answers `Sent to ada@example.com at <time>.` The Agent's own mail service is gone: mail is read and sent by the daemon on the same `surfaces.email.*` settings.

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
| `add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>]`, `delete <event>`, `import <path>`, `export [<path>]` | Local events; `delete` removes one for good (`add` makes it again). |

`/calendar add --title "Dentist" --start 2026-12-03T15:00` adds a local event.

The About you tab of Memory and knowledge reads and corrects the owner profile, the same place as the terminal app's (see `goodvibes-agent owner-profile`).
`/payments address` writes the address to the connected host's settings; the actions of `/payments` are the same as the terminal app's.

### Channels and delivery

`/channels` is the terminal app's command (one description for both; see "Chat channels"). Here the daemon's channel methods go to the connected host, and the Agent adds what it keeps itself: `readiness [--show all|ready|attention]` (the channels it can send to and what each lacks), `configured <channel>`, `guide [<channel>]`, `triage [--limit n]`, `send`, and `deliveries [--limit n]` (the stored receipts). Channel profiles are `/channels profiles`, `profile`, `set-profile` and `remove-profile`.

`/channels send` sends one message through one delivery target at once (a sent message cannot be called back):

```text
/channels send [--channel <surface[:route][ | label]> | --route <route[ | label]> | --webhook <http(s)-url>] [--link <link>] [--title <title>] <message>
```

- One recipient: `--channel` (a channel surface such as `slack`, optionally with a route and a label), `--route` (a bound route) or `--webhook` (an `http` or `https` address, asked for masked in the guided path and never shown). With none of them the message goes to the default target: the one ready channel whose default target is set. With no such channel it is refused (`No channel has a default target set, so there is nowhere to send this; nothing was sent.`), and with several it names them (`2 channels have a default target (slack, discord), so which one is meant is unclear; nothing was sent.`). More than one recipient is refused: `2 delivery targets were given, so the recipient is unclear and nothing was sent.`
- `--link` is sent with the message, under it, to that recipient; it is not a second target.
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
`/principals` is the terminal app's command, the same description in both apps, its methods called on the connected host.

### Automation and host actions

Automation (the menu) is the same place as in the terminal app, on the connected host: New schedule makes one (once at a date and time, every so often, a calendar pattern, or described in words; or, under "Anything else?", a task with the result that shows it is done), `c` changes one, `p` pauses or resumes it, `g` runs it now and `x` removes it; on the Runs tab `s` stops a run and `t` runs a failed one again. Triggers, the commands they may run, CI watches and check-ins are its other tabs. A script reaches the same capabilities with `goodvibes-agent do schedule.add --input prompt="Renew the passport" --input how=at --input at=2026-12-01T09:00`.
The Routines tab of Automation lists your routines with what makes one run by itself: `o` switches it on or off, `e` runs it on a schedule, `j` lists the routines put on a schedule so far, `k` shows one receipt and `y` checks them against the schedules that exist now.

### Media and devices

`/media` is the same description as the terminal app's: `providers` lists the media providers (what `/media` alone gives a model or script); `make [--as image|video] [--provider <id>] [--model <id>] [--out <file>] <description>` asks a provider to make an image or a video (it may charge; the answer says what it cost where the provider says), keeps it as an artifact and saves it as a file (`generated/<words>-<time>.<ext>`, or `--out`); `collect <provider> <job> [--out <file>] [key=value ...]` collects a job that had not finished. A collect with `waitSeconds=0` checks the job once and answers at once. A generation cancelled after the provider accepted the job still answers with the job's task id (`pending`), and the job is cancelled at the provider when the provider allows it, so it can be found, collected or cancelled; a submission whose answer was lost is reported as of unknown outcome (`MEDIA_SUBMIT_OUTCOME_UNKNOWN`), never as not sent: look for it in the provider's console before submitting again.
`/network-scan [on|off|status]` turns local-network scanning for model servers on or off; when on, the Agent scans at each start and `/provider` shows what it found. `off` prints `Local network scanning is now off. Nothing on your network will be probed.`

### Support

`/bundle` (Agent only) is described: `preview` ("See what a support bundle would hold", the report a bare `/bundle` runs where no list can be shown: it builds one in a temporary place, shows it and keeps nothing), `export [<file>] [--replace]` ("Save a support bundle": settings and setup with every secret taken out; an existing file is kept unless `--replace`, which writes over it), `inspect <file>` (what it holds and which settings loading it would change) and `import <file> [--include-security]` ("Load settings from a support bundle"; a model cannot run it, and loading security settings loosens a protection, so only your own line does it; `export` first keeps a copy of the settings it replaces).
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

Settings work as in the terminal app (`/settings`, `goodvibes-agent -c key=value`), stored under `~/.goodvibes/agent/`. The settings screen is the terminal app's: the seven topics, each setting on one line by name with its value in words, search by name, key or description, and the selected setting explained in a few sentences. A setting the daemon owns shows the daemon's value (`Held by the daemon.`), or `Unknown` with why while the daemon has not given it.
A project settings file cannot change permission, approval, provider, tool, surface, automation or helper settings.
The settings the Agent adds or uses most:

<!-- generated: settings:checkpoints -->

<!-- generated: settings:daemon -->

<!-- generated: settings:profile -->

<!-- generated: settings:occasions -->

<!-- generated: settings:calendar -->

<!-- generated: settings:google -->
