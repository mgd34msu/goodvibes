# The terminal app (`goodvibes`)

This part describes the terminal app, `goodvibes`, from launch to every command it offers. It covers the command line, the interface, every slash command, sessions, models and providers, tools, helper agents and worktrees, contracts and workstreams, checkpoints and undo, memory and knowledge, MCP servers, plugins, skills, hooks, headless runs and the Agent Client Protocol. The Agent (`goodvibes-agent`) shares most of this; the next part lists what it does differently.

## What the terminal app is

The terminal app is an interactive coding and operations assistant that runs in a terminal window.
It holds a conversation with a model, and the model works through tools: it reads and edits files, runs commands, searches, fetches web pages, starts helper agents and more.
Each tool call passes the permission gate, which allows it, refuses it, asks the owner, or lets the decision model decide, according to the permission mode.
The conversation loop runs inside the terminal app process.
Daemon-owned features (schedules, channels, the owner inbox, devices, hosted sessions, clusters, mail, calendar, CI watches) are reached through the daemon's operator API; when no daemon answers, those commands say so and change nothing.
The terminal app keeps its own state under `~/.goodvibes/tui/` (user scope) and `<project>/.goodvibes/tui/` (project scope), where `<project>` is the working directory.
State shared by every GoodVibes program on the machine lives under `~/.goodvibes/shared/`.

Terms used in this part:

| Term | Meaning |
| --- | --- |
| working directory | The directory the terminal app treats as the project. It is the current directory unless `--cd` or `tui <path>` names another. |
| session | One saved conversation. Sessions are stored per project in `<project>/.goodvibes/tui/sessions/`. |
| turn | One prompt from the owner and everything the model does until it answers. |
| slash command | A line typed in the composer that starts with `/`, such as `/model`. Slash commands run in the terminal app; they are not sent to the model. |
| composer | The text input box at the bottom of the screen. |
| registry key | A model's full name in the form `<provider>:<model-id>`, for example `openai:gpt-5.4`. |
| helper agent | A subagent the model starts with the `agent` tool. It has its own conversation and a narrower tool set. |
| contract | A tracked unit of delegated work with acceptance criteria that are checked before it counts as done. |
| workstream | A contract started from an owner request, planned into units and run by helper agents. |
| checkpoint | A snapshot of the workspace files that `/checkpoint restore` and `/checkpoint rewind` can return to (see "Restoring a checkpoint"). |
| view | A full-screen modal over the conversation, such as Agents, Usage or Changes. `Esc` closes it. |

## Launching the terminal app

### Launch forms

```sh
goodvibes                          # open the terminal app in the current directory
goodvibes tui ~/work/project       # open it with ~/work/project as the working directory
goodvibes "review this repo"       # open it with that prompt already sent as the first turn
goodvibes --cd ~/work/project      # same as tui <path>; --working-dir and -C are aliases
goodvibes --no-alt-screen          # keep output in the terminal's normal scrollback
goodvibes open goodvibes://open/agents   # open the app on one view
```

`goodvibes app` is an alias of `goodvibes tui`.
A launch whose model is not ready opens first run (choose a provider, sign in, then the conversation; see the install part of this file); `goodvibes setup` opens the full setup wizard on demand, and `goodvibes setup status` says whether first run has been done.
The onboarding screens are described under "First run and onboarding" in the install part.

`goodvibes open <link>` takes exactly one link of the form `goodvibes://open/<view>[?target=<id>[:<kind>]]`.
In a process view (agents, tasks, orchestration) the target selects that process; in another view the app opens the view and says the target was not used.
A link that is missing or not of that form is refused:

```text
$ goodvibes open notalink
goodvibes open takes one link: goodvibes://open/<view>[?target=<id>[:<kind>]] ("notalink" is not one).
```

The exit code is `2`.
The Links tab of the System place lists every view link.

### Global options

The complete help of every command, as the program prints it, is under "Command line: `goodvibes`" in the reference part.

How each option behaves:

| Option | Behavior |
| --- | --- |
| `-m, --model <registryKey>` | Uses this model for this launch. The text before the first colon names the provider (`openai:gpt-5.4`, `Ollama:llama3:8b`), which is then selected unless `--provider` is also given. The provider is any registered one (built-in, custom, or a model server found on this computer), named by its id or display name without regard to case, so `-m ollama:llama3:8b` is the scanned `Ollama` server's model. A name no registered provider has is an error listing the registered providers when the model is used (`models current`, `run`, the interactive app). A value with no colon, or with a slash before its first colon (`meta-llama/llama-3.3-70b-instruct:free`), is a model id under the configured provider. A model id that itself holds a colon needs its provider: `-m ollama:llama3:8b`, or `--provider Ollama -m llama3:8b`. |
| `--provider <id>` | Uses this provider for this launch. |
| `-C, --cd <dir>`, `--working-dir <dir>` | Sets the working directory for this launch. Sessions and project settings are read from that directory. |
| `--daemon-home <dir>` | Uses this daemon home (default `~/.goodvibes/daemon`) for every command that reads the operator token or daemon settings. It wins over the `GOODVIBES_DAEMON_HOME` environment variable. |
| `-c, --config <key=value>` | Overrides one setting for this launch only. It may be repeated. Nothing is saved. A key that is not a setting, or a value it does not take, stops the launch (exit `2`) with a line naming the key and the nearest setting (`permissions.mod is not a setting; did you mean permissions.mode?`) or what it takes (`permissions.mode does not accept that value; it takes one of ask-me, jev-decides, just-vibes, yolo, plan.`); the value given is never repeated. |
| `--enable <feature>`, `--disable <feature>` | Turns one feature flag on or off for this launch. The value is a feature id, not a setting key. An unknown id is refused and the error lists the known ids. |
| `-p, --prompt <text>` | Runs one prompt without the interface (the same as `run`). |
| `--print` | Selects non-interactive run mode (the same as `run`) when no command is given. |
| `-o, --output <format>` | Output format for `run` and for commands that print data: `text`, `json` or `stream-json`. Another value is refused with `-o must be one of: text, json, stream-json.` and exit `2`. `--json` means `--output json`. `--output-format <format>` is accepted as the same option and prints `[goodvibes] warning: --output-format is deprecated; use --output (or -o) instead.` on standard error; standard output is unchanged. When two of these are given, the last one wins. |
| `--just-vibes` | Sets the permission mode to `just-vibes` for this launch only: work continues without asking, and anything that needs the owner is held and listed at the end. It is the same as `--config permissions.mode=just-vibes`. |
| `--yolo` | Sets the permission mode to `yolo` for this launch only: every action runs without safety denials; `Pre:tool:*` hooks and never-run rules still apply. Containment, secret storage and payment limits still apply. `--no-worries-just-vibes` is an unlisted spelling of the same option. It may come before or after the command word (`goodvibes --yolo run ...` or `goodvibes run --yolo ...`). |
| `--no-alt-screen` | Keeps the interface in the normal scrollback instead of the alternate screen. |
| `--port <port>`, `--hostname <host>` (`--host`) | Port and bind address for `web` and `surfaces enable`. The port must be 1 to 65535. |
| `--open` | Opens a browser where the command supports it (`web`, `subscription login <provider> start`). Any other command ignores it. |
| `-r, --resume [id\|latest]` | Opens a saved session. Without an id it opens the last session of this working directory. |
| `-s, --session <id>` | `run` only: continue that saved session. Every other command refuses it. |
| `--continue` | Opens the last session of this working directory. |
| `--fork [id]` | Bare `--fork` resumes the last session of this working directory (the one `--continue` opens), then forks it. `--fork <id>` opens that session, then forks it. A session that cannot be resumed (no such id, or open in another running copy) is reported as `[Resume] Could not resume session <id>: <reason>` (`resume and fork` for `--fork`) and the app starts as a plain launch; nothing is forked. The same holds for `--resume` and `--continue`. `run` refuses `--fork`; the other commands ignore it. |
| `--timeout <duration>` | `run` only: cancel after this long. A bare number is seconds; `ms`, `s`, `m` and `h` suffixes are accepted. Exit code `124`. |
| `--max-turns <n>` | `run` only: stop after `n` model answers that still ask for tools. Exit code `1`. |
| `--omit-accumulated` | `run` with `stream-json` only: leave `accumulated` out of `STREAM_DELTA` frames. |
| `--answer-permissions` | `run` with `stream-json` only: read owner answers to permission prompts from standard input. |
| `--prompt-file <path>` | `run` only: read the prompt from a file; `-` reads all of standard input. |
| `-y, --yes` | Confirms a command that would otherwise only preview (for example `plugin bundles install`, `support-bundle import`). |
| `--non-interactive` | Disables every interactive prompt and implies `--yes`. |
| `--strict` | `doctor` only: also fail on advisory findings. Any other command ignores it. |
| `-h, --help` | Prints help: first `Most used:` (start the app, `run "<prompt>"`, `pair`, `status`, `goodvibes-daemon update --check`; the Agent adds `setup`), then every command, the options and examples. `goodvibes help <command>` prints one command's help. |
| `-v, --version` | Prints `goodvibes {{release}}`. |

Only one of `--continue`, `--resume` and `--fork` may be given on one launch.

### Rules of the command-line parser

- A flag that takes a value refuses a value that begins with `-`. Use the equals form: `--prompt='- item'`.
- `--` ends option parsing. Every word after it is a positional argument: `goodvibes run -- --literal-text`. A command never reads one of its own options (`--yes`, `--apply`) from a word after `--`.
- An unquoted word in a prompt that equals a command name or alias (`doctor`, `auth`, `task`) is read as that command. Quote the whole prompt.
- After a command word, an option that command does not take is refused with exit code `2`, and the error lists the options it accepts.
- A run-only flag (`--timeout`, `--max-turns`, `--omit-accumulated`, `--answer-permissions`, `--prompt-file`) on any other command is refused with exit code `2`:

```text
$ goodvibes status --timeout 5
--timeout, --max-turns, --omit-accumulated, --answer-permissions and --prompt-file apply only to the run command.
```

- A lone first word that is a command mistyped by one slip of the fingers is refused, with exit code `2`: five or more letters, and the command with two neighbouring letters swapped or one letter doubled:

```text
$ goodvibes stauts
Unknown command: stauts. Did you mean `goodvibes status`? To start with "stauts" as the first prompt instead, run: goodvibes -- stauts
```

- Any other lone word is a one-word prompt and starts the app with it (`goodvibes hello`, `goodvibes fix`, `goodvibes frobnicate`). When it is one or two letters from a command (`hello`, `staus`), a warning names that command.

### Environment variables the terminal app reads

The complete list of environment variables is under "Environment variables" in the reference part. The ones that change how the terminal app starts:

| Variable | Effect |
| --- | --- |
| `GOODVIBES_DAEMON_HOME` | Daemon home directory used to find the operator token and daemon settings. `--daemon-home` overrides it. |
| `GOODVIBES_HOME` | Home directory used by `goodvibes acp` for its embedded sessions. |
| `ACP_AGENT_CMD` | Set for the daemon: replaces the command a remote runner started from the Runners tab of the Work place ("start a runner", "start from a pool") runs as an ACP subagent (by default `goodvibes acp` beside the daemon). Give it as a JSON array of program and arguments, for example `["/path/to/agent","acp"]`; a value that is not an array is used as one path when such a file exists, otherwise split on spaces. A value that starts with `[` but is not a JSON array of non-empty strings is refused with the reason. |
| `EDITOR`, `VISUAL` | The editor that "Write the message in your editor" (in This conversation) and a template's edit (in Memory and knowledge) open. |
| Provider key variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the others in the provider list) | Sign a provider in with an API key. An environment variable wins over a key stored as a secret. |

## Command-line commands

Every command below prints text by default. Commands that print data accept `--json` (or `--output json`) and then print one JSON value.
A command that refuses prints the reason on standard error and exits non-zero; the refusal names what to run next.
Exit codes shared by all programs are under "Exit codes" in the reference part; the codes each command uses are given with the command.

### `goodvibes run` (alias `exec`, `e`)

`run` sends one prompt to the model without the interface, prints the result and exits.
It is described in full under the heading "Headless runs" below.

```sh
goodvibes run "summarize the current project"
goodvibes run --output json "list risks"
goodvibes exec --output stream-json --omit-accumulated --timeout 10m "fix lint"
goodvibes run --continue "and now write the tests"
```

A run with no prompt is refused:

```text
$ goodvibes run
A prompt is required.
```

The exit code is `2`.

### `goodvibes find` and `goodvibes do`

`find "<what you need>" [--output json]` names the three to five GoodVibes capabilities that do it, from the function group that serves the need, each with its id, its inputs and its risk; nothing runs. `do <capability id> [--input key=value ...] [--output json]` runs one by id through the daemon: your own typed command, which carries the machine's token (that is you). It names the folder it was typed in and runs at once in every permission mode (Ask me, Jev decides, Just vibes, YOLO and Plan alike), whatever the capability does: a read prints what it found, and a change, one that cannot be undone, one that runs by itself later or weakens a protection (a hook, a schedule, a file named by path that a program runs by itself later, such as `--input path=~/.bashrc`), one that spends money or writes a secret, or one that is only yours to make prints what it did. Nothing waits on a question and nothing is held: `do` prints no "Waiting for your answer" line for its own act and never exits `3`. A capability that acts on a conversation (clear, compact, undo) is refused in one line; it runs in the terminal app or the Agent. The permission modes decide what a model does, not what you type. Exit `0` done (or found), `1` refused or failed, `2` bad usage; with `--output json` the answer, or the `{ok:false, code, error, fix}` refusal, is one document on stdout.

```sh
goodvibes find "switch off the lint hook"
goodvibes do hooks.disable --input hook=lint-before-commit
```

The model has the same two as tools (`capability_find`, `capability_run`), and `goodvibes-daemon mcp serve` offers them to another program's model. A model's call from another program (through `mcp serve` or the API) is decided once, by the daemon under the owner's mode; your own call (`do`, a script holding the machine's token, a paired device, a signed-in session) is your own act and runs at once. Folder trust is never asked for a daemon capability, since it acts on what the daemon keeps. A model's call that needs the owner waits on the owner's one answer within its own request, worded as the capability in Waiting for you, and runs (or is refused with the owner's reason) when the owner answers; closing the connection withdraws the question. A refusal is never a `500`: the owner's no is `403` `CAPABILITY_NOT_APPROVED`, and GitHub refusing a CI read (`ci.status`, `ci.run`) is `424` `CI_SOURCE_REFUSED` in gh's own words. A value of an input that is a secret (a password, a key) is never shown: an ask, an approval record, the conversation and every log show it as `(hidden, <n> characters)`.

### `goodvibes status`

`status` prints the configuration posture: working directory, home directory, provider and model, reasoning effort, sign-in, decision model, permission mode, local auth files, daemon service, surfaces, onboarding, crashes, workspace trust and the exec sandbox.
The `provider` and `model` lines name what a turn started now would use: the saved model, or this launch's `-m`/`--provider`, resolved against the registered providers (custom ones and the model servers the last search of this computer saved) the same way a run resolves it, so `-m ollama:llama3:8b` shows `provider: Ollama`. When no registered provider has the name, a `problem:` line says so, lists the registered providers and says how to choose another. The Agent's `status` does the same.
It always exits `0`.

```text
$ goodvibes status
GoodVibes status
  workingDir: /home/me/work/project
  homeDir: /home/me

Provider:
  provider: openrouter
  model: openrouter:openrouter/free
  reasoning: medium
  sign-in: no subscription and no OPENROUTER_API_KEY in the environment. If you stored a key as a secret, the app uses it (this report does not read stored keys); otherwise sign in with: export OPENROUTER_API_KEY=<key>, or store it with "Store a secret" in the app (Permissions and safety, Secrets)
  ...
Decision model:
  when the decision model is missing or fails: Hybrid (default)
  No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open.

Auth:
  permissions: Jev decides (jev-decides)
  ...
Surfaces:
  controlPlane: yes (local 127.0.0.1:3421)
  httpListener: no (local 127.0.0.1:3422)
  web: yes (local 127.0.0.1:3423)
...
Workspace:
  trust: undecided
  registration: not registered (never asked)
```

With no model configured the terminal app selects `openrouter:openrouter/free`.
`goodvibes status --json` prints the same facts as one JSON object.

### `goodvibes doctor`

`doctor` prints `status` plus setup warnings, each with its cause and next step.
It exits `0` when the install is usable and non-zero only for a must-fix finding; `--strict` also fails on advisory findings.
Its three sub-reports explain one decision each:

| Command | What it prints |
| --- | --- |
| `goodvibes doctor explain <tool\|command>` | How the permission gate would decide one tool call or shell command under the mode in force, with the decision model, the remembered and never-run rules and the tool's path containment, without running it (see "Explaining a decision: `goodvibes doctor explain`" in the permissions part). |
| `goodvibes doctor routing` | Which provider and model serve each role (main chat, helper, tool model, TTS model, embeddings). |
| `goodvibes doctor hooks [--json]` | Every registered hook, where it came from and whether it validates. |

Worked example:

```text
$ goodvibes doctor explain "rm -rf build"
GoodVibes doctor: explain permission decision
  subject     : rm -rf build
  resolved as : shell command run through the "exec" tool: rm -rf build
  tool        : exec  (category: execute)
...
Analysis (from the platform analyzer):
  risk        : HIGH (shell)
Current settings:
  mode        : ask-me (Ask me) in force; set: jev-decides
                not jev-decides, because no decision model is set, so every call Jev would decide asks you (to use one, choose a Decision model in /settings open)
...
  rules       : the remembered rules of this project were read
  decision model: not consulted: No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open. The verdict is the one the gate gives without a decision model.
...
Decision: ASK
  decided by : user_prompt (user_denied)
  because    : This reaches a Human-in-the-Loop approval prompt; the outcome depends on your response at the prompt.
```

A file write is explained with the tool name and path: `goodvibes doctor explain write ./src/app.ts`.
Every `doctor` finding is described under "Checking an installation with doctor and status" in the install part.

### `goodvibes setup`

`goodvibes setup` opens the terminal app on the Setup tab of the System place: the setup topics, one form each.
`goodvibes setup status` prints whether first run has been done for this user and exits:

```text
$ goodvibes setup status
GoodVibes setup status
  checked: no
  scope: none
  source: n/a
  mode: n/a
  updatedAt: n/a
  workingDir: /home/me/work/project
```

### `goodvibes models` (alias `model`)

`models` lists, selects and pins models.

| Form | Effect |
| --- | --- |
| `goodvibes models` | Lists selectable models, the current one marked `*`. Text output shows at most a fixed number of rows and says `showing N of M`; JSON output lists every match. |
| `goodvibes models <provider-or-text>` or `models list <text>` | Lists models whose provider equals the word or whose registry key contains it. |
| `goodvibes models current` | Prints the current model, provider, sign-in kind, whether the provider is configured and the context window. |
| `goodvibes models use <registryKey>` (alias `set`) | Saves this model as the main chat model (`provider.model`). |
| `goodvibes models pin <registryKey>` / `unpin <registryKey>` | Adds the model to, or removes it from, the pinned favorites. |
| `goodvibes models pinned` | Lists pinned models. |
| `goodvibes models recent` | Lists the 25 most recently used models. |
| `goodvibes models chain [filter]` (alias `chains`) | Lists the backend order of every `synthetic` model (see "Synthetic failover" below). This form is not in the program's help. |

Worked examples:

```text
$ goodvibes models use openai:gpt-5.4
Model selected: openai:gpt-5.4

$ goodvibes models current
GoodVibes current model
  model: openai:gpt-5.4
  provider: openai
  setup: Unknown
  provider configured: no
  context: 1,050,000
```

Failure cases:

```text
$ goodvibes models use nosuchmodel
Unknown model: nosuchmodel. Nothing was changed. Name the provider to save a model that is not in the local catalog: goodvibes models use <provider>:nosuchmodel
```

The exit code is `1`.
A model that the local catalog does not know is saved when it is named with its provider (`goodvibes models use openai:new-model`); the provider's own answer decides later whether it exists.
`models pin` refuses a registry key that is not selectable: `Unknown model: <key>. Nothing was pinned.`

### `goodvibes providers` (alias `provider`)

`providers` shows each provider's setup class, whether it is configured, how it signs in, how many models it lists and its sign-in routes.

| Form | Effect |
| --- | --- |
| `goodvibes providers` or `providers list` | One line per provider; the current one is marked `*`. |
| `goodvibes providers current` | The current provider, model and sign-in routes. |
| `goodvibes providers inspect <provider>` | Every sign-in route of one provider with its state and a detail line saying what to do. |
| `goodvibes providers use <provider> [registryKey]` | Switches the main chat route to the provider and, when given, the model. |

Worked example:

```text
$ goodvibes providers inspect openai
Provider openai
  active: yes
  setup: Unknown
  configured: no
  via: api-key
  models: 53
  auth routes: 1/4 configured, 0/4 usable
    Ambient API key [api-key; not configured, not usable, unconfigured] - No direct API key is configured.
    SecretRef-backed API key [secret-ref; not configured, not usable, unconfigured] - No SecretRef-backed credential is configured.
    Service OAuth [service-oauth; not configured, not usable, unconfigured] - Service OAuth metadata exists, but the credential path is incomplete.
    Subscription OAuth [subscription-oauth; configured, not usable, unconfigured] - A built-in subscription OAuth adapter is available, but no session is stored yet.
  detail: Not signed in: sign in with a ChatGPT subscription in Models and providers, or store OPENAI_API_KEY there.
```

A line of `goodvibes providers` reads like this:

```text
  * openai             setup=unknown configured=no via=api-key models=53 routes=1/4 configured, 0/4 usable Not signed in: sign in with a ChatGPT subscription in Models and providers, or store OPENAI_API_KEY there.
```

### `goodvibes subscription` (alias `subscriptions`)

`subscription` signs a provider in with a subscription account instead of an API key. OpenAI (a ChatGPT subscription) is the built-in subscription provider.

| Form | Effect |
| --- | --- |
| `goodvibes subscription list` | Active and pending subscription sign-ins. |
| `goodvibes subscription providers` | Providers that offer subscription sign-in, with their redirect address. |
| `goodvibes subscription inspect <provider>` | One provider's stored sign-in: whether it is active or pending, token type and expiry. Never prints a token: with `--output json` the stored sign-in is `{ configured, tokenType, expiresAt, refreshToken: present\|absent, scopes, overrideAmbientApiKeys, createdAt, updatedAt }`. |
| `goodvibes subscription login <provider> start [--open]` | Starts the sign-in, saves a pending record and prints the authorization address. `--open` opens it in a browser. `goodvibes subscription start <provider>` is a shorter form. |
| `goodvibes subscription login <provider> finish <code-or-url>` | Finishes the sign-in with the code, or the whole redirect address the browser landed on. `goodvibes subscription finish <provider> <code-or-url>` is a shorter form. |
| `goodvibes subscription refresh <provider>` | Refreshes the stored token. This form is not in the program's help. |
| `goodvibes subscription logout <provider>` | Removes the stored or pending sign-in. |

The full sign-in, in order:

1. Run `goodvibes subscription login openai start --open`. It prints the authorization address and opens it:

```text
Subscription OAuth started: openai
  source: builtin
  state: <state>
  redirectUri: http://localhost:1455/auth/callback
  next: goodvibes subscription login openai finish <code-or-url>
  authorizationUrl:
  https://auth.openai.com/oauth/authorize?response_type=code&...
```

2. Sign in in the browser. The browser is sent to `http://localhost:1455/auth/callback?code=...`. The page may fail to load; that does not matter.
3. Copy the whole address from the browser's address bar and run `goodvibes subscription login openai finish '<the address>'`. It prints `Stored subscription session for openai.` with the token type and expiry.
4. Run `goodvibes providers inspect openai` to confirm that the `Subscription OAuth` route is usable.

Inside either program, "Sign in (log in) with a subscription" (`s` on openai, on the Providers tab of Models and providers) does the same through the daemon and shows the address to open; finish it with "Finish signing in with a code" (`f`) and the code or the whole address, unless a browser on the daemon's machine returns to its local callback address, which finishes it on its own.

Failure cases:

- `goodvibes subscription inspect nosuch` prints `No stored or available subscription provider named nosuch.` and exits `1`.
- A code that the provider refuses prints the provider's error (for example `OAuth token exchange failed (401)`) and exits `1`; start again with `login <provider> start`.
- `goodvibes subscription logout <provider>` with nothing stored prints `No stored subscription session existed for <provider>.` and exits `1`.

When OpenAI has both a subscription sign-in and an API key, requests use the subscription; a request the subscription fails is sent again to the same model with the API key, and the turn says so once.

### `goodvibes secrets` (alias `secret`)

`secrets` stores credentials in the GoodVibes secret store and links names to external secret references.
A secret reference has the form `goodvibes://secrets/<source>/<path>` and never contains the value.

| Form | Effect |
| --- | --- |
| `goodvibes secrets list` | The storage policy, whether secure storage is available, and the stored key names with their scope. Never prints values. |
| `goodvibes secrets providers` | The reference sources: `env`, `goodvibes`, `file`, `exec`, `1password`, `bitwarden`, `vaultwarden`, `bitwarden-secrets-manager`. |
| `goodvibes secrets test <ref>` | Checks that a reference resolves, without printing the value. |
| `goodvibes secrets set <KEY> [--user\|--project] [--secure\|--plaintext]` | Stores a value without it ever being on the command line. At a terminal it asks `Value for <KEY> (typing is not shown):` and nothing typed is echoed; when standard input is piped it reads the value from there (one trailing newline is dropped). `--plaintext` stores it unencrypted. Ctrl+C stops without storing anything. |
| `goodvibes secrets set <KEY> <value> [--user\|--project] [--secure\|--plaintext]` | Stores the value given as one argument. It stays in your shell history and is visible in the process list while the command runs, so prefer the form above. |
| `goodvibes secrets link <KEY> <ref> [--user\|--project] [--secure\|--plaintext]` | Makes `<KEY>` resolve through the reference. |
| `goodvibes secrets delete <KEY> [--user\|--project] [--secure\|--plaintext]` | Deletes a stored key. |

Flags may go before or after the key: `--user`, `--project`, `--secure`, `--plaintext` and `--stdin` take no value and never take the next word. `--stdin` reads the value (or a `link` ref) from standard input even when the input is a terminal.

Worked example:

```text
$ goodvibes secrets set OPENAI_API_KEY --user
Value for OPENAI_API_KEY (typing is not shown):
[secrets] Stored: OPENAI_API_KEY

$ goodvibes secrets list
GoodVibes secrets
  policy: preferred_secure
  secure available: yes
  stored keys: 1
    OPENAI_API_KEY (user-secure)

$ goodvibes secrets link GITHUB_TOKEN goodvibes://secrets/env/GH_TOKEN --user
$ goodvibes secrets test goodvibes://secrets/env/GH_TOKEN
```

A key stored with `--plaintext` is listed with `-plaintext` in its scope and `secrets list` adds `warning: plaintext fallback secrets are present`.
A provider reads its key from the environment first, then from the secret store.

### `goodvibes sessions` (alias `session`)

`sessions` lists and opens saved sessions of the working directory.

| Form | Effect |
| --- | --- |
| `goodvibes sessions list` | One line per session: id, message count, last save time, title. |
| `goodvibes sessions show <id\|name>` | One session's details. |
| `goodvibes sessions export <id\|name> [path]` | Writes the session to a JSON file (or prints it when no path is given). |
| `goodvibes sessions resume <id\|name>` | Opens the terminal app on that session. |

```text
$ goodvibes sessions list
GoodVibes sessions (3)
  user-0008b454  messages=34  2026-11-18T16:43:26.464Z  hello
  user-51cf10f8  messages=11  2026-11-18T04:56:35.305Z  find all of the implicit state machines in this
  user-7d4c6370  messages=8  2026-11-18T04:52:01.662Z  (untitled)

$ goodvibes sessions show nope
Session not found: nope
```

`sessions show` of a missing session exits `1`.

### `goodvibes tasks` (alias `task`)

`tasks` reads runtime tasks from the daemon.

| Form | Effect |
| --- | --- |
| `goodvibes tasks list` | Tasks the daemon holds. |
| `goodvibes tasks show <taskId>` | One task. |
| `goodvibes tasks submit <prompt>` | Submits a non-interactive task to the daemon. |

When no daemon answers, `tasks list` says so and exits `0`:

```text
GoodVibes tasks
  None listed: no daemon could be asked (Authentication failed · Token is invalid or has expired · Verify your credentials and token store configuration.); tasks exist only in the daemon or inside a running session.
```

### `goodvibes auth`

`auth` manages the local user store of the daemon and listener (usernames, passwords, sessions, the bootstrap credential).
Changes are written to the user store; a running daemon reads the user file again at its next sign-in check.

| Form | Effect |
| --- | --- |
| `goodvibes auth` or `auth status` | Auth posture. |
| `goodvibes auth users` | Local users. |
| `goodvibes auth sessions` | The sign-in sessions the daemon on this machine holds: `<username> expires=<time> id=<session id>` per session. It asks the running daemon at its loopback address with this machine's operator token; with no daemon answering it prints why and exits `1`. |
| `goodvibes auth add-user <username> [--password <value>\|--password-stdin] [--role <role>]` | Adds a user. Without a password flag it reads `GOODVIBES_AUTH_PASSWORD`. `--role` may be repeated; the default role is `user`. A name another kind of credential signs in as is refused: `shared-token`, `local`, `unknown`, and any name starting `pairing:`, `channel:`, `peer:` or `system:`. |
| `goodvibes auth delete-user <username>` | Deletes a user. A running daemon (or terminal app) re-reads the user file at its next sign-in or session check, within a few seconds, and ends that user's sessions then; no restart is needed. Prints `Auth user deleted: <username>` and that note; an unknown user prints `No auth user found: <username>` (exit `1`). |
| `goodvibes auth rotate-password <username> [--password <value>\|--password-stdin]` | Sets a new password. A running daemon ends that user's sessions at its next sign-in or session check, within a few seconds, without a restart. Prints `Auth password rotated: <username>` and that note. |
| `goodvibes auth revoke-session <session-id-or-token>` | Ends that session on the running daemon at once (through `local_auth.sessions.delete`): `Auth session revoked on the running daemon.` An unknown session, or no daemon answering, prints the daemon's reason and exits `1`. Take the id from `goodvibes auth sessions`. |
| `goodvibes auth revoke-sessions <username>` | Ends every session of that user on the running daemon: `Auth sessions revoked for <username> on the running daemon: <n>`; `The running daemon holds no auth sessions for <username>.` (exit `1`) when it holds none. |
| `goodvibes auth clear-bootstrap` | Deletes the bootstrap credential file. |

```sh
printf '%s\n' '<new-password>' | goodvibes auth add-user admin --password-stdin --role admin
```

Sessions live in the memory of the running daemon; this command cannot end them. Restart the daemon to end them all.
Local accounts are described under "Sign-in users" in the daemon part.

### `goodvibes acp`

`acp` runs the terminal app as an Agent Client Protocol agent on standard input and output. It is described under the heading "Editors: the Agent Client Protocol" below.

### `goodvibes host pair` and `goodvibes host unpair`

`host pair` makes this terminal app your own device on a daemon on another machine, with the sign-in code you start where you are signed in as yourself (that daemon's web UI: Devices and network, Pair something, "Show the sign-in code once"). With the daemon on this machine there is nothing to pair.

```sh
goodvibes host pair                         # type or paste the sign-in code when asked
goodvibes host unpair                       # forget the stored credential (or a lost attempt) here
```

`--url <exact-origin>` names the host for this one command and `--name <device-name>` names the device. The code is read from an interactive terminal, never from an argument; nothing else is asked. Bad usage, no terminal and Enter alone exit `2`; a code the daemon did not take (used, older than 15 minutes, or never one) exits `1`.
`unpair` forgets the credential here only; it stays valid on the host until it is revoked there.
Host pairing is described under "Host pairing: giving the terminal app its own credential" in the daemon part.

### `goodvibes pair` (aliases `qrcode`, `qr`)

`pair` mints a named, revocable device token on the connected daemon and prints its pairing link and a QR code for a phone or browser.

```sh
goodvibes pair --name "my phone"
```

Before minting, `pair` asks the daemon (`pairing.posture.get`, which mints nothing) whether another device could open the code; the daemon decides from its settings, with no request on the network: a loopback address cannot; `web.publicBaseUrl` is your statement that it can; otherwise `controlPlane.enabled` decides. When none could (the default: the daemon bound to `127.0.0.1`), the token is minted for a browser on this machine (`forThisMachine`), no QR code is drawn, and `pair` prints, exit `0`:

```text
This link signs in a browser on this computer. A phone cannot open it: the daemon serves only this machine: http://127.0.0.1:3421 is this machine's own address, which another device cannot open.
  1. done  The daemon serves the web UI at http://127.0.0.1:3421.
  2. next  goodvibes-daemon webui enable --lan
  3. then  goodvibes pair, then scan the code it prints with the phone.

  http://127.0.0.1:3421/#pair=<token>&offers=...
  Sign-in code: <token>  (to paste on the web UI's sign-in page, under Other ways to sign in)
  Token name: ...
```

Open the link in a browser on this machine and it opens the web app signed in, or paste the code on the sign-in page. Connected to a daemon on another machine that serves only its own machine, `pair` makes no code and exits `1`, printing `No pairing code was made: a phone could not open it yet.` and the same steps.

When one can, the output leads with the same list (`1. done  The daemon serves the web UI at <origin>, open to other devices.`, `2. next  Scan the code below with the phone's camera; it opens the web app already signed in.` with, under it, `(If the phone cannot open it, it must be on the same network as <host> with no firewall between, or reach it through Tailscale: Settings, Network, Tailscale in the web app on this computer.)`, `3. then  In the web app, accept or decline each offer: ...`), then the QR code, the link, the token name and the details. A daemon serving no web UI gets `No pairing code was made: the daemon serves no web UI, so a code would open nothing.` with `goodvibes-daemon webui enable --lan` as the next step. `goodvibes-agent pair` and the Agent's Pair something, A phone or another device, do the same against the connected host (`goodvibes-agent pair --json` adds `"forThisMachine": true` to a link only the host's machine opens). The pairing screen that Pair something, A phone or another device, opens in the terminal app first asks in place `Phones on your network cannot reach GoodVibes yet. Serve it to your network?` with `No, keep the link for this computer only` chosen; No shows the steps, then the link and the sign-in code behind Ctrl+V, and no QR code; Yes asks the daemon to serve its web UI to the network (what `goodvibes-daemon webui enable --lan` writes; the daemon answers once it is listening again) and shows the code for phones, with its QR, on the same screen. When the daemon still cannot be reached the question stays with the daemon's reason under it.

Device pairing is described under "Pairing a phone or another browser" in the daemon part.

### `goodvibes web`, `surfaces`, `listener`, `control-plane`, `service`, `remote`

These commands report and change the daemon's network surfaces and service. They are described in full under "Network exposure", "Serving the web UI" and "Service commands" in the daemon part, and under "The daemon's background service" in the install part; their usage is:

| Command | Usage | Effect |
| --- | --- | --- |
| `web` | `goodvibes web [--open] [--hostname <h>] [--port <p>]` | Prints where the web UI is served (see below); `--open` opens that address. `--hostname`/`--port` name a development server's endpoint instead for this one command. |
| `surfaces` (alias `surface`) | `surfaces [list]`, `surfaces check [<web\|listener\|control-plane\|surfaceId>]`, `surfaces show <...>`, `surfaces enable <...>`, `surfaces disable <...>` | Inspects and turns on or off the web UI, the control plane, the HTTP listener and each channel surface (for example `slack`). |
| `listener test [--json]` (aliases `http-listener`, `webhook`) | | Checks HTTP listener and webhook readiness. |
| `control-plane status [--json]` (aliases `controlplane`, `cp`) | | Daemon bind posture, reachability, local auth, bootstrap credential and operator tokens. |
| `service` (alias `services`) | `service status`, `service check [--json]`, `service install\|start\|stop\|restart\|uninstall` | The daemon's background service. |
| `remote` (alias `bridge`) | | Remote runner pools, runner contracts, review artifacts and private-host fetch posture. |

```text
$ goodvibes web
GoodVibes web
  enabled: yes
  served by: the daemon, on its control-plane listener
  url: http://127.0.0.1:3421
  development endpoint (web.host/web.port): local 127.0.0.1:3423

$ goodvibes remote
GoodVibes remote status
  runner pools: 0
  contracts: 0
  review artifacts: 0
  private-host remote fetch: no
```

The `url:` line has one owner, the same one pairing links, notification links and `tailscale.serve.run` use: the daemon's control-plane address while it serves the bundle (after `goodvibes-daemon webui enable`, see "Serving the web UI" in the daemon part), otherwise a set `web.publicBaseUrl` naming where a web UI runs, otherwise `none: no web UI is served; serve the bundle with goodvibes-daemon webui enable --bundle-dir <dir>` (and `--open` prints `nothing to open`). When `web.publicBaseUrl` names a different address for other devices (a tunnel), a `public url (links for other devices):` line shows it. `web.host`/`web.port` (3423) are only where the web UI's development server listens; nothing else binds them. `--json` gives `url` (null when none is served), `servedByDaemon` and, when set, `publicUrl`.

### `goodvibes support-bundle` (aliases `bundle`, `bundles`)

A support bundle is a redacted snapshot of configuration, diagnostics and posture, for a support request or for moving settings to another machine. The daemon writes and reads it: each form runs the daemon's capability (`bundle.export`, `bundle.inspect`, `bundle.import`) for the terminal app, as `goodvibes do` does, so the file is the same one the Support and transfer tab of the System place, a model or a script makes. When the daemon on this machine does not answer and its service is installed, it is started first, as the terminal app does at start; with no daemon to reach, the form says so and exits `1`. The bundle records the daemon service as the service manager reports it, the same facts `goodvibes service status` prints.

| Form | Effect |
| --- | --- |
| `goodvibes support-bundle export [path]` | Writes the bundle (`goodvibes-bundle.json` in this folder unless named); a file already there is replaced. |
| `goodvibes support-bundle inspect <path>` | Prints what a bundle holds and which settings loading it would change. |
| `goodvibes support-bundle import <path> [--include-security] [--yes]` | Applies the bundle's setting values. |

`import` refuses a bundle from another product or format version.
It imports only values that differ from the current settings.
It holds back permission, sandbox, listener, service and storage settings unless `--include-security` is given.
It applies all values or none.
Without `--yes` it prints what loading would change, changes nothing and exits `2`.
The daemon's own settings in a bundle are changed by the daemon as one update; a change to them that loosens a protection is put to the owner first.

```sh
goodvibes support-bundle export goodvibes-bundle.json
goodvibes support-bundle inspect goodvibes-bundle.json
goodvibes support-bundle import goodvibes-bundle.json          # preview, exit 2
goodvibes support-bundle import goodvibes-bundle.json --yes    # apply
```

`plugin bundles` is a different command (capability bundles; see "Plugins" below).

### `goodvibes hooks validate`

`hooks validate` checks the hooks file (`hooks.json` in the working directory, or the file `tools.hooksFile` names) against the hook loader's rules, and prints one line per hook.
It exits `1` when any hook is invalid.

```text
$ goodvibes hooks validate
GoodVibes hooks validation
  file: /home/me/work/project/hooks.json
  hooks: 2 total, 1 pass, 1 fail
  FAIL  pre:tool:exec #0 (unnamed): "pre:tool:exec" is not a recognized hook event point: no registered hook point matches it (phases are Pre, Post, Fail, Change and Lifecycle, and case matters); the Hook points tab of Tools and extensions lists them
  PASS  Post:tool:write #0 (unnamed) (contract: observe/non_blocking)
  result: 1 problem(s) found.
```

With no hooks file it prints `no hooks file present: nothing to validate.` and exits `0`.

### `goodvibes plugin` (alias `plugins`)

| Form | Effect |
| --- | --- |
| `goodvibes plugin init <name> [directory]` | Writes a minimal plugin (`manifest.json` and `index.js`), validates it, and says whether the apps load plugins from that directory. |
| `goodvibes plugin validate <path>` | Runs the plugin loader's checks on a plugin directory and says whether the apps load plugins from it. |
| `goodvibes plugin trust <name> <untrusted\|limited\|trusted> [note]` | Sets the plugin's trust tier for every GoodVibes program on this machine. Marking a plugin `trusted` whose signature does not verify needs `--yes`. |
| `goodvibes plugin verify <name>` | Checks the plugin's signature against its saved publisher key. |
| `goodvibes plugin capabilities <name>` | Prints what the plugin declares and what its tier grants. |
| `goodvibes plugin bundles browse <index-url-or-file>` | Lists the capability bundles in a marketplace index. |
| `goodvibes plugin bundles install <ref> --sha256 <pin> [--ref <git-ref>] [--yes]` | Verifies and, with `--yes`, installs a capability bundle. |
| `goodvibes plugin bundles uninstall <id>` | Removes an installed bundle. |
| `goodvibes plugin bundles list` | Lists installed bundles. |

Worked example:

```text
$ goodvibes plugin init my-plugin
Scaffolded plugin "my-plugin" at /home/me/work/project/.goodvibes/plugins/my-plugin
  created: manifest.json, index.js
  validation: PASS; the plugin loader accepts this manifest and entry.
  next: a plugin starts disabled. In the terminal app or the Agent, switch my-plugin on: o on it in the Plugins tab of Tools and extensions (no restart needed).
```

Without a directory, `plugin init <name>` writes `<project>/.goodvibes/plugins/<name>/`, where the loader looks. With a directory it writes there. The apps load a plugin only from a folder directly inside `<project>/.goodvibes/plugins/` (when the app runs in that project) or `~/.goodvibes/plugins/`. For any other directory, `plugin init` and `plugin validate` say so after the `PASS` line:

```text
  NOT LOADED  no app loads a plugin from this folder: plugins are read only from folders directly inside /home/me/work/project/.goodvibes/plugins or /home/me/.goodvibes/plugins.
  Move the folder into one of them, then enable it.
```

With `--output json` both add `loadedFromHere` (true or false) and `searchDirectories`.
A scaffolded plugin is not running yet: it must also be switched on (`o` on it in the Plugins tab of Tools and extensions, in the terminal app or the Agent), as described under "Plugins".
Refusals: `A plugin already exists at <dir> (manifest.json present). Choose another name or directory.` (exit `1`); `Cannot create the plugin: manifest.name must be lowercase letters, digits and hyphens, starting with a letter or digit (got 'Bad Name'); for example 'my-plugin'.` (exit `2`).

The heading "Plugins" below explains manifests, trust tiers and capability bundles.

### `goodvibes completion` (alias `completions`)

`completion <bash|zsh|fish>` prints a shell completion script generated from the command catalog.

```sh
goodvibes completion bash > ~/.local/share/bash-completion/completions/goodvibes
goodvibes completion zsh > "${fpath[1]}/_goodvibes"
goodvibes completion fish > ~/.config/fish/completions/goodvibes.fish
```

### `goodvibes help` and `goodvibes version`

`goodvibes help` prints the overview; `goodvibes help <command>` prints one command's usage and examples.
`goodvibes version` prints `goodvibes {{release}}`.
`goodvibes help version` has no detailed help and prints the overview.

## The interface

### Screen layout

The screen has four regions, top to bottom.

1. The header names the program, its version and the session, and in the terminal app, faint at the right, where its work runs: `daemon connected` (a daemon it reached) or `this computer`. While a helper agent or background process is open full screen, the header reads `main › <agent>` in the agent's color. While a failover is in force it also names the model answering, with `failover from <selected model>`.
2. The transcript shows the conversation: owner prompts, model answers, tool calls with their results, notices in square brackets (`[Permissions]`, `[Context]`, `[Failover]`), and the work tree of helper agents and background processes started in the turn.
3. The composer is the text box where the owner types. Its label shows what Enter will do (prompt, command, shell, note, memory pin).
4. The status bar, the row under the composer. Left: first one word for what main is doing, never dropped: `working` while a turn runs, `waiting for you` (warning colour) while a question waits for your answer, nothing at rest. Then `Permissions:` and the mode in force. When it is the mode chosen, its name (`Permissions: Jev decides`, `Permissions: Ask me`, `Permissions: YOLO`); when it is not, what is in force first and the choice second, with when it takes effect: `Permissions: asking you, for now · Jev decides once a decision model is set` (no decision model set), `· Jev decides once decision models are on` (decision models switched off), `· Jev decides once you pick it yourself (not measured on this decision model)` (Jev decides is only the shipped default and was not measured on this decision model), `· Jev decides once the decision model answers again · decision model unreachable` (or `· decision model failing`), and `Permissions: YOLO, for now · <mode> once the old auto-approve setting is off`; then the `shift+tab` key that changes it. Then the chips that stay visible (`! YOLO` while an old auto-approve setting is on, the microphone, `sleep disabled`), the unread notices (`2 notices` with the `ctrl+n` key; absent at zero; while the row has room, the newest unread notice's subject beside the count, `2 notices: Setting nosuch ignored (…)`, or the first words of its text when it has no title, which gives way after the branch), what the next `Esc` does while a turn runs, and any background work. Right, two spaces apart: the cost when the model is priced, `context 34%` (amber from 65%, red at the compaction threshold; `context unknown` when the window is not known), `branch main, changed` (`, changed` while the working tree differs from the last commit; absent outside a repository), `model <name>`, and `ctrl+p menu`. The right side is drawn faint, as background facts. A click on a segment opens its view: the mode opens `/permissions`, whose first row reads the mode in force and, chosen, says what it does, why it differs from your choice and the one setting that fixes that (`Choose a decision model`, `Turn decision models on`, or `Change when GoodVibes asks`), the notices the notifications, context the context inspector, branch the changes, model the model picker, the cost Usage. When the row is short the pieces go in this order: `ctrl+p menu`, the cost; the choice shortens and keeps its cause (`Jev decides once a decision model is set` to `Jev decides: no decision model set`, `Jev decides: not measured yet` while Jev decides is only the shipped default, `Jev decides: waits for the decision model` while it fails, followed by the failure; a click on the mode shows the rest); the notices lose their `ctrl+n` key and keep the count (`3 notices`), the branch loses its state word (`branch main`), the context goes, the branch goes; a failure shortens (`decision model unreachable` to `unreachable`); then the model, the notices, the mode's key; a failure goes last. `Permissions:` with the mode in force (`asking you, for now`) and the choice always stay. At 120 columns with no decision model set, `Permissions: asking you, for now · Jev decides: no decision model set` shows with context, branch and model (with `1 notice` in place of the context when there is one); with Jev decides only the shipped default and not measured, `Permissions: asking you, for now · Jev decides: not measured yet` shows the same way; with the decision model unreachable, `Permissions: asking you, for now · Jev decides: waits for the decision model · decision model unreachable` shows with the model (`· unreachable` when there is a notice). At 80 columns: `Permissions: asking you, for now · Jev decides: no decision model set` and its key, or `Permissions: asking you, for now · Jev decides: waits for the decision model · unreachable`.

While more than one session exists (a helper agent or background process is running), a row of session chips appears under the header; `Ctrl+G` `n` and `Ctrl+G` `p` (the rebindable `next-session` and `previous-session`, also `Ctrl+Q` and `Ctrl+_`) show the next and previous session, and the row ends with those keys. `Tab` and `Shift+Tab` never switch sessions.

### What the composer does with typed text

| Typed text | What happens on Enter |
| --- | --- |
| Plain text | It is sent to the model as a prompt. |
| A line that starts with `/` | It runs as a slash command. Typing `/` opens command autocomplete. |
| A line that starts with `!` | The rest runs as a shell command in the working directory, beside the composer. The command, its output and its exit status are shown in the conversation where it ran, and the output is placed in front of the next prompt as context for the model (the conversation shows that prompt, and the session title takes it, as typed). `Esc` stops a command that is still running. Spoken input is never run as a shell command. |
| `!# <text>` | `<text>` is pinned to session memory and also sent as the prompt. `[Memory] Pinned: "<text>" (<id>)` confirms it. |
| A single line `# <text>` (hash and space) | `<text>` is saved as a session-memory note and nothing is sent. `✓ Note saved → session memory: "<text>" (<id>)` confirms it. `#482 is failing`, `## heading` and text of more than one line are sent as prompts. |
| `@model:<id>` as the first or last word | The model switches exactly as `/model use <id>` would, then the rest is sent. Only a whole word at either end counts. When the switch does not happen, the text stays in the composer. |
| `!@<path>` | The file's text replaces the reference before sending. An image file (PNG, JPEG, WebP or GIF, judged by its bytes) is attached as an image instead. Any other file that is not UTF-8 text, or that cannot be read, stops the send with the reason (`a binary file is not sent as text; ...`); so does a folder (`it is a folder`) or anything that is not a regular file, such as a pipe or a device (`not a regular file`), which is never read. Text past 400,000 bytes is cut, and the cut says `kept the first N characters of <size> bytes`. |

Text that was not typed into the composer (a skill body, `/retry`, a template, an image sent from This conversation, a form, speech) is sent as written and never read for these markers.
In the terminal app, `@<path>` is plain text that names the file; the model reads it with its tools. (The Agent expands `@<path>` itself; see "Composer differences" in the Agent part.)
A paste of more than 8 lines folds into a marker `[TEXT: pN, M lines]`; "Read the pastes folded in the prompt", in This conversation, shows what each fold holds before sending.

Input history (`Up`, `Down`, `Ctrl+R`, in both programs) gives a sent message back as the composer held it: each fold comes back as a fold that holds its text ("Read the pastes folded in the prompt" shows it; text can be typed around it; `Enter` sends the whole text), and a pasted image comes back as its marker holding the image for the rest of the run. Each program keeps one history for every project, `~/.goodvibes/tui/input-history.json` or `~/.goodvibes/agent/input-history.json`: a JSON list of the last 500 lines as typed, newest first, in which a fold's marker names its content key (`[TEXT: h<hash>-<size>, M lines]`). Each folded text is a file of its own beside the list, `input-history-pastes/<key>.txt` (readable by the owner only), written once when the message that first holds it is sent and read only when a line naming it is recalled; a send without a new paste writes the list alone. Folded text goes through the same secret redaction as typed text, is stored once however many lines name it, and is kept up to 8 MiB in all, counted from the newest line; its file is removed when no kept line names it (the line dropped past 500, or older text past 8 MiB), and that line comes back as its marker alone. Pasted images are not written to disk. `@path` and `!@path` are kept as typed and read again when the line is sent. A line saved by 3.4.3 or earlier holds the marker only (its text was never kept) and comes back as that plain text; after a return to 3.4.3, lines saved since show their markers and the `input-history-pastes` folder is left alone.

Images in the terminal app:

- An image pasted from the clipboard (`Ctrl+V`, or "Paste the clipboard into the prompt" in This conversation) becomes a marker `[IMAGE: img1, clipboard, <size>KB]` in the composer and is sent with the message as an image.
- Pasting the path of an image file (ending in `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`) that exists and is at most 20 MB attaches the file the same way: `[IMAGE: img2, photo.png, <size>]`. A larger file stays a plain pasted path.
- "Send an image with a message", in This conversation, sends the image file with the message at once. A file over 20 MB is refused with its size. When the current model does not accept images, it prints `Warning: <model> does not support image input. The image will be stripped when sending.` and the image is not sent to that model.
- Deleting a marker with `Backspace` removes that image.
- `@photo.png` typed in the composer is plain text (the model can read the file with its tools); `!@photo.png` attaches the image, at most 20 MB, as a pasted path does.

### The leader and the menu

The leader (`Ctrl+G` by default, the rebindable `leader`) starts a two-key shortcut, over every screen: press it, and a strip at the bottom of the screen lists every key that can follow and what it does; the next key completes the shortcut or, if no shortcut uses it, cancels it (`Esc` cancels too). On a settings screen the key after the leader is that screen's action letter when it has one, and the strip lists those letters first, then the shortcuts of the key table. There is no time limit between the two keys. `Ctrl+G` then `m` opens the menu of every place: the fourteen function groups (This conversation, Sessions, Code and changes, Work and agents, Waiting for you, Models and providers, Permissions and safety, Tools and extensions, Memory and knowledge, Mail, calendar and channels, Automation, Devices and network, Money, System), each with one line on what is there and a count where something waits or failed; typing filters, `Enter` opens the place. The status bar's `ctrl+g m menu` keycap opens it with a click. In this release Waiting for you, Automation and System have their place; the others say so.

A place lists the real things (your schedules, what waits on you) read by themselves when it opens and again whenever they change elsewhere (a schedule paused, removed or run from the web UI, a question answered or expired elsewhere, shows with no key pressed). The hint row shows only the actions that apply to the selected item now, with the keys bound now; pressing one does it, says what happened and how to undo it, and asks first only when it cannot be undone or weakens a protection. Answering something that waits for you never asks again: the item is the question, so an answer's key answers it on the press, and `Enter` lists its answers, starting on No for an ask that loosens a protection. A list that could not be read says why; it is read again by itself when the daemon answers again (also when the place was opened while the daemon was down), and `r` reads it at once. Rows, tabs and menu rows can be clicked.

Waiting for you holds the questions, the approvals and the held calls (the calls `just-vibes` held instead of asking) of every program in one inbox: the daemon's held calls and the ones each terminal program's own gate held, so a held call can be answered here, in the web UI or on a phone. An answer runs on its key, and the line after it names the choice as you pressed it (`Answered "Run bun test?": No.`); a refusing answer says only that. Its other tabs: Decisions (the calls Jev decided, each changed on its keys in the program that decided it), Telegram (messages held for you), Sends (the Agent only), Answered (everything already answered, with who answered and whether the answer reached the asker, the session named by its title) and Kinds (of approval).

Sessions holds your conversations. Sessions: this conversation first (`open here`), then the ones saved in this project, newest first, each with when it was saved, its messages, its model and what it was left with (tasks running, approvals waiting); on any of them `e` renames it and `w` writes it to a file; on this conversation `f` continues in a copy and `u` uploads it for a link; on a saved one `Enter` resumes it here and `x` deletes it (it asks first); `s` searches the list in place as you type, by title and by what was said, each match showing the line that holds the words. A session another terminal saves in this project shows by itself. Branches: this conversation's branches (`you are here` on the current one); `Enter` switches to one, `m` brings in the messages it gained. Record: this conversation's record (every entry, turn by turn, where it spent most, what the last resume brought back), each opening whole, then its bookmarked blocks, `Enter` moving the conversation to one. Hand-offs: the project's cross-session task graph, shared by both programs: `n` adds a task, `o` hands one to another session, `a` accepts a hand-off, `w` takes it back, `x` cancels a task (it asks first), `g` shows the whole graph. Hosted: the conversations the daemon runs, which go on when the window closes, read from the daemon and following it, so one started, joined, left or ended anywhere shows with no key pressed; `h` starts one for this project and joins it (this terminal follows it live), `Enter` joins one, `x` ends one (it asks first). Joined here: the hosted session this terminal joined, with `t` to send it a message now, `k` to stop the tool it runs and `l` to leave it. The same acts are capabilities the model finds and runs (`session.list`, `session.resume`, `hosted.new` and the others); the Agent's Sessions place has its saved sessions and the daemon's hosted sessions (`h` starts one that answers as the Agent), changes only its own part of the Hand-offs, and keeps no branches.

Each place's letters are keys of the table too, one group per place, named `place.<place>.<action>` in `keybindings.json` (`place.automation.pause`, `place.waiting.read-again`); a place's two keys that can apply at once, or one of its keys the program reads before the place, are reported as a conflict. An item's answers keep the item's own keys (`y`, `n`, `1`...), the same on every surface.

System holds this program and this computer. This session: the session at a glance (what `/status` printed: the model, its context window and where it came from, and the other states; `/status` typed opens System here), with `q` to close the program, and how much the app prints, with `v` to change the print level and `n` to set one kind of notification on its own for this session, and whether every answer is spoken aloud, with `a` to turn it on or off, `p` to ask and hear one answer spoken and `w` to listen for the wake word again. Setup: the checklist of what most people set once, "Who decides" (when GoodVibes would stop and ask) first (first run never asks it: not done, its note naming the mode in force, until you choose there or set the mode in Settings; `Enter` opens the choice whatever is in force), then the model, how GoodVibes works with you, safety and history, each with what is set or missing, and the System topics this program sets up (keeping everything on this computer, the browser, a daemon on another computer, who can sign in, traces, provider behaviour, advanced switches, first run); `Enter` opens one, `s` skips a checklist topic for now or brings it back. Sleep: keep-awake and the work that holds this computer awake, read from the daemon and following it, with `k` to keep it awake or let it sleep again. Updates: whether the daemon keeps itself up to date, a release it found or is installing, failing checks, with `c` to check now. Voice: whether the voice runtime that speaks and listens is installed, with `i` to install it. Sign-in: the first-run sign-in file, with `x` to remove it (it asks first). Keys: every key, below. Each act is a capability the model and a script reach too (`system.status`, `system.quit`, `verbosity.show`, `verbosity.set`, `verbosity.set-domain`, `voice.review`, `voice.on`, `voice.off`, `voice.speak`, `voice.wake-again`, `power.status`, `power.on`, `power.off`, `update.daemon`, `voice.status`, `voice.setup`, `local-auth.remove-first-run-file`); the web UI's System panel has Sleep, Updates, Voice and Sign-in.

Permissions and safety (`/permissions` typed opens it) holds what protects this machine. This conversation: When GoodVibes asks (the mode in force and why it differs from the one chosen), with `w` for what it asks about and why, `s` for every permission setting in force and where it comes from, and `u` to set a secret as a variable for this session only; Plan mode (terminal app), with `p` to turn it on or off. Rules: the rules that decide a call without asking, each with what it covers, allow, ask or refuse, and where (one project, or every project for a never-run rule); `n` refuses a command everywhere, `a` adds a rule for this project, `x` removes one. Secrets: every stored secret by name and where it is kept (never a value); `n` stores one, `l` points one at a password manager, `c` checks one is stored, `t` uses this project's own copy (on one that waits for you; it asks first, as it weakens a protection), `x` deletes one (it asks first), `e` tests a reference, `h` lists where secrets can come from, `k` says how they are kept. This folder: trusted, restricted or not decided yet, with `t` to trust it (it asks first) and `x` to restrict it; the program reads the decision again at once, so the folder's hooks file and MCP servers start or stop now. Sign-in and Signed in: who may sign in to this machine's daemon and web app and who is signed in now; `n` lets someone sign in, `p` changes a password, `x` stops someone signing in or signs a session out (each password on a hidden line). Who is who: the people, bots and services the daemon knows and their identities on each channel; `n` adds one, `c` changes one, `x` removes one, `f` finds who an identity belongs to. Device tokens: each paired device's token with its policy, scope and rotation. Phone grants: the always-allow answers given to a phone's capabilities, with `x` to revoke one. Sandbox (terminal app): the sandbox sessions started here; `n` starts one, `e` runs a command in one, `w` saves its record, `o` reads a saved record, `x` stops one; `p` lists the sandbox presets for MCP servers. The lists read themselves again when a rule, a secret, a folder's trust or a sign-in changes in any program. Each act is a capability the model and a script reach too (`permissions.*`, `secrets.*`, `security.folder`, `security.trust-folder`, `security.restrict-folder`, `security.tokens`, `security.sandbox-presets`, the sandbox session ones, `plan.*`, `local-auth.*`, `principals.*`, `devices.grants`); the ones on this conversation (its mode, plan mode, a secret for this session, its sandbox sessions) run only in the program holding it. The web UI's Permissions and safety panel has the rules, secrets, sign-in, who is who, device tokens and phone grants.

The Keys tab (System) lists every key the program acts on as bound now, and each place's keys under the place's name; `Enter` on one and then the new key changes it (the leader and then a key makes a two-key shortcut), `d` puts back its default, `Shift+D` puts every key back (it asks first). The model can do the same three (`keys.bind`, `keys.reset`, `keys.reset-all`, found and run like any capability; a key is written `ctrl+k`, `f5`, `shift+tab` or `leader m`). Two actions on one key are reported in plain words naming both, there, in a notice at start, and for a hand edit of `keybindings.json`.

### Fixed keys

These keys are not in the rebindable table.

| Key | Action |
| --- | --- |
| `Shift+Enter` | Insert a newline. |
| `?` on an empty composer | Open the help list of every command. |
| `@` at the start or after a space | Open the file picker; the chosen path is inserted. `!@` opens it to insert a file whose text will be embedded. |
| `r` or `m` after a turn error | Retry the turn, or open the model picker. Any other key dismisses the choice. |
| `n`, `N` in locked search | Next or previous match; the search wraps and shows `(wrap)`. |
| Mouse wheel, drag, middle click | Scroll, select text, paste. |

### Rebindable keys

The default table of the terminal app:

| Action | Default key | What it does |
| --- | --- | --- |
| `leader` | `Ctrl+G` | Start a two-key shortcut (above). |
| `open-menu` | `Ctrl+G` `m` | Open the menu of every place. |
| `next-field` | `Tab` | Complete a path or command; otherwise toggle the nearest block's collapse; in a form, the next field; in a place, the next list. |
| `choose` | `Enter` | Send the composer, or run the selected row in a list. |
| `back` | `Esc` | One step per press, the first that applies: close the top view (one level), clear the composer, leave an agent or process view, return a scrolled-back transcript to the bottom, interrupt the running turn. The status bar names what the next `Esc` does (`esc clear input`, `esc back`, `esc interrupt`). Inside Agents it backs out one level and never stops work. |
| `move-up`, `move-down`, `move-left`, `move-right` | `Up`, `Down`, `Left`, `Right` | Move; `Up`/`Down` scroll the transcript or recall input history when the composer is focused. |
| `copy-selection` | `Ctrl+G` `c`, `F5`, `Ctrl+Shift+C` | Copy selected text to the clipboard (`Ctrl+Shift+C` where the terminal passes it on). |
| `clear-cancel` | `Ctrl+C` | Clear the composer; on an empty composer cancel generation; pressed twice within one second, exit. The footer shows `Press Ctrl+C again to exit`. |
| `screen-clear` | `Ctrl+L` | Repaint the screen. |
| `command-palette` | `Ctrl+P`, `Ctrl+K` | Open the command palette: every command, view and setting. |
| `open-agents` | `F2`, `Ctrl+O` | Open Your agents: what is running, what waits for you, what is scheduled. |
| `scroll-page-up`, `scroll-page-down` | `PageUp`, `PageDown` | Scroll the transcript by a page. |
| `history-search` | `Ctrl+R` | Reverse search of input history. |
| `search` | `Ctrl+F` | Search this conversation's transcript. |
| `block-copy` | `Ctrl+Y` | Copy the nearest block. |
| `bookmark` | `Ctrl+B` | Bookmark or unbookmark the nearest block (the Sessions place's Record tab lists them). |
| `block-save` | `Ctrl+S` | Save the nearest block to a file. |
| `delete-word` | `Ctrl+W` | Delete the word before the cursor (whitespace-delimited) into the kill ring. |
| `line-start` | `Ctrl+A` | Move to the start of the line. |
| `next-error-line-end` | `Ctrl+E` | Move to the end of the line; on an empty composer, jump to the next error in the transcript. |
| `kill-line` | `Ctrl+G` `k`, `Ctrl+X` | Kill from the cursor to the end of the line into the kill ring. |
| `clear-prompt` | `Ctrl+G` `u` | Clear the whole composer without using the kill ring. |
| `undo` | `Ctrl+Z` | Undo the last composer edit. |
| `redo` | `Ctrl+G` `z`, `Ctrl+^` | Redo the last undone composer edit. |
| `paste` | `Ctrl+V` | Paste from the clipboard; an image takes priority over text. |
| `word-back` | `Ctrl+G` `b`, `Ctrl+Left` | Move to the start of the previous word. |
| `word-forward` | `Ctrl+G` `f`, `Ctrl+Right` | Move to the end of the next word. |
| `kill-to-start` | `Ctrl+U` | Kill from the cursor to the start of the line into the kill ring. |
| `kill-word-forward` | `Ctrl+G` `d`, `Ctrl+Delete` | Kill the next word into the kill ring. |
| `yank` | `Ctrl+G` `y`, `Ctrl+\` | Paste the newest kill-ring entry. |
| `yank-pop` | `Ctrl+G` `Y`, `Ctrl+]` | Right after a yank, replace it with the previous kill-ring entry. |
| `cancel-tool-call` | `Ctrl+G` `t`, `Ctrl+T` | Cancel the running tool call; the turn continues. |
| `toggle-keep-awake` | `Ctrl+G` `a`, `F6` | Turn the machine's keep-awake on or off (the "sleep disabled" chip). |
| `toggle-memory-provenance` | `Ctrl+G` `e`, `F7` | List or hide the memories the last turn used. |
| `voice-input` | `Ctrl+G` `v`, `F8` | First press starts recording; the second press stops it and adds the transcription to the composer, after any text already there. |
| `focus-work-tree` | `Ctrl+G` `Up`, `Ctrl+Up` | Move the keyboard onto the transcript's work tree: arrows move and fold, `Enter` opens, `y` copies, `Esc` returns. |
| `cycle-permission-mode` | `Shift+Tab` | Cycle this session's permission mode (see below). |
| `open-notifications` | `Ctrl+N` | Open the notifications; the status bar counts the unread ones. |
| `failure-other-model` | `Ctrl+G` `o`, `F9` | On the newest failed turn: choose another model and send the prompt again. |
| `failure-details` | `Ctrl+G` `i`, `F3` | On the newest failed turn: show what the provider said. |
| `failure-sign-in` | `Ctrl+G` `s`, `F4` | On the newest failed turn whose provider refused its key: open the provider sign-ins (the Providers tab of Models and providers). |
| `failure-retry` | `Ctrl+G` `r`, `F12` | On the newest failed turn: send the prompt again. |
| `open-fix-session` | `Ctrl+G` `j`, `F10` | Open the fix session just started (a CI fix, a conflict resolution). |
| `next-session` | `Ctrl+G` `n`, `Ctrl+Q` | While the session chips show: the next session (agent or process). |
| `previous-session` | `Ctrl+G` `p`, `Ctrl+_` | While the session chips show: the previous session. |
| `model-picker-group` | `Ctrl+G` `g` | In the model list: group it another way (provider, price, none). |

The actions that sat on an `Alt` or `Ctrl+Shift` chord, which tmux, screen and macOS Terminal swallow, are a leader shortcut by default, each beside a second key every terminal sends (a function key, a free `Ctrl` chord, or `Ctrl` with an arrow or Delete). A person can bind a chord back: `{ "kill-line": { "key": "k", "alt": true } }` in `keybindings.json`; a binding there written before this release keeps working. A two-key shortcut is written `{ "key": "m", "leader": true }`. A key bound to `next-field`, `choose`, `back` or a `move-*` action is that key to every screen, and `Tab`, `Enter`, `Esc` or an arrow bound to another action does that action instead.

`Ctrl+G` `r` on the newest failed turn sends the failed prompt again in place of the failed turn. The failed turn stays in the transcript, and the offer stays, until the replacement is submitted: when the memory refresh before it fails, or the session or the failed turn changes meanwhile, nothing is taken away and the same key tries again. When the failed turn had already run tools, the tool results are kept and the turn continues from them, so their effects are not repeated. The keys are named on the failed turn's row (see "Turn errors"), not in the footer.

`Shift+Tab` cycles `ask-me` → `jev-decides` → `just-vibes` → `yolo` → `ask-me`.
Before `yolo` it asks for confirmation (default No); declining skips to the mode after it.
The change lasts for the session only. The saved default is changed in `/settings` (or `/settings set permissions.mode <mode>`); `/permissions` shows it but does not change it.
Plan mode is outside the cycle; its row on This conversation in Permissions and safety turns it on and off for this session, also without changing the saved default.
Nothing is written into the conversation: for 4 seconds the status bar's `Permissions:` segment is replaced (drawn inverse) by the new mode and what it does in one line, for example `Ask me: asks before commands and changes outside this folder`, then shows the mode's words again. A change made elsewhere (in settings, or a decision model failing) flashes the segment for 1.5 seconds. When the mode chosen is not the one in force (`jev-decides` with no working decision model runs as `ask-me`), the segment leads with what is in force and says when the choice takes effect: `Permissions: asking you, for now · Jev decides once decision models are on`.
A managed lock on `permissions.mode` stops the change, and a notice says so: `The mode stays <mode>: <reason>`.

### Changing a key

Key overrides are kept in `~/.goodvibes/tui/keybindings.json`.
The file is a JSON object from action name to one key combination or a list of them.
A key combination is an object with `key` (a single character or a key name such as `tab`, `up`, `pageup`, `f2`) and the optional booleans `ctrl`, `alt` and `shift`.

```json
{
  "command-palette": [{ "key": "p", "ctrl": true }],
  "kill-line": { "key": "k", "ctrl": true, "alt": true },
  "voice-input": [{ "key": "v", "alt": true }, { "key": "space", "ctrl": true }]
}
```

`/help keys` lists the current bindings and the file path.
An unknown action is ignored with the notice `keybindings: unknown action "<name>" ignored`.
An invalid combination keeps the default: `keybindings: invalid key combination for "<name>" ignored; the default stays`.
Two actions on one key are reported: `keybindings: <key> is bound to <a> and <b>; only <b> responds to it`.
A file that cannot be parsed is ignored as a whole and the defaults apply.
The old action name `apply-diff-line-start` is read as `line-start`.

### Views

Every view opens as a modal over the dimmed conversation; `Esc` closes one level at a time.

| View | How to open | What it holds |
| --- | --- | --- |
| Command palette | `Ctrl+P`, `Ctrl+K`, `?`, `/help` | Every command, view and setting, searchable. Old pane names (fleet, tokens, git) are search words. |
| Your agents | `F2`, `Ctrl+O`, `/agents` | The work board, the same panel as the Agent's: rows waiting for you first (`Waiting for you`: the agent and what it asks, `● Helper agent   Run bun test?   just now`, with the question, what it acts on and the consequence in the detail, `Enter` bringing its card to the front; an agent waiting for a reply in its own conversation reads `Waiting for your reply in its own conversation`), then one line per running agent (`● Helper agent   Writing docs/usage.md   15s  2 files read`, sub-agents indented under their parent), the agents that finished this session (or `no finished agents this session`), `Scheduled` (schedules and watches with their cadence and last run), and one line `Background services  N healthy ›`. The platform's own heartbeats, pollers and the code index are counted there, never as running; an unhealthy one is listed under that line by itself (`Daemon heartbeat stopped answering · 3 min ago`). A service another process runs (the daemon's heartbeat and CI watch poller, when the terminal app shares the daemon's folder state) is read from that process, never from the copy in the shared `watchers.json`, so both programs count the same services the same way; a beat that is only due (inside two intervals) is not a service that stopped answering. Keys: `Enter` opens the selected row (an agent or background process full screen; a contract, workflow or hosted agent full height in the panel; a pick or merge conflict acts; a stalled service restarts where it can), `s` stops it and what it started (asks first; `Ctrl+X` too), `n` starts a new agent (a coding agent found on `PATH`, hosted by the GoodVibes service), `b` opens or closes the background services, `p` pauses or resumes a schedule. Also: `i` interrupts, `D` discards a contract's worktree, `f` follows the newest running agent, `v` shows the archive (`a` archives or restores one, `A` archives everything finished), `/` filters. Empty: `nothing running` and `Ask for something and helper agents show up here.` A fleet that cannot be read: `Couldn't read what is running: <reason>` with `r` to try again. On a screen 90 columns or wider the selected row's detail is on the right, the same in both programs: an agent's task, who and since when (`Helper agent · started 15 s ago · 2 files read`), then `model`, `time`, `files 2 read · 0 changed`, `tokens`, `cost` only when priced, and `now` (what it is doing, in the tool's words: `Reading 2 files`; a call that ended reads `Read files`); never a tool's raw result. A contract, workstream or observed agent adds its workspace, checks and task graph. |
| Money, Spending | the menu (`Ctrl+G` then `m`), or a click on the cost in the status bar | This conversation first: its context against the compaction threshold, tokens, cost against the spending alert, its turns one by one and each agent it started, with its cost; then what the daemon spent on models in the last 7 days by what it was for (each schedule, piece of work, web chat and shared session), and where the daemon's own runs stand against the spending alert over the last 24 hours. `c` on the conversation's row shortens it now, `p` there sets your own price for the model in use, and `p` on a daemon row whose model has no price gives that model one; `w` sets the spending alert, `b` shows every split. |
| Changes | Code and changes: `Enter` on a changed file, `v` for this session's changes | Changed files with +/- counts, a tinted diff, a semantic summary; `]` and `[` move between hunks, `space` stages a hunk, `c` adds a review comment for the model, `m` marks reviewed, `o` opens the file in the editor. |
| Notices | `Ctrl+N` (System place, Notices tab) | Every notice, newest first, followed as they arrive. |
| Sessions | `/resume`, `/fork` | `/resume` resumes a saved session (alone, it lists them to pick from); `/fork` continues in a copy of this one. Everything else on sessions is the Sessions place. |
| Settings | `/settings` | Every setting by topic, searchable by name, key or what it does. |
| Model picker | `/model` | Providers and models for each route, for this conversation. |
| Models and providers | the menu (`Ctrl+G` then `m`) | The default model, pins, backups, providers and sign-ins, routing, services, comparisons, media providers, moving sign-ins. |

An opened helper agent shows its work as the spine of the transcript; the composer then steers that agent while the main conversation keeps running. In a contract, workflow or hosted agent opened inside Your agents, `s` opens the line that steers it.
An opened background process shows live output with timestamps, errors in red and follow mode on; it takes no input; `/` searches its output and `y` copies it.
`Esc` returns one level (a child agent to its parent, then main) and never stops anything.

### Keys inside lists and forms

Pickers (session picker, profile picker, selection lists, the recovery offer) share these keys:

| Key | Action |
| --- | --- |
| `Enter` | Run the selected row's main action. |
| `Space` | Toggle the selected row when it has a toggle. |
| `Left`, `Right` | Decrease or increase an adjustable row. |
| `Shift+Left`, `Shift+Right` | The same adjustment times ten. |
| `/`, or any key no row claims | Start filtering. |
| `Backspace` | Delete one character of the filter. |
| `Esc` | Close the list in one press. |

Configuration workspaces keep a search row that always takes typed characters.
An action there fires from `Enter`, from `Ctrl` plus its letter (the hint bar shows `^d delete`), or from the leader (`Ctrl+G` unless rebound) followed by its key for keys a terminal cannot send with `Ctrl` (`c`, `h`, `i`, `j`, `m`, digits and capitals; the hint bar shows `^G c`, and the leader as bound).
An action that deletes, uninstalls or clears asks for the same key a second time; `Esc` cancels.

### Turn errors

A failed turn is a row in the transcript under its prompt, which stays as you typed it. No notice is shown over the conversation:

```text
✕ The model didn't answer.
  OpenAI returned an error (500) six times. Nothing was changed.

  ctrl+g r try again   ctrl+g o use another model   ctrl+g i details

  Tip: name a backup model once and GoodVibes switches by itself:
  /model backup
```

The second line is worded from the failure's facts: the provider's status (`refused the API key (401)`, `turned the request away for too many requests (429)`, `returned an error (500)`), a connection error (`GoodVibes couldn't reach <provider> (ECONNREFUSED)`), how many requests were made, and what the turn's tools changed before it stopped, from the turn's own record (`2 files were changed before it stopped. /changes`; `1 command ran before it stopped.`; `Nothing was changed.` only when the record shows nothing was written, run or sent). `ctrl+g r` sends the prompt again, `ctrl+g o` opens the model picker and sends the prompt to the model chosen there, `ctrl+g i` shows the details under the second line (provider, model, status, code, attempts and their times, why the fallback order did not move the turn, the provider's own message) and hides them again. A provider that refused its key offers `ctrl+g s sign in again` (the provider sign-ins, on the Providers tab of Models and providers) in place of `ctrl+g r`. The row names each key as bound (`failure-retry`, `failure-other-model`, `failure-details`, `failure-sign-in`). The tip is shown only while `provider.fallbackModels` is empty. A turn sent with no usable model (no model selected, or its provider not signed in) is refused before any request: `No model is set up yet. Nothing was changed.` with `ctrl+g o choose a model` and `or set it up in the menu: System, Setup`. A newer prompt removes the keys and the tip from the older row; its first two lines stay. While a failing request is retried, the row says so (`Retrying up to 5 times…`) and becomes the failure row when the retries are spent.
A provider failure may move to another sign-in, another backend of a `synthetic` model, or the next model of your fallback order, as described under "Failover".
`/retry [modified text]` sends the last prompt again, optionally changed.

### Screen readers and accessibility

Both terminal programs are full-screen and repaint rows in place, so a screen reader reads them but repeats what is repainted (the status line, the composer, an answer being written). The route that reads well is the headless one: `goodvibes run '<prompt>'` (or `goodvibes-agent run "<prompt>"`) prints the answer as plain text; `--output json` prints one JSON object at the end and `--output stream-json` one line per event, with `--answer-permissions` for a script that answers approvals on stdin. The web UI is the other route: an ordinary web page. Plainer screens: `NO_COLOR` set to any value (or `TERM=dumb`) turns colour off, and nothing depends on colour alone (what cannot be undone also says `This can't be undone.`); `display.stream` off paints each answer once, when it is complete; `display.treeGlyphs` `ascii` draws plain lines; `display.themeMode` forces light or dark. Every built-in theme keeps dim and secondary text at 4.5:1 or more against its panels. Overlays take the keys while open, list them on their last row, and close with `Esc`; the approval card's chosen button is highlighted and opens on `No` for what cannot be undone or weakens a protection. The pages `products/tui/docs/accessibility.md` and `products/agent/docs/accessibility.md` say the same for each program.

## Slash commands

### How slash commands work

A slash command is typed in the composer and run with Enter: `/model use openai:gpt-5.4`.
Typing `/` opens autocomplete; `Tab` completes the selected command.
Every command has one name and no aliases.
Arguments are separated by spaces; quote an argument that contains spaces with `"` or `'` at the start of the word (`/checkpoint make "Release prep"`).
A quote character inside a word is an ordinary character, so `["a","b"]` is one word.
A backslash outside quotes is an ordinary character (`C:\dir`).
An unclosed quote refuses the whole line instead of being guessed.
A command you type in full, or a form you fill in and submit, is the request: it runs at once, whatever its risk, and its result says what the risk did (`Accepted drift's changed tools.` … `This loosened a protection: its tools are no longer held back.`). A line the model runs is put to you first when it carries a risk, under your permission mode; a row with nothing to fill in, chosen from a command's list, says what it does and asks. What still asks after your own command or key is what cannot be put back: Shift+Tab into YOLO, stopping a running agent (`s`, `Ctrl+X`), resetting a whole settings topic, removing Google credentials ("disconnect" on the Google tab of Mail, calendar and channels), using a service a project defines (`y`, "Use a service this project defines", on the Services tab of Models and providers), bringing in a moved setup ("bring one in", `m` on the Support and transfer tab of System, whose replaced files are not kept), committing or creating a git repository from Changes, and resuming a session another terminal has open. `--yes` is accepted and changes nothing.
A command that needs the daemon says `[<command>] <reason>` and changes nothing when no daemon answers.
A command the model runs on the owner's behalf passes the permission gate like any tool call; a few acts (pairing this terminal with its daemon, asking for work in your own words: `/work request <goal>`) refuse unless the owner typed or pressed them, and starting a remote runner (`remote.dispatch`), like every capability that is the owner's own act, is put to the owner when a model calls it, opening on No, and runs on the owner's yes.

The complete list of the terminal app's slash commands, with usage, aliases and descriptions, is under "Slash commands: terminal app" in the reference part.

The sections below explain the commands grouped by task. Each entry gives the purpose, the forms, a worked example with its result, and the failure cases.

### Help, navigation and display

`?` on an empty composer, `/help` and `Ctrl+P` (or `Ctrl+K`) all open the same list: every command as a plain title with its slash name on the right, grouped (Suggested, Session, Views, Settings, then every other command under the task it serves: Sessions and history, Change code, Run and check, Agents and work, Models and providers, Memory and knowledge, Channels and devices, Tools and extensions, Settings and safety, Help and setup), and the keyboard shortcuts as the last group, each with its key on the right. A row that runs a command with words already given shows the whole line (`/settings open permissions.mode`). `Ctrl+]` jumps to the next group's first row. Suggested learns from what you run from the list, kept across restarts in `palette-usage.json` beside the input history (not kept when `behavior.saveHistory` is off); until then it offers changes, model and compact. Typing searches titles, names, descriptions and search words; a search also lists the shortcuts it matches. Beside the search, `<n> commands and keys` counts every row of the list (`<shown> of <n>` while searching), the same rows the `<n> more ↓` count under the list counts. The detail pane shows the selected command's summary, what it can do (its actions, for a guided command with more than one; a command that does one thing shows only its summary) and `Finds:` with the words that find it; on an 80-column terminal there is no detail pane and the selected row's summary is one dim line under the list. Enter runs the command (a guided command opens its list of things to do); `tab` puts it in the composer to type arguments. A shortcut row is read, not run. `/help <command>` prints one command's actions and typed lines, and `/help keys` prints every key with the file that changes them (`~/.goodvibes/tui/keybindings.json`). The list's last shortcut row names that file too. Without an interface `/help` prints every command with its usage.
Looking through the conversation: `Ctrl+F` searches it in place; "search the web" (`w` on the Tools tab of Tools and extensions) searches the web instead. "Open folded blocks" and "Fold blocks", in This conversation, open or fold every block of a type. The Record tab of the Sessions place lists the blocks bookmarked with `Ctrl+B`; `Enter` on one moves the conversation to it. `Ctrl+E` on an empty composer moves to the next error; moving to the next or previous entry, the previous error and saying what the composer waits on are keys of the table with no default ("Moving through this conversation, while writing a message" in the Keys place), bound there when wanted. The model reaches the same as `session.find`, `session.next`, `session.prev`, `session.bookmarks` and `session.composer`.

How much the app prints is a row of the System place's This session tab, the same in both apps: `v` changes the level (Quiet, Balanced or Operator; it writes `behavior.hitlMode`, default `balanced`, and clears the per-domain levels set this session, naming them), and `n` sets one kind of notification's verbosity (minimal, normal or verbose) for this session. A model or a script runs the same as `verbosity.show`, `verbosity.set` and `verbosity.set-domain` (`goodvibes do verbosity.set --input level=quiet`).

`Ctrl+N` opens the notice history, the Notices tab of the System place, newest first; reading it there marks the notices seen. A notice is never drawn as a box over the conversation, a dialog or the first-run screens: it is counted on the status bar (`3 notices`) until read.

A notice exists only when you have something to do or need to know something you could not otherwise see: something needs your answer (a contract's question, a device asking to pair, a workspace waiting on trust), something you asked for failed (`[Contract] <id> FAILED: <reason>`, `[Tool recovery] Stopped ...`, a scheduled job that failed), something of yours was changed or skipped (a contract's commit, settings carried forward, a session restored after a crash, a setting that is not read), or a set decision model stopped answering. Everything else is not a notice:
- work in flight is shown where the work is: a contract's states (queued, shaping, planning, checking the plan, running), its checks, nudges and gates, and each agent's start and end are on its row in the agents view (`F2`) and in the activity log, never in the notices;
- a routine success is silent: a contract that passed, an agent that finished, a scheduled run that succeeded, a compaction (its receipt is the one line), an automatic session title, the model a decision router picked;
- a thing said once is not said again in the next session: the settings notices, "no daemon is installed" and the other start-up lines are announce-once;
- a notice about something that has ended is withdrawn: the decision model's failure notice leaves the history and the count when the model answers again;
- an information line that only reports progress or bookkeeping (`low` priority) goes to the activity log; it is never counted. `/clear` posts the name of the saved conversation as a notice (`[Session] Fresh conversation. The previous one is saved as <id>: /resume <id> returns to it.`) rather than writing it into the new conversation. A slash command that opens only a dialog or posts only a notice leaves the splash showing; the splash goes with the first message sent or the first line written into the conversation.
The conversation's record is the Record tab of the Sessions place: "Every entry, newest page first", "Turn by turn", "Where it spent most" and "What the last resume brought back", each opening whole on `Enter`, then the bookmarked blocks. The model runs them as `session.events` (with a kind, a first row and how many rows), `session.groups`, `session.hotspots` and `session.restored`.

Contextual guidance is three controls in This conversation (below): "See guidance for now" (what applies now, and how the session is doing for size), "Dismiss a piece of guidance" (one item, for what it reports now, picked from what is showing) and "Show dismissed guidance again" (one item, or every one when none is named).
Dismissing `g1` when it is not showing is refused with `Guidance g1 is not showing now, so there is nothing to dismiss.`

The `goodvibes://open/<view>` links are on the Links tab of the System place: one row per view (Enter opens it, `l` makes a link to one item in it, `g` opens a link someone gave you, `i` reads a saved file of links); "save the links to views" in Tools and extensions writes them to a file. The capabilities are `deeplink.review`, `deeplink.open`, `deeplink.inspect` and `deeplink.export`; `deeplink.open` with `agents` opens Your agents. A link that is not of that form prints `Not opened: <link> is not a goodvibes://open/<view> link.`

The Health tab of the System place is the one place for "is everything working" (there is no `/health` command). Its first row is the short status: `✓ Everything is working.`, or a headline such as `2 things need attention:` and one line per thing (`✕ <what is wrong>`) with what fixes it, named as its control. It reads setup, providers and accounts, settings, services, MCP servers, remote runners, the first-run sign-in file and the conversation's size; it makes no model request and changes nothing. A model runs the same with `capability_run` (`health.*`). Its controls:

| Control | Capability | What it does |
| --- | --- | --- |
| See what needs attention | `health.report` | The short status above. |
| Check one area | `health.check` (area, provider) | One area in detail: `setup`, `services`, `provider` (opens the providers view when typed by you), `accounts`, `auth`, `settings`, `intelligence`, `remote`, `mcp`, `memory`, `metrics` (the daemon's counters and a provider's quota), `continuity` (last-session pointer and recovery file), `worktrees`, `maintenance` (context use and session upkeep), `sandbox`, `terminal` (colour depth, synchronized output and the count of direct terminal writes intercepted this session), `approvals` (the Agent's; here Waiting for you lists them). |
| Describe a problem | `health.diagnose` (symptom) | Finds the runbook for the words and runs its checks against the app's live state, without a model request: "stuck turn". |
| See a failure report | `health.failure` (report, as summary, JSON or bundle) | This session's automatically classified failure reports: a summary (kind, what failed, error, stop reason, root cause, denied permissions, budget breaches, replay mismatches, how it happened), the report as JSON, or the whole bundle as JSON with the replay snapshot. Without one: `No failure report was recorded this session.` |
| Save a failure report as a file | `health.save-failure` (file, report, with replay, replace) | Writes the report's bundle (with the replay snapshot when asked). An existing file is kept unless you choose to replace it: `<file> already exists; nothing was written.` |
| Keep a failure report in memory | `health.keep-failure` (report) | Stores it once as an `incident` record in durable memory; a second time prints `Failure report <id> is already kept in memory as <record>; nothing was added.` |
| See the runtime store | `health.state` (parts) | What the app's runtime store holds now (session, conversation, agents, tasks, permissions and more), credentials masked; for debugging. |
| Check the connected host's compatibility | `health.compat` | The Agent's; here it is refused and names the Agent. |

Stopping a running agent is Your agents in Work and agents (`x` on a running agent, `agents.stop`).

`/quit` closes the program. A bare `:q` or `:wq` typed in the composer does the same. A model cannot run `/quit`.

### The conversation

The menu (the leader, then `m`) has a row "This conversation": it opens the controls on the conversation itself, one row each, with what the row acts on as it is now (the title, how many messages, how hard the model thinks, how many messages wait in the queue or pastes in the prompt), the key that reaches it where the conversation has one (`Ctrl+V` pastes the clipboard), and the line still typed for it where there is one (`/retry`, `/undo`, `/redo`, `/compact`, `/clear`, `/checkpoint`). `Enter` runs the selected control: at once when it needs nothing, else through a form built from what it asks for; the line under the list says what happened. The controls: send the last message again, redo, undo, compact, start a fresh conversation, give this chat a title, write the message in your editor, send an image with a message, paste the clipboard into the prompt, read the pastes folded in the prompt, see, change or take back a queued message, see what fills the context, see the project instruction files (the Agent), see and choose how hard the model thinks, save this session under a name, save this conversation as a file, branch it, open or fold its blocks, see what compaction removed, the guidance (see, dismiss, show again), and the workspace checkpoints (see them, make one, put the files back, go back to an earlier turn). A control the program does not have is not listed (the Agent queues no messages, keeps no guidance, opens no editor and goes back to no turn). The model reaches the same controls with `capability_find` and `capability_run`; a script or an outside agent is refused, since they act on the conversation open in this program.

`/clear` saves the current conversation as its own session and starts a fresh one; `/resume` brings the saved one back.
While a turn runs it refuses: `A turn is still running, so nothing was cleared.` with `Stop it with Esc or let it finish, then /clear.`
When the save fails nothing is cleared: `Could not save the current conversation, so nothing was cleared: <reason>`.

`/compact` summarizes older messages to free the context window. The transcript shows a before and after notice.
When the model's context window is too small to summarize, the oldest messages are dropped without a summary and the notice says so: `[Context] Dropped the N oldest message(s) without a summary and kept the last M ...`.
When there is nothing to gain it says so in one sentence and changes nothing: `Nothing to compact yet.` for an empty conversation, `This conversation is already as short as compaction can make it.` when a summary would not be shorter. An automatic compaction in that case says nothing and the request is sent as it is.
The app also compacts on its own when context use reaches `behavior.autoCompactThreshold` percent (default `80`, range 10 to 100).
"See what compaction removed", in This conversation, lists this session's compactions: when, how much each removed and what it kept.

Your notes, personas (VIBE.md files too), routines, document drafts and saved artifacts are the daemon's, one of each for every program: the Notes, Personas, Routines, Drafts and Artifacts tabs of Memory and knowledge (the menu, Ctrl+G then m) show them in the terminal app as in the Agent and the web UI, read by themselves and following changes made anywhere. On the Notes tab: Enter changes the selected note, `c` writes a new one, `f` searches, `v` marks it reviewed, `t` out of date, `m` keeps it as a memory record, `p`, `k` and `o` make a persona, a skill or a routine from it, `w` adds its web page to your knowledge, `s` reads it in full and `x` deletes it (asked first: it cannot be undone). Each is a capability (`notes.create`, `notes.to-memory`, ...) the model, an outside agent and `goodvibes do` run too. A message that starts with `!#` still pins a line to this conversation, which the model keeps seeing after a compaction.

"Give this chat a title", in This conversation, sets the conversation's title to what you type; its row shows the title it has now.

`/retry [changed message]` sends the last message again, keeping the work already done; with text it sends that text instead. A turn still running refuses it: `A turn is still running, so nothing was sent.`
Messages typed while a turn is streaming wait in a queue until the turn ends; the composer shows them numbered from 1 (`2 queued: change or take one back in This conversation until it is sent`). "See your queued messages" lists them: with none, `No queued messages. (Messages typed while a turn is streaming queue here until it finishes.)`. "Change a queued message" changes one; "Take back a queued message" takes one back (it is not sent; type it again to send it), asking first since it cannot be undone. In the form's list each row is that message itself, so a message chosen there stays the one acted on even when an earlier one is sent while you choose. A message already sent is refused: `The queued message "<its text>" was already sent, so it was not changed.`; a chosen one that left the queue while you chose: `That message is no longer queued: it was sent when the turn before it ended, so nothing was changed.`

"Paste the clipboard into the prompt" (`Ctrl+V` in the composer) puts the clipboard's text or image into the composer. Use it when the terminal's own paste does not carry images. With nothing usable: `The clipboard holds no text or image this program can paste.`
"Read the pastes folded in the prompt" shows what each `[TEXT: pN, M lines]` fold holds, or one fold's whole text. With no folds: `No paste is folded in the prompt (a paste over 8 lines folds to [TEXT: pN, M lines]).`
"Send an image with a message" sends an image file (PNG, JPEG, WebP, GIF, up to 20 MB, inside the project) to the model with the message at once (`Attached image: <name>` when no message is given); its form asks for the file and the message.
"Write the message in your editor" opens the composer draft in `$VISUAL` or `$EDITOR`, suspends the interface while the editor runs, and puts the saved text back in the composer. Set `export EDITOR=nvim` first.

Prompt templates are the Templates tab of **Memory and knowledge**: `Enter` shows one, `u` uses it as your next message (its blanks filled from name=value pairs in the form), `e` edits it in your editor, `x` deletes it (this project's, or the one every project shares; removed for good), and `s` keeps your last message as one (for this project, or for every project).
Project templates live in `<project>/.goodvibes/templates/`; templates for every project live in `~/.goodvibes/templates/`.
A template's file is `<stored name>.md`: the name in lower case, spaces as `-`, letters and digits of any script with `-` and `_` kept, everything else dropped, so `My Plan` and `my-plan` are one template and `会議メモ` and `計画` are two. A name that keeps nothing is refused (`TEMPLATE_NAME_UNSTORABLE`). A file in a templates folder whose name is not its own stored name is not listed (a warning in the log names it); rename it to use it.
Keeping your last message as `review` replies `Template saved: review (in this project).`; keeping one under a name that already has a template in that place replaces it and replies `Template replaced: review (in this project).`, which cannot be undone. Using `review` with the blanks `file=src/api.ts` sends it with its blanks filled in.
A missing template is refused with `No template <name>.`

### Sessions

Your conversations are the Sessions place (the menu, the leader then `m`, "Sessions"); two commands stay typed: `/resume` (alone it lists the saved sessions to pick from, `/resume <session> [--force]` resumes one) and `/fork [<name>]` (continue in a copy of this session). Every act below is also a capability the model finds and runs (`session.<word>`); a script or an outside agent is refused, since each acts on what this program holds.

| Tab and key | Capability | What it does |
| --- | --- | --- |
| Sessions, the list itself | `session.list`, `session.current`, `session.info` | This conversation first (`open here`), then the saved ones, newest first, with what each was left with; the selected one's details beside it. The list reads again by itself when another terminal saves or writes into a session of this project (it follows the daemon's session list). |
| Sessions, `s` | `session.search` | Search the list in place as you type: only the sessions whose title or messages hold the words stay, each with the line that holds them; `Enter` keeps the search, `Esc` clears it. |
| Sessions, `Enter` on a saved one | `session.resume` | Resume it: its messages, model and agent records continue here. When the saved model cannot be selected here, the resume says `The saved model <model> could not be selected here (<reason>); this session continues on <model in use>; the loaded conversation stands.` A session another running terminal has open is refused; "Have it handed over here" asks that terminal, through the shared daemon, to save it and hand it over (see "Which session is open where"); a session with agents still running here is refused. |
| Sessions, `e` | `session.rename` | Rename the selected session: a saved one's name in the list, or this one's. ("Give this chat a title", in This conversation, names the conversation open here.) |
| Sessions, `f` on this one | `session.fork` | Continue in a copy of this session under a new id. |
| Sessions, `w` | `session.save-saved` | Write the selected session's redacted transcript to a file (a new file in `~/goodvibes-exports`, never replacing one), or print it here. Both programs write the file. |
| Sessions, `u` on this one | `session.upload` | Upload this conversation as a secret GitHub Gist (unlisted, not private: anyone with the link can read it) and print the link; the owner's own act only. Not in the Agent. |
| Sessions, `x` on a saved one | `session.delete` | Delete it for good (never the open one); asks first. |
| Branches | `session.branches`, `session.switch-branch` (`Enter`), `session.merge-branch` (`m`) | This conversation's branches: go on from one, or add the messages it gained after it was made (refused when both changed; refused while a turn runs). "Branch this chat here", in This conversation, keeps one. Not in the Agent. |
| Record | `session.events`, `session.groups`, `session.hotspots`, `session.restored`, `session.bookmarks` | The open conversation's record, each view opening whole on `Enter`, and its bookmarked blocks (`Enter` moves the conversation to one). |
| Hand-offs | `session.graph` (`g`), `session.link-task` (`n`), `session.hand-off` (`o`), `session.accept` (`a`), `session.withdraw` (`w`), `session.cancel` (`x`, asks first) | The project's cross-session task graph, one file for both programs (`<project>/.goodvibes/shared/task-graph.json`), the one a turn's task tool reads: every task with its state and the hand-off waiting on it. It reads again by itself when another terminal changes it. The Agent changes only its own session's part (adds and cancels its own tasks, accepts one handed to it, takes back one handed off from it) and hands nothing off. `g` shows it whole in these words: each session by its title, each task by its label and id, what it waits on, and the hand-offs waiting; a model asking gets the graph as data too, every id whole. |
| Hosted, Joined here | `hosted.*` | Below. |

Saving this session under a name and saving this conversation as a file are controls of This conversation ("Save this session under a name", "Save or export this conversation as a file"). The Agent's file of this conversation is Markdown or text only, and it uploads nothing and keeps no branches.

Until 3.5.0 each program kept its own task graph in the project (`.goodvibes/tui/sessions/task-graph.json`, `.goodvibes/agent/sessions/task-graph.json`). At the first start of this version in a project both are carried into the shared file once, nothing dropped; the old files are left as they were, so a 3.5.0 binary still reads its own graph as it was at the upgrade (not the changes made since).

The GitHub credential for `upload` is found in this order:

1. the `github` entry of the named API services (`~/.goodvibes/tui/services.json`, see "Named API services"), when its auth headers contain `Authorization: Bearer <token>` or `Authorization: token <token>`; no other header is taken as the token;
2. the environment variable `GITHUB_TOKEN`.

The token needs the `gist` scope. It is sent only to `https://api.github.com/gists` in one `POST` whose body holds the description (`GoodVibes session: <title>`, or `GoodVibes session export` for an untitled session), `"public": false`, and the file under its file name.

A successful export prints one line with hints:

```text
Sessions, u on this conversation, As: A web page
Exported HTML session to /home/me/goodvibes-exports/session-2026-11-18T17-40-02.html  (redacted before upload)  Share link: https://gist.github.com/<user>/<id>  Upload receipt: /home/me/goodvibes-exports/session-2026-11-18T17-40-02.html.gist-<uuid>.json
```

The hint is `(sensitive data redacted)` or `(not redacted)` for a local export, and `(redacted before upload)` or `(uploaded unredacted, as stored)` for an upload that returned a share link. An upload that did not happen adds `(not uploaded)`, and one GitHub did not confirm adds `(upload unconfirmed)`, each followed by the local file's redaction hint. With `--then copy` the line ends `(path copied to clipboard)`, or `(could not copy the path)` when the copy failed.
Every upload attempt writes a receipt file `<export path>.gist-<uuid>.json` (mode 600) with `version`, `sessionId`, `exportedPath`, `recordedAt` and either `status: "accepted"` with `url`, or `status: "unconfirmed"`. When the receipt cannot be written, a notice (System place, Notices; `Ctrl+N`) records the outcome instead.

Failure cases:

| Situation | What is printed | Next step |
| --- | --- | --- |
| Empty conversation | `Nothing to export: conversation is empty.` | |
| No token | `No GitHub token found for --upload.` followed by how to add a `github` service entry or set `GITHUB_TOKEN` (a PAT with the `gist` scope). The local export is kept. | Add the token, then upload again (`u` in Sessions). |
| The `github` service entry cannot be read and no `GITHUB_TOKEN` | `Upload not attempted: the github service entry could not be read (<reason>) and GITHUB_TOKEN is not set. Local export saved at <path>.` | Fix `services.json` or set `GITHUB_TOKEN`. |
| GitHub answered with an error, or a network error | `Upload unconfirmed: GitHub API error <status>: <body>. GitHub may have received it; check before retrying.` (or `Network error: ...`) | Check your Gists before retrying. |
| The upload threw | `Upload failed: the Gist upload did not complete (<reason>). Local export saved at <path>.` | Retry. |


Daemon-hosted sessions, whose conversation loop runs in the daemon so it continues without a terminal, have no slash command: every act is a control. In the Sessions place, Hosted lists the daemon's hosted sessions (read again by itself when one starts, is joined, left or ends): `h` starts one and this terminal joins it (one press: the daemon starts it as your request, then this terminal follows it live; without a choice it keeps running or ends as `hostedSessions.detachPolicy` says), `Enter` joins the selected one, `x` ends it for good (it asks first: it cannot be undone). Joined here shows the session this terminal joined, with `t` (send a message now: with a turn running it goes into that turn at its next step, after the tools running finish or are stopped; with none running it starts a turn), `k` (stop the tool that is running, shown only while the session runs one, which its row names: "running read"; the call comes back to the model as stopped and the turn goes on at once, even when the tool does not let go: its work is abandoned) and `l` (leave: the session keeps running or ends as its setting says). "Send a message after this turn" is a control on This conversation, listed only while a hosted session is joined. In the Agent, `h` starts a session that answers as the Agent (the press goes with this machine's own daemon credential, so the daemon starts an Agent session for it); the Agent joins none.
A line typed in Your agents for the hosted session is sent only to the session that was joined when you started typing it; if another session was joined meanwhile it is not sent (`the message was for session <id>; attach to it again to apply it there`) and the draft stays.
A session joined here belongs to the daemon it was joined on. After `daemon.connectedHost.url` points elsewhere, sending, queueing, stopping a tool and ending that session are refused naming both daemons, and leaving it releases it on the daemon that holds it.
With nothing joined: `No hosted session is joined in this terminal, so nothing was queued.` with `The Sessions place lists them under Hosted; join one there first.` Hosted sessions are described under "Hosted sessions" in the daemon part.

On the Runners tab of the Work place, "save runners" (`S`), "look in a runner bundle" (`L`) and "bring in runners" (`I`) save, inspect or bring in a bundle of the daemon's runners (runner pools, contracts, artifacts, never the conversation); bringing one in replaces anything the daemon holds with the same ids (what it replaces is not kept; save runners first to keep a copy).

Recorded runs, a tab of the Work place (terminal app only), steps through recorded runs: every turn is recorded as a run. `Enter` on a recorded run loads it, and on the loaded one says where you are; `l` steps forward, `j` jumps to an event (0 is the start), `c` on another run compares it with the loaded one event by event, `e` writes the report as JSON, and `L` lists them all. A step that needs a loaded run without one is refused: `No run loaded. Load one first: Enter on it in Recorded runs, in the Work place.`

### Undo, rewind and checkpoints

The terminal app records a checkpoint of the workspace files at each turn and each helper-agent run, in any workspace.
`/checkpoint` holds them, described once for both programs. Bare, it opens its actions with "See your checkpoints" first (`list`, with how many are kept on the right; a model or a script running it bare gets the list):

| Action | Line | What it does |
| --- | --- | --- |
| See your checkpoints | `/checkpoint list` | Lists them, newest first, numbered from 1, with kind (`turn`, `agent-run` or `manual`), label, age and size. With none: `No checkpoints yet. Turns and agent runs take one by themselves; /checkpoint make takes one now.` |
| Make a checkpoint now | `/checkpoint make [<name>]` | Keeps the files as they are, held longer than the automatic ones: `Checkpoint <id> "<name>" made; it is kept longer than the automatic ones.` With no change since the last one: `Nothing has changed since the last checkpoint, so none was made.` |
| Put the files back to a checkpoint | `/checkpoint restore <n\|id>` | Files only, at once; the state before is kept as a checkpoint that brings it back (below). |
| Go back to an earlier turn | `/checkpoint rewind <n\|turn> [files\|conversation\|both]` | Files, conversation or both (the default) go back to the end of that turn, at once; `/undo rewind` takes it back (below). |

`/checkpoint rewind` without a turn lists the turns completed in this run of the app, newest first (a resumed session restores its turn list: `Rewind: restored N turn anchor(s)`). A turn whose rewind point could not be saved is not offered; both programs say so once per run of failures: `[Warning] A rewind point for this turn could not be saved (<cause>). /checkpoint rewind will not offer this turn; later turns are still recorded when saving works again.` `files` restores workspace files, `conversation` removes the later messages, `both` does both.
Typed by you, it reads the plan and applies it at once (the files are first kept in a safety checkpoint), and the `[Rewind]` receipt says what went back; it cannot be undone once new messages are added; until then `/undo rewind` takes it back. Run by the model, it is shown in the Changes view first (`Previewing going back to turn "<label>" (<scope>: ...). Enter or y goes back, n or Esc cancels.`) and applies exactly the plan shown: the plan carries a single-use token, and a conversation that changed after the preview is refused (`Nothing changed: <reason>.`); cancelling prints `Nothing changed: you chose not to go back.`
It refuses while a turn is running, and when no turn has completed in this run (`No completed turns are recorded for this conversation yet, so there is nothing to go back to.` with `/checkpoint restore` named instead).
`/undo rewind` reverses the last `/checkpoint rewind`; `/redo rewind` applies it again. Each replaces the whole conversation, so each refuses, changing nothing, when messages were added since (`/undo rewind` since the rewind, `/redo rewind` since the undo), naming how many; typed by you they restore the files at once (after a safety checkpoint), run by the model they show the files first and check again after the answer; both report when the restored conversation could not be saved.

### Restoring a checkpoint

`/checkpoint restore <n|id>` restores the files of one checkpoint at any time: `<n>` is its number in `/checkpoint list`, or give its id or an unambiguous id prefix; the guided path lists them.
Typed by you, it restores at once. Run by the model, it previews the files the restore would change in Changes first; `Enter` or `y` restores, `n` or `Esc` cancels (`Restore cancelled: nothing changed.`).
Only files are restored; the conversation is unchanged. The current files are first kept in a safety checkpoint (`pre-restore safety (before <id>)`). The receipt is `[Checkpoint] Restored "<label>" (<id>). Files only: the conversation is unchanged. The state before this is kept as "pre-restore safety (before <id>)" (<safety id>): /checkpoint restore <safety id> brings it back.`
Refusals: `No checkpoint #9. Run /checkpoint list to list checkpoints (1–N).`, `Checkpoint ref "8e" is ambiguous (2 matches). Use the list number instead.`, `Unknown checkpoint ref "x". Run /checkpoint list to list checkpoints.`, and the busy refusal while a turn runs; a partial restore names the paths that failed.

(The daemon's operator API also has `checkpoints.restorePreview` and `checkpoints.restore`; the API part describes them.)

### Undoing file changes and turns

`/undo [turn|file|set-aside|rewind]` and `/redo [turn|file|set-aside|rewind]` take back, or bring back, one step of the kind named; bare, they act on the last turn:

| Form | Effect | Output |
| --- | --- | --- |
| `/undo` | Remove the last conversation turn. Refused while a turn runs: `A turn is still running, so /undo did nothing.` | `Last turn undone; /redo brings it back.`, or `There is nothing to undo.` with `To take back the last file write or edit: /undo file` |
| `/undo file` | Revert every file the most recent not-yet-undone `write` or `edit` call changed. | `File reverted (last edit call):` or `N files reverted (last write call):` with the paths, then `Use /redo file to re-apply.`; with nothing recorded: `Nothing to undo. No file operations recorded.` |
| `/undo rewind` | Reverse the last `/checkpoint rewind`. | The rewind's result. |
| `/redo` | Restore the last undone turn. Refused while a turn runs. | `Turn restored.`, or `There is nothing to redo.` |
| `/redo file` | Re-apply the most recently reverted file change. | `File re-applied (<tool> call):` with the paths, or `Nothing to redo.` |
| `/redo rewind` | Re-apply the last undone `/checkpoint rewind`. | |

`/undo file` and `/redo file` work on a stack of tool calls kept in memory for this run of the app (up to 50 entries; changes from earlier runs cannot be undone this way, and changes made by `exec` commands are not recorded).
Each `/undo file` steps one call further back: to undo the last three edit calls, run `/undo file` three times.
The Agent has the same `/undo` and `/redo` (its `rewind` is refused: the Agent does not go back to a turn) and the same `/checkpoint list` and `/checkpoint restore`.
When a file was changed after that call (by you, another tool or another program), nothing is changed and the entry is kept: `File undo failed: Cannot undo the change to <path>: the file was changed after that operation (by you, another tool or another program). No file was changed and the history entry is kept: put the file back as that operation left it and undo again, or set the entry aside (/undo set-aside) to reach the one before it.` `/undo set-aside` (and `/redo set-aside`) sets the newest entry aside without changing any file: `Dropped the newest undo entry (<tool> call) without changing any file:` with its paths, then `The next /undo file acts on the one before it.`; with none, `Nothing to drop: no undo entries are recorded.`
`/undo file`, `/redo file`, `/undo rewind` and `/redo rewind` do not wait for a running turn; use them between turns.

### Models, providers and sign-in

`/model` is described once for both programs. Bare, it opens the full model picker (`choose`, "Choose a model"): the Recommended short list first where the catalog has one, each model with its price tier, and a tab for each job a model does (a model or a script running it bare gets the report "See your model and the others you can use", `list`). Its other actions are typed: `use <model>` ("Switch this conversation's model"), `refresh` ("Read the list of models again"), `backup <model>` and `drop-backup <model>`.
`/model use openai:gpt-5.4` ("Switch this conversation's model") switches this conversation's model only (the shared default every program starts with is "make it the default" in Models and providers) and prints `Now using <model> (<provider>).` and, when the requested reasoning level does not exist on that model, the level used instead.
When the provider is not signed in, the terminal app asks for its API key on a hidden line before the switch lands.
An unknown id is refused with the provider registry's reason. `/model use` alone opens the full model picker, as bare `/model` does.
`/model refresh` asks every provider you have set up for its models again (past any list kept on disk), then refreshes the catalog, the benchmarks and the token limits, asks the daemon to read its own lists again (`models.refresh`; the lists the web app and every other program show), and prints one line per provider: how many models it has, or why its list could not be read (`could not be read, its server is not running`, `could not be read (<error>); 12 models from its last list`, `0 models: it answered with an empty list`); a provider that does not list its own models says it uses the built-in catalog. With a daemon running, a note follows: `The daemon read its lists again too (what the web UI and the other programs show): <n> providers answered` (and `; could not read <provider> (<error>)`). In the model picker, `Ctrl+R` runs `/model refresh`. A part that failed makes the refresh a refusal naming it, after the rest was printed.
The model picker (its key, or a failed turn's `alt+o`) opens on Main chat, with the other things a model is chosen for behind one tab, `Other jobs (optional) ▸`: Side work, Tool work, Spoken replies, Decision model and Search index (see "Routing roles" below). `Tab` (or a click on that tab) moves to them; then each is listed, marked `(off)` when it is off, and a line under the tabs says what the chosen one does and, when none is chosen for it, that it uses the Main chat model. In the Agent the search index is not a tab, and that line says where it is set (`/settings open provider.embeddingProvider`). Under the search field a row names each filter key with what it is set to: `ctrl+t price: any  ctrl+k needs: any  ctrl+a all models  ctrl+b sort: off  ctrl+g g by: provider` (`ctrl+a usable only` while it hides models you cannot use; on a narrow screen it takes two rows; the grouping key is the rebindable `model-picker-group`, the leader then `g`, and the row names it as bound). Each model row shows its price tier beside its context (`free` in green, `paid`, `subscription`) when it is known, and the detail names it (`Price`) and how long ago the provider's model list was read (`List  list read 3 h ago`). A model tab lists only models the model catalog says read and write text (its published type and input and output modalities); an image, video or speech model is not offered. A model the catalog does not describe (a local or custom model, say) is listed after the described ones in a group titled `Not described by the catalog`, each marked `not in the catalog`; its detail reads `Not described by the model catalog; usable as a text model, listed after the described ones.` An open picker shows a fresh list as soon as the providers' lists change (the daemon reads every provider's list when it starts); `ctrl+r` reads them again now; pinned and recent models still come first. After them, a `Recommended` group lists at most five models from connected providers, each with why, in catalog facts only: `newest <family>` (the latest release date in a family the catalog names), `largest context: <n> tokens`, `lowest price: $<in> in, $<out> out per 1M tokens`, compared among one provider's models; a provider the catalog gives none of these facts for has none, and a benchmark sort lists no group. The Agent's picker shows the same group.

How hard the model thinks is two controls in This conversation, the same in both programs: "See how hard the model thinks" and "Choose how hard the model thinks" (its form lists the levels the current model offers).
Choosing `high` saves `provider.reasoningEffort` and says the level in effect.
A level the model does not offer is refused: `<Model> does not offer reasoning effort 'xhigh'; nothing was changed.` followed by `Levels it offers: ...`.
A model with no configurable reasoning refuses with the reason it has none.

What fills the model's context is a set of controls in This conversation, in both programs: "See what fills the context" breaks the context use down per message; in the Agent, "See the project instruction files" lists the project instruction files read into each turn and "See what the last turns were given" shows what the last turns were given (memories, personas, skills, routines).
The context window size is the daemon's, one for every program: "See the context window size" shows the window of the model this conversation uses (what its maker says, any size you set, any limit learned from the provider); "Set the context window size" (a size such as `200000`, `200k` or `1m`) sets it, and "Go back to the automatic window size" clears it and any learned limit. The change reaches the next turn of every running program, without a restart: `The context window for <model> is now 200,000 tokens (it was 1,000,000 tokens), in every program from its next turn.` The model, a script and an outside agent reach the same three as `context.window`, `context.set-window` and `context.clear-window` (a model's call acts on its conversation's model; another caller names one with `model`, else the daemon's default model is meant). A size chosen in the model picker is kept the same way.

Models and providers, in the menu (`Ctrl+G` then `m`) in both programs, is one place for where your models come from and how you are signed in to them; no slash command carries it (`/model` still opens the model picker for this conversation). Everything it lists is the daemon's, one copy for every program, and read by itself: a pin, a sign-in or a routing change made in the other program, the web app or a script shows with no key pressed. Its tabs:
- Models: every model you can use, the default and each backup marked, and "pinned" on the pinned ones. `u` makes the selected model the default (every conversation that has not chosen its own model uses it from its next message, in every program; a conversation chooses its own in its model picker), `f` pins it at the top of the model picker or unpins it, `b` adds it as a backup tried when a turn fails on the default, or drops the backup, and `o` sends every request to it ("Send every request to one model"; choosing a way on the Routing tab lets it go).
- Providers: each provider and how it is reached. `u` uses its first model by default; `s` starts a subscription sign-in and shows the address to open in a browser, and `f` finishes a sign-in waiting for its code with the code or the address the page sent you to (asked on a hidden line, never kept in the input history): `Signed in to openai with a subscription (...)`; `o` signs out (`Signed out of openai. An API key you set for it is used again.`); `v` shows the sign-in, `j` its settings and `i` how to fix it; `k` stores the provider's key; `x` removes a provider of your own, for good (adding it again puts it back); `a` shows its account, `w` each way it can be reached and why one is used, `h` what is wrong and the steps that fix it. A sign-in started here or in the web app is kept on the daemon's machine.
- Routing: Enter on "Only the model you chose", "Your model, moving on when a provider fails" or "The best provider for each request" routes every program's requests that way from the next one; `e` says why requests go where they go, `t` where a failed request would go (nothing is sent).
- Services: the API services your stored keys are sent to (see "Named API services").
- Comparisons: your blind model comparisons (see "Documents, artifacts, comparisons and research").
- Media: the media providers and whether each is set up.
- Move: your subscription sign-ins with their tokens, saved to a file (`e`; it loosens a protection, so only your own key or form runs it, and an existing file is kept unless you choose to replace it), checked (`c`: what a file holds and what loading it would add or replace) or loaded (`l`; a replaced sign-in cannot be recovered: sign in again to put it back); a summary of your sign-ins with no secret or token, for a support thread (`e` saves it readable by you only, `c` reads one); and your services list (`e` saves it, `l` replaces it from a file).
Anywhere in the place, `n` adds a provider of your own (a name and an address such as `http://192.168.1.20:1234/v1`, whose `/models` list is read, and a key kept in your secret store when you give one), `g` reads the model lists again, and `m` finds model servers on this computer (see "Local model servers").
A provider without subscription sign-in is refused: `<provider> has no subscription sign-in, stored or available.`
The model, a script (`goodvibes do <capability>`, `goodvibes find "<what you need>"`) and an outside agent reach the same acts as capabilities: `model.list`, `model.use`, `model.refresh`, `model.backup`, `model.drop-backup`, `pin.list`, `pin.add`, `pin.remove`, `provider.list`, `provider.use`, `provider.sign-in`, `provider.finish`, `provider.sign-out`, `provider.show`, `provider.add`, `provider.remove`, `provider.route`, `provider.pin-route`, `provider.explain`, `provider.fallback`, `provider.export`, `provider.inspect`, `provider.import`, `accounts.review`, `accounts.show`, `accounts.routes`, `accounts.repair`, `auth.review`, `auth.show`, `auth.repair`, `auth.export`, `auth.inspect`, `media.providers` and `models.scan`. One that loosens a protection (saving sign-ins with their tokens, loading them) is put to you in every mode.

Model comparisons are the Comparisons tab of Models and providers, in both programs, run by the daemon on its providers and kept in its artifact store; a comparison works in no project folder, so no folder-trust question comes before it and a restricted folder does not stop it. `c` ("Compare models on a prompt") sends one prompt to two to four models with their names hidden and keeps the answers to judge (`Sent to 2 models with their names hidden (kept with your comparisons): "..."`, each answer under `Answer A:`, `Answer B:`); `b` gives the models on this machine the standard task. Each row is named by its prompt and says what it is (answers to judge, judgment, model decision, report, reviewer handoff, handoff ZIP). `v` reads it, `j` judges which answer won and why (`answer A won, written by rt-1` when the names are shown), `a` switches to the winner (`The default model is now rtfake:rt-1 (it was ...): every conversation that has not chosen its own model uses it from its next message, in every program. The decision is kept with your comparisons.`), `k` keeps the default model and records why, `e` saves a report, a reviewer handoff or a ZIP of a handoff, `w` counts which models win, `d` compares two reviewer handoffs. The capabilities are `compare.run`, `compare.benchmark`, `compare.review`, `compare.judge`, `compare.apply`, `compare.record-decision`, `compare.export`, `compare.diff-handoffs` and `compare.analytics`; a model may run them, and the two that spend money (`compare.run`, `compare.benchmark`) are decided as spending money under your permission mode (in Ask me they wait for you in Waiting for you). A model that runs them reads the ids and next steps it needs; you read the answers in words.

The model, its reasoning effort and the permission mode each have one default, held by the daemon for every program: changing the default in one program shows in the other at once, with no restart. A conversation changes its own (its model picker, "Choose how hard the model thinks" in This conversation, `Shift+Tab`) without touching the default. The picker names each job's current model beside its tab (`Main chat: rt-1`); an empty model list reads again by itself and says when it was read and why it is empty.

Signing this terminal app in to another GoodVibes daemon or a listener with a user name and password is in Devices and network, beside pairing: `i` ("Sign in to a daemon or listener") asks for the service, its address, the user name and the password (on a hidden line), then asks "Sign in to a daemon or listener?" with the sentence `Your password for admin will be sent to https://host.example:3421 to sign in to the daemon; the session it gives is kept by this program until you change it (signing out ends it).` (it sends something outside this machine); `o` ("Sign out of a daemon or listener") ends a session. A listener session may be kept under another name. The Agent keeps no daemon or listener session (the host it connects to manages its own sign-in) and does not offer these.
`http://` to another machine is refused because the credential would travel unencrypted: `Not signed in: <host> is another machine and http:// would send the credential unencrypted. Use https://<host>. Nothing was sent.`
A refused sign-in says `Not signed in: the daemon answered HTTP <status>. Check the address, user name and password, then try again. Nothing was stored.`
A sign-in that answers with a redirect is not followed: `Not signed in: <origin> answered with a redirect to <origin>, and the password is sent only to the address you typed.`
A listener session is stored with the address that issued it; signing out of a listener sends it only to that address, and for any other address refuses with `The listener session stored as <key> was issued by <origin>; it is never sent to <address>. Nothing was sent or removed.`

Who may sign in to this machine's daemon and web app is the daemon's (the `local_auth.*` methods), chosen on the Sign-in and Signed in tabs of Permissions and safety (in the menu, `Ctrl+G` then `m`) in both programs; no slash command carries it. Sign-in lists the users and their roles: `n` lets someone sign in, `p` changes a user's password, `x` stops a user signing in (the user is removed for good; adding makes a new one). Signed in lists the open sessions: `x` signs one out. Removing the first-run sign-in file is in System. A password is asked on a hidden line, twice. The role defaults to `user`; `admin` loosens a protection, so a model cannot choose it. The capabilities are `local-auth.review`, `local-auth.add`, `local-auth.remove`, `local-auth.password` and `local-auth.sign-out`; `goodvibes auth` on the command line calls the same daemon methods (it starts an installed daemon that is stopped first, and never writes the user file itself).

Secrets are the daemon's, kept and changed on the Secrets tab of Permissions and safety in both programs; no slash command carries them. The tab lists every stored secret by name and where it is kept, never a value: `n` stores one (the value on a hidden line; this project or all your projects, encrypted by default, plain text loosens a protection), `l` points one at a password manager (a `goodvibes://secrets/...` address), `c` checks one is stored, `e` tests a reference, `h` shows where secrets can come from, `k` how they are kept, `t` on a secret of this project's own store that waits for you uses it (it loosens a protection, so it is asked and a model cannot run it), and `x` deletes one for good (asked first). "Use a secret for this session only" (`u` on This conversation) keeps a value as an environment variable for this session only: `$<NAME> is set for this session only.` The capabilities are `secrets.list`, `set`, `link`, `get`, `test`, `providers`, `storage`, `trust`, `delete` and `use`.
In the Agent a credential the daemon reads is filed in the daemon's tier whatever scope is asked, and storing it says so.

While a value is asked for with masked input (the same in both programs), the composer shows a bullet per character and holds the value apart from the prompt: typing, a terminal paste, the paste key (`Ctrl+V`), the cursor keys, `Home`, `End`, `Backspace` and `Delete` edit it, `Enter` hands it over, `Esc` or `Ctrl+C` cancels; undo, redo, the kill ring, history search, the command line and the other editor shortcuts are not offered, so the value never reaches them. A command line that carries a credential is kept in the input history with `<redacted>` in its place: `/settings set` for a credential key (in either program). The line a guided action shows ("This will run", "The command for this is") leaves a secret out, so typing it back asks for the secret on a hidden line.

Tokens, cost and the spending alert are in Money, Spending (the menu, `Ctrl+G` then `m`): this conversation's usage at the top, `w` sets the spending alert (a dollar amount; `0` turns it off), one setting the daemon keeps for every program, and each program warns at the end of an answer once a conversation's cost passes it, while the daemon says once, through your notification addresses, when what its own runs (schedules, work, web chat, shared sessions) cost in the last 24 hours passes it; `b` shows what the daemon spent over the last 24 hours or 7 days, split by what it was for, agent, model and provider. `p` sets your own price for a model (US dollars per million tokens in and out), kept by the daemon for every program and for what it records: on the conversation's row for the model in use, on a daemon row for a model with no price. A script reaches the same as `goodvibes do usage.alert --input usd=5`, `goodvibes do usage.price --input model=openrouter:deepseek/deepseek-chat --input input=0.27 --input output=1.10` and `goodvibes do usage.by-source`.
`/status` prints the session status: model, tools, token totals and cost, context use, surfaces and safety states. It takes no words.

### Settings and configuration

`/settings open [where]` opens the settings screen, the same in both programs. On the left are the seven topics the web UI shows, in its order: General, Account, Models and providers, Voice, Notifications, Memory, Permissions. A topic lists its settings section by section: each row is the setting's name with its value in words (`On`/`Off`, a choice's own words such as `Jev decides` or `Medium`, a number with the unit its name gives, `Not set`), one line per setting (the key is not shown; search still finds a setting by it). A few rows open a list instead of holding a value: `Tool servers (MCP)` under Permissions, `Provider sign-ins` under Models and providers, `Mail and calendar` under Account (terminal app) and `Features` under General (Agent); `←` or `Esc` comes back from one. Under the rows, the selected one is explained in a few sentences: what it does, when a change takes effect (where the setting says), the default in words, and where the value comes from when it is not the default (this program's settings file, the daemon's settings, the project's settings, the settings both programs share, the environment, managed or synced settings); a daemon-owned value the daemon has not given reads `Unknown`, with why. Typing searches every setting by name, key and description and lists the matches in the same one-line rows with a count; `tab` goes back to browsing by topic. Keys: `↑↓` move, `→`/`←` between the topics and their rows, `Enter` changes the selected setting (turns it on or off, moves a choice to the next one, opens a picker for a model, theme, voice or permission mode, or edits a number, text, list or secret in place; a secret is hidden as it is typed and kept in the secret store), `Shift+←→` nudges a number or a choice, `Ctrl+R` resets (`reset to <default>`; in the terminal app it asks whether to reset the setting, its topic or every setting, and a topic or every setting asks before it does), `PgUp`/`PgDn` page a long explanation. `where` is a topic, a section, a setting's key or name, or words to search for; `/settings open permissions.mode` opens Permissions on that setting. Bare `/settings` shows its actions; choosing `Open settings` opens the screen at once, at the first topic, with no form.

`/settings set <key> <value>` sets one key directly; the value is hidden as it is typed and in the input history, since a setting may hold a credential, and a credential key goes to the secret store with only its reference in the setting. A model cannot run `/settings set`:

```text
/settings set display.themeMode light
Set display.themeMode: "auto" → "light"
Theme mode: light (applied now).
```

A change to `display.theme` or `display.themeMode` applies at once in both programs, whoever makes it (the settings screen, `/settings set`, a pull on the Settings sync tab, an edit of the settings file); `auto` applies at once when the terminal reported its background at start-up, otherwise at the next launch.

`/settings set` with a missing value asks for it; where nothing can be asked (a script) it is refused naming the blank.
A value the daemon refuses for a daemon-owned key prints `Not set: the daemon refused <key>, and nothing was changed: <reason>`.
An invalid value prints `Could not set <key>: <reason>`.

Presets (saved sets of display, model and behaviour settings) are the Presets tab of Tools and extensions in the menu (Ctrl+G, then m): Enter loads the selected one, and there you save your settings as one, delete one, save one as a managed bundle, save them all to a file (an existing file is kept unless you choose to write over it), check a presets file, and add presets from a file (a file that is not a presets file is refused and nothing changes; a name already taken is refused unless you choose to replace yours or give a name prefix). The daemon keeps them, in the asking program's own folder (`~/.goodvibes/tui/profiles` for the terminal app), and loading one sets that program's own settings; a setting in it that would loosen a protection is held back and shown with its value now and in the preset, and is loaded only when you choose "Load them too" (asked on its own, opening on No). Each is a capability (`presets.list`, `presets.load`, `presets.save`, `presets.delete`, `presets.export`, `presets.inspect`, `presets.import`).
Settings sync bundles are the Settings sync tab of **Devices and network** (the menu, `Ctrl+G` then `m`), the same in both programs and run by the daemon: on "Your settings", `v` where they come from, `e` save them to a file, `i` look inside a file, `P` pull a file (your own act: a model's or another caller's pull is put to you), `w` one setting and `f` the recent failures; each setting that disagrees after a pull is a row of its own, with `k` settle it (keep this machine's value or the synced one) and `w` where its value comes from. A bundle holds the daemon's settings and the asking program's, each part labelled with whose it is; pulling applies each part to its owner, only the values that differ, and holds back each value that would loosen a protection (shown with its value now and in the file; taken only when you choose "Take them too", asked on its own, opening on No; settling a disagreeing setting to the pulled value is held back the same way), keeps each owner's settings file as it was beside it (`<file>.before-pull-<time>`) and says what was applied, changed and left (another program's part is left for that program). A bundle saved by 3.5.0 (one settings object) is split by who owns each key. Long answers (where they come from, the failures) open whole in the place's result pane. The capabilities are `settings-sync.review`, `.show`, `.conflicts`, `.resolve`, `.failures`, `.export`, `.inspect` and `.pull`. The staged bundle, rollbacks and locks are in Managed settings, below.
Managed settings (settings an administrator sets for a machine) are the Managed settings tab of Tools and extensions in the menu: the staged bundle (see its changes, apply it), each setting locked as managed (unlock it) and each apply you can roll back (roll it back), and on the tab: stage a bundle, apply a bundle (only these settings, if you name them), look inside a bundle, lock a setting, and see the applies so far. The daemon makes each change on the asking program's own settings (its settings file and the control-plane file beside it), the files that program reads. Applying and unlocking are marked `loosens a protection`, ask you first, and a model cannot run them; a bundle that changes a setting that touches security names those settings with the result, and what is applied is exactly what was read: applying a bundle stages the bundle it read once and applies that stage, applying the staged bundle applies the stage shown; a different stage put there since by another window or process is refused and nothing is applied. A lock is kept in the `settings-sync.json` beside a settings file: the daemon's folder (`~/.goodvibes/daemon/`, beside its settings, where an administrator can put one), its client folder (`~/.goodvibes/daemon-host/`), or a program's folder (`~/.goodvibes/tui/`, `~/.goodvibes/agent/`, where that program's "lock a setting" and applies record it, as 3.5.0 did). A lock in any of them holds for that setting everywhere: the daemon's settings, each program's own, the project's settings file and the shared file, through every door (Settings, a setup form's Save, `settings.set` and `settings.reset`, the daemon's `config.set`, `config.setMany`, `config.reset` and `POST /config`, the model's settings tool, an import or a sync pull of a file that would change it, refused whole (the daemon reads the file once before anything is asked, and what you are asked about is what then runs), settling a disagreeing setting, the machine group's replication, which leaves it pending on that machine, a capability's own write and a start-up carry, which keeps the value the lock holds). The write is refused before anything is asked, with `<key> is locked as managed by <who> (<why>)[, at <value>], so it was not changed. Only the owner removes the lock: Tools and extensions, Managed settings, unlock (it is kept in <file>).` (403 `CONFIG_MANAGED` at the daemon). Managed settings lists every lock that holds, wherever it is kept; unlocking removes the setting's lock from every file that keeps it; a full reset of settings is refused while any setting is locked. Applying a bundle or rolling one back refuses a setting locked by a lock another folder keeps. Rolling back releases the apply's locks, so it is marked `loosens a protection` too: anyone but you is put to you. So that going back to 3.5.0 weakens nothing, every lock kept outside `~/.goodvibes/tui/` also has a copy there (marked `mirroredFrom`, the file it was recorded in), the one file 3.5.0 reads; copies are kept in step at the daemon's start and whenever a lock is added or removed, and this version reads each lock only where it was recorded. A 3.5.0 program value carried into the daemon's settings at the upgrade is the locked one when either program's folder locked it. Each is a capability (`managed.review`, `managed.staged`, `managed.history`, `managed.inspect`, `managed.export`, `managed.stage`, `managed.apply`, `managed.apply-staged`, `managed.rollback`, `managed.lock`, `managed.unlock`).

Setup is the Setup tab of the System place (the menu, `Ctrl+G` then `m`); there is no `/setup`. Each row is a topic (the capability `setup.<topic>`, which find and run reach too); Enter opens one form for that topic, and the form's `Save` writes only what changed on it, then checks it. The tab starts with the checklist: "Who decides" (first run's step), then the things most people set once (a model; when GoodVibes asks, chosen; the sandbox; whether conversations are saved), each row saying `done` with what is set, `not done` with what is missing, or `skipped`. On one of those rows that is not done, `s` (skip for now) skips it: it leaves what the checklist counts as left; on a skipped row the same key (bring it back) brings it back. The choice is kept in the daemon's one setup record, the same in both programs; `setup.checklist` reads it for a model or a script. Then every other topic: `Provider sign-in`, `Store a password or key`, `Only this computer`, `Use it in a browser`, `Other devices`, `A daemon elsewhere`, `Receive webhooks`, `Chat apps and services`, `Use Cloudflare`, `Who can sign in here`, `Memory and context`, `Record traces`, `Automation settings`, `Paired devices and voice`, `Provider behaviour`, `Advanced switches`, `Import settings` (the Agent), `Pair with a host` and `Unpair from the host` (the Agent: Devices and network's `devices.pair` and `devices.unpair-host`) and `Run first-run again`. A topic this program does not serve is not listed; run by id, it says where it is set up. A provider of your own is "Add a provider of your own" (`n`) in Models and providers. `A daemon elsewhere` points this program at a daemon already running on another computer and opens nothing on this one: in the terminal app it holds the daemon-source choice (use the daemon on this computer, or connect to an existing one with its host, port and token, and `Connect to this daemon now`) and saving it writes only `daemon.connectedHost.url`; in the Agent it opens the settings screen at the connected-daemon address (`daemon.connectedHost.url`, and below it whether the Agent may dial it). `Only this computer`, `Use it in a browser`, `Other devices`, `Receive webhooks` and `Who can sign in here` open no form and are not capabilities of their own (nor is `Safety`, which opens the Sandbox setting tab of Permissions and safety): in both programs they open Addresses and ports of Devices and network, where each listener is turned on or off and given its address, port and encryption (Enter on a row), and `a` makes the account that signs in from a browser or another device, then retires the first-run sign-in (the first-run user, when it has another name, and its file). Each Setup row's sentence says what this program opens for it. `Chat apps and services` makes no account: when it opens the computer to the network, its row "The account that signs in" opens that same Addresses and ports (Esc comes back to the form), and its sentence says so in both programs. Esc closes a form without saving.
The setup checks are on the Health tab of the System place (its "started" row: what this setup has, `o` checks for problems, `e` its services and sign-ins, `s` saves the review as a file; there is no `/startup` command; the sandbox is on the Sandbox setting tab of Permissions and safety, the remote runners on the Runners tab of Work and agents), and the links to views on its Links tab (`l` makes a `goodvibes://` link, `g` opens one). The support folder and moving a setup to another computer are the daemon's, for either program, on the Support and transfer tab of the System place: "Support folder" `s` writes one (the setup review of the project you are in, its tool servers included, the platform facts with this program's integration helpers and links to its views, the services and hooks files and the remote runners, every literal credential masked) and `o` reads one back; "Move this setup" `s` writes the transfer file (settings, services, plugins and skills; a literal credential is left out), `o` reads one and says what bringing it in would change and replace, each security setting it holds back shown with its value now and in the file, and `m` brings one in (asked first: the files it replaces are not kept). Security settings stay as they are unless you choose to bring them in too, which loosens a protection and is asked first, opening on No (a model's call of that is put to you); the answer says what was changed, what was held back and what was left as it is. The capabilities are `startup.support-bundle`, `startup.support-bundle-inspect`, `startup.transfer-export`, `startup.transfer-inspect` and `startup.transfer-import`.
A confirmation applies exactly what it showed. When "Use a service this project defines" finds its target changed between the question and Yes (the file rewritten, the entry edited), nothing is done and the question is asked again with `Changed since you looked:` and each change on top ; a model's call is refused with `TARGET_CHANGED`. Its question names what the entry sends and to which host.
A confirmation whose text does not fit the screen scrolls (up, down, page up, page down) and says `↓ N more lines`; its confirming button stays disabled until the end has been shown. In a settings list, Enter and a two-press action act on the row drawn under the highlight: while a search is shown that is the search result, and a second press after the list refreshed onto another row asks again.
An existing target is not overwritten without `--overwrite`.
`/update` (actions `check`, `apply`, `rollback`, `daemon [--check]`, `review`, `save-review <file> [--replace]`, `read-review <file>`) checks for a newer release and, for binary installs, downloads, verifies and applies it or rolls back. Updates are described under "Updating" in the install part.
The System place's Sleep tab (in both programs) shows who holds this computer awake, and `k` there sets the daemon-held keep-awake on or off (the same as `Ctrl+G` `a` or `F6`); the model and a script reach the same act as the capabilities `power.status`, `power.on` and `power.off`. The setting, `power.keepAwake`, is the daemon's: a change goes to the daemon, or with none running into the daemon's settings file it reads at start, so every app and the daemon read the one value and a change made while the daemon was down is kept. A value an earlier version kept in an app's own settings file is moved to the daemon's settings file the first time the app starts (or dropped there when the daemon's file already sets it), and the app says so once.

Permissions and safety (the menu, `Ctrl+G` then `m`; `/permissions` typed bare opens it) gathers what protects this machine, in tabs: This conversation (the mode in force and why, the settings in force, plan mode in the terminal app, a secret for this session; `a` what needs attention, `v` the whole security review, `m` risky routes through MCP servers, each from this program's own MCP servers and plugins with the daemon's tokens, policies and folder trust), Rules, Secrets, This folder, Sign-in, Signed in, Who is who, Device tokens, Phone grants, Policy, Sandbox setting and (the terminal app's) Sandbox sessions. A long answer opens whole in the place's result pane. What needs attention names blocked or overdue paired-device tokens, policy lint findings and a failed review, MCP servers with held-back tools or allowed to run anything, risky MCP routes, held-back plugins and an undecided folder, each with where it is fixed. The capabilities are `security.report`, `security.review`, `security.attack-paths` (run by the program), and on the daemon `security.tokens`, `security.folder`, `security.trust-folder`, `security.restrict-folder`, `security.trust`, `security.save-trust`, `security.read-trust`, the policy ones (see "Managed policy bundles" in the permissions part) and the sandbox ones (see "The exec sandbox" there); no slash command carries them.

"Trust this folder" (`t` on This folder) says `This folder (<name>) is trusted. Every tool may run here, subject to your permission settings; its hooks file loads and the MCP servers its files name start.` and every program working in that folder reads the decision again at once and loads the folder's hooks and MCP servers. The terminal app and the Agent say the same words.
An untrusted folder does not load its hooks file or its project MCP servers. Restricting a trusted folder stops its loaded hooks and its project MCP servers at once, in this app and in every other GoodVibes process working in that folder: the daemon announces the change and each program reads the trust register again.

`/permissions` (`show`, `rules`, `revoke <rule>`, `never <command>`, `add <allow|deny|ask> <command|class|path|tool> <target>`), plan mode, Permissions and safety and the Waiting for you place belong to the permission system; they are described in full under "Permission modes", "Remembered rules", "Decisions Jev made: Waiting for you, Decisions", "Calls held by `just-vibes`: Waiting for you, Held calls", "The owner inbox: Waiting for you", "Plan mode", "Workspace trust" and "Managed policy bundles" in the permissions part. In short:

- Plan mode (`p` on its row of This conversation) on says `Plan mode is on: writes, commands and network calls are blocked until you turn it off (or press Shift+Tab).`; off restores the previous mode (it loosens a protection: asked first, and a model cannot run it).
- Waiting for you (the menu, Ctrl+G then m) lists what waits on the owner, each item answered with its own keys; `x` on a request for approval you raised withdraws it (sent at the revision shown, so one that moved is refused; a withdrawn request is gone, raise it again to put it back). Its Decisions tab lists what Jev decided for the owner, each changed with `k` keep, `u` undo, `n` never, `a` always or `s` ask me; its Held calls tab the calls `just-vibes` held, `y` to let one run, `n` to set it aside; its Answered tab everything already answered; its Kinds tab what each kind of approval asks about.
- `/permissions` shows the mode in force and why it differs from the saved or chosen one; `/permissions rules` lists the permission rules; `/permissions revoke <rule-id>` removes one; `/permissions add` adds one directly (a never-run rule, or an allow, deny or ask rule).

### Code work

Code and changes is the place for the project's files, in the menu (Ctrl+G then m) of both programs; in the terminal app typing `/changes` opens it too; `v` in the Changes view cycles the staged changes, the changes not staged yet and everything since the last commit. Its lists are this program's own: read when it opens, after each action, and again by themselves whenever the program takes a checkpoint (after every turn or agent run that changed files, and when one is made or restored by hand):

| List | What it shows | Its controls |
| --- | --- | --- |
| Changed files | git status of the working folder: each staged, changed, new or deleted file. Outside a repository, one row "No git repository here". | `Enter` opens the file's diff in the Changes view (terminal app), `d` counts what is not staged and opens it there, `c` commits every change (a model cannot), `v` reviews this session's changes hunk by hunk (terminal app), `i` on the no-repository row starts a repository (never done implicitly). |
| Commits | The last ten commits: message, date and short hash. | |
| Worktrees | Every worktree of the project, from the one register file both programs and the daemon read: this checkout, then each one with its state (active, paused, kept, or gone from disk while the register still has it), its branch, session or task, setup and why it is kept. | `p` pauses or resumes, `k` keeps, `s` runs its setup again (the daemon's `worktrees.setup.run`, for this program's project), `a` ties it to a session or task, `o` and `b` show the worktrees of its task or session and how to bring them back, `x` removes it (asks; the daemon's `worktrees.discard`, which commits anything uncommitted onto its kept branch first), `u` stops tracking one that is gone (asks). The Agent reads the register without changing it: it has `s`, `x`, `o` and `b`, and not `p`, `k`, `a` or `u`. |
| Code index | How the source-tree code index stands: what is indexed, how results are labelled (semantic or lexical), what was skipped, the last build and reindex (terminal app; the Agent keeps no code index). | `b` builds it: from then on the session's own file writes reindex the files they touch, whatever `storage.codeIndexEnabled` says. `k` sets that one setting, the daemon's, for every project on the machine (default off; on, a project's index is built the first time a turn there asks for code and kept current after edits, in every program and the daemon's own turns). |
| Code intelligence | What is ready (problems, symbols, hover), the language servers and their state, then each file with problems, the one with the most errors first. | On any row: `y` symbols, `o` outline, `g` where a symbol is defined, `u` its uses, `h` what it is; on a file with problems they look at that file and its first problem, on the first row a form asks for the file (and line and column). `i` installs a language server for a language or a file of it. |
| Results | The rows of the last lookup or code search. | |

Anywhere in the place: `t` runs the project's tests and `f` finds code in the index (each result labelled semantic or lexical). Every action is a capability the model and outside agents find and run too (`git.status`, `git.log`, `git.diff`, `git.init`, `git.commit`, `codebase.status`, `codebase.build`, `codebase.search`, `intelligence.review`, `intelligence.diagnostics`, `intelligence.symbols`, `intelligence.outline`, `intelligence.definition`, `intelligence.references`, `intelligence.hover`, `intelligence.install`, `code.test`, `worktree.review`, `worktree.inspect`, `worktree.attach`, `worktree.attached`, `worktree.recover`, `worktree.pause`, `worktree.resume`, `worktree.keep`, `worktree.cleanup`, `worktree.setup`, `worktree.discard`). They act on the folder of the program holding the conversation, so they run there: `capabilities.run` and `goodvibes do` refuse them in one line, except `worktree.setup` and `worktree.discard`, which the daemon runs through its methods for the project the request names (`workingDirectory`: a terminal program and `goodvibes do` send their own folder); a request that names no project is refused, never run on the daemon's own folder.

The Changes view shows this session's file changes, the working tree, the staged set or everything against `HEAD`; `v` switches between them. The session view holds only files this session's tools wrote; before the first one it is empty (`this session · no files changed yet`).
A clean tree commits nothing (`<root>: nothing to commit, the working tree is clean.`); a commit says `Committed N files in <root>: <hash> <message>`.

Running the tests runs the project's test command (the configured test gate, else the `package.json` `test` script) with its output in the conversation, and the place says what passed and failed; `Esc` stops it. The script runs with the project's package manager: the `packageManager` field, else the one lockfile present; with neither, the manager the script itself calls (`bun test` runs with bun), else the first of npm, bun, pnpm and yarn that is installed.
It prints `Running: <command> (<source>; Esc stops it)` first. It runs until the command exits or you stop it: no clock stops it.
A second run while one runs, or while a stopped run is still printing its end, says `A test run is still going, or still finishing after a stop; Esc stops it, and the tests can be run again once it has ended.`

The model's tools are the Tools tab of Tools and extensions, in both programs: each tool with what it does; `v` its contract (description and parameters), `k` checks that it keeps its contract, `K` checks every tool (`tools.list`, `tools.contract`, `tools.verify`, `tools.verify-all`). An unknown tool is refused with `No tool <name> is registered here.` Each agent's tool calls show live in Your agents (the Work place).

`w` on the same tab searches the web (`tools.web-search`, run by the daemon): the words, and how many results, then ranked results with where each came from. A failed search is refused with `Search failed: <detail>`. A search that names no provider (this one, and the `web_search` tool without `providerId`) uses the one set in `webSearch.defaultProvider`; its default, `auto`, uses the first configured of SearXNG, Brave, Exa, Firecrawl, Tavily and Perplexity, else DuckDuckGo, which needs no key. A provider named there that is not registered or has no key falls back to `auto`. `web_search.providers.list` returns `defaultProviderId`, the provider that would answer now.
Images and video are made by the daemon's media providers, the same in both programs; no slash command carries them. The providers, what each makes and whether it is set up are the Media tab of Models and providers (`media.providers`). Making one is `M` on the Tools tab of Tools and extensions (`media.make`; the form asks the description, image or video, the provider, the model and the file): the daemon asks its provider to make it (it may charge, so the model's call is put to you), keeps it with the daemon's artifacts and writes it into the asking program's project, to `generated/<words>-<time>.<ext>` or the file given inside the project (a path outside it is refused before anything is asked for). A file already at the path is never replaced. After your own press, the program you pressed it in opens the saved file in the desktop's viewer (or says no viewer is available); a model's call opens nothing. A provider a plugin registers that answers the picture itself, rather than an artifact, is saved to the file the same way and said not to be kept with your artifacts. A job the provider has not finished is reported with where to collect it: "collect a media job" in the Work place (`media.collect`; it was paid for when it was accepted). With no provider that makes it set up, the refusal names the providers that could.

Evaluations, a tab of the Work place (terminal app only), evaluates the product on real tasks. It lists the task suites run in this session with how many tasks passed and the gate's verdict, and reads again after every result. Its controls (each the capability named, which the model and a script reach too):

| Control | Capability | Effect |
| --- | --- | --- |
| `l` tasks in a suite | `eval.list` | List the tasks of the suite. |
| `s` run a suite, `Enter` run it again | `eval.run` | Run each task through `goodvibes run`, then the task's `verify.sh`. |
| `c` compare with the baseline | `eval.compare` | Compare the last results with the baseline. |
| `g` run and stop on a regression | `eval.gate` | Run the suite and fail on a failed or regressed task; it creates the baseline when none exists ("Save this run as the baseline" replaces it). |

A suite is a directory (default `.goodvibes/eval/tasks`) with one directory per task holding `task.json` (the instruction) and `verify.sh` (exits `0` on pass).
The run works in a copy of the suite. Before a task's session starts, its `verify.sh` (or the script `task.json` names in `verify`) and any files listed in `task.json` `verifyFiles` are copied out of the task directory and checked against the suite's own files by sha256; a task whose files differ, or are missing, fails without running. The verdict comes from that copy, never from the task directory the session worked in, so a session that edits `verify.sh` cannot change its result. The script runs with the task directory as its working directory, read-only inside a bubblewrap boundary, the only sandbox the product has (Linux with bubblewrap and user namespaces); on macOS, native Windows or a Linux without bubblewrap there is none, so it runs on the host with the task directory writable and the task's output begins its note with `verification was NOT isolated`, and finds its listed files under `$GOODVIBES_EVAL_VERIFY_DIR`.
Comparing without a baseline is refused: `There is no baseline at <file>.` with `Gating a suite makes one.`
`Esc` or `Ctrl-C` stops a running suite (the task's `goodvibes run` gets SIGTERM, no further task starts, and the scratch copy is removed); it says `Stopped before it finished; no result was kept.` and records nothing. Quitting the terminal stops it the same way. One suite runs at a time in a terminal; a second is refused: `Nothing was run: a task suite is already running in this terminal.` with `Press Esc to stop it, then run this again.`

Failure reports are on the Health tab of the System place, "This session's failures" (see above).

### Helper agents, tasks and orchestration

Your agents are in the Work place (`/agents` typed alone opens it on Your agents). Its tabs and keys:

- Your agents (the terminal app): `t` team modes and recipes, `s` start an agent in a team mode (`local-engineer`, `local-shell`, `remote-engineer`, `teammate`, `research`, `dream`, `review`, `verifier`, `integration`), `R` run a recipe (agents one after another, each handed the last one's report: `research-implement-review`, `remote-certification`, `triage-delegate-integrate`, `dream-then-certify`; a step whose agent fails stops the recipe and names the steps not started), `x` stop an agent and every agent it started, `X` stop its group; both stop for good. The tab lists the agents running now.
- Archetypes (the terminal app): Enter shows one, `s` starts an agent from it, `l` lists them all with any problems.
- Coding agents: the third-party coding agents found on `PATH` (Claude Code, Codex, opencode); Enter hosts one as a row in Your agents, `l` lists them. With none installed: `No third-party coding agents found. Install Claude Code, Codex or opencode on PATH to host one.`
- A task the model hands over (its `agent` tool, with a decision model set; a team's or a recipe's agents) runs on the daemon as a piece of work for this project, tied to the conversation that asked (`work.delegate`): it shows in Work, its row in Your agents follows it, and its result comes back to the conversation. It runs on when the program closes; its result then waits in Work. A task handed over outside any plan (no decision model) runs here as before.
- Handed off: every hand-off of coding work to the terminal app, with its progress and answer; `h` hands work on (the Agent and the web UI), Enter shows where one stands. They are the daemon's (`agents.hand-off`, `agents.handed-off`).
Runtime tasks (this program's and the daemon's) are the Work place's Tasks here and Daemon tasks lists, in both programs: see one and what it produced, add a task, start, change, mark done or failed, pause, resume, cancel (stops it; run again starts it again) and run again; the background commands of this program. A daemon task takes only cancel and run again; the Agent only reads tasks and refuses a change with the reason. The model and a script reach them as `work.tasks`, `work.task`, `work.task-output`, `work.processes`, `work.task-add`, `work.task-start`, `work.task-change`, `work.task-done`, `work.task-failed`, `work.task-pause`, `work.task-resume`, `work.task-cancel` and `work.task-retry`.

- `s` on Your agents with the mode `research` and "map the auth flow" starts a research agent on that task.
- `R` on Your agents with `research-implement-review` and "add rate limiting" runs the recipe's steps in order; the conversation gets a line per step: `Recipe research-implement-review, step 1 of 4 (research): agent <id> (researcher) started.`

The git worktrees helper agents work in are the Worktrees list of Code and changes (see "Helper agents and worktrees").

Work is described under "Contracts and work" below.

Self-hosted remote runners are the daemon's: it starts them, keeps their pools, contracts and what they hand back (`~/.goodvibes/daemon/remote-runners.json`), and a runner goes on when the window that started it closes. Three tabs of the Work place show them, read again on every change made anywhere: Runners (`d` start a runner, `D` start from a pool, `Enter` its contract, `v` supervisor, `k` what it can do, `h` how to recover a struggling one, `o` its connection, `x` stop, which stops it for good, `e` save its work, `a` put in a pool, `u`/`U` setup and save it, `E`/`w` the environment and save it, `b`/`B` start-up bundle and look in one, `S`/`L`/`I` save, look in and bring in runners), Runner pools (`m` make a pool, `Enter` see it, `d` start a runner here, `a` add a runner, `u` take one out) and Handed back (`Enter` review, `e` save to a file, `g` run its task here, `i` bring one in). Each is the `remote.*` capability of the same name, which the model and a script reach too.

- Starting a runner starts an ACP subagent (the command `goodvibes acp`, or `ACP_AGENT_CMD` set for the daemon) as a remote runner in the project folder of the program that asked; a full pool is refused with what to remove.
- Review shows the runner's result; "run its task here" runs it locally at once, with only the tools it recorded.
- Starting a runner, when a model calls it, is put to the owner, opening on No, and runs on the owner's yes; a runner's every permission ask goes through the daemon's gate under your mode.

"Environment" on the Runners tab shows the shell lines (including `ACP_AGENT_CMD`) a remote machine needs.
Release readiness is the System place's Release tab (terminal app only): the row shows the readiness of this project from this session; `l` shows the release checklist, `s` saves the evidence to a file (write over an existing one only when chosen), `o` reads saved evidence. A model or a script runs the same as `release.review`, `release.checklist`, `release.save` and `release.read`.
`H` on the Tools tab of Tools and extensions (terminal app) lists the local helper interfaces remote clients can use (`tools.helpers`); `L` there saves every view's `goodvibes://open/...` link to a file in the project (`deeplink.export`).

### Memory and knowledge

`/memory` opens Memory and knowledge, described under "Memory and knowledge" below; knowledge, what is known about you and your templates have no slash command of their own.

### Extensions

Tools and extensions, in the menu (Ctrl+G, then m), is one place for hooks, the hooks that ran, hook points, the model's tools, tool servers (MCP), plugins, the marketplace and skills; `/mcp` typed alone opens it on Servers. Each part is described under "MCP servers", "Plugins", "The marketplace", "Hooks" and "Skills" below; the named API services (Models and providers, Services) under "Named API services".

### Daemon-owned features

At start, when no daemon answers and a daemon service is installed on this machine, both programs start it and say what happened in one line: `[Startup] The GoodVibes daemon was stopped; GoodVibes started it.`; `[Startup] The GoodVibes daemon is starting; shared sessions, the web UI, phone access and the other things that need it work once it is ready.` when the service is still coming up (the program carries on, waits on the daemon's own ready record with no time limit, connects when it is ready and updates the status bar; if the service stops instead, the failure line below is shown); `[Startup] The daemon is installed but not answering, and starting it did not succeed: <reason>. Start it manually with: goodvibes service start`; or, with nothing installed, `[Startup] No GoodVibes daemon is running and none is installed on this machine, ...` with `goodvibes-daemon install-service`. A daemon configured on another machine is never started from here.

These commands work through the daemon. The features are described in the automation part ("Scheduled routines", "Supervised triggers", "Notifications", "Mail", "Calendar", "Chat channels", "Voice", "Purchases and payments", "CI watch") and the daemon part ("Credentials and pairing", "The relay", "Hosted sessions", clusters); this list gives each command's forms and an example.

Schedules, their runs, triggers, the commands triggers may run, CI watches and check-ins have no slash command: they are the daemon's, in **Automation** (the menu, `Ctrl+G` then `m`), the same place in both apps (see "Automation, in every program" in the automation part). Its tabs read by themselves and follow the daemon's changes: Schedules (`n` new schedule, a form that asks what it does and when; on a schedule `g` runs it now, `p` pauses or resumes it, `c` changes it, `x` removes it, asking first because it cannot be undone), Runs (`s` stops a run that is waiting or running, `t` runs a failed one again), Triggers (`n` watch for something; on a trigger `h` what it did, `x` stop, `s` start one that gave up), Commands (`n` let triggers run a command, which asks first because it loosens a protection), CI watches (`n` watch a repository, `k` check one now; on a watch `g` check it now, `x` stop watching) and Check-ins (`g` check in now). A time described in words ("every weekday at 9am") is read by the daemon, and the outcome line says what was kept: `Scheduled. "triage the inbox": every weekday at 09:00 (0 9 * * 1-5) [UTC]; next 2026-11-26 09:00 UTC.` A time already passed is refused: `Not kept: <time> has already passed.` Run now says what ran and how it stands: `Started "Morning brief". Its run is running.` With no daemon a list says `Could not read your schedules: the daemon did not answer (it may be stopped or still starting)` and reads again by itself when the daemon is back. The terminal app keeps no schedule of its own. The same capabilities (`schedule.*`, `triggers.*`, `ci.*`, `checkin.*`) are the model's through `capability_run` and a script's through `goodvibes do`.

Webhook notification addresses (ntfy.sh format, for example `https://ntfy.sh/my-topic`) are the daemon's one list, on the Notifications tab of Mail, calendar and channels (`Ctrl+G` then `m`): add, stop sending to one, remove every one, send a test, send a notification. The Failed notifications tab lists failed deliveries (the daemon keeps `integrations.delivery.maxDlqSize` of them, 500 by default; once full the oldest is dropped with a warning in the log) and sends one, or all, again; one whose Slack or Discord destination changed since it failed is sent only with "send it where the channel posts now".

Channels have no slash command: they are the daemon's, on the Channels tab of Mail, calendar and channels in both apps (see below), each action a capability `channels.*` the model and a script reach too. Pairing a channel is Pair something, A chat channel, in Devices and network, which asks for each required value with masked input, then enables the surface; "send a test" on a working channel sends a real test message. A notice a program sends on its own events (a turn that ended, an approval waiting, a budget reached, an agent or a piece of work that ended, the model's notify tool) goes out through the daemon's one list of webhook addresses; one that fails is in the daemon's Failed notifications, beside the daemon's own. The failed notices each program kept itself up to 3.5.0 are carried into that list once; the programs' files are left as they were.
A Telegram chat's messages can be held for your decision, the same in both apps: Waiting for you's Telegram tab lists the messages waiting and the review queue, read by itself and read again when one changes. On it, `h` holds a chat (a form: the chat id, the bot, how long each message waits, default 1h, and how long the chat is held, default 7d); on a waiting message `y` accepts it for review and `n` refuses it; on one in the queue `o` reads its original, `c` closes the review (the held message is dropped for good; it asks first), `x` stops capturing new messages under its configuration and `b` hands the chat back to normal handling; `i` says where any message stands. The model and scripts reach the same acts as the capabilities `telegram.list`, `telegram.configure`, `telegram.approve`, `telegram.deny`, `telegram.status`, `telegram.read`, `telegram.cancel`, `telegram.revoke` and `telegram.release`, run in the daemon through its `inbound.telegram.*` methods; every one but `telegram.list` and `telegram.status` is the owner's own.

Mail has no slash command: it is the daemon's one mailbox, read and sent in **Mail, calendar and channels** (the menu, `Ctrl+G` then `m`), the same place in both apps. Its Inbox lists the newest messages by itself and follows the daemon's changes; on a message `Enter` opens it, `n` writes a new one (sent when the form is submitted; a sent mail cannot be called back), `d` saves a draft, and `m`, `e` and `p` show the mailbox settings, change one and store the password on a hidden line. The same capabilities (`mail.status`, `mail.list`, `mail.read`, `mail.draft`, `mail.send`, `mail.settings`, `mail.set`, `mail.password`) are the model's through `capability_run` and a script's through `goodvibes do`. The same message sent again within ten minutes is not delivered twice; "Send it again" sends a new copy. The Calendar tab lists the next 30 days (`Enter` opens an event, `n` adds one, `c` changes it, `x` removes it), the Google tab the daemon's one Gmail and Google Calendar connection, in this app as in the Agent and the web UI (`c` connects it, installing what it needs as it goes and showing the consent link in a pane of its own with the copy key; the steps show under the connection as they go, with no key pressed; `k` checks it by reading mail and calendar, `a` asks Google for consent again, `x` disconnects, `u` takes up credentials found on the daemon's machine, `i`/`f` hand over an OAuth client, `m` sets the Gmail address, `l` the calendar's private address, `o` connects by one route, `w` shows the written steps: capabilities `google.*`; see "Google (Gmail and Google Calendar)" in the automation guide), and the Channels tab every channel with one state each (working, needs a look, not working, not set up, switched off, not known) and why under one that needs a look, does not work or is not known; `Enter` says what a channel needs, `t` sends a test through one that works, `k` runs the daemon's checks on one that does not, `w`/`e` show and change who may write to the assistant there, `p`/`g`/`u` show, give and remove the model and permission mode its sessions get, and `s` opens the form that sets one up.
The calendar has no slash command: it is the daemon's one calendar, the same in both apps. The Calendar tab lists the calendar kept on this computer, the feeds you subscribe to (read-only, marked with the feed's name) and the connected CalDAV server, Google or Outlook account together; `s` says what it reads, `a` lists every event kept here, `i` imports an .ics file and `e` exports to a new one; `n` adds an event to the connected calendar, or here when none is connected or "The calendar on this computer" is chosen. The Calendar accounts tab signs Google and Outlook in (`Enter`: a browser on the daemon's computer, a code for another device, or the address the browser landed on; the daemon answers at once with the link and finishes by itself), `u` gives your own app's client id, `o` signs out. The Calendar feeds tab lists the feeds (`n` subscribes, `g` reads one again now, `a` every one, `x` stops one). A feed is read again whenever the calendar is read and it is older than its interval. The capabilities are `calendar.*`.
Who is who (channel identities mapped to named people, bots and services) is the daemon's, on the Who is who tab of Permissions and safety in both apps; no slash command carries it. The tab lists them with their identities (Enter shows one); `n` adds one (name, kind, and `channel:value` pairs such as `slack:U123, email:sam@example.com`), `c` changes or renames one, `x` removes one for good (asked first), `f` finds who a user on a channel is. The capabilities are `principals.list`, `get`, `resolve`, `create`, `update` and `delete`.
What the platform knows about you is the About you tab of **Memory and knowledge** (see "Memory and knowledge" below), the same in both apps; a write counts only when you make it there.
Cards, addresses and what may be bought are in **Money** (the menu, `Ctrl+G` then `m`), the same place in both apps; everything in it is kept by the daemon, so the web UI's Money screen, a script and the model see the same. Its tabs read by themselves and follow the daemon's changes: Cards (`n` adds one, each field typed on the hidden line; `x` removes one, asking first because it cannot be undone), Addresses (`Enter` changes the billing or the shipping address; a blank field keeps what is set), Repeat purchases (what a schedule may buy without asking: `n` allows one, `x` stops one, `a` approves one purchase ahead of time), and Spending (this conversation first, its context, tokens, cost, turns and agents, with `c` to shorten it now; then what the daemon spent on models in the last 7 days by what it was for, a schedule, a piece of work, a web chat or a shared session; `p` sets your own price for a model, `b` shows every split and `w` sets the spending alert). Approving a purchase ahead or allowing a repeat purchase says what it did: nothing has been bought yet. Removing a card the daemon no longer holds says the card was not found. The same capabilities (`payments.cards`, `payments.add-card`, `payments.remove-card`, `payments.address`, `payments.approve`, `payments.repeat`, `payments.repeats`, `payments.stop-repeat`, `usage.by-source`, `usage.alert`, `usage.price`) are a script's through `goodvibes do`; the model may run the three that only read, the spending alert and a model's price, and is refused the rest as the owner's own acts. There is no `/payments` any more: every action is a control in Money, and the purchases waiting for an answer are on Waiting for you's Purchases tab. Settings' "Cards on file" row opens Money on its Cards tab.
What is paired with the daemon and how other machines reach it are in **Devices and network** (the menu, `Ctrl+G` then `m`), the same place in both apps and the web UI's Devices and network screen; everything in it is the daemon's, read by itself and read again when it changes anywhere. Its tabs: Paired (each device, with `n` rename and `x` revoke, which cuts it off for good; the old shared token, while it still works, with `x` retire it and `g` give a device its own token, shown once in the place's own pane with a copy key and gone when you leave it; `h` how this terminal connects to its daemon, `U` forget this terminal's daemon pairing; `s` opens Settings at Secure address), Waiting to pair (the devices that asked to pair as nodes, a browser's Phone node or a peer daemon: `a` approve, `x` reject; approved, the device finishes when its person presses Finish pairing on it; a request naming a device already paired is approved only with Replace, which ends the old pairing), Phones (the phones paired as device nodes and what each can serve), Always allowed (`x` stops an "always allow" answer), Captures (`x` deletes one now), Relay (the devices paired through the relay, `x` cuts one off; `y` says whether the relay is reachable), Machine group (this machine's group: `c` start one, `k` its join key, shown once in the place's own pane like a token, `n` rename, `o` a new key, `u` share a setting, `t` take the group's, `l` leave), Machines (`x` removes one from the group; on another machine of the group, `s` the group as it sees it, `k` the join key, `o` a new key, `l` make it leave), Nearby groups (`j` joins one with its key), Cloudflare settings, Addresses and ports, and Phone and voice settings (the daemon's settings for each, `Enter` changes one: the value is typed in plain text unless the setting holds a password or key), Network scan (whether the daemon also checks the other devices on your local network for model servers, `o` turns it on or off, and each server it kept), Settings sync (above, under Settings) and Cloudflare (`q` what the token needs, `t` create it, `d` find accounts, `v` check a token, `e` deploy, `k` check the worker, `x` turn it off). `p` pairs something new from any tab: A phone or another device (the program's own pairing screen, with the QR code and the other ways to sign in), This program with its daemon, A device through the relay, or A chat channel. The same capabilities (`devices.list`, `devices.rename`, `devices.revoke`, `devices.revoke-shared`, `devices.requests`, `devices.approve`, `devices.reject`, `devices.nodes`, `devices.revoke-grant`, `devices.captures`, `devices.delete-capture`, `devices.relay-status`, `devices.relay-codes`, `devices.relay-revoke`, the `cluster.*` and `cloudflare.*` ones) are the model's through `capability_run` and a script's through `goodvibes do`; approving or rejecting a pairing, the join key, creating the Cloudflare token, deploying and turning Cloudflare off are the owner's own acts and refused to the model.

"Add a card" fixes the daemon before the first field; if the daemon this terminal talks to changes while the card is typed, it is not sent (`The daemon this terminal talks to changed while the card was being entered ... Nothing was sent.`).
Pair something asks what to pair. A phone or another device opens the device-pairing view (a QR of an offer; `r` there shows a new one). When the window cannot hold the whole QR code with the rest, the view shows the code and its address alone, whole, with one key, `^d details`, that switches to the other rows and back; when even the code alone does not fit, one line says so with the address and the key that shows the link. This program with its daemon (Name, Sign-in code) is the one way this terminal becomes your own device on a daemon on another machine: you start it yourself where you are signed in as yourself (that daemon's web UI with your password, or your terminal app on that machine: Pair something, A phone or another device, "Show the sign-in code once"), and type that code here, hidden as you type; the daemon confirms it as a device and this terminal keeps it. Nothing asks that daemon to mint a key for whoever asks. With no code it says how this terminal reaches its daemon: with the daemon on this machine there is nothing to pair (this terminal is your own program there). In a shell the same is `goodvibes host pair`, which reads that code from the terminal. A device through the relay mints a relay pairing payload for one device (it carries a relay code for that device alone, labelled with the name); when the daemon's relay is off it asks first, opening on No, "Devices cannot reach this machine through the relay yet. Turn the relay on so they can?", with a `Relay address` field (its `wss://` shape checked as it is typed) when no relay address is set. Yes saves the address, turns the relay on and pairs in the same run (`relay.pairing.mint` with `turnOn` and `url`): while the relay does not answer yet it says `The relay is on at <address>, and it is not answering yet. The pairing shows here as soon as it does; you can carry on meanwhile.` and prints the pairing when it comes; No answers `No relay pairing was made: the relay is off on the daemon, and it was left off.` A chat channel asks for each of a channel's required values with masked input, then switches it on. Forget its daemon pairing (Paired, `U`) forgets this terminal's host credential (the owner's only); cut off on the Relay tab refuses that device through the relay from its next request while every other keeps working. Pairing and the host credential run in the program holding the conversation (`devices.pair`, `devices.host-status`, `devices.unpair-host`): `capabilities.run` from elsewhere is refused in one line, and the Agent's Setup rows "Pair with a host" and "Unpair from the host" are the same two capabilities.
The machine group (sharing inbound channel work and a few settings with your other machines on the network) is the Machine group, Machines and Nearby groups tabs of **Devices and network**; they act on the group of the daemon the program talks to. A machine whose sharing is off is turned on by choosing "Turn sharing on" in the "If sharing is off" option (the daemon restarts and the action finishes then). Removing a machine, leaving, sharing or taking a setting and a new key that stops the old one at once ask first, because they cannot be undone. On another machine, `goodvibes-daemon cluster` (with `--host`) does the same from a shell.
The optional Cloudflare integration is the Cloudflare tab of **Devices and network**, in both programs: what the API token needs, creating it (the bootstrap token typed on the hidden line), finding accounts, checking a token, deploying (it spends money; turning it off takes it down), checking the worker and turning it off (with a bootstrap token it revokes the operational token this daemon made, which cannot be undone, and the token is then created again before deploying). Parts are chosen in the "Also use" field and left out in the "Leave out" field. A token in an environment variable is given by a script as `goodvibes do cloudflare.validate --input token="$CF_TOKEN"`.
Voice has no slash command; it is in the System place in both programs. On This session, the row "Speak answers aloud": `a` speaks every answer or stops doing so (`ui.voiceEnabled`), `p` sends one message whose answer is also spoken, `w` starts listening for the wake word again after it stopped by itself (it also starts again by itself when the terminal regains focus, and when the wake input device setting changes). On the Voice tab, the row "Voice runtime" shows the managed local voice runtime and follows an install by itself, step by step, to its result: `i` installs it, `t` stops playback, `v` shows the wake-word models and `w` sets them up (and installs speech-to-text too when asked), `e`, `o` and `m` keep the voice settings you changed as a file, read one, or apply one. Live local playback needs `mpv` or `ffplay` on `PATH`.

## Sessions

A session is one saved conversation.
Saved sessions of the terminal app live in `<project>/.goodvibes/tui/sessions/`, one file per session; the first line of the file carries the title, model and message count.
A session file names the program, the project and the session id, so a terminal-app session and an Agent session with the same name are different sessions.

### When a session is saved

- After every completed turn the whole conversation is written (one temporary file, one rename).
- "Save this session under a name" (in This conversation), `/clear` and `/quit` also save it.
- `behavior.saveHistory` (default on) controls whether conversations are kept at all.
- Saved sessions are kept until they are deleted (`x` on one in the Sessions place); the retention sweep never removes them.

### Crash snapshots

A crash snapshot is a second copy written only while the conversation holds something the saved session does not:

- when a prompt is accepted;
- after a batch of tool calls, at most once every five seconds;
- when the save at the end of a turn fails;
- for a change made outside a turn (`/undo`, a new title, a branch switch), at most once a minute;
- on a signal, a crash or a quit, before the final save.

The snapshot is deleted when a later save succeeds.
On the next start the terminal app offers the newest snapshot that is newer than its saved session, unless another running terminal has that session open.
Opening a session by any route (`--continue`, `--resume`, `goodvibes sessions resume`, `/resume`) offers its snapshot on top of the saved copy when the snapshot is newer.
Choosing Remove deletes that snapshot.
A restored snapshot that ends inside a turn keeps that turn's prompt marked cancelled, keeps the tool results it had, keeps a cut-off reply with a line saying it was cut off, and records each tool call whose result never reached disk as interrupted with an unknown effect. The interrupted turn is never run again on its own.
Crash snapshots nobody resumes are removed after `atRest.retentionMaxAgeDays` days (default 30).

### Which session is open where

A terminal that has a session open holds that session's lock under `~/.goodvibes/shared/owner-askers/`.
The operating system releases the lock when the process ends, however it ends.
`/resume` refuses a session another running terminal has open unless `--force`, and the session picker asks first.
A load takes the session's lock before it replaces the conversation, so of two terminals loading one session at the same moment one gets it and the other is refused. `/resume <id> --force` (or "Have it handed over here" when resuming from the Sessions place) never writes a session alongside the terminal that has it open: through the daemon both terminals are attached to, it asks that terminal to save the session and let go, waits until it has, then resumes it here; the other terminal says the session moved and no longer writes it. When the two terminals are not attached to one daemon, the other one cannot be asked (`It is open in another terminal that is not attached to this daemon, so it cannot be asked to let go.`); close the session there first. The refusal without `--force` reads `Continue it there, or run /resume <id> --force to have that terminal save it and hand it over to this one.`
Saving under another name or moving to a session another running terminal has open ("Save this session under a name" keeping work in the saved copy, a fork onto that name) is refused the same way and nothing is switched.
A save of a session that another terminal saved after this one read it is refused (`Session <name> was saved by another terminal since this one read it ... nothing was saved`): run `/resume <name>` to continue from that save, or keep this conversation under another name with This conversation, "Save this session under a name". A rename changes the title on the file as it is, keeping the other terminal's turns.
A headless `run` on a session another terminal has open is refused (see "Headless runs").

### Starting on a session

| Want | Command |
| --- | --- |
| Continue the last session of this project | `goodvibes --continue` |
| Open a session by id | `goodvibes --resume user-0008b454` or `goodvibes -r user-0008b454` |
| Open the last session | `goodvibes --resume` |
| Resume the last session, then fork it | `goodvibes --fork` |
| Open a session, then fork it | `goodvibes --fork user-0008b454` |
| Pick from a list inside the app | `/resume` |

When no last-session pointer exists, `--continue` prints `No previous conversation to continue. This is a new one; the Sessions place lists saved ones.` and starts a new conversation.
A resumed session prints `Resumed session: <id>` with its message count and model.
A forked session prints `Session forked:` with the new id, the fork name, the source title and the message count.

### Branches

"Branch this chat here", in This conversation, keeps the conversation as a named branch inside the session; on the Sessions place's Branches tab `Enter` goes on from one and `m` adds the messages a branch gained after it was made.
A saved branch that this version cannot read is left out of a resume, and the transcript names it.

## Models and providers

A provider is a model service. A sign-in is one way of authenticating to a provider.
A model is named by its registry key `<provider>:<model-id>`.
The main chat model is saved in `provider.model`; the reasoning effort in `provider.reasoningEffort` (default `medium`).
With nothing configured the terminal app uses `openrouter:openrouter/free`.

### Where a provider's model list comes from

No provider keeps a fixed list of models in the program.
A provider's list is what its own endpoint answers (for example OpenAI's `/v1/models`, and with a subscription sign-in the plan's own list), else its last answer saved on disk, else the pinned model catalog's rows for it.
A model the provider lists that the catalog does not know is selectable at once, marked unclassified.
A model typed by name that no list contains is still sent; the provider's refusal, if any, is shown as it is.
Lists are read again in the background, never on a request's path: at start-up (a list on disk younger than a day is used without a request), after a sign-in, when the model picker opens (again from disk while younger than a day), on `/model refresh` (always read, here and on the daemon), on the web app's `Refresh models` (`models.refresh`), and when a provider refuses a model as unknown (at most once a minute per provider). The model catalog (the list of a provider with no listing of its own) is checked at start-up and again at those moments once its last check is a day old. A list that changes is announced by the daemon, and every program reads the one list again.
`goodvibes status` and `goodvibes doctor` show where the current list came from and how old it is.
A provider whose endpoint did not answer the start-up discovery shows `Health: unreachable: <the failure>` in the picker's detail area.

### Providers

The complete list of built-in providers, with how each signs in, is under "Providers" in the reference part.

Native providers speak the vendor's own API: `openai`, `anthropic`, `gemini`, `amazon-bedrock`, `amazon-bedrock-mantle`, `anthropic-vertex`, `github-copilot`.
Compatible and gateway providers share one OpenAI- or Anthropic-compatible adapter with a fixed base URL and become usable when their API key is present.
`synthetic` groups one model across every provider that serves it (see "Synthetic failover").
`decision-router` is a provider whose answer comes from the configured decision model routes; it needs a General answer provider and model before it can be selected.
`goodvibes providers` shows each provider's setup class: `api-key`, `cloud-account`, `self-hosted`, or `unknown`.

### Signing a provider in with an API key

1. Get the API key from the provider.
2. Store it in one of three ways:
   - set the environment variable before launching: `export OPENAI_API_KEY='<your-api-key>'`;
   - store it in the secret store: `goodvibes secrets set OPENAI_API_KEY --user`, then paste the key when it asks (nothing is shown);
   - inside the app, select a model of that provider with `/model use` and type the key when the app asks for it.
3. Select a model: `goodvibes models use openai:gpt-5.4` or `/model use openai:gpt-5.4`.
4. Check it: `goodvibes providers inspect openai` shows the API-key route as configured and usable.

An environment variable wins over a stored key.
Cloud-account providers need their platform credentials: Amazon Bedrock reads `AWS_BEARER_TOKEN_BEDROCK`, an `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` pair, or `AWS_PROFILE`; Anthropic on Vertex reads a project id plus `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login` or metadata-based auth; GitHub Copilot reads `COPILOT_GITHUB_TOKEN` or a stored GitHub token for `github-copilot`.
`cloudflare-ai-gateway` also needs `cloudflare.accountId` and `cloudflare.aiGatewayId` (or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID`).

### Signing a provider in with a subscription

A subscription sign-in uses the provider's own account sign-in in a browser instead of an API key.
OpenAI (a ChatGPT subscription) is built in. The procedure is under "`goodvibes subscription` (alias `subscriptions`)" above; inside the app, `s` on openai on the Providers tab of Models and providers.
Another provider can offer subscription sign-in when an `oauth` block for it is added to `~/.goodvibes/tui/services.json`:

```json
{
  "name": "exampleai",
  "authType": "oauth",
  "tokenKey": "EXAMPLEAI_API_KEY",
  "providerId": "exampleai",
  "oauth": {
    "authUrl": "https://auth.example.com/authorize",
    "tokenUrl": "https://auth.example.com/token",
    "clientId": "<client-id>",
    "redirectUri": "http://127.0.0.1/callback",
    "scopes": ["openid"]
  }
}
```

A project's `services.json` cannot carry an `oauth` block.

### Local model servers

"Find model servers on this computer" (`m` anywhere in Models and providers; `models.scan` for the model, a script or an outside agent) has the daemon probe this computer for model servers that answer an OpenAI-compatible `/v1/models` request, and registers each one as a provider for every program. A running program takes them at once, with no restart: its model picker lists them and its next turn can use them. Your local network is scanned from Devices and network ("Scan your network for model servers").
Discovery does not run on its own at start-up; start-up restores the providers found earlier from a cache without probing them.
The scan checks well-known ports (11434 Ollama, 1234 LM Studio, 8080 llama.cpp, 1337 Jan, 4891 GPT4All, 5001 KoboldCpp, 2242 Aphrodite, and 5000, 7860, 8000 and 8001, common ports of other OpenAI-compatible servers) and identifies a server by its port or its response headers.

| Server | Identified by | Adapter |
| --- | --- | --- |
| Ollama | Port 11434 | Dedicated |
| LM Studio | Port 1234, or `lmstudio` in headers or model ids | Dedicated |
| vLLM | `x-vllm-*` response headers | Dedicated |
| llama.cpp | `llama` in the `server` header | Dedicated |
| Text Generation Inference | `text-generation-inference` in headers | Dedicated |
| LocalAI | `localai` in the `server` header | Generic |
| Jan | Port 1337 | Generic |
| GPT4All | Port 4891 | Generic |
| KoboldCpp | Port 5001 | Generic |
| Aphrodite | Port 2242 | Generic |

Each server found becomes a provider whose id is the server's name: `Ollama`, `LM Studio`, `vLLM`, `llama.cpp`, `LocalAI`, `TGI`, `Jan`, `GPT4All`, `KoboldCPP` or `Aphrodite` for a server on this machine (`127.0.0.1` or `localhost`), the same name followed by ` (<host>)` for one elsewhere on the network (for example `Ollama (192.168.1.50)`), and `local-<host>:<port>` for an unidentified server. Its models are `<provider id>:<model id>`, for example `Ollama:llama3:8b`. A name a configured provider already uses is skipped.
The servers the last search found are saved (`~/.goodvibes/tui/discovered-providers.json`, the daemon's) and registered, without probing, by every command of the program: the interactive app, `goodvibes run`, `models`, `models current`, `models use`, `providers` and the rest. A scanned model is used like any other:

- for one launch, `goodvibes -m Ollama:llama3:8b` (the provider half is matched by id or display name without regard to case, so `-m ollama:llama3:8b` is the same model; `--provider Ollama -m llama3:8b` also works). This leaves the saved default alone; or
- `/model` and pick it, for this conversation only; or make it the default for every conversation that has not chosen its own: `u` on it on the Models tab of Models and providers, or `goodvibes models use Ollama:llama3:8b` (the daemon's `provider.model`).

When a saved model's provider is no longer registered (the server was scanned away, or `discovered-providers.json` was removed), nothing stops working: `goodvibes models current` exits `1` with `The model '<key>' cannot be used: no registered provider is named '<provider>'.`, the registered providers and how to choose another, `goodvibes models` and `goodvibes providers` list as usual with that line at the top, `goodvibes models use <key>` changes it, and a turn fails with the same message. An unknown provider in `-m <provider>:<model>` or `models use <provider>:<model>` is refused the same way, listing the registered providers; it never becomes a model of another provider.
A dedicated adapter knows the server's tool calling and streaming; Ollama, LM Studio and llama.cpp also get the `instant`, `low`, `medium`, `high` reasoning levels.
An Ollama server that answers only `/api/tags` and not `/v1/models` cannot be used as an OpenAI-compatible provider and is reported as skipped.
To add one server by hand, "Add a provider of your own" (`n` in Models and providers) with a name and its address, for example `box` and `http://192.168.1.50:11434/v1`; it probes `<address>/models`.
`sglang` (port 30000), `litellm` (port 4000) and `copilot-proxy` (port 3000) are built-in self-hosted providers that need no scan. Without a key they count as set up only once a server at that address has answered with its models; until then their status reads `No server has answered at <address> with any models yet. Start it, or set its address.` and model pickers leave them out.

### Custom providers

Any OpenAI-compatible API can be added as a JSON file in `~/.goodvibes/tui/providers/`:

```json
{
  "name": "myrouter",
  "displayName": "My Router",
  "type": "openai-compat",
  "baseURL": "https://router.example.com/v1",
  "apiKeyEnv": "MYROUTER_API_KEY",
  "models": [
    {
      "id": "big-model",
      "displayName": "Big Model",
      "contextWindow": 200000,
      "capabilities": { "toolCalling": true, "codeEditing": true, "reasoning": true, "multimodal": false }
    }
  ]
}
```

Files in that directory are read again when they change; no restart is needed.
`contextWindow` is optional. Without it the window shows as unknown (`context 29.9k / unknown`) and no compaction is driven by a guess. The variable `apiKeyEnv` names is the provider's key route: its status (and the web UI's Models and providers) reads `set up via env` while that variable is set.

### Routing roles

The model picker chooses a model for one of six roles. Each role writes its own settings, so a choice for one never changes another.

| Role | Picker label | Settings | Behavior |
| --- | --- | --- | --- |
| Main chat | Main chat | `provider.provider`, `provider.model` | Normal turns. |
| Helper | Side work | `helper.globalProvider`, `helper.globalModel`, `helper.enabled` (default off) | Supporting work such as summaries and session titles; empty values use the tool-work model when it is on, else the main model. |
| Tool model | Tool work | `tools.llmProvider`, `tools.llmModel`, `tools.llmEnabled` | GoodVibes's own background model calls (commit messages, repairing a failed edit, summarizing changes); selecting a model turns it on. |
| TTS model | Spoken replies | `tts.llmProvider`, `tts.llmModel` | The model that answers the messages "ask and hear it" sends (System, This session); empty uses the main model. |
| Decision model | Decision model | `judgment.endpoint`, `judgment.model`, `judgment.keySource`, `judgment.keyName`, `judgment.backend` | The model that decides which actions are safe to run under Jev decides. The tab lists "No decision model" and the decision models Settings offers; choosing one asks for its address and where its key comes from, the same steps as the Decision model row of `/settings open`, which write the same settings. Both programs. |
| Embeddings | Search index | `provider.embeddingProvider` | The embedding provider for memory search and the code index. It has no model choice. The terminal app only. |

`goodvibes doctor routing` prints which provider and model serve each role.

### Reasoning effort

The levels a model accepts are resolved per model: the live catalog entry first, then a declaration (a plugin, a custom provider file, a local server's traits), then a per-family table, then a labelled best guess.
For models whose only control is a thinking-token budget, each level maps to a budget:

| Level | Token budget |
| --- | --- |
| `none` | 0, offered only when the model can switch reasoning off |
| `instant` | 0 |
| `minimal` | 1024 |
| `low` | 2048 |
| `medium` | 8192 |
| `high` | 32768 |
| `xhigh` | 49152 |
| `max` | 63999 |

A model with an on/off toggle treats any level above `none` as on. A model with no reasoning control offers no levels.
"See how hard the model thinks", in This conversation, shows the levels the current model offers; the saved preference is kept when a model that caps lower is selected, and the level in effect is shown.

### Making a model and reasoning effort the default

The default model, its reasoning effort and the permission mode are one shared default, kept in the daemon's settings (`~/.goodvibes/daemon/settings.json`, `provider.model`, `provider.reasoningEffort`, `permissions.mode`): every program starts each new conversation with it, and a conversation can choose its own without touching it. Until 3.5.0 each program kept its own; at the first start of this version they are carried into the one default once, whichever program starts first: the model and the effort are the terminal app's, the mode is the stricter of the two programs' (Plan, then Ask me, then Jev decides and Just vibes, then YOLO), and one notice names what each program had and what was kept. The programs' own files are left as they were, for a rollback.

What changes what:

| Action | Changes |
| --- | --- |
| "make it the default" on a model, or "use its default model" on a provider (which picks that provider's highest benchmark-ranked text model from `models.dev`), in Models and providers; `goodvibes models use <id>` / `goodvibes-agent models use <id>` | The shared default model, for every program. |
| "How hard the model thinks" and "When GoodVibes asks" in Settings | The shared default effort and mode, for every program. |
| `/model use <id>`, picking a model in the model picker, `@model:<id>` in a prompt | This conversation's model only. |
| "Choose how hard the model thinks" in This conversation; Shift+Tab | This conversation's effort or mode only. |
| `-m <id>`, `--provider`, `-c provider.reasoningEffort=high` on the command line | Nothing kept: this launch only. |

Check with `goodvibes models current` and `goodvibes status` (the `provider`, `model` and `reasoning` lines), or `goodvibes-agent models current` and `goodvibes-agent status`.

The level saved is a preference: on a model that does not offer it, a level that model offers is used instead (`/model` and "See how hard the model thinks" say which), and the saved preference stays for the next model.

### Failover

A failed request never moves to a model the owner did not choose. The same rule holds everywhere a turn runs: the terminal app (interactive and `goodvibes run`), the Agent (interactive and `run`), the daemon's hosted sessions and its agents. The engine's turn loop applies it, in this order:

1. **Another sign-in.** Inside the request, a provider with two sign-ins tries the second when the first fails. Only `openai` has two built in: a request the ChatGPT subscription fails is sent again to the same model with the API key, and the turn says once which sign-in answered and why (in a headless run, one line on standard error and `signIn.movedFrom` in `USAGE`).
2. **Synthetic backends.** A `synthetic` model moves between the providers that serve it (see "Synthetic failover").
3. **Retries.** A failure that a wait can clear (a rate limit with a short `Retry-After`, a network error, a 5xx) is retried on the same model, and the stream shows `STREAM_RETRY`. With nowhere else to go the waits are 5, 10, 20, 40 and 60 seconds. When `provider.fallbackModels` has an entry not yet tried whose provider is signed in, the model gets one retry after 2 seconds and then the turn moves on; a server asking to wait longer than that (`Retry-After`) is not waited for, the turn moves at once.
4. **The fallback order.** When the model still fails (every sign-in, every synthetic backend and every retry), the turn moves to the first entry of `provider.fallbackModels` not yet tried this turn whose provider is signed in, and sends the failed request again to it; the rest of the turn, tool calls already made included, continues on that model. Entries are registry keys such as `["anthropic:claude-sonnet-5"]`; the provider half is matched by id or display name without regard to case. A worker agent given its own `fallbackModels` uses that order instead, and one whose routing says `providerFailurePolicy: "fail"` uses none.
5. **Stop.** With no order set, or every entry tried, the turn ends with the error (`provider_error`, or `provider_exhausted` for a spent `synthetic` model). The failed turn's row says so (see "Turn errors"), with the reason nothing else was tried in its details (`ctrl+g i`, the `Fallback` row); a headless run's `TURN_ERROR` carries the same reason as `fallbackNote`.

Each move prints a line naming both models, the position in the fallback order, the error and the price difference when both prices are known, and says which model answers:

```text
[Failover] openai:gpt-6.1-sol -> anthropic:claude-sonnet-5, entry 1 of your fallback order (provider.fallbackModels) (Rate limited: ...) [cost/1M: input $2.00→$3.00, output $10.00→$15.00]. claude-sonnet-5 answers the rest of this turn; the next turn starts on openai:gpt-6.1-sol again.
```

When prices are unknown the line says `[cost data unavailable]`. In the terminal app a second line names the billing class left and joined, for example `[Failover] billing: API key → Subscription: billing class changed`, and while the move is in force the header and footer name the model answering, with `failover from <selected model>`. In a headless run (`goodvibes run`, `goodvibes-agent run`) the move is one line on standard error, `[Failover] <from> -> <to>, <position>; <to> answers the rest of this turn.`, and the result's `model` and `provider` name the model that answered. Text the failed attempt had already streamed is withdrawn (`DRAFT_WITHDRAWN`) before the next model streams its answer. A companion chat (`companion.chat.*`) moves the same way: the reply's `metadata.failover` holds the moves (`from`, `to`, `because`), `answeredBy` and the `[Failover]` lines, and the `turn.completed` envelope carries the same `metadata`; when nothing is left to try, the failed reply's `failureReason` (the failure reading every program draws its row from) holds the reason in its `Fallback` detail, and the `turn.error` text is the reading's headline and cause. The selection itself never changes: the next turn starts on the selected model again.

The same order serves the model calls made outside a turn: context compaction (the summary and the distilled brief), the helper and tool models, the check-in note, native work intake, knowledge enrichment, image understanding and the private verification proposal (which moves with its turn, so the rest of that turn continues on the model it moved to). Each moves only for that one call: the model's other sign-in first, then the first entry of `provider.fallbackModels` not yet tried whose provider is signed in; with no order, or every entry tried, the call fails with the error as before. Image understanding moves only to a model that reads images and stays in its scope (a local-only reading never goes to a cloud model). A call that succeeds the first time sends no other request. Background calls report a move or a stop in the log, not the conversation.

Set a fallback order (it applies from the next failure, in every program that reads the same settings). `/model backup` ("Add a backup model", in both programs) lists the models you can select and adds the one you pick to the end of the order; `/model backup <model>` adds that one; `/model drop-backup <model>` ("Remove a backup model") takes one out. The same setting by key:

```text
/model backup anthropic:claude-sonnet-5
/model backup groq:llama-3.3-70b-versatile
/settings set provider.fallbackModels ["anthropic:claude-sonnet-5","groq:llama-3.3-70b-versatile"]
```

### Synthetic failover

The `synthetic` provider groups one model across every backend that serves it at the same billing tier (free, paid or subscription), under one entry; the picker shows each entry with its number of providers and an S, A, B or C tier badge, split into Top Models and All Synthetic.
A model served free by some providers and paid by others becomes one entry per tier, named with the tier (`<model>-free`, `<model>-paid`), and each entry fails over only to backends of its own tier, so a free synthetic model never reaches a paid backend. An entry needs at least two providers in its tier.
Backends are tried in order of context window, then maximum output tokens, skipping backends whose provider has no key.
Each backend gets one attempt; a failed backend goes on cooldown and the next is tried at once:

| Failure | Cooldown | Next |
| --- | --- | --- |
| 429 rate limit, or out of credit | The provider's retry-after, else 60 s | Next backend at once. |
| Other 4xx (401, 403, 404) | 60 s | Next backend at once. |
| 500 or network error | 5 s | Next backend at once. |
| 400 | None | No failover: the request itself is malformed. |

When every backend is cooling down and the shortest cooldown is 120 s or less, the turn waits it out and retries once; a longer cooldown ends the turn with the error.
Each rotation and wait is reported as a retry naming the provider and the reason.
For a free synthetic model only, when every backend is exhausted the turn moves to the next-best free model by benchmark score and says so; free, paid and subscription models never mix.
A paid or subscription synthetic model that is exhausted moves to your `provider.fallbackModels` (see "Failover"); with none left, it stops the turn with recovery options.
A provider can move a model from free to paid. The shared model catalog is checked again when its last check is more than 24 hours old, at the next message you send or the next model list you open (no timer runs). When that check finds that a model you use (the current one, a pinned or a recent one) is no longer free, a provider warning says so at once: "<model> (<provider>) is no longer free: the model catalog now lists it as paid at $X in and $Y out per 1M tokens. It is the model in use, so the next messages are charged. Pick a free model with /model if you do not want to pay." Before the next message is sent to that model, the decision is made the way your permission mode makes every decision: under YOLO it keeps using it; under Jev decides and Just vibes the decision model decides (`providers.keep-paid-model`: keep when the price is a small fraction of a dollar per million tokens or you have no free model, otherwise send nothing), and without a working decision model Jev decides asks you while Just vibes holds it (nothing is sent, nobody is waited on); under Ask me (and Plan) you are asked, on the ordinary approval card, opening on No: `<model> is no longer free: about $X in and $Y out per 1M tokens. Keep using it?` with `Each message to it is charged from now on. A yes is asked once for this change; No sends nothing.` and the buttons `Yes, keep using it` (`y`), `No` (`n`, selected) and `Choose another model` (`m`). A yes is remembered for that change (in `model-price-changes.json` in the settings folder) and not asked again; No or Choose another model sends nothing and ends the turn with `<model> is no longer free, so nothing was sent.` and the keys `choose another model` and `send it anyway (asks again)`. A headless run that answers no approvals refuses it, as every such ask. Whatever decided it, a provider warning in all three programs says so: `<model> is no longer free (about <price>); <who> kept using it, so this and the next messages are charged.` or `...; <who> did not keep using it, so nothing was sent. Choose another model with /model.` Both model pickers show each model's price tier (free, paid, subscription, or price not known). A provider that changes its price between catalog checks is still only seen at the next check; `/model refresh` checks at once.
`goodvibes models chain [filter] [--json]` prints each synthetic model's backend order.

To make failover possible, give keys for several free providers, for example `GROQ_API_KEY`, `HF_API_KEY`, `NVIDIA_API_KEY`, `OLLAMA_CLOUD_API_KEY`, `OPENROUTER_API_KEY`, `AIHUBMIX_API_KEY`, then pick a model from the `synthetic` provider.

### Settings for providers and routing

<!-- generated: settings:provider -->

<!-- generated: settings:helper -->

## Tools

The model works only through tools. Every tool call passes the permission gate before it runs.
The Tools tab of Tools and extensions lists the tools available in this session; `goodvibes doctor explain <tool> <args>` shows how one call would be decided.

The complete list of model tools with their inputs is under "Model tools" in the reference part.

The terminal app registers 28 tools (the same 28 run in the daemon's hosted sessions and in helper agents). `repl` is registered only where the command sandbox is available. Each, in one line:

| Tool | What it does |
| --- | --- |
| `read` | Read files with extract modes (`content`, `outline`, `symbols`, `lines`, `ast`), caching, token-budget pagination and batches. |
| `write` | Write files, in batches, with modes `fail_if_exists` (default), `overwrite`, `backup` and `restore`. |
| `edit` | Find-and-replace edits (exact, fuzzy, regex, AST) in one atomic or partial transaction. A file must be read before it is edited. |
| `find` | Search files (glob), content (regex) and symbols, several queries per call. |
| `repo_map` | A map of the repository: per-directory counts and the most-imported files with their exports, within about 25000 tokens. |
| `exec` | Run shell commands: batches, parallel, background, retry, timeout, expectations, until-pattern, file operations before the command. |
| `analyze` | Code analysis: impact, dependencies, dead code, security, coverage, public surface, and more. |
| `inspect` | Project inspection: structure, API routes and OpenAPI specs, database schema, React components, frontend layout checks, scaffolding. |
| `fetch` | HTTP requests with extraction modes and named API services. |
| `web_search` | Ranked web search through a search provider. |
| `agent` | Start and manage helper agents (see "Helper agents and worktrees"). |
| `task` | Durable cross-session task references, dependencies, cancellations and handoffs shared by every session of the project. |
| `work_plan` | The project's checklist, the one the owner sees in the Work place. |
| `workflow` | Hook actions, recurring background commands and workflow state; work itself is run with `agent`. |
| `trigger` | Watch for something (for example a command exiting) and start an agent turn when it happens; the daemon supervises the watch. |
| `state` | Session key-value state, memory by key, hooks, the print level, budget and context, tool-call analytics. |
| `registry` | Find skills, agents and tools by keyword or task; read a skill's dependencies and full text. |
| `control` | List this app's slash commands and views, subscription providers and sandbox presets. |
| `channel` | Inspect and operate channel surfaces: accounts, directories, targets, capabilities, channel tools and actions. |
| `remote` | Remote runner pools, contracts and portable artifacts. |
| `mcp` | Call MCP server tools (`mode: "call"`) and inspect servers, tools, schemas and trust. |
| `query` | Leave the owner a question in the owner inbox and continue working. |
| `profile` | Record and read what the owner says about themselves: dated plans, birthdays and anniversaries, profile fields, facts. |
| `goodvibes_context` | Read the current GoodVibes runtime: settings, integrations, surfaces, providers, models, tools. |
| `goodvibes_settings` | Apply a GoodVibes setting the owner gave a concrete value for. It runs only as a call the permission gate admitted (a `write`); nothing in its own arguments confirms it. A change that loosens security is put to the owner, and is written only when the owner, their standing rule or the mode settled the call; in a channel guest's turn it is refused. |
| `context_accounting` | Report what was added to the model's context this turn (memory records and why) and the recall outcome. |
| `contract_self_check` | Inside a contract unit: read how the unit's acceptance criteria read at the last check, without ending the turn. |
| `repl` | Evaluate one JavaScript, TypeScript, Python, SQL or GraphQL snippet inside the command sandbox. |

Facts about individual tools that change how the owner works with them:

- `write` modes are `fail_if_exists`, `overwrite`, `backup` (copies the original to `.goodvibes/.backups/`, keeping the newest 5 per file) and `restore` (puts the newest backup back). With `tools.autoHeal` on (default off), a written file with syntax errors is run through the formatter, the linter and a model repair. The project's formatter and linter run inside a bubblewrap boundary with no network, a scrubbed environment and the project read-only (a configured language tool may change only its own hidden copy of the file); where no such boundary can be built, that stage is skipped with a warning naming why.
- `write` and `edit` take `validate.after` (`typecheck`, `lint`, `test`, `build`), which runs the project's own script for each; a check the project does not declare is refused before anything is written.
- `edit` results carry a `status`: `applied`, `not_found`, `ambiguous`, `conflict` or `failed`.
- `exec` runs background processes: `bg_output <id>` shows the newest 256 KB of a process's output; a finished process's record is kept for 30 minutes.
- `fetch` uses named services from `~/.goodvibes/tui/services.json` (see "Named API services").
- `repl` exists only where the command sandbox is on (`sandbox.enabled` and the `exec-sandbox` feature) and bubblewrap is installed.
- `query` posts a question to the owner inbox and returns at once; the owner answers it in Waiting for you, in the web UI or from a phone, and the answer reaches the asking session on its next model request, or when that session is next opened. It needs no permission in any mode: its category is `read` and it touches only the app's own state (the inbox), so asking the owner a question is never itself an approval. On a turn a guest started on a channel it is still put to the owner, like every call that reads the app's own state.
- MCP tools are named `mcp:<server>:<tool>`; the model calls them through the `mcp` tool with `mode: "call"`.

## Helper agents and worktrees

A helper agent is a subagent the model starts with the `agent` tool, or the owner starts with `/agents start`, `/agents recipe`, "start a runner" on the Runners tab of the Work place, or `/agents host`.
It has its own conversation and a tool set narrowed by its archetype; an agent that runs a contract unit in worktree mode also has its own git worktree (see "Worktrees").
Helper agents run beside the main conversation and report back through the agent message bus.
Ask for one in plain words (`spawn an engineer agent to refactor src/utils.ts`) or let the model decide.

### The `agent` tool

Its modes: `spawn`, `batch-spawn`, `status`, `list`, `templates` (the archetypes with their tool sets), `get` (details with recent messages), `wait` (returns at once when the agent has ended, else waits up to `timeoutMs`, at most 30 minutes; the agent runs on), `cancel`, `message` (send it a message), `budget` (token use), `plan` (task, template and tools), `contracts` and `contract-history` (the session's contracts and one contract's decisions, checks and escalations), `activity` (what the session's contracts and agents actually did, from the product's records and across a restart of the app: each contract's state and units with their answers, and each agent's state, the files it read, whole or by line range, the files it changed, the commands it ran and its last report), `cohort-status` and `cohort-report` (a team started under one `cohort` name).
An agent does not survive a restart of the app; its contract does. `status`, `get` and `wait` on an agent id this process no longer runs answer with what it was (the planner or the agent of which unit of which contract) and what that contract is now, never only "unknown"; `cancel`, `message`, `budget` and `plan` refuse with the same fact.
When the app starts, each contract that was running when it stopped is said in one line: found on disk and continuing (with the step it takes up and the units that had finished, whose results are kept), waiting for a contract slot, or stopped (with why, what had finished, and that the unfinished work is asked for again as a new contract). The same line is given to the model of the session that started the contract with its next request.
Work given to `spawn` or `batch-spawn` runs as a contract unless `outsideContract` is set: a planner splits it into units and each unit is checked against its acceptance criteria. With `outsideContract`, the agent runs on its own task, and only then are `model`, `provider`, `fallbackModels`, `reasoningEffort`, `tools` and `executionIntent` applied.
Whether agents may start is decided by what you said in the conversation, not only your latest message: an instruction to use agents stands until a later message of yours about agents changes it. When you asked for agents (fan out, a set of agents, use or assign agents, delegate) and did not later forbid or limit them, they start with no decision-model request. When you forbade them in plain words (do not use agents, do it yourself), the call is refused with your words quoted and what would be accepted. Only when your words do not settle it (you said nothing about agents, one message both asks and restricts, or the call starts more agents than a number you named) is the decision model asked, once per state of the conversation. When it cannot answer, the permission mode decides: `yolo` and `just-vibes` start the agents; `ask-me` and `jev-decides` show the agents and their tasks in the approval prompt, and your answer stands for the rest of the conversation. A contract started this way is named after the work you asked for and lists the planned tasks, never after your latest message alone.
A tool call identical to one refused earlier in the same turn is not run again: the model is given the refusal again in full, and the transcript shows one `[Blocked]` line.
A team is a cohort: members spawned with the same `cohort` name, each with its archetype as its role, a `communicationLane`, `context` and `successCriteria`.

### Archetypes

An archetype is a named agent template: description, tool list, optional model and system prompt.

| Archetype | Tools | Purpose |
| --- | --- | --- |
| `orchestrator` | read, find, analyze, inspect, registry | Coordinates and decomposes work. |
| `planner` | read, find, analyze, inspect | Read-only goal decomposition; no write, edit, exec or delegation. |
| `engineer` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Implementation. |
| `reviewer` | read, find, analyze, inspect, fetch, registry | Code review. |
| `tester` | read, write, find, exec, analyze, inspect | Writes and runs tests. |
| `researcher` | read, find, analyze, inspect, fetch, registry | Explores a codebase. |
| `integrator` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Integrates deliverables. |
| `general` | read, write, edit, find, exec, analyze, inspect, fetch, registry | General purpose. |

A custom archetype is a Markdown file in `<project>/.goodvibes/agents/`; the file's body is the system prompt, and a file with a built-in name replaces the built-in:

```markdown
---
name: documenter
description: API documentation writer
tools: [read, find, write]
model: anthropic:claude-haiku-4-5
family: general
---

You are a technical documentation specialist. Focus on clarity and completeness.
```

Optional front matter keys: `model`, `provider`, `family` (`implement`, `review`, `test`, `research`, `general`).
`/agents archetypes` lists archetypes and their problems; `/agents archetype <name>` shows one; `/agents start-archetype documenter "document the billing API"` starts one.

### Watching and steering helper agents

- The transcript's work tree shows each helper agent as a lane; `Alt+Up` moves onto it and `Enter` opens it full screen.
- In the opened agent, the composer steers that agent while the main conversation keeps running.
- `F2` or `Ctrl+O` opens Your agents: `Enter` opens an agent (its composer steers it), `s` stops it (asks first).
- `x` on a running agent in Your agents (Work and agents) stops it (`agents.stop`, also a model's or a script's).

### Worktrees

Only contract work runs in git worktrees. A helper agent started outside a contract (`outsideContract: true`, `/agents start`, `/agents host`, a remote runner started from the Work place) works in the main working tree; no tool input or command gives it a worktree.

Who gets a worktree:

- Work handed to the `agent` tool (`spawn` or `batch-spawn` without `outsideContract`) and a piece of work started in the Work place becomes a contract. A planner splits it into units; each unit is run by its own helper agent.
- The setting `contract.isolation` decides where units run: `auto` (default) uses worktrees when the project is a git repository with at least one commit, else the shared working tree; `worktree` always uses worktrees; `shared` never does (units then run one at a time).
- In worktree mode each unit gets its own worktree on a private branch named `ws-owned/<id>`, under `<repository root>/.goodvibes/.worktrees/`. Up to `contract.maxParallelUnits` (default 64) units of one group (see "Contracts") run at once.
- New worktrees run the cold-start setup in `worktree.setup.commands` and copy the files matched by `worktree.setup.carryOverGlobs`.

How to ask for parallel work in worktrees:

1. Make sure the project is a git repository with a commit (Code and changes: "start a repository here", then commit once), or set `/settings set contract.isolation worktree`.
2. Ask in plain words for the work and name its parts, for example: `Add rate limiting to the API, a health endpoint, and retry logic in the client, as three independent pieces of work.` The model starts a contract; the planner decides how many units there are. The owner cannot force exactly N units or N worktrees; naming independent parts is what leads the planner to separate units.
3. Or see the plan first: turn on "Show me the plan before it runs" in Settings, ask for the work, then in the Work place change its steps and approve the plan, which starts it (see "Work").

How to watch:

- `F2` or `Ctrl+O` opens Your agents, with each unit's agent; `Enter` opens one (its composer steers it), `s` stops it (asks first).
- A piece of work's detail in the Work place shows its steps, their states and what each waits on.
- Code and changes, Worktrees, lists each worktree with its state, setup and why it is kept.
- In a headless run, the `AGENT_*` and `CONTRACT_*` frames report progress.

How results come back:

1. When a unit passes, its branch joins one integration lane and is merged into the contract's branch, one unit at a time, in the order units finish.
2. A unit whose branch conflicts during that merge is not merged as it is; its worktree and `ws-owned/<id>` branch are kept, the lane continues with the next unit, and the work plans a repair step (within `contract.maxFixRounds`). The host brings the other branch into the repair step's tree, so the conflicting files hold both sides between conflict markers; the step's agent combines them, the host finishes the merge, and the step is checked like any step. A repair that leaves markers waits for you in every permission mode: the work waits in Work for you to keep the first change, keep the second, or stop (the work's `a` answer, its Answer chooser), and also in Waiting for you; no decision model chooses it in your place. Stopped, the work ends failed with both changes kept on their branches, named in its line. A conflict no repair can be planned for (its fix rounds used up) ends the work failed.
3. When every unit has passed and the contract's checks pass, the contract's result is published to the project's branch. With `contract.autoCommit` on (default) it is merged with `git merge --no-ff` and the commit message names the contract; `contract.commitScope` `off` leaves it as uncommitted changes.
4. If the project's files changed after the contract started, the result is applied as uncommitted changes on top of those edits, and the automatic commit is deferred.
5. If the result cannot be put in (the merge conflicts with the project's own edits, a rebase or merge of the owner's is under way, a hook of the project refuses), the merge is aborted, the project's tree is put back as it was, and the result stays on branch `<branch>`. What comes next waits for you in every permission mode: the work waits in Work for you to clear what blocks it and answer `retry` (put it in again) or `cancel`; no decision model answers it in your place, and each try runs the project's hooks once. Not put in (your `cancel`, or a third failure), the work ends failed, its line saying what failed and that the result is on its own branch: in Work, History, merge it in or discard it. To take it by hand, run `git merge <branch>` and resolve the conflicts.

What is left behind:

- A unit that passed and merged: its worktree is removed.
- A unit that failed or was cancelled: its worktree is removed only when it holds nothing unique (no uncommitted changes, no commits beyond the contract's branch); installed dependency folders (`node_modules`, `.venv`) and the product's own `.goodvibes/` folder are not unique work. Otherwise it is kept, and the oldest kept worktrees are removed first when too many are kept.
- A unit whose merge conflicted: worktree and branch kept.
- When the contract ends, whichever way (passed, failed, cancelled, or ended at the next start after a crash), its own worktree, its captured-input view and every unit worktree inside it are released at once when they hold nothing beyond the project's branch, the captured input (the commit made from your uncommitted files when the contract started; your checkout still has them) and the contract's branch; their branches go with them. One that holds work is kept: the contract's end line says where it is and how to take it (`git merge <branch>`), a worktree with uncommitted changes is named once more with its next steps at the next start, and the Worktrees list of Code and changes shows it for as long as it stays. The start-up pass applies the same rule to worktrees whose contract ended while no program was running.
- On restart, a passed unit whose branch had not been merged is put back on the integration lane, and worktrees on disk that belong to known units are adopted or reported, never deleted.
- "Remove a worktree" (Code and changes, Worktrees, `x`) removes a kept worktree after asking (refused with the reason when it holds unique work); "Keep a worktree" (`k`) marks one to keep. A keep, pause, resume or attach made while the retention sweep is already removing that worktree is refused with the reason, never recorded and then ignored; one made before the sweep claims the tree keeps it.

The worktree capabilities, each a control on the Worktrees list of Code and changes and found and run by the model:

| Capability | Effect |
| --- | --- |
| `worktree.review` | Every worktree with its state, branch, setup and why it is kept (the list itself). |
| `worktree.inspect` | One worktree's state, owner, session, task and setup (the selected row's detail). Unknown: `No tracked worktree at <path>.` |
| `worktree.setup` | Run the cold-start setup again; the worktree then shows how it went. |
| `worktree.attach` | Tie a worktree to a session or task. |
| `worktree.attached` | Worktrees of one session or task. |
| `worktree.recover` | The worktrees of a session or task and what brings each back. |
| `worktree.pause`, `worktree.resume`, `worktree.keep` | Change a worktree's state (`Paused "<branch>".`). |
| `worktree.discard` | Asks, then has the daemon remove it; a worktree with unique work is refused with the reason. |
| `worktree.cleanup` | Asks, then removes a worktree's tracking after it is gone (`Stopped tracking "<worktree>".`). |

<!-- generated: settings:worktree -->

<!-- generated: settings:agents -->

<!-- generated: settings:orchestration -->

## Contracts and work

### Contracts

A contract is a tracked piece of delegated work: a goal, units of work, acceptance criteria checked when the work ends, a budget, and an owner who answers its questions.
The planner arranges a contract's units in groups. A group is a set of units that may run at the same time; a group starts once every group it depends on has passed, its units run side by side (up to `contract.maxParallelUnits` in worktree mode, one at a time in shared mode), and when all of them have passed the group as a whole is checked before the groups that depend on it start. The contract passes when its last group and the whole deliverable pass their checks.
Contracts run on the daemon, each as a piece of work in the Work place (its plan, steps and results).
A contract that needs the owner raises a question (an escalation) in Waiting for you; the work continues after the answer.
`contract.*` settings control gates, budgets and limits. Nothing in Work stops on a clock: a step runs until its agent's turn ends, its process exits, its connection closes, the provider answers an error, or the owner or a decision stops it; a gate command runs until it exits. A quiet step's row says since when it has been quiet, with the work's stop beside it.
A gate runs only for work that changed something it checks: `typecheck` a script source (`.ts`, `.js` and their kin) or a TypeScript or package configuration, `lint` a script source or an ESLint or package configuration, any other gate any changed file. A unit that changed no file (a read-only review or research unit) runs no gate, shows no gate line and is never nudged for one. In a worktree, which git creates without ignored folders, the project's installed dependencies (each `node_modules` folder the checkout it came from has, where git ignores it) are linked in, so a gate runs the project's own scripts as they run in the project. When there are none to link, the gate is reported once per contract as `could not run here: the project's dependencies are not installed where the work is`; it is not the unit's failure and nothing is asked of the unit for it. A skipped gate is shown as skipped, never as a failure.
Every check a contract asks of the decision model has a fallback. When the decision model cannot make a check (it fails, does not answer, or refuses the request), the check is decided by code, as with no decision model in use, and recorded as not judged with the reason: the work is kept as delivered, the contract goes on with its other units and finishes, and nothing written is thrown away. The owner sees one line about it (the decision model's own failure notice, or, for a refused request, `[Contract] <id>: the decision model could not judge part of this work (<reason>); that work is kept as delivered and the contract goes on. Its result lists what was not judged.`). The contract's result then says which units were judged and passed, which were delivered but not judged and why, which were not delivered, and where the work is. A contract fails only when its work failed, never because its checks could not be made; this holds under `Decision Model Only` too.
When no configured, healthy provider serves a model for a contract's planner, the contract does not fail: it keeps its `planning` state and waits, and says so once, to the owner as a notice and on its row in Your agents (where its session's model reads it too): `[Contract] Contract <id> is waiting: no model can be routed to plan it (<why>). It plans on its own as soon as a provider that serves this work is available: signed in, configured, or answering again. Cancel the contract to stop it.` It plans as soon as the providers or their models change (a key or sign-in, a provider file, a model list read again) or a provider's hold after a failure ends or a call to it succeeds; it is not read again otherwise. A turn waiting on the contract's agents stops waiting and the model reads the line. Under `Decision Model Only`, a decision model that cannot read the route still ends planning.
A request to the decision model is sized to what its endpoint reads in one request (the documented limits of the System One wire without its long-context mode, a Cloudflare target's context, and a target's `maxInputBytes` and `maxQuestions`). A request larger than that is split by question: questions that fit beside the whole evidence go together, and each one that does not is asked with the parts of the evidence most related to it (array items, fields and text segments scored by the question's words). Every part left out is marked `left out of this request` where it was; the host keeps the complete evidence.
At start the daemon resumes the contracts that had not ended. One it cannot run is held, not run, and its status (`contracts.status`) carries `held` with the code and reason: `input-unavailable` when its recorded input could not be restored (cancelling it ends it as cancelled), `claim-unavailable` when no run claim could be taken in the project's `.goodvibes/contracts` directory (another process may be running it, so it is not cancelled from here: `CONTRACT_HELD`). The input check makes sure the work resumes from exactly the input it started from: the project folder is still at the recorded path as a repository root, the recorded input commit is in it with the recorded files, and the input view, where one is kept, still holds them. It compares content and path, never inode or device numbers, so a project folder copied, moved back or restored from a backup resumes; the contract's worktrees are checked the same way (path, `.git` pointer, Git's own binding, branch). A held contract is said to you and to the model in one line beside the other resumed-contract lines: `[Contracts] Contract <id> ("<goal>") was running when the app stopped and is held, not continued: <what could not be restored>. Nothing of it was changed; <units finished>. To go on: put the project back as it was at <path> and restart, and it continues; or stop it (in Work and agents, on the Work tab, the work, `x` "stop") and ask for the work again, which starts a new contract.` The planner agents a contract runs for its plan and its fix plans report through the contract, never as `[Background work]` lines of their own. A contract whose resume throws is left on disk unchanged and reported for itself (`CONTRACT_NOT_RESUMED`, with `See it in the Work place, then restart to try again.` and `Or cancel it: goodvibes-contract cancel <id>.` as next steps) while the others still resume. When resuming fails as a whole, the daemon records `Saved contracts could not be resumed at start-up: <reason>. They are still on disk; restart to try again. Your work is in Work.` as a receipt the next attached terminal or web UI shows.
A kill of a workstream unit while its gates run stops the gates and commits nothing; the phase reads cancelled.
A reply that a failure question does not accept is refused before anything is taken, so a shared-tree contract does not take the tree for it.

<!-- generated: settings:contract -->


### Work

Work is one thing, held and run by the daemon: the same work in the terminal app, the Agent, the web UI and on a phone, and it goes on when the window that asked for it closes. The Work place (the menu, `Ctrl+G` then `m`, row "Work and agents"; or `/work`, which opens it) shows it, read by itself and read again whenever a request, the ledger or a run changes anywhere:

- Work: each piece of work by what you asked for and where it stands (not started, its plan waits for you, starting, its start cut off, running, needs you, a step failed, done, failed, stopped). Its detail: what you asked for, what done means, its plan as steps with where each stands and what each waits on, its results, the questions it waits on, the step it stopped at and what failed, its report and its spending limit. A step that fails (its agent failed: the connection to its model failed and its transport could not make it again, the provider refused, ...) ends failed at once with what failed in words, and Work runs nothing again by itself. In every permission mode the work stops at that step and waits for you (the menu's count for Work counts it), and a restart of the daemon keeps it waiting there; no decision model answers it in your place. A step not run again (your answer, or its third failure) ends the work failed, its line naming the step and what failed. Only a stop someone made reads "stopped": yours; the daemon closing reads as cut off. The keys shown are the ones that apply to the selected work: `s` start (not started), `x` stop (live work, a failed step included; it cannot be undone, so it asks), `t` run this step again (a step failed), `g` go on without it (a step failed and no step still to run needs its result; not shown otherwise), `g` go on (a start cut off by a restart), `a` answer what it asks (needs you: a question the work itself asks, which Waiting for you shows too), `b` change what it may spend (live work), `v` check where it stands. The model, an outside agent and a script reach the same acts as `work.retry`, `work.go-on-without` and `work.cancel`.
- A plan that waits for you: with "Show me the plan before it runs" on (off by default), starting a piece of work writes its plan and holds it. `e` changes a step, `m` moves a step, `d` takes a step out, `w` writes the plan again, `Enter` approves it (the work starts with exactly those steps), `X` throws it away (it asks; the work stays, not started).
- Plan mode: the model in plan mode only reads, but it can propose a piece of work with its plan (`work.propose`). The proposal waits in Work exactly like a held plan, with the same keys; approving it asks for the work and starts it with that plan, and throwing it away leaves nothing. Nothing runs until you approve.
- Asking for work: say what you want in the conversation and the daemon decides whether it is an answer or a piece of work. In the place, `n` New work takes what you want done and the results that mean it is done (1 to 100 lines, each at most 20,000 characters, 262,144 bytes in all), or, in its "From a file" field, a JSON file with "goal" and "criteria"; `y` asks in your own words. Nothing starts until it is started.
- History: finished and stopped work, and work carried in from old planning records.
- Unanswered: the work you asked for and the message you typed that have no answer from the daemon yet (a copy is kept by the program that sent it, so a lost answer is safe to send again). On work you asked for: `v` check, `t` send again, `X` drop (it asks). On a message: `v` check, `t` try again, `g` go on, `X` drop (it asks).
- Checklist: the project's running list of things to do, which the model keeps with its `work_plan` tool while it works (its open items reach the model once per turn) and you add to (`p`), change (`Enter`), mark (`m`), move on (`o`), take off (`x`) and clear of finished items (`C`); `M` shows it as Markdown and `E` saves that to a file. It records things to do and runs nothing; it is a checklist, never a plan. Changes from the place are yours: the model's own changes go through its tool.
- Remote runners, their pools and what they hand back (described with the remote runners).

The model and agents outside GoodVibes reach the same acts by find and run (`work.list`, `work.start`, `work.status`, `work.cancel`, `work.resume`, `work.answer`, `work.retry`, `work.budget`, `work.approve`, `work.step-edit`, `work.step-move`, `work.step-drop`, `work.plan-redo`, `work.plan-discard`, `work.propose`, `work.new`, `work.request`, `work.submission*`, `work.intake*`, `work.checklist` and the other checklist ones); a script with `goodvibes do <id>`. Each act on a piece of work runs on the daemon, naming only the work. A step of work runs again only after it failed (it answers that step's retry question).

Old planning records an earlier version's planning interview kept (its planning state, work plans and decisions; the checklist stays the checklist) are carried into Work by the daemon at the first start of this version, nothing dropped and the old records left as they were; one line says how many pieces of work were carried, and they show under History. A record that could not be carried is said in one line and tried again at the next start.

## Memory and knowledge

### Session memory

Session memory is text pinned to this session; it survives compaction.
Add to it with `!# <text>` (pins and sends) or `# <text>` (saves and sends nothing). Notes kept for good, beside every conversation, are the Notes tab of Memory and knowledge.
Durable records that apply to this session only are memory records whose "Where it applies" is This session ("Remember something", `n` in Memory and knowledge).

### Durable memory

Durable memory is a store of records shared by every GoodVibes program on the machine, in `~/.goodvibes/shared/memory.sqlite` (read and written through the daemon while it serves memory).
Each record has a class, a scope, a summary, optional detail and tags, a confidence, a review state and its provenance (where it came from).

| Field | Values |
| --- | --- |
| class | `decision`, `constraint`, `incident`, `pattern`, `fact`, `risk`, `runbook`, `architecture`, `ownership` |
| scope | `session`, `project`, `team` |
| review state | `fresh`, `reviewed`, `stale`, `contradicted` |

Records that match a turn can be added to the model's context; "What a task gets" (`w` on the Memory tab) shows which would be, and `Ctrl+G` `e` (or `F7`) lists the memories the last turn used.

### Memory and knowledge, the place

Memory, knowledge, what is known about you and your templates are in **Memory and knowledge** (the menu, `Ctrl+G` then `m`, or `/memory`, which opens it), the same place in both programs and the web app's Library. Everything in it is kept by the daemon, so the web app, a script and the model see the same; its tabs read by themselves and read again when something changes anywhere. Each action asks for what it needs in a form (a record, a copy, a connector or a template picked from its live list), says what it will do in one sentence, and runs when the form is submitted; only an act that cannot be undone or that loosens a protection asks first. The keys below are the defaults; each can be rebound in the Keys tab of System.

| Tab | Keys |
| --- | --- |
| Memory: the records, newest first; a record not reviewed is marked, one out of date or contradicted needs a look | `Enter` the whole record (where it applies, detail, tags, where it came from, links); `e` correct it in place (it keeps its id, kind, origin and links); `v` say whether it is still right (marking it reviewed counts only from you); `p` change where it applies (this session, this project, the team); `l` link it to another; `x` forget it (asks first: it cannot be undone); `s` search (by the words, or by what they mean through the semantic index); `w` what memory a task would be given; `i` what memory each recent turn (of this session, or of one agent) was given, terminal app only; `c` remember an incident report, the last policy check, or a tool server's or plugin's trust as a record; `g` the memory settings |
| Proposals | What tidying memory proposes while you are away: two records that disagree, the same record twice, one out of date. `Enter` shows the first record it names |
| Copies and files | The copies of memory (daily, before a migration, before a restore); `u` replaces all memory with one, copying the current records first (yours only; asks first). `o` save memory to a file (a team handoff is the team's records), `k` read a memory file, `m` load one (records already there are left as they are); a model may name only a path inside the project. `f` keep memory as Markdown files in their own repository (the setting `memory.projection.dir`, default `.goodvibes/memory/projection`, a folder in the project), `d` see what your edits to them would change, `t` take chosen changes into memory (yours only): a file still as written is never read as an edit, a file whose top lines were broken is reported as unreadable, never as a deletion, and a field both you and memory changed is not taken. `h` the semantic search index: each stored vector records the embedding space it was made in, so after the embedding provider or its model changes it shows how many wait to be embedded again; `b` rebuilds it |
| Sources, Entries, Issues, Jobs, Connectors | Your structured knowledge, one store for both programs and the web app (the Agent's earlier Agent Knowledge was carried into it once). `Enter` one in full. Sources: `s` search, `t` how it stands, `f` add a file, `u` add pages from a list of addresses, `b` add a bookmarks export (Netscape HTML, a Chrome or Edge `Bookmarks` file, or bookmark JSON), `h` add your browser history (yours only), `j` add a saved artifact. Entries: `m` the map, `k` what a task would get, `c` what could be merged, `z` tidy (a quick or a deep pass), `o` what tidying did, `w` when it is tidied, `i` rebuild. Issues: `v` review an open one (accept, reject, resolve, reopen, accept with changes, or forget, which cannot be undone), `l` check for problems. Jobs: `x` stop a waiting or running one. Connectors: `d` check one, `g` add something through it. Everywhere: `a` add a web page, `q` ask your knowledge (an answer with its sources, facts, linked entries and how sure it is). A private-network address is refused unless the form allows your network, which loosens a protection and is asked first |
| About you | Your profile, each fact with where it came from (People included, since you are reading it). On a fact: `Enter` where it came from and the values it replaced, `c` correct it, `u` put back its earlier value, `x` forget it (asks first); on a line: `x` forget it. `f` record a fact, `o` add a line, `y` what is known about a person, `t` whether it loads, `w` all of it as text. A write is yours only: the model records a fact with its `profile` tool. A profile that cannot be read says so on its one row |
| Templates | Your prompt templates, this project's and every project's. `Enter` see one, `u` use it as your next message (its blanks filled from the form), `e` edit it in your editor (`$VISUAL` or `$EDITOR`), `x` delete it (asks first), `s` keep your last message as one |
| Notes, Personas, Routines, Drafts, Artifacts | The Agent's own stores (see "How the Agent differs") |

Every action is a capability the model reaches with `capability_find` and `capability_run`, an outside agent with `capabilities.find` and `capabilities.run` (HTTP, WebSocket, `goodvibes-daemon mcp serve`) and a script with `goodvibes do <id> --input name=value` (and `goodvibes find "<need>"`): `memory.list`, `memory.add`, `memory.search`, `memory.show`, `memory.edit`, `memory.review`, `memory.promote`, `memory.link`, `memory.remove`, `memory.queue`, `memory.explain`, `memory.export`, `memory.inspect`, `memory.import`, `memory.snapshots`, `memory.restore`, `memory.index`, `memory.rebuild-index` and the `knowledge.*`, `about-me.*` and `template.list|show|delete` ones run in the daemon; `memory.injections`, `memory.capture`, `memory.sync-files`, `memory.review-files`, `memory.apply-files` and `template.use|save|edit` run in the program holding the conversation, so `capabilities.run` and `goodvibes do` refuse them in one line. `memory.restore`, `memory.apply-files`, `knowledge.import-browser-history` and the `about-me.*` writes are refused to the model as the owner's own acts.

Every record keeps who wrote it, from the credential the daemon checked (never a field a caller sends): you (from any of your credentials: your own press or typed words, a paired device, the machine's token and any script using it, a typed `do`, the MCP set-up, or your yes in Waiting for you), your model in your own conversation, or someone else (a guest or a channel stranger, a turn on someone else's input, text read from outside). A write from one of your credentials runs at once and is yours; a record a model writes (`memory.add`, `memory.import`, `notes.to-memory`, or a correction or move of one of yours) is decided when it is written, as any write that steers the model, by its row under the mode in force; once written it is given to turns as any record, its author shown on its "Written by" line, and a conversation it enters counts from then on as having read text from outside. Records kept before authors were kept (3.5.0, or earlier in this version) are yours. A session a caller names as where a record came from is kept only when that caller registered that session. `memory.add`, `memory.edit`, `memory.promote` and `memory.import` write what steers a model: a model's call of them is decided by that row under your mode, like the other risky classes, and your own `do` of them runs at once.

Worked example (a script; it writes what steers a model, so the daemon decides it under your permission mode: under YOLO it runs at once, under Ask me your card asks it and the command waits on your answer, under Jev decides Jev decides it):

```text
goodvibes do memory.add --input class=decision --input "summary=Use Postgres advisory locks for the job queue" --input tags=queue,db
Remembered "Use Postgres advisory locks for the job queue".
Its id is mem_<id>.
```

<!-- generated: settings:memory -->

<!-- generated: settings:learning -->

## MCP servers

The terminal app connects to MCP (Model Context Protocol) servers and gives their tools to the model as `mcp:<server>:<tool>`.

### Where servers are configured

| File | Scope | Written by `/mcp add` |
| --- | --- | --- |
| `<project>/.goodvibes/mcp.json` | Project | Yes, with `--scope project` (the default) |
| `~/.config/mcp/mcp.json` | Global | Yes, with `--scope global` |
| `<project>/.mcp/mcp.json` | Project, read only | No |
| `~/.mcp/mcp.json` | User, read only | No |
| `~/.config/claude/claude_desktop_config.json` | Claude Desktop's servers, read only | No |

Project files start no server until the workspace is trusted ("Trust this folder" in Permissions and safety, This folder); an undecided workspace counts as untrusted.
A file that cannot be read is skipped with one warning.
When two files name the same server, the files are taken in this order and a later one's entry is used: `~/.mcp/mcp.json`, Claude Desktop's file, `<project>/.mcp/mcp.json`, your `~/.config/mcp/mcp.json`, then `<project>/.goodvibes/mcp.json` (once the workspace is trusted). So your own global entry wins over another program's entry of that name (its command, url and policy), and `/mcp add --scope global` takes a server over from another program's file. A denial only tightens: the merged entry keeps the `deniedTools` of every file that named the server, and the strictest `trustMode` any of them set (`blocked`, then `constrained`, `ask-on-risk`, `allow-all`; an unset mode counts as `ask-on-risk`).

```json
{
  "servers": [
    { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>" } },
    { "name": "remote-docs", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer <your-token>" }, "toolTimeoutMs": 300000 }
  ]
}
```

Every one of these files may instead use the format other MCP clients use, an object keyed by server name. Both forms are read. When GoodVibes rewrites one of its own two files (`/mcp add`, `/mcp remove`, a kept per-tool rule), it writes the `servers` list form shown above, keeping the entries it could not read:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>" } }
  }
}
```

A server has a `command` (a local process speaking over standard input and output) or a `url` (a remote HTTP server).
A server name may not contain `:` or `/`.
A tool call waits up to 120 seconds; `toolTimeoutMs` changes it (`0` for no limit).

Fields of a server entry that control what it may do:

| Field | Type | Meaning |
| --- | --- | --- |
| `trustMode` | `constrained`, `ask-on-risk` (default), `allow-all`, `blocked` | How calls are enforced (below). `allow-all` is read only from `~/.config/mcp/mcp.json`; in a project file it is ignored with a warning and the default applies. |
| `allowedPaths` | array of string | Directories the server's path arguments must stay inside. Empty or absent: paths are not checked. `/mcp add --path <dir>` adds one (repeatable). |
| `allowedHosts` | array of string | Hosts the server's URL arguments must use. Empty or absent: hosts are not checked. `/mcp add --host <host>` adds one (repeatable). |
| `role` | `general` (default), `docs`, `filesystem`, `git`, `database`, `browser`, `automation`, `ops`, `remote` | A label shown in `/mcp review` and the posture report. It changes no enforcement. |
| `deniedTools` | array of string | Tools refused every time, whatever the trust mode. Any MCP file may carry it. |
| `allowedTools` | array of string | Tools let past `allowedPaths` and `allowedHosts`. Read only from your own files; one in a project file is ignored with a warning. |

### What the trust modes enforce

Every MCP call first passes the permission gate like any other tool call: the permission mode and `permissions.tools.mcp` (`allow`, `prompt` (default) or `deny`) decide whether it may run and whether the owner is asked. Then the server's own rules decide, in this order, with no further question to anyone:

1. A quarantined server's tools, or a server with `trustMode` `blocked`, are refused.
2. A tool in the session denials or in `deniedTools` is refused; a tool in `allowedTools` is allowed.
3. With `allow-all`, every other call is allowed.
4. With `constrained` or `ask-on-risk`, a call whose path arguments are inside `allowedPaths` and whose URL arguments use `allowedHosts` is allowed. One outside them is refused under `constrained`: `request exceeds configured scope for server '<name>': ... Call it with values inside the scope, or ask the owner to widen the server's scope.` Under `ask-on-risk` it is put to you on an approval card, in every permission mode (`yolo` included; held for you in `just-vibes`), with the reason `The tool server <name> is set to ask you before anything outside its limits, and this call to <tool> is outside them: <value> is not in a folder it may use (<folders>).` (or `<value> is not a site it may reach (<sites>)`), and the card's "Only you decide this:" line names the same cause, never a rule of yours; it is sent only if you allow it, otherwise the model gets `MCP call '<qualified name>' was not allowed: <reason>`. Its card offers the usual remember options, as for any call put to you. To allow more, change the server's limits or its trust level in Tools and extensions. Where nobody can be asked (a host with no permission owner), it is refused: `... Nobody can be asked from here, so it was not sent.` Only the limits set are checked: a server with no `allowedPaths` has no folder outside its limits, and one with no `allowedHosts` no site.

The places say each level in these words (the Servers tab's Trust line, the set-trust and add forms' choices, Settings → MCP): `ask-on-risk` "Act inside its limits without asking" (a server with no level kept has it), `constrained` "Refuse calls outside its limits", `blocked` "Refuse every call", `allow-all` "Do not hold it to its limits"; each choice's sentence says that a call it lets through still goes as your permission mode allows. The Servers tab's "Its limits" line says what is checked ("1 folder, any site"; "no folders or sites set, so no call is outside its limits").

Besides that, they differ in the risk level `/mcp review` reports for the server: `constrained` is `low` (`medium` when either scope list is empty), `ask-on-risk` is `medium` (`high`), `allow-all` is `high` (`critical`), and `blocked` or a quarantined server is `critical`.

There is no allow-list of tools. `allowedTools` does not limit a server to those tools: it only lets them past the path and host scope. To let the model use only some of a server's tools, block each of the others:

```text
/mcp tools github
/mcp block github delete_repository --keep
/mcp block github create_or_update_file --keep
/mcp block github push_files --keep
```

The same rules written by hand in the server's entry:

```json
{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "trustMode": "ask-on-risk", "deniedTools": ["delete_repository", "create_or_update_file", "push_files"] }
```

A tool the server adds later is allowed until it is blocked. To refuse every tool of a server, set `trustMode` to `blocked`.

### Where each rule is kept

- `/mcp trust` and `/mcp role` write `trustMode` or `role` into the file that holds the server's entry (`<project>/.goodvibes/mcp.json` or `~/.config/mcp/mcp.json`) and apply it at once; it holds after a restart: `<server> is set to "<mode>". Kept in <scope> MCP config <path>; it applies now and after a restart.` A server that comes only from a read-only file gets the value for this session only, and the line says why: `It is set for this session only (<reason>).` `/mcp restore-trust <server>` and `/mcp restore-role <server>` end a value set for this session only. A value set for this session belongs to the program it was set for: when a reload puts a different program behind the name (another file, command, address or environment), the value ends and the server runs under its configured trust mode and role. Both programs take `allow-all` and `ask-on-risk` from `/mcp trust` and `/mcp add --trust`; each loosens a protection, so only your own line sets it (a model's line is refused); `/mcp trust <server> constrained` sets it back. Settings → MCP keeps a trust mode the same way (`<server> trust mode is <mode>, kept in <scope> MCP config <path>: it applies now and after a restart.`). `allow-all` is read only from `~/.config/mcp/mcp.json`: written to a project file it is ignored when the file is read.
- `/mcp block <server> <tool>` lasts for the session. With `--keep` it is written as `deniedTools` into the file that holds the server's entry (`<project>/.goodvibes/mcp.json` or `~/.config/mcp/mcp.json`). `/mcp unblock` removes the block, this session's and the kept one.
- `/mcp exempt` writes `allowedTools` into `~/.config/mcp/mcp.json` only; for a project server it is refused. `/mcp unexempt` removes it. `unblock` and `unexempt` each drop only their own kind of rule, and say so when the tool has none: `<tool> on <server> is not blocked; nothing changed.`
- On a server's row in Settings → MCP, typing `block`, `unblock`, `exempt` or `unexempt` (a tool name after it is optional) closes Settings and opens that `/mcp` action for the server: it asks for the tool and how long when they are missing, and says what it will do before it does it.
- A server that comes only from a read-only file (`.mcp/mcp.json`, `~/.mcp/mcp.json`, Claude Desktop's file) cannot keep per-tool rules: `Add <server> to your own MCP config (/mcp add with --scope global) to keep per-tool rules, or block it for this session only: /mcp block <server> <tool>.`
- A rule written while a server runs applies at once.
- The daemon runs the same actions for the web UI and scripts, each method named by the action's word: `mcp.servers.tools.block`, `.unblock`, `.exempt`, `.unexempt` (each kept with the server's entry; a block for one terminal's session is that terminal's), `mcp.servers.trust.set`, `mcp.servers.role.set`, `mcp.servers.reload`, `mcp.servers.quarantine.accept`, `mcp.servers.upsert` (Add a server) and `mcp.servers.remove`. `unblock`, `exempt`, a looser trust level and accepting changed tools are the owner's own acts: refused for the Agent's model. Going back to a saved trust level or role and holding tools back act on one terminal's session, so they are done there.
- `deniedTools`, `trustMode` `blocked`, the path and host scope and quarantine are enforced by the MCP registry itself, so they apply in every permission mode, `yolo` included.

### `/mcp`

Tool servers are two tabs of Tools and extensions, in both programs: Servers (this program's own connections: each server, connected or not, its trust level, role and per-tool rules) and Server files (what the MCP config files keep, read from the daemon). `/mcp` typed alone opens the place on Servers; from a model or a script it is the servers report. Each action is a key on the selected server (or on the tab, for those that act on every server); one with blanks opens a form built from its inputs, with the server already given. What the config files keep is written by the daemon, and the program reads its config again at once; this program's own connections and its session's settings are changed in the program. The same actions are typed after `/mcp`, and are the capabilities named, which the model, an outside agent and a script find and run.

| Action | Control | Capability, line | Risk |
| --- | --- | --- | --- |
| See your servers | the Servers tab | `mcp.servers`, `/mcp servers` | |
| See a server's tools | `t` | `mcp.tools`, `/mcp tools [<server>]` | |
| Block a tool | `b` | `mcp.block`, `/mcp block <server> <tool> [--keep]` (this session only; `--keep`: until you unblock it, as `deniedTools`) | |
| Stop blocking a tool | `u` | `mcp.unblock`, `/mcp unblock <server> <tool>` (picks from the tools blocked) | loosens a protection |
| Let a tool go beyond its server's limits | `g` | `mcp.exempt`, `/mcp exempt <server> <tool>` (`allowedTools` in the global file) | loosens a protection |
| Make a tool follow its server's limits again | `G` | `mcp.unexempt`, `/mcp unexempt <server> <tool>` | |
| Add a server | `A` | `mcp.add`, `/mcp add <name> [--url <https address>] [--scope project\|global] [--trust <mode>] [--role <role>] [--path <dir>]... [--host <host>]... [--env NAME=VALUE]... [--header Name=Value]... [-- <command and its arguments>...]` (see "Adding a server") | `allow-all` and `ask-on-risk` loosen a protection |
| Remove a server | `x` | `mcp.remove`, `/mcp remove <server> [--scope project\|global]` | cannot be undone |
| Reconnect every server from its config | `R` | `mcp.reload`, `/mcp reload` | |
| Set a server's trust level | `s` | `mcp.trust`, `/mcp trust <server> <constrained\|ask-on-risk\|blocked\|allow-all>` | `ask-on-risk` and `allow-all` loosen a protection |
| Go back to the saved trust level | `S` | `mcp.restore-trust`, `/mcp restore-trust <server>` | loosens a protection |
| Set a server's role | `y` | `mcp.role`, `/mcp role <server> <general\|docs\|filesystem\|git\|database\|browser\|automation\|ops\|remote>` | |
| Go back to the saved role | `Y` | `mcp.restore-role`, `/mcp restore-role <server>` | |
| Hold back a server's tools for review | `q` | `mcp.quarantine`, `/mcp quarantine <server> [<why>]` (this session only) | |
| Accept a server's changed tools | `a` | `mcp.accept-tools`, `/mcp accept-tools <server>` | loosens a protection |
| See which servers need attention | `W` | `mcp.review`, `/mcp review` (`✓ Every MCP server is working.`, or one `✕` line per server and how to fix it) | |
| See how to fix a server | `f` | `mcp.repair`, `/mcp repair [<server>]` | |
| See where servers are configured | the Server files tab | `mcp.files`, `/mcp files` | |

An action marked "loosens a protection" only counts when you type it or choose it: a model's line is refused before anything is asked. Old spellings (`deny`, `allow`, `clear`, `config`, `auth-review`, `trust <server> config`, `quarantine <server> approve`) are not accepted; the refusal lists the actions.

### Adding a server

`A` on the Servers tab opens the form (how it starts, the command or address, its name, then what it may do). Typed, `/mcp add <name> -- <command> [words...]` (or `/mcp add <name> --url <https address>`) writes the server to `<project>/.goodvibes/mcp.json` (`--scope project`, the default) or `~/.config/mcp/mcp.json` (`--scope global`) and reloads.
The words after `--` are the command and its own `args`, passed unchanged, including words that look like GoodVibes options (`--path`, `--host`, `--env`, `--scope`). Words after the name that are not GoodVibes options and come before any `--` are read the same way.

```text
/mcp add data --scope global -- /usr/local/bin/my-mcp-server --path /srv/data --verbose
```

The entry gets `"command": "/usr/local/bin/my-mcp-server"` and `"args": ["--path", "/srv/data", "--verbose"]`; before `--`, `--path /srv/data` would set the server's `allowedPaths` instead.

Refusals (nothing is written):

| Input | Message |
| --- | --- |
| A server at a web address with `--env` | `A server at a web address takes no environment; send credentials as a header.` |
| A command server with `--header` | `Headers are sent only to a server at a web address; a command takes environment entries.` |
| `--env` or `--header` without `=` | `Environment entries are NAME=VALUE; "<entry>=" was not.` (or `Header entries ...`) |
| An unknown `--role`, `--scope` or `--trust` value | `Role: "<value>" is not one of general, docs, ...` (or `Kept for`, or `Trust`) |
| `--trust allow-all` or `ask-on-risk` | Asks first (it loosens a protection); refused when a model runs it. |

`--env` values are written into the file as given; the file is the server's own configuration, so keep it private.

Worked example:

```text
/mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=<your-token> --scope global -- npx -y @modelcontextprotocol/server-github
/mcp tools github
/mcp block github delete_repository --keep
```

A server that fails to connect is retried after 1, 2, 4, 8 and 16 seconds while `runtime.mcpLifecycle` is on (the default); after five failures it stays disconnected until "reconnect every server" (`R` on the Servers tab). A server that refuses its credentials is not retried: it waits in `auth_required`, and a call to one of its tools says `the server refused its credentials, so it is not retried; it reconnects as soon as its entry is saved with new ones (/mcp add under the same name, with its --header or --env)`: saving the entry reconnects it, from the Servers tab, through `/mcp` or by hand (before each MCP call both programs compare every MCP config file's modification time and size with the ones last read, and read a changed file again first). A change kept in a server's MCP config before any server started (the Agent starts them on first use) writes to the workspace the program runs in and starts them. A server that exits on its own is restarted the same way, with the same checks as its first connect.
A server that never completes its handshake is given up after 30 seconds.
"Run MCP servers inside the sandbox" (Permissions and safety, Sandbox setting) runs MCP servers inside the command sandbox in every program; the running ones restart inside it at once, and one in the middle of a call when that call ends.

## Plugins

A plugin is code loaded into the app process that registers commands, tools, providers, hooks, views and more.

### Where plugins live

The loader searches exactly these directories, in this order; a project plugin overrides a global one with the same manifest name:

1. `<project>/.goodvibes/plugins/<name>/`
2. `~/.goodvibes/plugins/<name>/`

"Where they are looked for" (`D` on the Plugins tab of Tools and extensions, `plugin.dirs`) lists them. Each plugin directory holds `manifest.json` and an entry file (`index.js` unless `main` names another):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "main": "index.js",
  "capabilities": ["register.tool", "register.hook"]
}
```

`name` is lowercase letters, digits and hyphens. `capabilities` declares what the plugin needs: `register.tool`, `register.provider`, `register.hook`, `register.panel`, `filesystem.read`, and the high-risk `filesystem.write`, `network.outbound`, `shell.exec`.
A tool, provider or event-hook registration the manifest does not declare is refused and the plugin does not start.

### Plugins are off until enabled

A plugin that is found is not loaded until it is switched on. `o` on it in the Plugins tab (`plugin.enable`) loads and starts it at once and records the choice (with the directory it was enabled from) in the daemon's one plugin state; from then on it starts with the app. `o` again (`plugin.disable`) stops it and records that. A newly written plugin therefore needs switching on, not only a restart.

### The entry file

The entry file is an ES module. It must export `init(api)`, called once after the plugin is loaded; it may also export `activate()` (called after `init`) and `deactivate()` (called before the plugin is unloaded, and also when `init` finished but `activate()` then failed, so what `init` started is stopped). Each may be `async`.

The `api` object has exactly these members:

| Member | What it does | Needs |
| --- | --- | --- |
| `registerCommand(name, description, handler)` | Adds the slash command `/plugin-<plugin name>-<name>` (named after the plugin, so two plugins cannot collide). `handler(args, context)` receives the typed words and `context.print(text)`, which shows text in the session that typed the command; an error it throws is shown there. | Any tier. |
| `registerTool(name, schema, handler)` | Adds a tool the model can call. `schema` is a JSON Schema object for the tool's arguments; `handler(args)` returns `{ success, output?, error? }`. Registering a name twice fails the plugin's start. | `register.tool`, tier `limited`. |
| `registerProvider(name, { baseURL, apiKey?, models, displayName?, embeddingModel? })` | Adds an OpenAI-compatible provider. Returns a promise. | `register.provider`, tier `limited`. |
| `registerProviderInstance({ provider, models?, suppressCatalogModelRegistryKeys?, replace? })` | Adds a fully custom provider implementation. | `register.provider`, tier `limited`. |
| `onEvent(eventName, handler)` | Subscribes to one runtime event type (the events part lists them); returns an unsubscribe function. | `register.hook`, tier `limited`. |
| `registerGatewayMethod(descriptor, handler)` | Adds a daemon operator API method. | Tier `limited`. |
| `registerChannelPlugin(plugin)`, `registerDeliveryStrategy(strategy, { replace? })` | Adds a channel surface or an outbound delivery strategy. | Tier `limited`. |
| `registerMemoryEmbeddingProvider(provider, { replace?, makeDefault? })` | Adds a memory embedding provider. | |
| `registerVoiceProvider(provider, { replace? })`, `registerMediaProvider(provider, { replace? })`, `registerWebSearchProvider(provider, { replace? })` | Adds a voice, media or web-search provider. | |
| `getConfig(key)` | Reads one value of this plugin's stored config. | |
| `log(level, message)` | Writes to the app's log; `level` is `info`, `warn`, `error` or `debug`. | |

A complete plugin that adds a command and a tool (its manifest declares `"capabilities": ["register.tool"]` and its tier is `limited`):

```js
// <project>/.goodvibes/plugins/word-count/index.js
export function init(api) {
  api.registerCommand('wc', 'Count the words of the typed text', (args, context) => {
    context.print(`${args.length} words`);
  });
  api.registerTool('word_count', {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to count' } },
    required: ['text'],
  }, async (args) => ({ success: true, output: String(String(args.text).split(/\s+/).filter(Boolean).length) }));
  api.log('info', 'word-count loaded');
}
```

### Adding a plugin and confirming it is loaded

1. `goodvibes plugin init word-count` (writes `<project>/.goodvibes/plugins/word-count/`), then edit `index.js` and `manifest.json`.
2. `goodvibes plugin validate .goodvibes/plugins/word-count` must print `PASS`.
3. If it registers tools, providers or event hooks: `goodvibes plugin trust word-count limited`.
4. In the app, on the Plugins tab of Tools and extensions: select `word-count` and press `o`. The outcome line says `Plugin word-count switched on.`, or the reason it did not start (an undeclared capability, a tier too low, an error thrown by `init`). When the tier was too low the plugin stays switched on, and `s` (set what it may do) to `limited` starts it, also after the app was restarted.
5. Confirm: the Plugins tab shows it switched on with its tier; `Enter` on it shows its state, its trust tier and the capabilities its tier withheld; `/plugin-word-count-wc a b c` prints `3 words`; the Tools tab lists `word_count`.
6. After editing the plugin, `R` on the Plugins tab (load them again) loads it again and names each plugin that did not start, with the reason.

### Trust tiers

| Tier | The plugin gets |
| --- | --- |
| `untrusted` (default) | Views, commands and reading files. |
| `limited` | Also the tools, providers and hooks it declares, gateway methods, channels and delivery strategies. |
| `trusted` | Also the high-risk capabilities it declares. |

A plugin that declares a high-risk capability does not start below `trusted`.
The tier is one decision per plugin for every GoodVibes program on the machine, kept in `~/.goodvibes/plugin-trust.json`.
A tier is given to one copy of the plugin: the copy in the directory it was enabled from (or, when it was never enabled, the first one found), and that copy's manifest and every file in its directory (its `node_modules` included) as they were then. A same-named copy in another directory (a repository's own `.goodvibes/plugins`), or the same copy after its code changed, starts `untrusted` until its trust is set again. The Plugins tab, its `p` (what it asks to do) and the refusal that stops such a plugin say so: its tier was set for files that have since changed (or for a copy in a different folder), so review the change, then set it again with `s`. The tier is not a sandbox: a plugin's code runs inside the program with its access.
`trusted` is set by a verified signature against the publisher's Ed25519 key (saved once with `k`, save its publisher key), or by the owner's confirmation when it does not verify.

### Managing plugins

Plugins are two tabs of Tools and extensions, in both programs: Plugins (each plugin found on this machine, switched on or off or quarantined, with its tier) and Published plugins (the local curated catalog). What is kept (switched on or off, the tier, keys, the catalog) is the daemon's; loading the plugins again and a quarantine act on the program's own running plugins. No slash command carries them; each is the capability named, which the model, an outside agent and a script find and run.

| Control | Capability | Effect |
| --- | --- | --- |
| the Plugins tab, `Enter`, `W`, `D` | `plugin.list`, `plugin.inspect`, `plugin.review`, `plugin.dirs` | Plugins, one plugin's trust, quarantine and capabilities, how much they may do, the search directories. |
| `o` | `plugin.enable`, `plugin.disable` | Switch a plugin on (`Plugin <name> switched on.`) or off. |
| `R` | `plugin.reload` | Load the plugins again and report each that did not start and why. |
| `s`, `k`, `v`, `p` | `plugin.trust`, `plugin.trust-key`, `plugin.verify`, `plugin.capabilities` | Set and check trust. Only the owner can choose `trusted`; setting `limited` sets it back. |
| `q`, `u` | `plugin.quarantine`, `plugin.lift` | Stop a plugin and keep it from loading; lifting it (the owner's only) lets it load again. |
| `P` on Published plugins, `x` on an entry | `plugin.publish-local`, `plugin.unpublish` | Publish a plugin folder into the local curated catalog, or take it out (publishing puts it back). |

Installing, updating and uninstalling a catalog plugin is the Marketplace tab (see "The marketplace").

### Capability bundles

A capability bundle is a tar archive whose top-level `goodvibes-bundle.json` is its manifest; its other files are installed beside it.
The pin is the SHA-256 of the archive bytes (for a git source, of `git archive --format=tar` of the ref).
`goodvibes plugin bundles install <ref> --sha256 <pin>` verifies and prints the activation plan (granted, withheld and quarantined capabilities) and changes nothing; with `--yes` it installs into `.goodvibes/plugins`, `skills`, `hooks/packs` or `policies/packs` with an install receipt.
A reference is a file path, an `https` URL or a git remote with `--ref`.
A missing or wrong `--sha256` is refused; so are links, absolute paths and `..` inside the archive, URLs that are not `https` or that name this machine or a private address, archives over 64 MiB, and fetches over 60 seconds.

## Skills

A skill is a Markdown document of instructions with front matter; its body is sent to the model when the skill is used.
Skills are found in, first match of a name wins:

1. `<project>/.goodvibes/skills/`
2. `<project>/.goodvibes/tui/skills/`
3. `~/.goodvibes/skills/`
4. `~/.goodvibes/tui/skills/`

A skill is a file `<name>.md` or a folder `<name>/SKILL.md` (the folder may hold supporting files).

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag
triggers: [/notes-draft]
---

Read the git log since the last tag, group the changes by area, and write release notes in plain product terms.
```

Typing `/<skill-name>` (here `/release-notes`), or one of its `triggers`, in the composer sends the skill's body as the prompt.
The skill directories are read each time a `/<name>` is typed, so a new or edited skill file works at once, without a restart.
The model also finds skills with the `registry` tool.
These skill folders are the one skill store of every program: the daemon manages it, and the terminal app, the Agent, the web UI and the daemon's `skills.*` methods read the same files. GoodVibes keeps what it knows about a skill in the skill's own front matter: `title` (the name you gave it), `enabled` (`yes` or `no`), `review` (`fresh`, `reviewed` or `stale`), `triggers`, `tags`, `requires-env`, `requires-commands`, `source`, `provenance`, `stale-reason`, `reviewed-at`, `created-at` and `updated-at`; skill bundles are kept in `~/.goodvibes/skills/skill-library.json`. A skill file without these keys (one written by hand) loads as it always has; a skill that has them is loaded by the `registry` tool and by its triggers only while it is switched on and reviewed.
Skills are managed on the Skills, Skill bundles and Published skills tabs of Tools and extensions in the menu (Ctrl+G, then m): see one, make one, change it, switch it on or off, mark it reviewed or out of date, delete it, take in a skill file found on disk, import or save a shared SKILL.md, see where each was found, publish a skill folder to the local catalog or take it out, and the same for bundles. Each is a capability a model, an outside agent or a script finds and runs (`my-skills.*` and `skills.*`, for example `goodvibes do my-skills.list`); marking a skill or bundle reviewed, and switching on one nobody reviewed, count only when you do them yourself. Installing, updating and uninstalling a catalog skill is the Marketplace tab (see "The marketplace").

## The marketplace

The marketplace is a local-first curated catalog of plugins, skills, hook packs and policy packs, kept in `.goodvibes/tui/ecosystem/*.json` (for all your projects under `~/.goodvibes/tui/ecosystem/`, for one under `<project>/.goodvibes/tui/ecosystem/`). It is two tabs of Tools and extensions, in both programs, read from the daemon, which installs, updates and removes for the asking program's project: Marketplace (every curated entry, with its kind and whether it is installed) and Installed (what was installed, for this project or all your projects). A change made anywhere shows in an open tab with no key pressed. No slash command carries them; each is the capability named, which the model, an outside agent and a script find and run (`goodvibes do marketplace.browse`).

| Control | Capability | Effect |
| --- | --- | --- |
| the Marketplace tab, `s` search, `v` at a glance, `f` what fits this project | `marketplace.browse`, `marketplace.overview`, `marketplace.recommend` | Browse. "What fits this project" is read by the program you are in, ranked by the decision model when one is set. |
| `Enter`, `g`, `h` on an entry | `marketplace.review`, `marketplace.provenance`, `marketplace.install-hint` | Check one entry before installing. |
| `i` on an entry not installed | `marketplace.install` | Install it; the form asks "Install for": this project or all your projects. `Installed curated <kind> <id> into <path>`, said on the Installed tab, which opens on the new install, where `x` (uninstall, its undo) and `u` apply. |
| the Installed tab; `Enter`, `u`, `j`, `b`, `x` on an install | `marketplace.installed`, `marketplace.receipt`, `marketplace.update`, `marketplace.history`, `marketplace.rollback`, `marketplace.uninstall` | Manage an installed entry: its receipt, update it (the old one kept as a backup), its backups, roll back (the form offers the backups, newest first), uninstall (asks first; install it again to bring it back). |
| `e`, `k`, `m` on the Marketplace tab | `marketplace.bundle-export`, `marketplace.bundle-inspect`, `marketplace.bundle-import` | Move the local curated catalog (its entries, this project's or the one for all your projects) to another machine; nothing installed is in it, and bringing one in installs nothing. |

## Hooks

A hook runs an action when an event happens: before or after a tool call, a file write, a model call, an agent lifecycle step and more.

### The hooks file

Hooks are read from `hooks.json` in the working directory, or from the file `tools.hooksFile` names (resolved against the working directory).
A hooks file inside an untrusted workspace is not loaded; "Trust this folder" in Permissions and safety, This folder, loads it.
A hooks file that another user owns or can write is not loaded.

```json
{
  "hooks": {
    "Post:tool:write": [
      { "type": "command", "command": "echo \"written\" >> .goodvibes/write-log.txt", "async": true, "description": "Log file writes" }
    ],
    "Pre:tool:exec": [
      { "type": "prompt", "prompt": "Review this command for safety: $ARGUMENTS", "model": "anthropic:claude-haiku-4-5" }
    ]
  },
  "chains": [
    {
      "name": "notify-after-agent-completes",
      "steps": [
        { "match": "Lifecycle:agent:spawned" },
        { "match": "Lifecycle:agent:completed", "within": "5m" }
      ],
      "action": { "match": "Lifecycle:agent:completed", "type": "command", "command": "notify-send 'Agent finished'" }
    }
  ]
}
```

### Event paths

A hook is listed under an event path `Phase:Category:Specific`; `*` matches any specific (`Pre:tool:*`). Segments are case-sensitive.

| Phase | When | Authority |
| --- | --- | --- |
| `Pre` | Before the operation | Can refuse it (`decision: "deny"`), put a tool call to you (`decision: "ask"`), rewrite its input (`updatedInput`) or add a note the model reads (`additionalContext`). A `Pre:tool:*` hook that fails refuses the call. `Pre:tool:*` hooks run in every permission mode, `yolo` included, and for a tool run inside another tool. |
| `Post` | After it succeeds | Observes only. |
| `Fail` | When it fails | Observes only. |
| `Change` | When tracked state changes | Observes only. |
| `Lifecycle` | On lifecycle transitions | Observes only. |

Categories: `tool`, `file`, `git`, `agent`, `compact`, `llm`, `mcp`, `config`, `budget`, `session`, `contract`, `communication`, `permission`, `transport`, `webhook`.
`Pre:git:*` and `Post:git:*` fire only for git operations GoodVibes itself performs through its own git service (its checkpoint, worktree and commit work). A `git push` or any other git command the model runs through the `exec` tool raises only `Pre:tool:exec` (and `Post:tool:exec`), so a hook meant to stop the model's git commands must match `Pre:tool:exec`.
The Hook points tab of Tools and extensions (`hooks.contracts`) lists every hook point.
A key that matches no hook point is not loaded; `goodvibes hooks validate` reports it.

### Hook types and fields

| Type | Action |
| --- | --- |
| `command` | Run a shell command; the event is passed as JSON on standard input. |
| `prompt` | Send a prompt to a model; `$ARGUMENTS` is replaced with the event JSON. |
| `agent` | Start a helper agent for the event. |
| `http` | POST the event to `url` (redirects are not followed). |
| `ts` | Run a TypeScript module (`path`) whose default export handles the event. |

Fields: `match`, `matcher` (an exact, case-sensitive string compared with the event's third segment, its specific name: under `Pre:tool:*`, `"matcher": "exec"` limits the hook to `exec` calls; there are no wildcards or patterns; or `effect:<class>`, which matches every tool call the permission gate classes as `read`, `write`, `execute` or `delegate`, whichever tool made it: under `Pre:tool:*`, `"matcher": "effect:execute"` fires for every tool that runs a command, not only `exec`), `type`, `command` / `prompt` / `url` / `path`, `headers`, `model`, `timeout` (seconds; default 30, 60 for `agent`), `statusMessage`, `async` (runs in the background and its answer is discarded, so it is refused under a point that waits for its hooks to deny, ask or rewrite the call, such as `Pre:tool:*`; an observer belongs under a `Post` or `Fail` point), `once` (runs once per daemon or app run, then is removed; a restart or an edit to the entry arms it again), `description`, `name`, `enabled` (default true).
When several hooks answer one event, a deny outranks an ask and an ask outranks an allow, so one hook's `allow` never cancels another's `ask`.
A chain step takes `match`, `capture`, `within`, `condition`, `optional` and `debounce`. `within` and `debounce` are a number with `ms`, `s`, `m` or `h` (`500ms`, `30s`, `5m`, `1h`); a chain with any other value is not registered, and the reason is logged. An event for the step after an optional one skips it, and also ends that step's `debounce` wait early.
A chain cannot be switched on or off: switching on and off (`hooks.enable`, `hooks.disable`) acts on hooks, and removing (`hooks.remove`) takes out a hook or a chain.

### The command hook contract

A `command` hook runs `/bin/sh -c "<command>"` in its own process group, with your privileges, in the program's current directory (not necessarily the project when `--cd` was used), so give scripts by absolute path.

Standard input receives one JSON object, the event:

| Field | Meaning |
| --- | --- |
| `path` | The event path, for example `Pre:tool:exec`. |
| `phase`, `category`, `specific` | Its three segments. |
| `sessionId` | The session the event belongs to. |
| `timestamp` | Milliseconds since the epoch. |
| `payload` | What happened (below). |
| `agentId` | Present when a helper agent raised the event. |
| `effects` | On a tool call: the permission gate's class of the call (`read`, `write`, `execute` or `delegate`), as a one-item list; also in `payload.effects`. |

The payloads of the tool and file events:

| Event | `payload` |
| --- | --- |
| `Pre:tool:<tool>` | `callId`, `tool`, `args` (the call's arguments exactly as the model sent them; for `exec`, `args.commands[].cmd` holds each shell command; for `edit`, `args.edits[].path`; for `write`, `args.files[].path`). |
| `Post:tool:<tool>` | `callId`, `tool`, `result` (the tool's result object). Fired only when the call succeeded. It has no `args`. |
| `Post:file:write`, `Post:file:edit`, `Fail:file:write`, `Fail:file:edit` | `tool`, `callId`, `paths` (every file the call wrote or tried to, as the call named them: `files[].path` of a `write`, `edits[].path` and a notebook operation's `path` of an `edit`), `path` (the first of them), and `error` on `Fail`. File contents are never in the payload. |
| `Change:file:external` | `filePath` (absolute) and `change` (`changed` or `deleted`): a watched file changed outside GoodVibes. |

The other categories carry their own payloads; the Hook points tab lists each point, and `t` (try it) on one shows what fires.

What the hook returns:

- Exit code `0` with nothing, or with text that is not JSON, on standard output means success with no decision.
- Exit code `0` with a JSON object on standard output is the hook's result. Its fields: `ok` (default `true`), `decision` (`allow`, `deny` or `ask`), `reason`, `updatedInput` (an object that replaces the call's arguments), `additionalContext` (text the model reads with the call's result), `error`.
- A non-zero exit code, or running past `timeout` (default 30 seconds; the process group is then killed), is a failure: `command exited with code <n>: <first 200 characters of standard error>`.

How a `Pre:tool:*` result is used:

- `"decision": "deny"` refuses the call before the permission gate sees it; the model receives `reason` (or `Tool '<tool>' was refused by its Pre hook.`). The first deny of several hooks wins.
- `updatedInput` is what the gate checks and what runs; when several hooks return one, the last wins.
- `"decision": "ask"` puts the call to you, in every mode (`yolo` included; held for you in `just-vibes`), with the hook's `reason` on the card: `Your Pre:tool:<tool> hook asks you about this call: <reason>`. A rule that refuses the call still refuses it. `"decision": "allow"` changes nothing: the permission gate still decides.
- A hook that fails without a decision refuses the call: `Hook '<name>' at Pre:tool:<tool> failed (<error>), so the call was refused. Fix or remove the hook, then retry.`

`Pre:tool:*` hooks finish before the call runs. `Post:*`, `Fail:*` and file hooks run beside the turn: the next call does not wait for them, and their failure is only logged.

### Hooks in every mode and inside other tools

`Pre:tool:*` hooks run in every permission mode, `yolo` included (`--yolo`, Shift+Tab, `permissions.mode` `yolo`, `goodvibes --yolo run`): a deny refuses the call and an ask puts it to you. They also fire for a tool that one tool runs inside another (for example `agent_harness` calling `agent_operator_method`, or `inspect` writing a scaffold with `write`): the inner call's payload carries `nested: true`, and a deny, an ask or a rewrite applies to it as to a call the model made itself.

### Example: refuse every `git push` the model runs

To make sure a command never runs, use a never-run rule instead of a hook: `/permissions never git push`. The gate itself refuses it, in every mode, through every tool that can reach a shell, in the base64 form, through wrappers, `sh -c`, scripts and quoting (see "Never-run rules" in "Permissions and decisions"). The hook below is for a check of your own that a rule cannot express.

A hook fires for the tool called, whether the model called it or another tool ran it. So it must be registered under every tool that runs a command, now or later. In the two programs' tool registries these are:

| Tool | Program | How it runs a command |
| --- | --- | --- |
| `exec` | both | `commands[].cmd`, or base64-encoded in `commands[].cmd_base64` |
| `repl` | both | code that starts a process |
| `workflow` | both | hook actions and scheduled commands, run later |
| `trigger` | both | `definition.spec.command` plus `args` (an argv list, not a shell line), run later |
| `state` | both | a `command` hook added with `mode: "hooks"`, run later on its event |
| `terminal` | Agent | `command`, a tracked background process |
| `process` | Agent | `command` for `action: "start"`, and `data` written to a running process's standard input with `action: "write"` |
| `agent_harness` | Agent | modes such as `run_background_process` and `run_command` |
| `agent_operator_method` | Agent and terminal app | daemon methods by id, including running a command on a paired peer or registered backend; each call admitted by the gate under the mode in force, the owner's own acts refused |

1. Save this script as `<project>/.goodvibes/hooks/block-git-push.sh` and make it executable (`chmod +x`). It needs `jq` 1.6 or later.

```sh
#!/bin/sh
if jq -e '
  .payload.args as $a
  | ([ $a | .. | strings ]
     + [ $a | .. | objects | .cmd_base64? | strings | (try @base64d catch "") ]
     | any(test("\\bgit\\b[^;&|]*\\bpush\\b")))
  or ([ $a | .. | objects | select((.args? | type) == "array")
        | [ .command?, .args[]? ] | map(strings) | join(" ") ]
      | any(test("\\bgit\\b") and test("\\bpush\\b")))
' >/dev/null; then
  printf '%s\n' '{"decision":"deny","reason":"git push is blocked by this project'"'"'s hook. Ask the owner to push."}'
fi
exit 0
```

It refuses the call when any text value in the call's arguments (or the decoded text of a `cmd_base64`) contains `git` followed by `push` before a `;`, `&` or `|`, or when an argv-style object (`command` plus an `args` list, as `trigger` takes) contains both words.

2. Add it to `<project>/hooks.json` under each of those tools, using the absolute path of the script:

```json
{
  "hooks": {
    "Pre:tool:exec":                   [{ "name": "block-git-push-exec", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:terminal":               [{ "name": "block-git-push-terminal", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:process":                [{ "name": "block-git-push-process", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:repl":                   [{ "name": "block-git-push-repl", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:workflow":               [{ "name": "block-git-push-workflow", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:trigger":                [{ "name": "block-git-push-trigger", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:state":                  [{ "name": "block-git-push-state", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:agent_harness":          [{ "name": "block-git-push-agent_harness", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }],
    "Pre:tool:agent_operator_method":  [{ "name": "block-git-push-agent_operator_method", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/block-git-push.sh" }]
  }
}
```

The terminal app accepts the four Agent-only keys and never fires them. Do not put the script under `Pre:tool:*`: that would also refuse `write` and `edit` calls whose file text mentions `git push`.

3. Run `goodvibes hooks validate`; it prints one `PASS  Pre:tool:<tool> #0 block-git-push-<tool> (contract: intercept/blocking)` line per key (nine) and `result: all hooks are valid.`
4. If the workspace is not trusted yet, choose "Trust this folder" in Permissions and safety, This folder: in either program the waiting hooks file loads at once. After editing `hooks.json` later, nothing needs running: before any hook fires, both programs compare the file's modification time and size with the ones they loaded and read a changed file again first (a file in an untrusted workspace still loads nothing). `l` on the Hooks tab (read the file again) reads it at once.
5. Check it: `t` (try it) on `Pre:tool:exec` in the Hook points tab lists the hook; once a command has run, the Hook runs tab shows each run of it and what it did.

Tested inputs, refused: `cd x && git -C repo push` (`exec`), the base64 form of `git push origin main`, a `terminal` command `git push`, `process` `action: "start"` with `git push origin main`, `process` `action: "write"` with data `git push`, `repl` code `Bun.spawnSync(["git","push"])`, a `trigger` with `command: "git"` and `args: ["push"]` (either key order), a `state` command hook `git push`, a `workflow` schedule `git push`, and `agent_harness` `run_background_process` with `git push`. Passed: `git status`, `npm run dev`, a `trigger` running `git status`.

It also refuses harmless commands that contain the two words in that order, for example `git commit -m "push fix"` or `git log --grep push`.

What it does not stop:

- A command whose words are not in that order or are built when it runs: `echo push | xargs git`, `g''it push`, `$(printf git) push`, a variable holding `push` (including one set in `exec`'s `env`), a script file the model wrote earlier and then runs (`sh publish.sh`), a git alias (`git config alias.p push` followed by `git p`), or text sent to a running shell in pieces (`process` `write` of `git ` and then `push`).
- Tools of MCP servers (a git MCP server's push tool is the call `mcp` with `mode: "call"`); add a `Pre:tool:mcp` entry with a script that inspects `.payload.args.qualifiedName` to cover a specific server tool.
- Agents hosted with `/agents host` and remote runners started from the Work place, which run their own tools in their own process.
- Commands the owner runs: `!git push` in the composer, or a shell outside GoodVibes.
- If `jq` is missing or the script fails, every call under these keys is refused (a failing `Pre:tool:*` hook refuses the call).

### Example: format files after every edit

`Post:file:edit` and `Post:file:write` carry the paths written (`.payload.paths`); this hook formats every file git reports as changed or new instead, which also covers files a command changed (it needs a git repository and the project's own `prettier`; `--no-install` keeps `npx` from downloading one). Save as `<project>/.goodvibes/hooks/format-changed.sh` (executable):

```sh
#!/bin/sh
cat >/dev/null   # the event on stdin is not needed
cd "$(git rev-parse --show-toplevel)" || exit 0
{ git diff --name-only --diff-filter=ACMR HEAD; git ls-files --others --exclude-standard; } \
  | grep -E '\.(ts|tsx|js|jsx|json|css|md)$' \
  | xargs -r npx --no-install prettier --write >/dev/null 2>&1
exit 0
```

```json
{
  "hooks": {
    "Post:tool:edit": [
      { "name": "format-after-edit", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/format-changed.sh", "timeout": 60 }
    ],
    "Post:tool:write": [
      { "name": "format-after-write", "type": "command", "command": "/home/me/work/project/.goodvibes/hooks/format-changed.sh", "timeout": 60 }
    ]
  }
}
```

It formats files the owner changed too, not only the model's. The hook runs beside the turn, so the model's next tool call may start before formatting ends; when the model then edits a file the formatter changed, the `edit` tool refuses (the file changed since it was read) and the model reads it again.

### Managing hooks, and the hooks that ran

Hooks are three tabs of Tools and extensions, in both programs: Hooks (the managed hooks and chains of the project's hooks file, on or off), Hook runs (which hook ran, when, at which point, on what, in which program and what it did: let it go on, refused it, put it to you, or failed and why) and Hook points. Managing the file is the daemon's, for the asking program's project; a hook fires in the turn of whichever program runs it, and each program posts its runs to the daemon's one trace, headless runs (`goodvibes run`, `goodvibes-agent run`) too, before the run ends, so the Hook runs tab, the web UI and an agent see the runs of every program. Both tabs follow changes made anywhere, with no key pressed. No slash command carries them; each is the capability named, which the model, an outside agent and a script find and run (`goodvibes do hooks.trace`).

| Control | Capability | Effect |
| --- | --- | --- |
| the Hooks and Hook points tabs | `hooks.contracts` | List hook points and the managed hooks; each hook runs under its own `timeout` (default 30 s, 60 s for an agent hook). |
| the Hook runs tab | `hooks.trace` | The latest hook runs of every program, newest first. |
| `l` on Hooks | `hooks.reload` | Read the file again into this program's hooks. |
| `n` on Hooks, `h` on a hook point | `hooks.scaffold` | Add a named hook skeleton to the file (what it runs: a command, a prompt, an agent, a web address or a TypeScript file). |
| `c` on Hooks | `hooks.chain` | Add a chain skeleton. |
| `o`, `x` on a hook | `hooks.enable`, `hooks.disable`, `hooks.remove` | Switch a hook on or off, or remove it; removing also takes a chain and removes it for good (add it again to bring it back). A chain cannot be switched: `<name> is a chain; a chain cannot be switched on or off.` |
| `t` on a hook point | `hooks.simulate` | Show what fires for an event. |
| `i`, `m`, `e` on Hooks | `hooks.inspect`, `hooks.import`, `hooks.export` | Move hook sets between files; `e` asks which file to save to (left blank, it is the hooks file itself); installing with "Replace them all" replaces the hooks there (save them to a file first to keep a copy). |

Every change (make, chain, switch on or off, remove, install) edits the hooks file itself: the file the setting `tools.hooksFile` names, resolved against the working directory, which is `<project>/hooks.json` by default.
Before writing, the daemon reads the file again; a file that is not valid JSON, is writable by other users, or is owned by another user is not changed (`The hooks file <path> was not changed: it was not loaded because <reason>. Fix the file, then retry.`).
The file is written to a temporary file and renamed over the old one, keeping its permissions, with two-space JSON indentation; the hooks are then loaded again at once.

Making `lint-after-write` at `Post:tool:write` that runs a command (`n`, or `goodvibes do hooks.scaffold --input name=lint-after-write --input match=Post:tool:write --input type=command`) says `Made managed hook lint-after-write at Post:tool:write in /home/me/work/project/hooks.json; fill in what it runs there, then switch it on.` and adds this entry under the key `Post:tool:write`:

```json
{
  "name": "lint-after-write",
  "match": "Post:tool:write",
  "type": "command",
  "enabled": false,
  "description": "Managed hook scaffold for Post:tool:write",
  "command": "echo implement-hook"
}
```

A scaffolded hook starts disabled. Replace its placeholder, then switch it on (`o` on it in the Hooks tab).
The placeholder for each type: `command` gets `"command": "echo implement-hook"`; `prompt` gets `"prompt": "Return a HookResult JSON object for $ARGUMENTS."`; `agent` gets `"prompt": "Handle this hook event: $ARGUMENTS"`; `http` gets `"url": "http://localhost:3000/hooks"`; `ts` gets `"path": "./hooks/handler.ts"`.

A chain `notify-done` of `Lifecycle:agent:spawned,Lifecycle:agent:completed` (`c`) is appended to the file's `chains` list:

```json
{
  "name": "notify-done",
  "description": "Managed hook workflow for Lifecycle:agent:spawned -> Lifecycle:agent:completed",
  "steps": [{ "match": "Lifecycle:agent:spawned" }, { "match": "Lifecycle:agent:completed" }],
  "action": { "name": "notify-done-action", "match": "Lifecycle:agent:completed", "type": "command", "command": "echo chain-action", "enabled": true }
}
```

A scaffolded chain's action is enabled at once and runs `echo chain-action` until it is edited.
`goodvibes doctor hooks` lists registered hooks and their source.

## Named API services

`~/.goodvibes/tui/services.json` defines named API services the `fetch` tool can call by name, with their credentials kept in the secret store.
A project's `.goodvibes/tui/services.json` adds services only when they name keys in the owner's secret store and the owner confirms each with "Use a service this project defines".
The services are the daemon's, one list for every program, on the Services tab of Models and providers in both programs (no slash command carries them): each service with how it signs in, and any service from this project that waits for you. On a service, `v` shows how it signs in, its address and which of its credentials are stored; `t` tests it (sends one request with its credentials; a redirect is not followed and reads `<service> was reached and redirected (HTTP <status>) to <location>; nothing was sent there. Set baseUrl or testPath to the final address`); `c` checks its sign-in (names the sign-in headers its credentials make, never their values); `a` checks every service (a missing key, password or address, counted by how each signs in). On a project service waiting for you, `y` ("Use a service this project defines": it loosens a protection, so it asks one question, with exactly what the entry sends and where, because a stored key sent to the host the repository chose cannot be called back, and approves only that entry; a model cannot run it). On the Move tab, the services list is saved to a file (`e`; an existing file is kept unless you choose to write over it; a model's save must name a path inside the working directory) or replaced from one (`l`; the old file is kept as `.bak`; it loosens a protection and is the owner's only: its answer lists every service that is new or changed as `name: key -> host`, the names no longer listed, and `To put it back: the old list is kept at <file>.bak; replacing the list from that file brings it back.`). The capabilities are `services.list`, `services.show`, `services.check`, `services.test`, `services.check-auth`, `services.trust`, `services.export` and `services.import`.
With none: `No services yet. Add entries to ~/.goodvibes/tui/services.json, or replace your services list from a file.`
Checking the sign-in of a service with a missing credential is refused: `<name> cannot sign in right now: a credential it needs is not stored.` with `See <name> in the Services list of Models and providers for which.`

## Headless runs

`goodvibes run` runs one prompt without the interface and exits. `exec`, `-p/--prompt` and `--print` with no command are the same.
The terminal app runs the turn in the `run` process itself with its local model; it does not need the daemon.
The `--intake-*` flags instead work on a prompt captured through native admission on the daemon.

```sh
goodvibes run "summarize the current project"
goodvibes run --output json "list risks"
goodvibes run --output stream-json --omit-accumulated --timeout 10m --max-turns 20 "fix the failing test"
goodvibes --just-vibes run "tidy the test fixtures and tell me what you could not do"
goodvibes run --session user-0008b454 "continue with the next step"
```

### Flags of `run`

| Flag | Effect |
| --- | --- |
| `--output text\|json\|stream-json` | Output format (below). |
| `--timeout <duration>` | Cancel after this long, as Ctrl-C would; exit `124`, `stopReason` `timeout`. `90`, `90s`, `5m`, `1h`. A value that is not a positive duration is refused with exit `2`: `--timeout expects a positive duration such as 90, 90s, 5m or 1h, not "abc".` |
| `--max-turns <n>` | Stop once the model has answered `n` times in this run's own loop and still asks for tools; exit `1`, `stopReason` `max_turns`. Helper agents and helper models do not count. Tools from that last answer are not run. A value that is not a whole number of at least 1 is refused with exit `2`: `--max-turns expects a positive whole number, not "0".` |
| `--omit-accumulated` | With `stream-json`, leave `accumulated` out of `STREAM_DELTA` frames. |
| `--answer-permissions` | With `stream-json`, answer owner prompts on standard input. Without it, a call that needs the owner is refused. With another format it is refused with exit `2`. |
| `--prompt-file <path>` | Read the prompt from a file; a relative path is read from the working folder. `--prompt-file -` reads all of standard input: `cat task.md \| goodvibes run --prompt-file -`. A prompt also given as text (`Give the prompt once: as text or with --prompt-file, not both.`), a file that cannot be read (`--prompt-file could not read <path>: <reason>`), or `-` with `--answer-permissions` is refused with exit `2`. |
| `--continue`, `--resume [id]`, `--session <id>` | Continue the last or the named session. A session that does not exist fails. |
| `--intake-status`, `--intake-retry`, `--intake-resume`, `--intake-cancel` | Inspect, retry, resume or cancel the saved native input. They take no prompt; use one at a time. |

A refusal while the command line is read (an unknown option, a bad `--timeout` or `--max-turns` value, `--answer-permissions` without `stream-json`, a run-only flag on another command) prints the one-line reason, a blank line, then the program's whole top-level help, on standard error, and exits `2`.
A run with no prompt is refused after the command line is read, so it prints no help. The session named by `--continue`, `--resume` or `--session` is claimed first, so when that session is open in another running copy the run reports `session-open-elsewhere` (exit `1`) instead. Otherwise it exits `2` and prints, by output format:

| Format | Terminal app | Agent |
| --- | --- | --- |
| `text` | `A prompt is required.` on standard error and one empty line on standard output | `A complete original prompt is required.` on standard error and one empty line on standard output |
| `json` | `{"schemaVersion":1,"ok":false,"response":"","error":"A prompt is required.","stopReason":"invalid-input","sessionId":null,"usage":null}` on standard output; standard error empty | the same object with `"error":"A complete original prompt is required."` |
| `stream-json` | the same object with `"type":"TURN_RESULT"` first | the same object with `"type":"NATIVE_INTAKE_RESULT"` first |

### Output formats

- `text`: the answer on standard output. Errors, and the message of a run that never reached the model, go to standard error. Calls `just-vibes` held go to standard error as `Held for you (not run): <id> <tool>: <reason>; ...`.
- `json`: nothing until the end, then one JSON object on one line: the final frame.
- `stream-json`: one JSON object per line as events happen, then the final frame.

When no decision model was in use for the run, its one-line explanation (for example `No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open.`) goes to standard error in every format, and the JSON formats also carry it in `diagnostics`.
When a request moves from one sign-in of a provider to another (OpenAI: subscription to API key), one line goes to standard error in every format, once per move: `<model> answered through your <provider> <sign-in>: the <previous sign-in> failed (<reason>).` The reason is a fixed phrase for the kind of failure with the HTTP status and the provider's short error code, for example `it reached its rate limit (HTTP 429), code rate_limit_exceeded`; the provider's own error text is never repeated.
Free text in any frame (`error`, `reason`, `question`, `summary`, `detail`, a tool's error) has credentials masked and is cut at 1000 characters followed by `...`. Tool arguments, agent task text, agent output and the full contract request are never included.
Consumers ignore frame types and fields they do not know. A field shown as optional is left out when it has no value; it is never sent as `null`, except `sessionId` and `usage` in the final frame.

### Stream frames

Every stream frame is one JSON object whose first two keys are `schemaVersion` (always `1`) and `type`.

| `type` | Field | Type | Meaning |
| --- | --- | --- | --- |
| `SESSION` | `sessionId`, `model`, `provider` | string | The first frame of every run that reached a session, written before the first request (after a resume, the resumed session): the session and the model that answers. |
| | `workingDirectory` | string | The working folder of the run. |
| | `version` | string | The GoodVibes version running the turn. |
| | `permissionMode` | string | The permission mode in force: `ask-me`, `jev-decides`, `just-vibes`, `yolo` or `plan`. |
| | `chosenMode` | string | The mode chosen in settings (`permissions.mode`); the same as `permissionMode` unless something holds it back. |
| | `modeReason` | string, optional | Present only when `permissionMode` differs from `chosenMode`: why, in one sentence (for example, Jev decides was chosen but no decision model is set, so every call Jev would decide asks you). |
| `PERMISSION_MODE_CHANGED` | `permissionMode`, `previousMode`, `chosenMode` | string | The mode in force changed during the run: a setting changed, or the decision model stopped answering or answered again. With "When the decision model is missing or fails" on Hybrid the turn asks the failed model nothing more, so the change back comes in a later run; on Decision Model Only it comes as soon as the model answers. |
| | `modeReason` | string, optional | Present when the new mode in force is not the chosen one: why. |
| `STREAM_DELTA` | `content` | string | The new text of this chunk. |
| | `accumulated` | string | The whole answer streamed so far in this model response. Left out with `--omit-accumulated`. |
| `DRAFT_WITHDRAWN` | `reason` | string | The streamed answer was withdrawn (the turn moved to another model after it had begun). Discard the text received so far; the replacement streams from empty. |
| `TOOL_EXECUTING` | `turnId`, `callId`, `tool` | string | A tool call starts. |
| `TOOL_SUCCEEDED` | `turnId`, `callId`, `tool` | string | The call finished. |
| | `durationMs` | number | How long it ran. |
| `TOOL_FAILED` | `turnId`, `callId`, `tool` | string | The call failed. |
| | `durationMs` | number | How long it ran. |
| | `error` | string | Why. |
| `TOOL_CANCELLED` | `turnId`, `callId`, `tool` | string | The call was cancelled. |
| | `reason` | string, optional | Why. |
| `PERMISSION_REQUESTED` | `callId`, `tool` | string | A tool call reached the permission gate. Written when the gate has decided it, just before `PERMISSION_DECIDED`; a request never decided is written when the run ends, without `ownerPrompt`. |
| | `category` | string | `read`, `write`, `execute` or `delegate`. |
| | `riskLevel` | string, optional | `low`, `medium`, `high` or `critical`. |
| | `summary` | string, optional | What the call does, in one line. |
| | `ownerPrompt` | boolean | `true` when the owner was asked to answer this call. |
| `PERMISSION_DECIDED` | `callId`, `tool`, `category` | string | The gate's decision on the call. |
| | `approved` | boolean | Whether it may run. |
| | `source` | string | Who decided: `boundary`, `stakes_preset`, `config_policy`, `managed_policy`, `safety_check`, `runtime_mode`, `invocation_admission`, `session_override`, `user_rule`, `user_prompt` (the owner answered), `jev_decision` (the decision model). |
| | `ownerPrompt` | boolean | `true` when the owner was asked. |
| | `reasonCode` | string, optional | The exact reason: `boundary_judgment_input`, `boundary_catastrophic`, `boundary_surface_authority`, `boundary_card_details`, `boundary_outward_effect`, `owner_act`, `preset_allow`, `preset_deny`, `owner_approved_outward`, `config_allow`, `config_deny`, `managed_policy_allow`, `managed_policy_deny`, `safety_guardrail`, `mode_allow_all`, `mode_queued_for_owner` (held by `just-vibes`), `invocation_already_admitted`, `mode_denied`, `plan_mode`, `session_cached_allow`, `session_cached_deny`, `user_rule_allow`, `user_rule_deny`, `user_approved`, `user_denied`, `jev_act`, `jev_revise`, `jev_defer`, `jev_reject`. |
| | `reason` | string, optional | Why: when Jev decided the call (`source` `jev_decision`), its reason (`Jev allowed it: the safety reading put its stakes at low.`); on a refusal, the refusal's explanation. Masked and cut at 1000 characters. |
| `PERMISSION_PROMPT` | `callId`, `tool`, `category` | string | With `--answer-permissions` only: the owner is asked, and the run waits for an answer on standard input. Also `riskLevel`, `summary` and `answer`; for a capability `summary` is its own question ("Keep this computer awake?") and `lines` (array of strings) its sentence and each input on a labelled line, a secret one hidden. |
| | `riskLevel` | string | As above. |
| | `summary` | string | As above. |
| | `answer` | string | The exact line to write, for example `Write one line to stdin: {"type":"PERMISSION_ANSWER","callId":"c1","approved":true} (or false).` |
| `PERMISSION_ANSWERED` | `callId` | string | An answer line was accepted. |
| | `approved` | boolean | The answer. |
| `PERMISSION_ANSWER_REJECTED` | `callId` | string, optional | Present when the line's `callId` was a string. |
| | `reason` | string | Why the line was not used. |
| | `waiting` | array of string | Call ids still waiting for an answer. |
| `AGENT_SPAWNING`, `AGENT_RUNNING` | `agentId`, `taskId` | string | A helper agent starts. |
| | `parentAgentId`, `contractId` | string, optional | Its parent agent and contract. |
| | `contractRole` | string, optional | `owner`, `unit` or `planner`. |
| `AGENT_COMPLETED` | `agentId`, `taskId` | string | The agent finished. |
| | `durationMs`, `toolCallsMade` | number, optional | How long it ran and how many tool calls it made. |
| `AGENT_FAILED` | `agentId`, `taskId` | string | The agent failed. |
| | `error` | string, optional | Why. |
| | `durationMs` | number, optional | How long it ran. |
| `AGENT_CANCELLED` | `agentId`, `taskId` | string | The agent was cancelled. |
| | `reason` | string, optional | Why. |
| `CONTRACT_CREATED` | `contractId`, `sessionId`, `ownerAgentId` | string | Delegated work became a contract. |
| | `origin` | string | `turn`, `agent-tool`, `cli`, `hosted`, `external` or `proposal`. |
| `CONTRACT_STATUS_CHANGED` | `contractId` | string | The contract moved. |
| | `from`, `to` | string | `queued`, `shaping`, `planning`, `checking-plan`, `running`, `judging`, `fixing`, `committing`, `awaiting-owner`, `passed`, `failed`, `cancelled`. |
| `CONTRACT_ESCALATED` | `contractId`, `escalationId`, `targetId`, `question` | string | The contract waits on its owner. |
| | `scope` | string | `plan`, `unit`, `group`, `deliverable` or `shape`. |
| | `reason` | string | `plan-unresolved`, `stalled`, `unsettled`, `fix-rounds-exhausted`, `writing-unclear`, `attempts-undecided` or `owner-decision-needed`. |
| `CONTRACT_PASSED` | `contractId` | string | The contract passed. |
| | `criteriaMet`, `criteriaJudged` | number | Acceptance criteria met, out of those judged. |
| `CONTRACT_FAILED` | `contractId`, `reason` | string | The contract failed. |
| | `failureKind` | string | `transport`, `max_turns`, `planning`, `budget`, `owner-rejected`, `judgment-unavailable`, `zombie` or `other`. |
| `CONTRACT_CANCELLED` | `contractId`, `reason` | string | The contract was cancelled. |
| `USAGE` | `turnId`, `provider`, `model` | string | One model response: its provider and model id. Helper agents and helper models count here too. |
| | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | number | Tokens of this response. |
| | `costUsdCents` | number, optional | Its price in US cents, when the model is priced. |
| | `signIn` | object, optional | For a provider with more than one sign-in: `route` (`subscription` or `api-key`), and `movedFrom` (the route that failed) with `reason` when this response moved sign-in. |
| `SESSION_RECOVERED` | the `recovery` fields | | The session was restored from a crash snapshot. Written before the first request. |

For each tool call the gate decides first, so `PERMISSION_REQUESTED` and `PERMISSION_DECIDED` come before `TOOL_EXECUTING`. A call the gate refuses produces `PERMISSION_DECIDED` with `approved: false` and then `TOOL_FAILED`, with no `TOOL_EXECUTING`. A call a `Pre:tool:*` hook refuses never reaches the gate: it produces only `TOOL_FAILED`, whose `error` is the hook's reason.

### The final frame

`json` prints only this object. `stream-json` prints it last, with `type` first: `TURN_RESULT` for a turn the terminal app ran itself, `NATIVE_INTAKE_RESULT` for an `--intake-*` run.

| Field | Present | Type | Meaning |
| --- | --- | --- | --- |
| `type` | `stream-json` only | string | `TURN_RESULT` or `NATIVE_INTAKE_RESULT`. |
| `schemaVersion` | always | number | `1`. |
| `ok` | always | boolean | `true` exactly when the exit code is `0`. |
| `response` | always | string | The answer. When delegated work produced the answer, the work's answers joined by blank lines. For a run that never reached a model, the status message. |
| `error` | when a model turn ran, and on most failures | string | What went wrong. A run whose model turn completed carries `""`. A native-intake result that never reached a model (for example `native-unavailable`) has no `error`; its message is in `response`. |
| `stopReason` | always | string | See the table below. |
| `events` | when a turn ran | number | How many events the run observed. |
| `sessionId` | always | string or `null` | The session; `null` when no model turn ran. |
| `model` | when a turn ran | string | The selected model's registry key. |
| `provider` | when a turn ran | string | The selected provider. |
| `signIn` | when a provider with more than one sign-in answered | string | The sign-in that answered last: `subscription` or `api-key`. |
| `usage` | always | object or `null` | Summed over every model response of the run (helper agents and helper models included): `modelCalls`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `costUsdCents` only when every response was priced. `null` when no model turn ran. |
| `heldForOwner` | when the run held calls | array | One object per held call: `id`, `tool`, `summary`, `reason`. `just-vibes` holds what it does not run; in any other mode a call the mode puts to the owner while nobody in the run can answer it (no `--answer-permissions`) is held the same way. Nothing was run for them; run again with `--answer-permissions`, or approve them in Waiting for you, to decide each. |
| `kind` | on some failures | string | `outcome-unknown` (the daemon may have acted) or `unavailable` (nothing was sent). |
| `cause` | with `kind`, when known | string | `journal_conflict`, `journal`, `principal`, `network`, `schema`, `host_changed`, `unknown`. |
| `native` | for native intake | object | `status` (`pending`, `recorded`, `unknown`, `invalid`, `unavailable`), `message`, `cause`, `request` (`requestId`, `inputId`, `text`: the words of the prompt), `result` (the host's record, whose `kind` is for example `captured`, `processing`, `turn`, `work`, `blocked`, `refused`, `cancelled`), `execution`, `nextStep` (`retry`, `resume`, `cancel` or `inspect`; run `--intake-<nextStep>`, where `inspect` means `--intake-status`), `notSent: true` (this run's own text was not sent because an earlier input must move first), `hostedTurn` (the daemon-hosted reply: `state`, `sessionId`, and on failure `failure` with `summary` and `retryable`). |
| `refusal` | when refused before starting | object | `code` (`SESSION_OPEN_ELSEWHERE`), `state`, `reason`, `next` (array of steps). |
| `recovery` | when restored from a crash snapshot | object | `sessionId`, `applied` (boolean), `refusal` (when not applied: `no-snapshot`, `unusable-snapshot`, `apply-failed`), `snapshotAt` (ISO time), `snapshotKept` (boolean), `messages` (number), `turns` (number), `interruptedTurn` (`prompt` masked and cut at 1000 characters, `toolResults` number, `interruptedToolCalls` as `{ callId, tool }`, `partialReply` boolean), `lost` (array of sentences). |
| `diagnostics` | when no decision model was in use | object | `decisionModel`: `inUse: false`, `policy` (the stored "When the decision model is missing or fails" value: `Hybrid` or `Decision Model Only`), `reason` (`not-set`, `unavailable`), `line`, and `failure` (`model`, `what`, `nextStep`) when the set model was failing. |

`stopReason` values:

| Value | Exit | Meaning |
| --- | --- | --- |
| `completed` | 0 | The turn, and any work it delegated, finished with an answer. |
| `empty_response` | 1 | The model returned no text. |
| `max_turns` | 1 | `--max-turns` was reached. |
| `timeout` | 124 | `--timeout` was reached. |
| `cancelled` | 130 | Ctrl-C, SIGTERM, or a cancellation this run issued to delegated work. |
| `contract-failed` | 1 | Delegated work (a contract) ended without passing; `error` says why. |
| `awaiting-owner` | 1 | Delegated work stopped for an owner decision; open the session interactively and answer it. |
| `agent-failed` | 1 | A helper agent started outside a contract ended without a completed report. |
| `preflight_failed`, `context_overflow` | 1 | The turn was refused before it started, so nothing ran; `error` says why. `preflight_failed`: an equivalent turn is already in flight. `context_overflow`: the conversation does not fit the model's context window; compact it or choose a model with a larger window. |
| `provider_error` | 1 | The provider failed (after any sign-in move inside the provider, the retries, and every model of `provider.fallbackModels` not yet tried). |
| `provider_exhausted` | 1 | Every backend of the selected `synthetic` model is exhausted (rate limits and cooldowns) and no model of `provider.fallbackModels` was left to try: `All providers for the selected synthetic model are exhausted`. |
| `hook_denied` | 1 | A `Pre:llm:chat` hook refused the model request, which ends the turn. (A `Pre:tool:*` hook that refuses a tool call fails only that call; the turn goes on.) |
| `tool_loop_circuit_breaker` | 1 | The turn was stopped by a turn limit or its budget before the request was complete: `Stopped: <the limit, or 'a turn limit was reached'>. The request is not complete.` |
| `unexpected_error` | 1 | The turn failed in an unexpected way (the run's own error is in `error`), including a turn admitted through native intake that then failed in this process (`The turn failed in this process: <reason>`). |
| `turn-unsettled` | 3 | The turn ended without a completion, error, cancellation or refusal event. |
| `session-open-elsewhere` | 1 | The session named by `--continue`, `--resume` or `--session` is open in another running copy. |
| `session-not-found` | 1 | The session named by `--resume <id>` or `--session <id>` does not exist, or `--continue` found none to continue; refused before anything is sent, so native intake records nothing. `--session` with `--continue`, `--resume` or `--fork` is refused as conflicting flags. |
| `invalid-input` | 2 | No prompt, or a prompt given with an `--intake-*` flag. |
| `native-<kind>` | varies | An `--intake-*` run: `<kind>` is the kind of the host's record. `--intake-status` exits `0` whenever the host has a record. Otherwise `native-work` exits `0` when the work has an execution state, `native-blocked` and `native-refused` exit `1`, `native-cancelled` exits `130`, and any other kind (`native-captured`, `native-processing`, `native-turn` not run by this process) exits `3`. With no record kind the reason is `native-<status>`: `native-invalid` exits `2`, `native-unavailable` exits `1`, and `native-pending` (another intake action is already in progress), `native-recorded` (the host recorded the input without a result kind) and `native-detached` (no intake state came back at all) exit `3`. |
| `native-unknown` | 3 | The outcome on the host is unknown. |
| `native-unavailable` | 1 | No daemon or no credential; nothing was sent. |

A failure while shutting down after an otherwise successful turn changes exit `0` to `1` and appends `shutdown failed: ...` or `session pointer not written: ...` to `error`.

### A complete example stream

A run that lists files with one shell command, decided by the decision model:

```text
$ goodvibes run --output stream-json "how many TypeScript files are in src?"
{"schemaVersion":1,"type":"STREAM_DELTA","content":"I'll count them.","accumulated":"I'll count them."}
{"schemaVersion":1,"type":"USAGE","turnId":"turn-1","provider":"openai","model":"gpt-5.4","inputTokens":5120,"outputTokens":48,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsdCents":1.3,"signIn":{"route":"subscription"}}
{"schemaVersion":1,"type":"PERMISSION_REQUESTED","callId":"call-1","tool":"exec","category":"execute","riskLevel":"high","summary":"Execute shell command","ownerPrompt":false}
{"schemaVersion":1,"type":"PERMISSION_DECIDED","callId":"call-1","tool":"exec","category":"execute","approved":true,"source":"jev_decision","ownerPrompt":false,"reasonCode":"jev_act","reason":"Jev allowed it: the safety reading put its stakes at low."}
{"schemaVersion":1,"type":"TOOL_EXECUTING","turnId":"turn-1","callId":"call-1","tool":"exec"}
{"schemaVersion":1,"type":"TOOL_SUCCEEDED","turnId":"turn-1","callId":"call-1","tool":"exec","durationMs":41}
{"schemaVersion":1,"type":"STREAM_DELTA","content":"There are 212 ","accumulated":"There are 212 "}
{"schemaVersion":1,"type":"STREAM_DELTA","content":"TypeScript files in src.","accumulated":"There are 212 TypeScript files in src."}
{"schemaVersion":1,"type":"USAGE","turnId":"turn-1","provider":"openai","model":"gpt-5.4","inputTokens":5390,"outputTokens":12,"cacheReadTokens":4864,"cacheWriteTokens":0,"costUsdCents":0.4,"signIn":{"route":"subscription"}}
{"type":"TURN_RESULT","schemaVersion":1,"ok":true,"response":"There are 212 TypeScript files in src.","error":"","stopReason":"completed","events":11,"sessionId":"user-1a2b3c4d","model":"openai:gpt-5.4","provider":"openai","signIn":"subscription","usage":{"modelCalls":2,"inputTokens":10510,"outputTokens":60,"cacheReadTokens":4864,"cacheWriteTokens":0,"costUsdCents":1.7}}
```

The ids, counts and prices above are illustrative; the field names and their order are what the program writes.

### Answering permission prompts from a script

1. Run with `--output stream-json --answer-permissions`, with standard input connected to the script.
2. For each call that needs the owner, the run writes a `PERMISSION_PROMPT` frame and waits. The script is the run's one answerer for every question its calls raise, a method the daemon would otherwise decide itself (a schedule, a channel route or draft, a profile fact) included: nothing goes to Waiting for you, and no time limit decides a question.
3. The script writes one line: `{"type":"PERMISSION_ANSWER","callId":"<callId>","approved":true}`. Optional fields: `remember` (boolean) and `note` (text the model sees on a refusal, cut at 2000 characters).
4. The run acknowledges with `PERMISSION_ANSWERED`, or rejects the line with `PERMISSION_ANSWER_REJECTED` and the reason (`callId must be the string from the PERMISSION_PROMPT frame`, `approved must be true or false`, `no prompt is waiting for this call id; it was answered already, or never asked`).

Lines that are not a `PERMISSION_ANSWER` are ignored. A call never answered is refused when standard input ends, the run is cancelled or the run finishes; it is never approved by silence.

A complete script that approves every prompt (Linux, with `jq`):

```sh
mkfifo answers
exec 3<>answers   # hold the pipe open, so the run's input does not end after the first answer
goodvibes run --output stream-json --answer-permissions "delete the build directory" <answers |
while IFS= read -r frame; do
  printf '%s\n' "$frame"
  call=$(printf '%s' "$frame" | jq -r 'select(.type=="PERMISSION_PROMPT") | .callId')
  if [ -n "$call" ]; then
    printf '{"type":"PERMISSION_ANSWER","callId":"%s","approved":true}\n' "$call" >&3
  fi
done
exec 3>&-
rm answers
```

### Crash recovery in runs

Every run writes its session's crash snapshot at the same moments the interface does, and records the session as the last one, so `--continue` reaches a run that was killed.
`run --continue`, `--resume [id]` or `--session <id>` on a session whose snapshot is newer than its saved copy restores the snapshot first, without asking; the interrupted turn is recorded as interrupted and not run again.
Text mode prints one `[Recovery]` line on standard error; `stream-json` writes `SESSION_RECOVERED`; both JSON formats carry `recovery`.
A session another running copy has open is refused before anything is sent: exit `1`, `stopReason` `session-open-elsewhere`, `refusal.code` `SESSION_OPEN_ELSEWHERE`.

### Exit codes of `run`

| Code | Meaning |
| --- | --- |
| `0` | Completed. |
| `1` | Failed: model or provider error, empty response, delegated work failed, `--max-turns` reached, a turn refused before it started (`preflight_failed`, `context_overflow`), or the daemon was unavailable or refused the input. |
| `2` | Invalid input: a usage error, a missing prompt, or a prompt given with an `--intake-*` flag (`Recovery uses the original journal input; do not supply a replacement prompt.`). A usage error prints the error and the command's one usage line on stderr, not the whole help; with `--output json` or `stream-json` it is the run's final frame on stdout (`ok` `false`, `stopReason` `invalid-input`). Any other command asked for `--output json` answers a usage error with `{ "ok": false, "kind": "usage", "error": "...", "next": ["Usage: ..."] }`. |
| `3` | Outcome unknown: the turn ended without a final event (`turn-unsettled`), or a native input may have taken effect on the daemon (run `goodvibes run --intake-status` before retrying). |
| `124` | `--timeout` reached. |
| `130` | Cancelled (Ctrl-C, SIGTERM, or the saved input was cancelled). |

A run that finished without a decision model still exits `0`; `diagnostics` says so.

## Editors: the Agent Client Protocol

`goodvibes acp` runs the terminal app as an Agent Client Protocol agent on standard input and output, so an ACP editor (Zed and others) can drive it.
Standard output carries only protocol frames; everything for a person goes to standard error.
It takes no arguments; an argument prints its usage and exits `2`.
It exits `0` when the editor closes standard input or on SIGINT or SIGTERM, and `1` when ACP cannot run (the reason is one line on standard error).
Prompts are text only; session restore (`loadSession`) is not supported and `initialize` reports it as `false`.
It uses the terminal app's model, providers and permission mode. Each prompt is answered by one agent working in the thread's folder with the thread's conversation: its answer, its tool calls and its permission asks reach the editor, and the prompt ends `end_turn`, or `cancelled` after `session/cancel`. A run that fails ends the prompt with an error that says why (`The run failed: ...`); while a provider error is being retried the editor is shown why the answer is late.
Editor threads share the one embedded daemon of the home directory (`GOODVIBES_HOME` selects it); a thread whose working directory lies outside it gets its own; `session/close` ends a thread.

Zed configuration:

```json
{ "agent_servers": { "GoodVibes": { "command": "goodvibes", "args": ["acp"] } } }
```

To expose the operator API to an MCP client instead, use `goodvibes-daemon mcp serve` (described under "`mcp serve`" in the daemon part).
A remote runner the daemon starts (the Runners tab of the Work place, "start a runner" or "start from a pool") runs this same command as its subagent; `ACP_AGENT_CMD`, set for the daemon, replaces it. (There is no model tool named `delegate`.)

## Project instructions

The model's standing instructions are built from these files, each present and non-empty file appended in this order (a later file takes precedence where they disagree):

1. `~/.goodvibes/SYSTEM.md`
2. `~/.goodvibes/GOODVIBES.md` (the owner's global instructions)
3. the nearest `AGENTS.md`, found by walking up from the working directory to the project's root (never a folder above it)
4. `<project>/.goodvibes/GOODVIBES.md` (the project's instructions)
5. the file named by the setting `provider.systemPromptFile`

3 and 4 are the project's own files: read only while you trust the project, each opened as it really is (one linked out of the project gives nothing of itself), at most 1 MiB, cut at 32,000 characters, and marked in the prompt as the project's file, never as your words. One not read is named in one line instead. See "What a project's own files give a model" in the permissions part.

To give the terminal app standing instructions for one project, write them to `<project>/.goodvibes/GOODVIBES.md`; for every project, to `~/.goodvibes/GOODVIBES.md`.

## Settings the terminal app reads most

Every key is listed under "Settings" in the reference part. The prefixes that change the terminal app's own behavior:

<!-- generated: settings:display -->

<!-- generated: settings:behavior -->

<!-- generated: settings:ui -->

<!-- generated: settings:tools -->

<!-- generated: settings:checkpoints -->

<!-- generated: settings:runtime -->
