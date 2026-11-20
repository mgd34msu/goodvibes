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
| checkpoint | A snapshot of the workspace files that `/rewind` can return to (see "Restoring a checkpoint"). |
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
A launch whose model is not ready opens first run (choose a provider, sign in, then the conversation with starting prompts for the folder; see the install part of this file); `goodvibes onboarding` (alias `goodvibes setup`) opens the full setup wizard on demand.
The onboarding screens are described under "First run and onboarding" in the install part.

`goodvibes open <link>` takes exactly one link of the form `goodvibes://open/<view>[?target=<id>[:<kind>]]`.
In a process view (agents, tasks, orchestration) the target selects that process; in another view the app opens the view and says the target was not used.
A link that is missing or not of that form is refused:

```text
$ goodvibes open notalink
goodvibes open takes one link: goodvibes://open/<view>[?target=<id>[:<kind>]] ("notalink" is not one).
```

The exit code is `2`.
`/deeplink review` inside the app lists every view link.

### Global options

The complete help of every command, as the program prints it, is under "Command line: `goodvibes`" in the reference part.

How each option behaves:

| Option | Behavior |
| --- | --- |
| `-m, --model <registryKey>` | Uses this model for this launch. The text before the first colon names the provider (`openai:gpt-5.4`, `Ollama:llama3:8b`), which is then selected unless `--provider` is also given. The provider is any registered one (built-in, custom, or a server found by `/scan`), named by its id or display name without regard to case, so `-m ollama:llama3:8b` is the scanned `Ollama` server's model. A name no registered provider has is an error listing the registered providers when the model is used (`models current`, `run`, the interactive app). A value with no colon, or with a slash before its first colon (`meta-llama/llama-3.3-70b-instruct:free`), is a model id under the configured provider. A model id that itself holds a colon needs its provider: `-m ollama:llama3:8b`, or `--provider Ollama -m llama3:8b`. |
| `--provider <id>` | Uses this provider for this launch. |
| `-C, --cd <dir>`, `--working-dir <dir>` | Sets the working directory for this launch. Sessions and project settings are read from that directory. |
| `--daemon-home <dir>` | Uses this daemon home (default `~/.goodvibes/daemon`) for every command that reads the operator token or daemon settings. It wins over the `GOODVIBES_DAEMON_HOME` environment variable. |
| `-c, --config <key=value>` | Overrides one setting for this launch only. It may be repeated. Nothing is saved. |
| `--enable <feature>`, `--disable <feature>` | Turns one feature flag on or off for this launch. The value is a feature id, not a setting key. An unknown id is refused and the error lists the known ids. |
| `-p, --prompt <text>` | Runs one prompt without the interface (the same as `run`). |
| `--print` | Selects non-interactive run mode (the same as `run`) when no command is given. |
| `-o, --output <format>` | Output format for `run` and for commands that print data: `text`, `json` or `stream-json`. Another value is refused with `-o must be one of: text, json, stream-json.` and exit `2`. `--json` means `--output json`. `--output-format <format>` is accepted as the same option and prints `[goodvibes] warning: --output-format is deprecated; use --output (or -o) instead.` on standard error; standard output is unchanged. When two of these are given, the last one wins. |
| `--just-vibes` | Sets the permission mode to `just-vibes` for this launch only: work continues without asking, and anything that needs the owner is held and listed at the end. It is the same as `--config permissions.mode=just-vibes`. |
| `--yolo` | Sets the permission mode to `yolo` for this launch only: every action runs without safety denials; `Pre:tool:*` hooks and never-run rules still apply. Containment, secret storage and payment limits still apply. `--no-worries-just-vibes` is an unlisted spelling of the same option. It may come before or after the command word (`goodvibes --yolo run ...` or `goodvibes run --yolo ...`). |
| `--no-alt-screen` | Keeps the interface in the normal scrollback instead of the alternate screen. |
| `--port <port>`, `--hostname <host>` (`--host`) | Port and bind address for `web` and `surfaces enable`. The port must be 1 to 65535. |
| `--open` | Opens a browser where the command supports it (`web`, `subscription login <provider> start`). |
| `-r, --resume [id\|latest]` | Opens a saved session. Without an id it opens the last session of this working directory. |
| `-s, --session <id>` | `run` only: continue that saved session. Every other command refuses it. |
| `--continue` | Opens the last session of this working directory. |
| `--fork [id]` | Bare `--fork` forks the session that is active when the app starts. `--fork <id>` opens that session, then forks it. `run` refuses `--fork`. |
| `--timeout <duration>` | `run` only: cancel after this long. A bare number is seconds; `ms`, `s`, `m` and `h` suffixes are accepted. Exit code `124`. |
| `--max-turns <n>` | `run` only: stop after `n` model answers that still ask for tools. Exit code `1`. |
| `--omit-accumulated` | `run` with `stream-json` only: leave `accumulated` out of `STREAM_DELTA` frames. |
| `--answer-permissions` | `run` with `stream-json` only: read owner answers to permission prompts from standard input. |
| `-y, --yes` | Confirms a command that would otherwise only preview (for example `plugin bundles install`, `support-bundle import`). |
| `--non-interactive` | Disables every interactive prompt and implies `--yes`. |
| `--strict` | `doctor` only: also fail on advisory findings. |
| `-h, --help` | Prints help. `goodvibes help <command>` prints one command's help. |
| `-v, --version` | Prints `goodvibes 3.3.1`. |

Only one of `--continue`, `--resume` and `--fork` may be given on one launch.

### Rules of the command-line parser

- A flag that takes a value refuses a value that begins with `-`. Use the equals form: `--prompt='- item'`.
- `--` ends option parsing. Every word after it is a positional argument: `goodvibes run -- --literal-text`. A command never reads one of its own options (`--yes`, `--apply`) from a word after `--`.
- An unquoted word in a prompt that equals a command name or alias (`doctor`, `auth`, `task`) is read as that command. Quote the whole prompt.
- After a command word, an option that command does not take is refused with exit code `2`, and the error lists the options it accepts.
- A run-only flag (`--timeout`, `--max-turns`, `--omit-accumulated`, `--answer-permissions`) on any other command is refused with exit code `2`:

```text
$ goodvibes status --timeout 5
--timeout, --max-turns, --omit-accumulated and --answer-permissions apply only to the run command.
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
| `ACP_AGENT_CMD` | Replaces the command `/remote dispatch` and `/remote dispatch-pool` start as an ACP subagent (by default this program's own `acp` command). Give it as a JSON array of program and arguments, for example `["/path/to/agent","acp"]`; a value that is not an array is used as one path when such a file exists, otherwise split on spaces. A value that starts with `[` but is not a JSON array of non-empty strings is refused with the reason. |
| `EDITOR`, `VISUAL` | The editor `/editor` and `/template edit` open. |
| Provider key variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the others in the provider list) | Sign a provider in with an API key. An environment variable wins over a key stored with `/secrets`. |

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

### `goodvibes status`

`status` prints the configuration posture: working directory, home directory, provider and model, reasoning effort, sign-in, decision model, permission mode, local auth files, daemon service, surfaces, onboarding, crashes, workspace trust and the exec sandbox.
The `provider` and `model` lines name what a turn started now would use: the saved model, or this launch's `-m`/`--provider`, resolved against the registered providers (custom ones and the servers the last `/scan` saved) the same way a run resolves it, so `-m ollama:llama3:8b` shows `provider: Ollama`. When no registered provider has the name, a `problem:` line says so, lists the registered providers and says how to choose another. The Agent's `status` does the same.
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
  sign-in: no subscription and no OPENROUTER_API_KEY in the environment. If you saved a key with /secrets, the app uses it (this report does not read stored keys); otherwise sign in with: export OPENROUTER_API_KEY=<key>, or /secrets in the app
  ...
Decision model:
  policy: Hybrid (default) (judgment.policy)
  No decision model is in use: none is set, so decisions take their fallbacks. Next: to use one, set judgment.model, judgment.endpoint or TYPESAFE_API_KEY.

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
                not jev-decides, because no decision model is set (judgment.model, judgment.endpoint or TYPESAFE_API_KEY), so every call Jev would decide asks you
...
  rules       : the remembered rules of this project were read
  decision model: not consulted: No decision model is in use: none is set, so decisions take their fallbacks. Next: to use one, set judgment.model, judgment.endpoint or TYPESAFE_API_KEY. The verdict is the one the gate gives without a decision model.
...
Decision: ASK
  decided by : user_prompt (user_denied)
  because    : This reaches a Human-in-the-Loop approval prompt; the outcome depends on your response at the prompt.
```

A file write is explained with the tool name and path: `goodvibes doctor explain write ./src/app.ts`.
Every `doctor` finding is described under "Checking an installation with doctor and status" in the install part.

### `goodvibes setup`

`goodvibes setup` opens the terminal app on `/setup`: the setup topics, one form each.
`goodvibes setup status` prints whether first run has been done for this user and exits:

```text
$ goodvibes setup status
GoodVibes onboarding status
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
  detail: Not signed in: sign in with a ChatGPT subscription (/provider sign-in openai) or set OPENAI_API_KEY.
```

A line of `goodvibes providers` reads like this:

```text
  * openai             setup=unknown configured=no via=api-key models=53 routes=1/4 configured, 0/4 usable Not signed in: sign in with a ChatGPT subscription (/provider sign-in openai) or set OPENAI_API_KEY.
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

Inside the terminal app, `/provider sign-in openai` does the same and waits for the browser to return to the local callback address; when the browser returns there the sign-in finishes without step 3.

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
| `goodvibes secrets set <KEY> <value> [--user\|--project] [--secure\|--plaintext]` | Stores a value. `--plaintext` stores it unencrypted. |
| `goodvibes secrets set <KEY> --stdin` | Reads the value from standard input. Use it for a value that starts with `--`, and to keep the value out of shell history. |
| `goodvibes secrets link <KEY> <ref> [--user\|--project] [--secure\|--plaintext]` | Makes `<KEY>` resolve through the reference. |
| `goodvibes secrets delete <KEY> [--user\|--project] [--secure\|--plaintext]` | Deletes a stored key. |

Put flags after the positional words: the `secrets` helper reads the word after a flag as that flag's value.

Worked example:

```text
$ printf '%s' '<your-api-key>' | goodvibes secrets set OPENAI_API_KEY --stdin --user
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
| `goodvibes auth add-user <username> [--password <value>\|--password-stdin] [--role <role>]` | Adds a user. Without a password flag it reads `GOODVIBES_AUTH_PASSWORD`. `--role` may be repeated; the default role is `user`. |
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

`host pair` reviews and creates the credential this terminal app uses to call its host daemon.

```sh
goodvibes host pair                         # review only: prints what pairing would do
goodvibes host pair --bootstrap-shared      # review using the daemon's shared bootstrap credential
goodvibes host pair --apply                 # create the credential; asks for fresh confirmation
goodvibes host unpair                       # forget the stored credential here
```

`--url <exact-origin>` names the host and `--name <device-name>` names the credential.
`--apply` needs a fresh confirmation typed in an owner terminal; `--yes` is not accepted for it.
`unpair` forgets the credential here only; it stays valid on the host until it is revoked there.
Host pairing is described under "Host pairing: giving the terminal app its own credential" in the daemon part.

### `goodvibes pair` (aliases `qrcode`, `qr`)

`pair` mints a named, revocable device token on the connected daemon and prints its pairing link and a QR code for a phone or browser.

```sh
goodvibes pair --name "my phone"
```

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

A support bundle is a redacted snapshot of configuration, diagnostics and posture, for a support request or for moving settings to another machine.

| Form | Effect |
| --- | --- |
| `goodvibes support-bundle export [path]` | Writes the bundle. |
| `goodvibes support-bundle inspect <path>` | Prints what a bundle holds. |
| `goodvibes support-bundle import <path> [--include-security] [--yes]` | Applies the bundle's setting values. |

`import` refuses a bundle from another product or format version.
It imports only values that differ from the current settings.
It holds back permission, sandbox, listener, service and storage settings unless `--include-security` is given.
It applies all values or none.
Without `--yes` it lists each change as `current -> new`, changes nothing and exits `2`.
With `daemon.connectedHost.url` set, the daemon's settings go to that daemon with the token stored for it (or an `/accounts sign-in daemon` session); with none stored, nothing is sent and the import fails with `CREDENTIAL_NOT_FOR_TARGET`. This machine's daemon token is never sent to another daemon.

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
  FAIL  pre:tool:exec #0 (unnamed): "pre:tool:exec" is not a recognized hook event point: no registered hook point matches it (phases are Pre, Post, Fail, Change and Lifecycle, and case matters); /hooks contracts lists them
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
  next: a plugin starts disabled. In the terminal app or the Agent run /plugin enable my-plugin (no restart needed).
```

Without a directory, `plugin init <name>` writes `<project>/.goodvibes/plugins/<name>/`, where the loader looks. With a directory it writes there. The apps load a plugin only from a folder directly inside `<project>/.goodvibes/plugins/` (when the app runs in that project) or `~/.goodvibes/plugins/`. For any other directory, `plugin init` and `plugin validate` say so after the `PASS` line:

```text
  NOT LOADED  no app loads a plugin from this folder: plugins are read only from folders directly inside /home/me/work/project/.goodvibes/plugins or /home/me/.goodvibes/plugins.
  Move the folder into one of them, then enable it.
```

With `--output json` both add `loadedFromHere` (true or false) and `searchDirectories`.
A scaffolded plugin is not running yet: it must also be enabled (`/plugin enable my-plugin`, in the terminal app or the Agent), as described under "Plugins".
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
`goodvibes version` prints `goodvibes 3.3.1`.
`goodvibes help version` has no detailed help and prints the overview.

## The interface

### Screen layout

The screen has four regions, top to bottom.

1. The header names the program, its version and the session. While a helper agent or background process is open full screen, the header reads `main › <agent>` in the agent's color. While a failover is in force it also names the model answering, with `failover from <selected model>`.
2. The transcript shows the conversation: owner prompts, model answers, tool calls with their results, notices in square brackets (`[Permissions]`, `[Context]`, `[Failover]`), and the work tree of helper agents and background processes started in the turn.
3. The composer is the text box where the owner types. Its label shows what Enter will do (prompt, command, shell, note, memory pin).
4. The status bar, the row under the composer. Left: `Asks:` and the permission mode chosen (`Asks: Jev decides`); when the mode in force differs, ` · asking you for now · <why>` (`decision model unreachable`, `decision model failing`, `no decision model set`, `no decision model chosen`, `not measured yet`); then the `shift+tab` key that changes it. Then the chips that stay visible (`! YOLO` while an old auto-approve setting is on, the microphone, `sleep disabled`), the unread notices (`2 notices` with the `ctrl+n` key; absent at zero), what the next `Esc` does while a turn runs, and any background work. Right, two spaces apart: the cost when the model is priced, `context 34%` (amber from 65%, red at the compaction threshold; `context unknown` when the window is not known), `branch main, changed` (`, changed` while the working tree differs from the last commit; absent outside a repository), `model <name>`, and `ctrl+p menu`. A click on a segment opens its view: the mode opens the permission mode setting, the notices the notifications, context the context inspector, branch the changes, model the model picker, the cost Usage. On a narrow screen the pieces go in this order: `ctrl+p menu`, the cost, the branch, the context, the reason shortens (`decision model unreachable` to `unreachable`), the model, the reason, the notices; `Asks:` with the mode and `asking you for now` always stay.

While more than one session exists (a helper agent or background process is running), a row of session chips appears under the header; `Tab` and `Shift+Tab` switch between sessions when the composer is empty.

### What the composer does with typed text

| Typed text | What happens on Enter |
| --- | --- |
| Plain text | It is sent to the model as a prompt. |
| A line that starts with `/` | It runs as a slash command. Typing `/` opens command autocomplete. |
| A line that starts with `!` | The rest runs as a shell command in the working directory, beside the composer. The command, its output and its exit status are shown in the conversation where it ran, and the output is placed in front of the next prompt as context for the model (the conversation shows that prompt, and the session title takes it, as typed). `Esc` stops a command that is still running. Spoken input is never run as a shell command. |
| `!# <text>` | `<text>` is pinned to session memory and also sent as the prompt. `[Memory] Pinned: "<text>" (<id>)` confirms it. |
| A single line `# <text>` (hash and space) | `<text>` is saved as a session-memory note and nothing is sent. `✓ Note saved → session memory: "<text>" (<id>)` confirms it. `#482 is failing`, `## heading` and text of more than one line are sent as prompts. |
| `@model:<id>` as the first or last word | The model switches exactly as `/model use <id>` would, then the rest is sent. Only a whole word at either end counts. When the switch does not happen, the text stays in the composer. |
| `!@<path>` | The file's text replaces the reference before sending. An image file (PNG, JPEG, WebP or GIF, judged by its bytes) is attached as an image instead. Any other file that is not UTF-8 text, or that cannot be read, stops the send with the reason (`a binary file is not sent as text; ...`). |

Text that was not typed into the composer (a skill body, `/retry`, a template, `/image`, a form, speech) is sent as written and never read for these markers.
In the terminal app, `@<path>` is plain text that names the file; the model reads it with its tools. (The Agent expands `@<path>` itself; see "Composer differences" in the Agent part.)
A paste of more than 8 lines folds into a marker `[TEXT: pN, M lines]`; `/pastes` shows what each fold holds before sending.

Images in the terminal app:

- An image pasted from the clipboard (`Ctrl+V`, or `/paste`) becomes a marker `[IMAGE: img1, clipboard, <size>KB]` in the composer and is sent with the message as an image.
- Pasting the path of an image file (ending in `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`) that exists and is at most 20 MB attaches the file the same way: `[IMAGE: img2, photo.png, <size>]`. A larger file stays a plain pasted path.
- `/image <path> [prompt text]` sends the image with the prompt at once. A file over 20 MB is refused with its size. When the current model does not accept images, it prints `Warning: <model> does not support image input. The image will be stripped when sending.` and the image is not sent to that model.
- Deleting a marker with `Backspace` removes that image.
- `@photo.png` typed in the composer is plain text (the model can read the file with its tools); `!@photo.png` attaches the image, at most 20 MB, as a pasted path does.

### Fixed keys

These keys are not in the rebindable table.

| Key | Action |
| --- | --- |
| `Enter` | Send the composer, or run the selected row in a list. |
| `Shift+Enter` | Insert a newline. |
| `Tab` | Complete a path or command; with an empty composer while session chips show, switch to the next session; otherwise toggle the nearest block's collapse. |
| `Esc` | Close the top view (one level), then clear the composer, then interrupt the running turn. Inside Agents it backs out one level and never stops work. |
| `PageUp`, `PageDown` | Scroll the transcript by a page. |
| `Up`, `Down` | Scroll the transcript, or recall input history when the composer is focused. |
| `F2` | Open or close Your agents. |
| `?` on an empty composer | Open the help list of every command. |
| `@` at the start or after a space | Open the file picker; the chosen path is inserted. `!@` opens it to insert a file whose text will be embedded. |
| `r` or `m` after a turn error | Retry the turn, or open the model picker. Any other key dismisses the choice. |
| `n`, `N` in locked search | Next or previous match; the search wraps and shows `(wrap)`. |
| Mouse wheel, drag, middle click | Scroll, select text, paste. |

### Rebindable keys

The default table of the terminal app:

| Action | Default key | What it does |
| --- | --- | --- |
| `copy-selection` | `Ctrl+Shift+C` | Copy selected text to the clipboard. |
| `clear-cancel` | `Ctrl+C` | Clear the composer; on an empty composer cancel generation; pressed twice within one second, exit. The footer shows `Press Ctrl+C again to exit`. |
| `screen-clear` | `Ctrl+L` | Repaint the screen. |
| `command-palette` | `Ctrl+P`, `Ctrl+K` | Open the command palette: every command, view and setting. |
| `open-agents` | `Ctrl+O` | Open Your agents: what is running, what waits for you, what is scheduled (the same as `F2`). |
| `history-search` | `Ctrl+R` | Reverse search of input history. |
| `search` | `Ctrl+F` | Search this conversation's transcript. |
| `block-copy` | `Ctrl+Y` | Copy the nearest block. |
| `bookmark` | `Ctrl+B` | Bookmark or unbookmark the nearest block (`/bookmarks` lists them). |
| `block-save` | `Ctrl+S` | Save the nearest block to a file. |
| `delete-word` | `Ctrl+W` | Delete the word before the cursor (whitespace-delimited) into the kill ring. |
| `line-start` | `Ctrl+A` | Move to the start of the line. |
| `next-error-line-end` | `Ctrl+E` | Move to the end of the line; on an empty composer, jump to the next error in the transcript. |
| `kill-line` | `Alt+K` | Kill from the cursor to the end of the line into the kill ring. |
| `clear-prompt` | `Alt+U` | Clear the whole composer without using the kill ring. |
| `undo` | `Ctrl+Z` | Undo the last composer edit. |
| `redo` | `Ctrl+Shift+Z` | Redo the last undone composer edit. |
| `paste` | `Ctrl+V` | Paste from the clipboard; an image takes priority over text. |
| `word-back` | `Alt+B` | Move to the start of the previous word. |
| `word-forward` | `Alt+F` | Move to the end of the next word. |
| `kill-to-start` | `Ctrl+U` | Kill from the cursor to the start of the line into the kill ring. |
| `kill-word-forward` | `Alt+D` | Kill the next word into the kill ring. |
| `yank` | `Ctrl+Shift+Y` | Paste the newest kill-ring entry. |
| `yank-pop` | `Alt+Y` | Right after a yank, replace it with the previous kill-ring entry. |
| `cancel-tool-call` | `Alt+C` | Cancel the running tool call; the turn continues. |
| `toggle-keep-awake` | `Alt+A` | Turn the machine's keep-awake on or off (the "sleep disabled" chip). |
| `toggle-memory-provenance` | `Alt+M` | List or hide the memories the last turn used. |
| `voice-input` | `Alt+V` | First press starts recording; the second press stops it and puts the transcription in the composer. |
| `focus-work-tree` | `Alt+Up`, `Ctrl+Up` | Move the keyboard onto the transcript's work tree: arrows move and fold, `Enter` opens, `y` copies, `Esc` returns. |
| `cycle-permission-mode` | `Shift+Tab` | Cycle this session's permission mode (see below). |
| `open-notifications` | `Ctrl+N` | Open the notifications; the status bar counts the unread ones. |
| `failure-other-model` | `Alt+O` | On the newest failed turn: choose another model and send the prompt again. |
| `failure-details` | `Alt+I` | On the newest failed turn: show what the provider said. |
| `failure-sign-in` | `Alt+S` | On the newest failed turn whose provider refused its key: open the provider sign-ins (`/auth`). |

`Alt+R` on the newest failed turn sends the failed prompt again in place of the failed turn. The failed turn stays in the transcript, and the offer stays, until the replacement is submitted: when the memory refresh before it fails, or the session or the failed turn changes meanwhile, nothing is taken away and `Alt+R` tries again. When the failed turn had already run tools, the tool results are kept and the turn continues from them, so their effects are not repeated. The keys are named on the failed turn's row (see "Turn errors"), not in the footer.

`Shift+Tab` cycles `ask-me` → `jev-decides` → `just-vibes` → `yolo` → `ask-me`.
Before `yolo` it asks for confirmation (default No); declining skips to the mode after it.
The change lasts for the session only. The saved default is changed in `/settings` (or `/settings set permissions.mode <mode>`); `/permissions` shows it but does not change it.
Plan mode is outside the cycle; `/plan` turns it on and off for this session, also without changing the saved default.
Nothing is written into the conversation: the status bar's `Asks:` segment shows the new mode and flashes (drawn inverse) for 1.5 seconds. When the mode chosen is not the one in force (`jev-decides` with no working decision model runs as `ask-me`), the segment says so and why: `Asks: Jev decides · asking you for now · no decision model chosen`.
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
| Your agents | `F2`, `Ctrl+O`, `/agents` | The work board, the same panel as the Agent's: rows waiting for you first (`Waiting for you`), then one line per running agent (`● Helper agent   Writing docs/usage.md   15s  2 files read`, sub-agents indented under their parent), the agents that finished this session (or `no finished agents this session`), `Scheduled` (schedules and watches with their cadence and last run), and one line `Background services  N healthy ›`. The platform's own heartbeats, pollers and the code index are counted there, never as running; an unhealthy one is listed under that line by itself (`Daemon heartbeat stopped answering · 3 min ago`). Keys: `Enter` opens the selected row (an agent or background process full screen; a contract, workflow or hosted agent full height in the panel; a pick or merge conflict acts; a stalled service restarts where it can), `s` stops it and what it started (asks first; `Ctrl+X` too), `n` starts a new agent (a coding agent found on `PATH`, hosted by the GoodVibes service), `b` opens or closes the background services, `p` pauses or resumes a schedule. Also: `i` interrupts, `D` discards a contract's worktree, `f` follows the newest running agent, `v` shows the archive (`a` archives or restores one, `A` archives everything finished), `/` filters. Empty: `nothing running` and `Ask for something and helper agents show up here.` A fleet that cannot be read: `Couldn't read what is running: <reason>` with `r` to try again. On a screen 90 columns or wider the selected row's detail is on the right: model, time, files read and changed, tokens, and cost only when priced. |
| Usage | `/usage`, `/cost` | Context bar with the compaction threshold, session tokens and cost, per-turn bars, per-agent cost and the budget alert. |
| Changes | `/changes`, `/diff`, `/review` | Changed files with +/- counts, a tinted diff, a semantic summary; `]` and `[` move between hunks, `space` stages a hunk, `c` adds a review comment for the model, `m` marks reviewed, `o` opens the file in the editor. |
| Notifications | `/notifications` | Every notice, newest first; `Enter` goes to its subject. |
| Sessions | `/session`, `/resume` | Saved sessions, with hosted sessions in a Hosted group. |
| Settings | `/settings` | Every setting by category, searchable. |
| Model picker | `/model`, `/provider` | Providers and models for each route. |

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

Configuration workspaces (`/memory open`, `/todo open`, `/marketplace`, `/plugin`, `/services open`, `/provider open` and others) keep a search row that always takes typed characters.
An action there fires from `Enter`, from `Ctrl` plus its letter (the hint bar shows `^d delete`), or from `Ctrl+G` followed by its key for keys a terminal cannot send with `Ctrl` (`c`, `h`, `i`, `j`, `m`, digits and capitals; the hint bar shows `^G c`).
An action that deletes, uninstalls or clears asks for the same key a second time; `Esc` cancels.

### Turn errors

A failed turn is a row in the transcript under its prompt, which stays as you typed it. No notice is shown over the conversation:

```text
✕ The model didn't answer.
  OpenAI returned an error (500) six times. Nothing was changed.

  alt+r try again   alt+o use another model   alt+i details

  Tip: name a backup model once and GoodVibes switches by itself:
  /model backup
```

The second line is worded from the failure's facts: the provider's status (`refused the API key (401)`, `turned the request away for too many requests (429)`, `returned an error (500)`), a connection error (`GoodVibes couldn't reach <provider> (ECONNREFUSED)`), how many requests were made, and what the turn's tools changed before it stopped, from the turn's own record (`2 files were changed before it stopped. /changes`; `1 command ran before it stopped.`; `Nothing was changed.` only when the record shows nothing was written, run or sent). `alt+r` sends the prompt again, `alt+o` opens the model picker and sends the prompt to the model chosen there, `alt+i` shows the details under the second line (provider, model, status, code, attempts and their times, why the fallback order did not move the turn, the provider's own message) and hides them again. A provider that refused its key offers `alt+s sign in again` (the provider sign-ins, `/auth`) in place of `alt+r`. The tip is shown only while `provider.fallbackModels` is empty. A turn sent with no usable model (no model selected, or its provider not signed in) is refused before any request: `No model is set up yet. Nothing was changed.` with `alt+o choose a model` and `or run /setup`. A newer prompt removes the keys and the tip from the older row; its first two lines stay. While a failing request is retried, the row says so (`Retrying up to 5 times…`) and becomes the failure row when the retries are spent.
A provider failure may move to another sign-in, another backend of a `synthetic` model, or the next model of your fallback order, as described under "Failover".
`/retry [modified text]` sends the last prompt again, optionally changed.

## Slash commands

### How slash commands work

A slash command is typed in the composer and run with Enter: `/model use openai:gpt-5.4`.
Typing `/` opens autocomplete; `Tab` completes the selected command.
A command that is not yet described may have aliases (`/d` is `/diff`); a described command has only its name.
Arguments are separated by spaces; quote an argument that contains spaces with `"` or `'` at the start of the word (`/title "Release prep"`).
A quote character inside a word is an ordinary character, so `["a","b"]` is one word.
A backslash outside quotes is an ordinary character (`C:\dir`).
An unclosed quote refuses the whole line instead of being guessed.
A command that would change or delete something important asks for confirmation in a dialog; some take `--yes` instead.
A command that needs the daemon says `[<command>] <reason>` and changes nothing when no daemon answers.
A command the model runs on the owner's behalf passes the permission gate like any tool call; a few commands (`/devices pair host`, `/remote dispatch`, `/work request <goal>`, `/workstream start`) refuse unless the owner typed them.

The complete list of the terminal app's slash commands, with usage, aliases and descriptions, is under "Slash commands: terminal app" in the reference part.

The sections below explain the commands grouped by task. Each entry gives the purpose, the forms, a worked example with its result, and the failure cases.

### Help, navigation and display

`?` on an empty composer, `/help` and `Ctrl+P` (or `Ctrl+K`) all open the same list: every command as a plain title with its slash name on the right, grouped by task (Suggested, Session, Views, Settings, every other command), and the keyboard shortcuts as the last group, each with its key on the right. Typing searches titles, names, descriptions and search words; a search also lists the shortcuts it matches. The detail pane shows the selected command's summary, what it can do (its actions, for a guided command) and `Finds:` with the words that find it; on an 80-column terminal there is no detail pane and the selected row's summary is one dim line under the list. Enter runs the command (a guided command opens its list of things to do); `tab` puts it in the composer to type arguments. A shortcut row is read, not run. `/help <command>` prints one command's actions and typed lines, and `/help keys` prints every key with the file that changes them (`~/.goodvibes/tui/keybindings.json`). The list's last shortcut row names that file too. Without an interface `/help` prints every command with its usage.
`/find` (alias `/findtext`) searches this conversation's transcript, the same as `Ctrl+F`. `/search` searches the web instead.

`/expand [all|thinking|tool|code]` and `/collapse [all|thinking|tool|code]` open or fold every transcript block of that type. Without an argument they act on all blocks.
`/bookmarks` (alias `/bm`) lists blocks bookmarked with `Ctrl+B`.
`/next-error` (alias `/ne`) and `/prev-error` (alias `/pe`) scroll to the next or previous error line in the transcript.

`/verbosity` sets how much the app prints, the same in both apps: `/verbosity set quiet|balanced|operator` writes `behavior.hitlMode` (default `balanced`); `/verbosity show` (what `/verbosity` alone gives a model or script) prints the current level and the per-domain verbosity; `/verbosity set-domain <domain> <minimal|normal|verbose>` sets one domain's verbosity for this session.

`/notifications` opens the notification history.
`/conversation [review|events [kind]|groups [kind]|hotspots|composer|find <query> [kind]|next [kind]|prev [kind]|restore]` (aliases `/transcript`, `/composer`) reviews the transcript's structure: event kinds, groups, the busiest regions, the composer's state, and jumps between events of one kind. A wrong form prints its usage.

`/guidance` lists contextual guidance (`review`, the report), dismisses one item for what it reports now (`dismiss <item>`, picked from what is showing), or shows dismissed items again (`reset [<item>]`, every one when none is named).
`/guidance dismiss g1` on an item that is not showing is refused with `Guidance g1 is not showing now, so there is nothing to dismiss.`

`/deeplink` lists (`review`, what `/deeplink` alone gives a model or script), opens (`open <view|goodvibes://open/...> [target]`) and saves (`export <path>`, read back with `inspect <path>`) `goodvibes://open/<view>` links. `/deeplink open agents` opens Your agents. A link that is not of that form prints `Not opened: <link> is not a goodvibes://open/<view> link.`

`/health` is the one place for "is everything working". Bare in the terminal, it opens its list of actions; from a model or a script it prints the short status: `✓ Everything is working.`, or a headline such as `2 things need attention:` and one line per thing (`✕ <what is wrong>`) with `  Fix: <the line that fixes it>` under it. It reads setup, providers and accounts, settings, services, MCP servers, remote runners, the first-run sign-in file and the conversation's size; it makes no model request and changes nothing. Its actions:

| Action | Line | What it does |
| --- | --- | --- |
| See what needs attention | `/health report` | The short status above. |
| Check one area | `/health check <area> [--provider <id>]` | One area in detail: `setup`, `services`, `provider` (opens the providers view when typed by you), `accounts`, `auth`, `settings`, `intelligence`, `remote`, `mcp`, `memory`, `metrics` (the daemon's counters and a provider's quota), `continuity` (last-session pointer and recovery file), `worktrees`, `maintenance` (context use and session upkeep), `sandbox`, `terminal` (colour depth, synchronized output and the count of direct terminal writes intercepted this session), `approvals` (the Agent's; here `/approval` lists them). |
| Describe a problem | `/health diagnose <symptom>` | Finds the runbook for the words and runs its checks against the app's live state, without a model request: `/health diagnose stuck turn`. |
| See a failure report | `/health failure [<id>\|latest] [--as summary\|json\|bundle]` | This session's automatically classified failure reports: a summary (kind, what failed, error, stop reason, root cause, denied permissions, budget breaches, replay mismatches, how it happened), the report as JSON, or the whole bundle as JSON with the replay snapshot. Without one: `No failure report was recorded this session.` |
| Save a failure report as a file | `/health save-failure <file> [--report <id>] [--with-replay] [--replace]` | Writes the report's bundle (with the replay snapshot when asked). An existing file is kept unless `--replace`: `<file> already exists; nothing was written.` |
| Keep a failure report in memory | `/health keep-failure [<id>\|latest]` | Stores it once as an `incident` record in durable memory; a second time prints `Failure report <id> is already kept in memory as <record>; nothing was added.` |
| Stop a running agent | `/health stop-agent <agent> [--note <why>]` | Asks a running agent to stop (asks you first: it cannot be undone). `F2` or `Ctrl+O` opens Your agents, where `s` does the same. |
| See the runtime store | `/health state [<part> ...]` | What the app's runtime store holds now (session, conversation, agents, tasks, permissions and more), credentials masked; for debugging. |
| Check the connected host's compatibility | `/health compat [--json]` | The Agent's; here it is refused and names the Agent. |

`/quit` closes the program. A bare `:q` or `:wq` typed in the composer does the same. A model cannot run `/quit`.

### The conversation

`/clear` (aliases `/cls`, `/reset`) saves the current conversation as its own session and starts a fresh one.
While a turn runs it refuses: `A turn is still running. Stop it with Esc or let it finish, then /clear.`
When the save fails nothing is cleared: `Could not save the current conversation, so nothing was cleared: <reason>`.

`/compact` summarizes older messages to free the context window. The transcript shows a before and after notice.
When the model's context window is too small to summarize, the oldest messages are dropped without a summary and the notice says so: `[Context] Dropped the N oldest message(s) without a summary and kept the last M ...`.
When there is nothing to compact: `[Context] Nothing was compacted: <reason>.`
The app also compacts on its own when context use reaches `behavior.autoCompactThreshold` percent (default `80`, range 10 to 100).
`/compact-history` (alias `/compaction-history`) lists this session's compactions.

`/keep <text>` pins text to session memory; pinned text survives compaction. `/keep` with no text prints its usage. Blank text prints `[Pin] Nothing pinned: text was blank.`
`/note [list|add <text>|remove <id>]` manages session notes, which are also kept across compaction. `/note add Ask about the staging DNS` prints `Note added: [<id>] Ask about the staging DNS`; `/note remove <id>` prints `Note removed: [<id>]` or `Note not found: <id>`.
`/title [text]` shows or sets the conversation title.

`/retry [modified text]` (alias `/r`) sends the last request again, keeping the work already done; with text it sends that text instead.
`/queue [list | edit <n> <text> | delete <n>]` (alias `/q`) manages messages typed while a turn is streaming; they wait in a queue until the turn ends. With an empty queue: `No queued messages. (Messages typed while a turn is streaming queue here until it finishes.)`

`/paste` (alias `/clip`) inserts the clipboard's text or image into the composer. Use it when the terminal's own paste does not carry images. With nothing usable: `Clipboard does not contain supported text or image data.`
`/pastes [pN]` (alias `/pending-pastes`) shows the text behind each `[TEXT: pN, M lines]` fold. With no folds: `[Pastes] No folded pastes are currently in the composer (pastes over 8 lines fold to [TEXT: pN, M lines]).`
`/image <path> [prompt text]` (alias `/img`) attaches an image file (PNG, JPEG, WebP, GIF) to the next message, optionally with the prompt. Without a path it refuses with `Usage: /image <path> [prompt text]`.
`/editor` opens the composer draft in `$VISUAL` or `$EDITOR`, suspends the interface while the editor runs, and puts the saved text back in the composer. Set `export EDITOR=nvim` first.

`/template` manages prompt templates: `list` (the report; picking one sends it, Del deletes, Ctrl+E edits), `use <template> [name=value ...]`, `save <name>` (your last message), `show <template>`, `edit <template>` and `delete <template> [--everywhere]` (asks first; `--everywhere` deletes the one every project shares).
Project templates live in `<project>/.goodvibes/templates/`; templates for every project live in `~/.goodvibes/templates/`.
`/template save review` saves your last message as `review`; `/template use review file=src/api.ts` sends it with its blanks filled in.
A missing template is refused with `No template <name>.` and the line that lists them.

### Sessions

`/session` is described once for both programs and holds every session action. Bare, it opens its list with "See this session" first, then "Resume a saved session", "Save this session under a name", "See your saved sessions" and grouped rows ("Copy, rename or delete a session", "Save or share the conversation", "Branches of this conversation", "Look through this conversation", "Tasks across sessions"); a model or a script running it bare gets this session's details. `/resume` and `/save` are single-action commands built from the same two action definitions `/session` lists: `/resume` alone opens the list of saved sessions to pick from, `/resume <session>` resumes one.

| Line | Action |
| --- | --- |
| `current` | See this session: id, name, when it started, messages, model. |
| `list` | See your saved sessions, newest first. |
| `resume <session> [--force]` (also `/resume <session>`) | Resume a saved session: its messages, model and agent records continue here. A session another running terminal has open is refused unless `--force`; a session with agents still running here is refused. |
| `save [<name...>] [--switch] [--replace]` (also `/save`) | Save this session under a name (its title when none) in `<project>/.goodvibes/tui/sessions/`; `--switch` keeps working in the saved copy; `--replace` writes over a different session saved under that name and asks first. |
| `fork [<name...>]` | Continue in a copy of this session under a new id. |
| `rename <name...>` | Rename this session. |
| `info [<session>]` | See a saved session's details. |
| `search <words...>` | Search saved sessions. |
| `delete <session>` | Delete a saved session (asks first; never the open one). |
| `events [<kind>] [<from row>] [--last <n>]`, `groups [...]`, `hotspots [<kind>]` | Look through this conversation's record: entries, entries by turn, counts. |
| `save-file [markdown\|text\|html\|json] [<file>] [--keep-secrets] [--replace] [--then open\|copy]` | Save this conversation as a file (default a new file named for the time, `~/goodvibes-exports/session-<timestamp>.<ext>` for Markdown, html and JSON, `conversation-<timestamp>.txt` in the working directory for text). API keys, tokens and your home path and login name are hidden unless `--keep-secrets`; plain text is always hidden. An existing file is kept unless `--replace`, which asks first. `--then open` opens a web page in the browser; `--then copy` copies the path. |
| `save-saved <session\|.> [markdown\|text] [--out <file>] [--print]` | Save a saved session's redacted transcript as a file (never replacing one), or print it here. |
| `upload [html\|md\|json] [--keep-secrets] [--then open\|copy]` | Upload this conversation as a secret GitHub Gist (unlisted, not private: anyone with the link can read it) and print the link. It sends something outside this machine, so it asks first and only counts when you type it. |
| `branch [<name...>]`, `branches`, `switch-branch <branch>`, `merge-branch <branch>` | Keep a branch of the conversation as it is now, list them, go on from one, or add the messages a branch gained after it was made (refused when both changed; switching and merging refuse while a turn runs). |
| `graph [--session <id>] [--format text\|json]` | See the cross-session task graph and the handoffs waiting. |
| `link-task <task> [--session <id>] [--depends-on <session:task>] [--label <text>]`, `hand-off <task> --to <session> [--reason <text>]`, `accept <handoff>`, `withdraw <handoff>`, `cancel <task> [--scope task\|subtree\|session] [--task <task>] [--reason <text>]` | Change the cross-session task graph; `cancel` asks first. The Agent reads the graph but refuses these. |

The Agent has the same `/session`, `/resume` and `/save`; its `save-file` writes Markdown or text only, its `save-saved` only prints, and it refuses `upload` and the branch actions.

Worked example:

```text
/session save-saved . text --out notes/session.txt
Exported session user-0008b454 (34 messages, redacted) to notes/session.txt
```

The GitHub credential for `upload` is found in this order:

1. the `github` entry of the named API services (`~/.goodvibes/tui/services.json`, see "Named API services"), when its auth headers contain `Authorization: Bearer <token>` or `Authorization: token <token>`; no other header is taken as the token;
2. the environment variable `GITHUB_TOKEN`.

The token needs the `gist` scope. It is sent only to `https://api.github.com/gists` in one `POST` whose body holds the description (`GoodVibes session: <title>`, or `GoodVibes session export` for an untitled session), `"public": false`, and the file under its file name.

A successful export prints one line with hints:

```text
/session upload html
Exported HTML session to /home/me/goodvibes-exports/session-2026-11-18T17-40-02.html  (redacted before upload)  Share link: https://gist.github.com/<user>/<id>  Upload receipt: /home/me/goodvibes-exports/session-2026-11-18T17-40-02.html.gist-<uuid>.json
```

The hint is `(sensitive data redacted)` or `(not redacted)` for a local export, and `(redacted before upload)` or `(uploaded unredacted, as stored)` for an upload.
Every upload attempt writes a receipt file `<export path>.gist-<uuid>.json` (mode 600) with `version`, `sessionId`, `exportedPath`, `recordedAt` and either `status: "accepted"` with `url`, or `status: "unconfirmed"`. When the receipt cannot be written, a notice in `/notifications` records the outcome instead.

Failure cases:

| Situation | What is printed | Next step |
| --- | --- | --- |
| Empty conversation | `Nothing to export: conversation is empty.` | |
| No token | `No GitHub token found for --upload.` followed by how to add a `github` service entry or set `GITHUB_TOKEN` (a PAT with the `gist` scope). The local export is kept. | Add the token, run `/session upload` again. |
| The `github` service entry cannot be read and no `GITHUB_TOKEN` | `Upload not attempted: the github service entry could not be read (<reason>) and GITHUB_TOKEN is not set. Local export saved at <path>.` | Fix `services.json` or set `GITHUB_TOKEN`. |
| GitHub answered with an error, or a network error | `Upload unconfirmed: GitHub API error <status>: <body>. GitHub may have received it; check before retrying.` (or `Network error: ...`) | Check your Gists before retrying. |
| The upload threw | `Upload failed: the Gist upload did not complete (<reason>). Local export saved at <path>.` | Retry. |


`/hosted` works with daemon-hosted sessions, whose conversation loop runs in the daemon so it continues without a terminal. It is described once (terminal app only); bare, it opens its list of actions with "See the hosted session you are in" first (a model or a script running it bare gets that status). The actions and their lines:
`status`; `new [<first message...>] [--on-leave keep|stop]` (start one and join it; without `--on-leave` it follows `hostedSessions.detachPolicy`); `list [--all]` (`--all` includes ended ones); `attach <session>` (join one; the guided path lists the sessions, and a typed plain number is read against the last `/hosted list` printed); `send <message...>` (send now, into the turn it is running); `send-later <message...>` (runs after the current turn); `stop-tool [<call>]` (stop the tool call that is running, the first one when none is named); `leave` (this terminal leaves; the session keeps running or ends as its setting says); `end <session id>` (asks first; it cannot be undone).
`end` takes a session id, never a list number, so its question names exactly the session that ends.
A line typed in Your agents for the hosted session is sent only to the session that was joined when you started typing it; if another session was joined meanwhile it is not sent (`the message was for session <id>; attach to it again to apply it there`) and the draft stays.
A session joined here belongs to the daemon it was joined on. After `daemon.connectedHost.url` points elsewhere, `send`, `send-later`, `stop-tool` and `end` of that session are refused naming both daemons, and `/hosted leave` releases it on the daemon that holds it.
With nothing joined: `No hosted session is joined in this terminal, so nothing was queued.` with `/hosted attach <id> joins one`. Hosted sessions are described under "Hosted sessions" in the daemon part.

`/remote session-export <file>`, `session-inspect <file>` and `session-import <file>` save, inspect or bring in a remote session bundle (runner pools, contracts, artifacts, never the conversation); `session-import` asks first, since it replaces anything held here with the same ids.

`/replay [load [runId] | step [n] | seek <rev> | diff <runId> | export <path>]` (alias `/rep`) loads a recorded run, steps or seeks through its revisions, compares two runs and exports one.

### Undo, rewind and checkpoints

The terminal app records a checkpoint of the workspace files at each turn and each helper-agent run, in any workspace.
`/checkpoint [label]` creates a manual checkpoint kept for forensic retention: `Checkpoint created: <id> "<label>" (forensic retention).` With no file changes since the last one: `No changes since the last checkpoint; nothing to save.`
`/checkpoints` (alias `/ckpts`) lists checkpoints, newest first, numbered from 1. With none: `No checkpoints yet. /checkpoint <label> creates one manually; turns and agent runs snapshot automatically.`

`/rewind` with no argument lists the turns completed in this run of the app (a resumed session restores its turn list: `Rewind: restored N turn anchor(s)`).
`/rewind <n|turnId> [files|conversation|both]` rewinds to the end of that turn. `files` restores workspace files, `conversation` removes the later messages, `both` (the default) does both.
The rewind is previewed in the Changes view: `Previewing rewind of turn "<label>" (<scope>: ...). Enter or y rewinds, n or Esc cancels.`
Cancelling prints `Rewind cancelled: nothing changed.`
A wrong scope prints `Unknown scope "<word>". Use one of: files | conversation | both.`
`/rewind` refuses while a turn is running.
`/undo rewind` reverses the last `/rewind`; `/redo rewind` applies it again. Each replaces the whole conversation, so each refuses, changing nothing, when messages were added since (`/undo rewind` since the rewind, `/redo rewind` since the undo), naming how many; both check again after asking about files, and both report when the restored conversation could not be saved.

### Restoring a checkpoint

`/checkpoints restore <n|id>` restores the files of one checkpoint at any time: `<n>` is its number in `/checkpoints`, or give its id or an unambiguous id prefix.
It previews the files the restore would change in Changes; `Enter` or `y` restores, `n` or `Esc` cancels (`Restore cancelled: nothing changed.`). `--yes` typed by you skips the question; from the model it is ignored, so a model-run restore is always put to you.
Only files are restored; the conversation is unchanged. The current files are first kept in a safety checkpoint (`pre-restore safety (before <id>)`), which `/checkpoints restore` can bring back. The receipt is `[Checkpoint] Restored files from checkpoint <id> ("<label>"). Files only: the conversation is unchanged.`
Refusals: `No checkpoint #9. Run /checkpoints to list checkpoints (1–N).`, `Checkpoint ref "8e" is ambiguous (2 matches). Use the list number instead.`, `Unknown checkpoint ref "x". Run /checkpoints to list checkpoints.`, and the busy refusal while a turn runs; a partial restore names the paths that failed.

When no turn has completed in this run of the app, `/rewind` also lists the workspace checkpoints instead of turns, and `/rewind <n|id>` restores one the same way:

```text
/rewind
No completed turns recorded this run yet; falling back to workspace checkpoints (FILES ONLY, no conversation state):
   1. 3f2a9c1b     turn      after: add rate limiting  (12 min ago)
   2. 8e01d4aa     manual    before refactor  (1 h ago)
Restore one: /rewind <n|id>; files only; conversation history is untouched.
```

The kind column is `turn`, `agent-run` or `manual`; the ids and labels above are examples.

(The daemon's operator API also has `checkpoints.restorePreview` and `checkpoints.restore`; the API part describes them.)

### Undoing file changes and turns

`/undo [rewind|file]` and `/redo [rewind|file]`:

| Form | Effect | Output |
| --- | --- | --- |
| `/undo` | Remove the last conversation turn. Refused while a turn runs: `A turn is still running. Stop it with Esc or let it finish, then /undo.` | `Last turn undone. Use /redo to restore. Tip: /undo file to revert a file write/edit.`, or `Nothing to undo. Tip: use /undo file to revert the last file write/edit.` |
| `/undo file` | Revert every file the most recent not-yet-undone `write` or `edit` call changed. | `File reverted (last edit call):` or `N files reverted (last write call):` with the paths, then `Use /redo file to re-apply.`; with nothing recorded: `Nothing to undo. No file operations recorded.` |
| `/undo rewind` | Reverse the last `/rewind`. | The rewind's result. |
| `/redo` | Restore the last undone turn. Refused while a turn runs. | `Turn restored. Tip: /redo file to re-apply a reverted file.`, or `Nothing to redo. ...` |
| `/redo file` | Re-apply the most recently reverted file change. | `File re-applied (<tool> call):` with the paths, or `Nothing to redo.` |
| `/redo rewind` | Re-apply the last undone `/rewind`. | |

`/undo file` and `/redo file` work on a stack of tool calls kept in memory for this run of the app (up to 50 entries; changes from earlier runs cannot be undone this way, and changes made by `exec` commands are not recorded).
Each `/undo file` steps one call further back: to undo the last three edit calls, run `/undo file` three times.
The Agent has the same `/undo file` and `/redo file` (and `/checkpoints restore`), with the same lines.
When a file was changed after that call (by you, another tool or another program), nothing is changed and the entry is kept: `File undo failed: Cannot undo the change to <path>: the file was changed after that operation (by you, another tool or another program). No file was changed and the history entry is kept: put the file back as that operation left it and undo again, or drop the entry (/undo file drop) to reach the one before it.` `/undo file drop` (and `/redo file drop`) sets the newest entry aside without changing any file: `Dropped the newest undo entry (<tool> call) without changing any file:` with its paths, then `The next /undo file acts on the one before it.`; with none, `Nothing to drop: no undo entries are recorded.`
`/undo file`, `/redo file`, `/undo rewind` and `/redo rewind` do not wait for a running turn; use them between turns.

### Models, providers and sign-in

`/model` is described once for both programs. Bare, it opens its actions with "See your model and the others you can use" first (`list`; a model or a script running it bare gets that report): `use <model>` ("Switch model"), `refresh` ("Read the list of models again"), and under "Choose backup models…" `backup <model>` and `drop-backup <model>`.
`/model use openai:gpt-5.4` switches the main chat model, saves it in `provider.model` and prints `Now using <model> (<provider>).` and, when the requested reasoning level does not exist on that model, the level used instead.
When the provider is not signed in, the terminal app asks for its API key on a hidden line before the switch lands.
An unknown id is refused with the provider registry's reason. `/model use` alone asks which model, from the models you can switch to.
`/model refresh` asks every provider you have set up for its models again (past any list kept on disk), then refreshes the catalog, the benchmarks and the token limits, and prints one line per provider: how many models it has, or why its list could not be read (`could not be read, its server is not running`, `could not be read (<error>); 12 models from its last list`, `0 models: it answered with an empty list`); a provider that does not list its own models says it uses the built-in catalog. A part that failed makes the refresh a refusal naming it, after the rest was printed.
The model picker (its key, or a failed turn's `alt+o`) is unchanged; its left rail selects the route the choice is for: Main Chat, Helper Model, Tool LLM, TTS LLM or Embeddings (see "Routing roles" below).

`/effort` is described once for both programs: `show` ("See how hard the model thinks", the report) and `set <level>` ("Choose how hard the model thinks"; bare `/effort set` lists the levels the current model offers).
`/effort set high` saves `provider.reasoningEffort` and prints the level in effect.
A level the model does not offer is refused: `<Model> does not offer reasoning effort 'xhigh'; nothing was changed.` followed by `Levels it offers: ...`.
A model with no configurable reasoning refuses with the reason it has none.

`/context [window [<size>|clear]]` (alias `/ctx`) shows context use with a token breakdown per message.
`/context window 200000` sets a custom context window for the current model; `/context window clear` removes it.

`/provider` is described once for both programs: where your models come from and how you are signed in to them. Bare, it opens its actions with "See your providers" first (`list`: the provider in use, every provider, subscription sign-ins and how requests are routed; a model or a script running it bare gets that report), then:
- `use <provider> [--model <model>]` ("Switch provider"; without `--model` its first model).
- Under "Sign in with a subscription…": `sign-in <provider> [--no-browser] [--manual]`, `finish <provider> <code or address>` (the code is asked on a hidden line when left out, and never kept in the input history), `sign-out <provider>`, `show <provider>` and `open` (the terminal app's sign-ins screen; the Agent has none and says so).
- Under "Add or remove a provider of your own…": `add <name> <address> [--key <key>]` and `remove <name>` (asks first; it cannot be undone).
- Under "Choose how requests are routed…": `route off|manual|auto` ("Only the model you chose", "Your model, moving on when a provider fails", "The best provider for each request"), `pin-route <model>` ("Send every request to one model"; `/provider route` lets it go), `explain` and `fallback` (where a failed request would go, nothing sent).
- Under "Move your sign-ins to another machine…": `export <file>` (writes the sign-ins with their tokens; it loosens a protection, asks first, and a model cannot run it), `inspect <file>` (what it holds and what loading it would add or replace) and `import <file>` (asks first; replaced sign-ins cannot be recovered).
`/provider add lmstudio http://192.168.1.20:1234/v1` reads the address's `/models` list and saves an OpenAI-compatible provider; `/provider remove lmstudio` removes it and its stored key.
`/provider sign-in openai` opens the browser and, in the terminal app, listens on the local callback address; when the browser returns there it prints `Signed in to openai with a subscription (...)`. `--no-browser` prints the address without opening it; `--manual` skips the local listener so the sign-in is finished with `/provider finish openai <code or address>`. The Agent always finishes with `finish`.
When the browser opened somewhere else (another machine over SSH), open the printed address there and finish with `finish`.
A provider without subscription sign-in is refused: `<provider> has no subscription sign-in.`, followed by the shape of an `oauth` block to add to `~/.goodvibes/tui/services.json`.
`/provider export <file>` warns `The file holds working sign-in tokens: keep it private and delete it after use.`
`/provider sign-out openai` prints `Signed out of openai. An API key you set for it is used again.`
`/scan` probes localhost and the local network for model servers and registers each one it finds (see "Local model servers").
`/pin <model-id>` and `/unpin <model-id>` add a model to, or remove it from, the pinned favorites.

`/accounts` is described once for both programs: bare, it opens its list of actions with "See your provider accounts" first (a model or a script running it bare gets that report). The actions are `review` (each provider's routes, sign-in freshness and issues), `show <provider>`, `routes <provider>`, `repair <provider>` (what to fix, with the steps as rows to run), `open` (the providers screen), `sign-in <daemon|listener> <address> --user <name>` and `sign-out <daemon|listener> <address>` (a listener session may be kept under another name with `--key <name>`).
`/accounts sign-in daemon https://host.example:3421 --user admin` asks for the password on a hidden line, then asks "Sign in to a daemon or listener?" with the sentence `Your password for admin will be sent to https://host.example:3421 to sign in to the daemon; the session it gives is kept until you change it (signing out ends it).` (it sends something outside this machine).
`http://` to another machine is refused because the credential would travel unencrypted: `Not signed in: <host> is another machine and http:// would send the credential unencrypted. Use https://<host>. Nothing was sent.`
A refused sign-in says `Not signed in: the daemon answered HTTP <status>. Check the address, user name and password, then try again. Nothing was stored.`
A sign-in that answers with a redirect is not followed: `Not signed in: <origin> answered with a redirect to <origin>, and the password is sent only to the address you typed.`
A listener session is stored with the address that issued it; `/accounts sign-out listener <address>` sends it only to that address, and for any other address refuses with `The listener session stored as <key> was issued by <origin>; it is never sent to <address>. Nothing was sent or removed.`
The Agent has the same `/accounts`; its `sign-in` and `sign-out` refuse, because the Agent keeps no daemon or listener session (the host it connects to manages its own sign-in).
Provider subscriptions are signed in and out with `/provider sign-in` and `/provider sign-out`.

`/auth` (both programs) shows how you are signed in to model providers: `review` (the report a bare `/auth` runs where no list can be shown), `show <provider>`, `repair <provider>`, `export <file> [--replace]` (a summary of stored secret names and provider sign-ins, no secret or token, readable by you only; an existing file is kept unless `--replace`, which asks first) and `inspect <file>`.

`/local-auth` (terminal app) chooses who may sign in to this machine's daemon and web app: `review` (the users, their roles, the open sessions and the first-run sign-in file), `open` (the local sign-in screen), `add <name> [--role user|admin]`, `remove <name>` (asks first; it cannot be undone), `password <name>`, `sign-out <session>` (sessions are chosen from the list of who is signed in) and `remove-first-run-file`. A password is asked on a hidden line, twice in the guided path; typed on the line it is `--password <password>` (with `--again <password>` to check it), kept in the input history as `<redacted>`. The role defaults to `user`; `admin` loosens a protection, so a model cannot choose it.

`/secrets` (both programs) keeps passwords and keys where programs can read them, without showing them. Bare, it opens its actions with "See your secrets" first; the actions are `list`, `set <name> [<value>] [--scope project|user] [--storage secure|plaintext]` (without the value it asks on a hidden line; `project` and `secure` are the defaults, `plaintext` loosens a protection), `link <name> <reference>` (a `goodvibes://secrets/...` address in a password manager), `get <name>` (says whether it is stored, never its value), `test <reference>`, `providers` (where a secret can be read from, with an example line for each), `storage` (the storage rule, how many are encrypted or plain text, and where each store is), `trust <name>` (use a secret from this project's store; it loosens a protection, so it asks and a model cannot run it), `delete <name> [--scope project|user] [--storage secure|plaintext]` (asks first; it cannot be undone) and `use <name> [<value>]`, which keeps a value as an environment variable for this session only: `$<NAME> is set for this session only.` with `(N characters, value not shown.)`.
In the Agent a credential the daemon reads is filed in the daemon's tier whatever scope is asked, and `set` says so.

While a value is asked for with masked input (the same in both programs), the composer shows a bullet per character and holds the value apart from the prompt: typing, a terminal paste, the paste key (`Ctrl+V`), the cursor keys, `Home`, `End`, `Backspace` and `Delete` edit it, `Enter` hands it over, `Esc` or `Ctrl+C` cancels; undo, redo, the kill ring, history search, the command line and the other editor shortcuts are not offered, so the value never reaches them. A command line that carries a credential is kept in the input history with `<redacted>` in its place: `/secrets set <name> <value>` and `/secrets use <name> <value>`, `/local-auth add` and `password` with `--password`, `/accounts sign-in` with `--password`, `/settings set` for a credential key (in either program), `/notify add <url>`, the Agent's `/channels send --webhook <url>` and `/calendar connect <provider> --code <code-or-address>`. The line a guided action shows ("This will run", "The command for this is") leaves a secret out, so typing it back asks for the secret on a hidden line.

`/usage [turns|agents]` opens the Usage view on a tab.
`/cost [panel|budget <usd>|attribution [24h|7d] [--json]]` opens Usage, sets the session budget alert (`/cost budget 5` prints `Cost budget alert set to $5.00.`; `0` disables it), or prints cost attributed per agent over the last 24 hours or 7 days from the daemon.
`/status` prints the session status: model, tools, token totals and cost, context use, surfaces and safety states. It takes no words.

### Settings and configuration

`/settings set <key> <value>` sets one key directly; the value is hidden as it is typed and in the input history, since a setting may hold a credential, and a credential key goes to the secret store with only its reference in the setting. A model cannot run `/settings set`:

```text
/settings set display.themeMode light
Set display.themeMode: "auto" → "light"
Theme applied: light.
```

`/settings set` with a missing value asks for it; where nothing can be asked (a script) it is refused naming the blank.
A value the daemon refuses for a daemon-owned key prints `Not set: the daemon refused <key>, and nothing was changed: <reason>`.
An invalid value prints `Could not set <key>: <reason>`.

`/presets` works with presets (saved sets of display, model and behaviour settings): `open` ("Pick a preset": Enter loads one, Ctrl+S saves the current settings as one, Ctrl+D deletes one), `list` (the report), `export <file> [--overwrite]` (an existing file is kept unless `--overwrite`), `inspect <file>` and `import <file> [--prefix <word>] [--overwrite]` (a file that is not a presets file is refused and nothing changes; a name already taken is refused unless `--overwrite`).
`/settings-sync` works with settings sync bundles: `review` (what it alone gives a model or script), `export <file>`, `pull <file>` (changes that touch security are shown and asked about first), `conflicts`, `resolve <setting> local|synced`, `inspect <file>`, `show <setting>`, `failures` and `open` (the settings sync screen). The staged bundle, rollbacks and locks are `/managed`'s.
`/managed` applies a managed settings bundle (settings an administrator sets for a machine): `review`, `staged`, `history`, `inspect <file>`, `stage <file>`, `export <profile> <file>`, `apply <file> [--key <setting>]...`, `apply-staged [--key <setting>]...`, `rollback <apply>`, `lock <setting> <who> <reason>` and `unlock <setting>` (the owner's only; it asks first). `apply` prints a rollback token; `/managed rollback <token>` restores the earlier values. A bundle that changes a setting that touches security shows those changes and asks first, and what is applied is exactly what was shown: `apply <file>` stages the bundle it read once and applies that stage, `apply-staged` applies the stage it showed; a different stage put there since by another window or process is refused and nothing is applied. A locked key cannot be changed from Settings or `/settings` until `/managed unlock <setting>`.

`/setup` is a guided command. Bare, it lists topics; each opens one form for that topic, and the form's `Save` writes only what changed on it, then checks it. The topics: `Choose a model` (`/setup model`), `Sign in or out of a provider` (`sign-in`), `Add a provider of your own` (`add-provider <name> <address>`), `Store a password or key` (`store-key`), under `Reach GoodVibes from elsewhere…` the topics `Keep everything on this computer` (`local-only`), `Open GoodVibes in a browser` (`browser`), `Use it from other devices` (`other-devices`), `Receive webhooks` (`webhooks`) and `Use Cloudflare` (`cloudflare`), then `Connect chat apps and services` (`chat-apps`), `Who can sign in here` (`who-signs-in`), `How GoodVibes works with you` (`how-it-works`), under `Features and switches…` the topics `Safety and sandboxing` (`safety`), `Memory and context` (`memory`), `Telemetry`, `Automation`, `Paired devices and voice` (`devices-voice`), `Provider behaviour` (`provider-behaviour`) and `Advanced switches` (`advanced`), then `History and privacy` (`history`, opens the setting), `Bring over settings from the terminal app`, `Pair the Agent with a GoodVibes host` (`pair`) and `Unpair the Agent from the GoodVibes host` (`unpair`) (each shown with `Agent only`; in the terminal app they say where to do them) and `Run first-run again` (`first-run`). The Agent lists the same topics. A form that opens the computer to the network also asks for the account that signs in from other devices. Esc closes a form without saving.
`/startup` is the setup checks and transfers, a guided command of its own (bare, it lists them; without an interface it runs `review`): `/startup review`, `doctor`, `services`, `hooks`, `remote` and `sandbox` show what this setup has; `/startup support-bundle <dir> [--overwrite]` writes a support bundle directory (`Exported support bundle to ./bundle`), masking any literal credential, and `/startup support-bundle-inspect <dir>` reads one back; `/startup export <path> [--overwrite]` writes the setup review as JSON; `/startup transfer-export <path> [--overwrite]` writes a setup transfer bundle, `/startup transfer-inspect <path>` reads one, and `/startup transfer-import <path>` shows the plan (every changed setting and replaced file) and applies it on Yes, reporting `N setting(s) changed, M file(s) replaced`; `/startup link <view> [item]` prints a `goodvibes://` link and `/startup open-link <link>` opens one.
A confirmation applies exactly what it showed. When `/startup transfer-import` or `/services trust <name>` finds its target changed between the question and Yes (the file rewritten, the entry edited), nothing is done and the question is asked again with `Changed since you looked:` and each change on top ; a model-run line is refused with `TARGET_CHANGED` and the same line as its next step. The `/services trust` question names what the entry sends and to which host.
A confirmation whose text does not fit the screen scrolls (up, down, page up, page down) and says `↓ N more lines`; its confirming button stays disabled until the end has been shown. In a settings list, Enter and a two-press action act on the row drawn under the highlight: while a search is shown that is the search result, and a second press after the list refreshed onto another row asks again.
An existing target is not overwritten without `--overwrite`.
`/update` (actions `check`, `apply`, `rollback`, `daemon [--check]`, `review`, `save-review <file> [--replace]`, `read-review <file>`) checks for a newer release and, for binary installs, downloads, verifies and applies it or rolls back. Updates are described under "Updating" in the install part.
`/power status` shows who holds this computer awake; `/power on` and `/power off` set the daemon-held keep-awake (the same as `Alt+A`).

`/security` gathers what protects this machine. Bare in the terminal, it opens its list; from a model or a script it prints the short status (`✓ Nothing needs attention.`, or each thing that does with `Fix: <line>`): blocked or overdue paired-device tokens, policy lint findings and a failed preflight, MCP servers with held-back tools or allowed to run anything, risky MCP routes, held-back plugins, and an undecided folder. Its actions, by group:

- The review: `review` (every count), `tokens` (paired-device tokens), `attack-paths` (risky routes through MCP servers).
- What is trusted: `trust` (permission mode, secrets, services, plugin and MCP trust), `folder` (this folder's trust), `trust-folder` (loosens a protection, asks first, only you), `restrict-folder`, `save-trust <file> [--replace]` (owner-only file, secret names not values), `read-trust <file>`.
- Policies: see "Policy bundles" in the permissions part.
- Sandbox and sandbox sessions: see "The exec sandbox" in the permissions part.
- Screens: `security-screen`, `policy-screen`, `sandbox-screen`.

`/security trust-folder` prints `This folder is trusted: every tool may run here, subject to your permission settings.` and loads the folder's hooks and MCP servers.
An untrusted folder does not load its hooks file or its project MCP servers.

`/permissions` (`show`, `rules`, `revoke <rule>`, `never <command>`, `add <allow|deny|ask> <command|class|path|tool> <target>`), `/plan` (`status`, `on`, `off`), `/questions`, `/decisions`, `/held`, `/approval` (`kinds [<kind>]`: what each kind of approval asks about; `waiting`: opens the approvals waiting on you), `/security` belong to the permission system; they are described in full under "Permission modes", "Remembered rules", "Decisions Jev made: `/decisions`", "Calls held by `just-vibes`: `/held`", "The owner inbox: `/questions`", "Plan mode", "Workspace trust" and "Managed policy bundles" in the permissions part. In short:

- `/plan on` prints `Plan mode is on: writes, commands and network calls are blocked until /plan off or Shift+Tab.`; `/plan off` restores the previous mode (it loosens a protection, so it asks first and a model cannot run it); `/plan status` says whether it is on.
- `/questions` lists what waits on the owner; `/questions answer <id> <choice|text> [note]` answers one.
- `/decisions` lists what was decided for the owner (`/decisions list --when today`, `yesterday`, `<YYYY-MM-DD>` or `"since <30m|2h|3d|1w|day>"` for one period); `/decisions undo <decision>` reverses one.
- `/held` lists calls `just-vibes` held; `/held approve <id...|all>` runs them; `/held dismiss <id...|all>` sets them aside.
- `/permissions` shows the mode in force and why it differs from the saved or chosen one; `/permissions rules` lists the permission rules; `/permissions revoke <rule-id>` removes one; `/permissions add` adds one directly (a never-run rule, or an allow, deny or ask rule).

### Code work

`/git [status|log|diff|init]` (alias `/g`) shows the working tree status (the default), recent commits, a summary of unstaged changes, or creates a repository.
Outside a repository: `Not a git repository: <dir>. Nothing was changed. Run /git init to create one.`
`/git init` inside one: `<dir> is already inside a git repository; nothing was changed.`

`/diff [session|head|working|staged]` (alias `/d`) opens Changes on this session's file changes (the default), everything against `HEAD`, the working tree or the staged set. The session view holds only files this session's tools wrote; before the first one it is empty (`this session · no files changed yet`), and `v` switches to the other views.
`/changes [session|working|staged|head]` opens the same view.
`/review` (one action, "Review this session's changes") opens this session's diff hunk by hunk to comment for the model or revert a hunk.

`/git` (terminal app) is described: `status` ("See what changed", the report: staged, changed, new and deleted files, then what committing every change would include), `log` (the last ten commits), `diff` (counts the changes not yet staged and opens them in Changes), `init` ("Start a repository here"; never done implicitly) and `commit` ("Commit every change": stages every change, new files included, and commits it; a set already staged by hand is committed as it is; a model cannot run it).
A clean tree prints `<root>: nothing to commit, the working tree is clean.`; a commit prints `Committed N files in <root>: <hash> <message>`.

`/test [pattern]` (one action) runs the project's test command (the configured test gate, else the `package.json` `test` script) and shows pass and fail results; `Esc` stops it. The script runs with the project's package manager: the `packageManager` field, else the one lockfile present; with neither, the manager the script itself calls (`bun test` runs with bun), else the first of npm, bun, pnpm and yarn that is installed.
It prints `Running: <command> (<source>, limit Ns; Esc stops it)` first.
A run past the limit is killed: `Test run timed out after Ns and was killed. Raise contract.gateTimeoutMs (0 for no limit) or pass a pattern to run fewer tests.` (`contract.gateTimeoutMs` defaults to 900000 ms.)
A second `/test` while one runs prints `A test run is already going; Esc stops it, then run /test again.`

`/codebase` works with the source-tree code index: `status` (the report), `build` (`Build started: /codebase status, or Your agents (F2) under Background services (b), shows how it goes.`) and `search <words...> [--limit <n>]` (matching code, each result labelled semantic or lexical).
`/intelligence` uses language servers, in both programs: `review` (the report: what is ready, the language servers, the problems tracked, and what to run when something is not ready; the terminal app only), `diagnostics [<file>]` (the terminal app only), `symbols <file>`, `outline <file>`, `definition <file> <line> --column <n>`, `references <file> <line> --column <n>`, `hover <file> <line> --column <n>`, and `install <language|file>`. `/intelligence definition src/app.ts 42 --column 10` prints the definition location; `/intelligence install typescript` installs the language server for that language. A line missing its column asks for it (or, from a model, is refused naming it).

`/tools` works with the model's tools: `list` (the report; a picker shows what each does), `contract <tool>`, `verify <tool>`, `verify-all` and `activity` (opens Your agents, where each agent's tool calls show). An unknown tool is refused with `No tool <name> is registered.`

`/search <query> [--limit <n>]` runs a web search and prints ranked results with source labels. A failed search prints `Search failed: <detail>`.
`/imagine [--out <path>] <prompt>` generates an image with the first configured image provider, writes it to `generated/<prompt words>-<time>.<ext>` (or `--out`), and opens it where a desktop exists. A file already at the path is never replaced. A job the provider has not finished is reported with the command that collects it: `/imagine --collect <provider> <task-id> [key=value ...]`. With no image provider configured it lists each generation provider's status and the key it needs.

`/eval` evaluates the product on real tasks:

| Action | Effect |
| --- | --- |
| `list [suite-dir]` | List the tasks of the suite (the report). |
| `run [suite-dir]` | Run each task through `goodvibes run`, then the task's `verify.sh`. |
| `compare [baseline-file]` | Compare the last results with the baseline. |
| `gate [suite-dir] [--baseline <file>] [--save-baseline]` | Run the suite and fail on a failed or regressed task; it creates the baseline when none exists. |

A suite is a directory (default `.goodvibes/eval/tasks`) with one directory per task holding `task.json` (the instruction) and `verify.sh` (exits `0` on pass).
The run works in a copy of the suite. Before a task's session starts, its `verify.sh` (or the script `task.json` names in `verify`) and any files listed in `task.json` `verifyFiles` are copied out of the task directory and checked against the suite's own files by sha256; a task whose files differ, or are missing, fails without running. The verdict comes from that copy, never from the task directory the session worked in, so a session that edits `verify.sh` cannot change its result. The script runs with the task directory as its working directory, read-only inside a bubblewrap boundary, the only sandbox the product has (Linux with bubblewrap and user namespaces); on macOS, native Windows or a Linux without bubblewrap there is none, so it runs on the host with the task directory writable and the task's output begins its note with `verification was NOT isolated`, and finds its listed files under `$GOODVIBES_EVAL_VERIFY_DIR`.
`/eval compare` without a baseline prints `[eval] Baseline file not found: <file>` and `[eval] /eval gate [suite-dir] makes one.`

Failure reports are actions of `/health` (see above).

### Helper agents, tasks and orchestration

`/agents` is your agents in one place, in both programs. Alone it opens its actions; `/agents open [--target <id>[:<kind>]]` opens Your agents. Its actions, grouped:

- Start agents: `team` (the team modes and recipes, agent templates, and the tasks running now), `start <mode> <what to do>` (one agent in a team mode: `local-engineer`, `local-shell`, `remote-engineer`, `teammate`, `research`, `dream`, `review`, `verifier`, `integration`), `recipe <recipe> <what to do>` (agents one after another, each handed the last one's report: `research-implement-review`, `remote-certification`, `triage-delegate-integrate`, `dream-then-certify`; a step whose agent fails stops the recipe and lists the steps not started), `archetypes` (built-in and project archetypes, with any problems), `archetype <name>` and `start-archetype <name> <what to do>`.
- Host a coding agent: `hostable` lists third-party coding agents found on `PATH` (Claude Code, Codex, opencode); `host <agent> [folder]` starts one as a row in Your agents that can be steered and stopped like any agent (`n` in the panel does the same). With none installed: `No third-party coding agents found. Install Claude Code, Codex or opencode on PATH to host one.`
- Work contracts and stopping agents: `contract [<contract>]`, `contracts-view` (the full-screen view), `stop-group <group>` and `stop-branch <agent>` (an agent and every agent it started); both stops ask first.
- `hand-off` and `handed-off` are the Agent's (handing coding work to the terminal app); here they are refused with the reason.
`/communication` opens the view of agent communication routes and recent activity.
`/tasks` works with runtime tasks (this terminal's and the daemon's), in both programs: `list [--status <state>] [--kind <kind>]` (the report), `open` (Your agents), `show <task>`, `output <task>`, `create <kind> <owner> <title...>`, `start <task>`, `update <task> <title|description|result> <text...>`, `complete <task> [result]`, `fail <task> <error...>`, `pause <task> [note]`, `resume <task> [note]`, `cancel <task> [note]` (asks first) and `retry <task> [note]`. Tasks are picked from lists. A daemon task takes only cancel and retry; the Agent only reads tasks and refuses a change with the reason.

- `/agents start research "map the auth flow"` starts a research agent on that task.
- `/agents recipe research-implement-review "add rate limiting"` runs the recipe's steps in order and prints a line per step: `[Recipe research-implement-review] step 1/4 research: agent <id> (researcher) started.`

`/worktree` manages the git worktrees helper agents work in (see "Helper agents and worktrees").

`/workstream`, `/graph`, `/todo` and `/work` are described under "Contracts, workstreams and work plans" below.

`/remote` works with self-hosted remote runners. `/remote` alone opens its actions ("See remote runners at a glance" first; a model or script running it alone gets that overview), grouped as: start a runner (`dispatch <task> [--template <kind>]`, `dispatch-pool <pool> <task>`); follow and stop runners (`show [connection]`, `contract <runner>`, `supervisor [runner]`, `capabilities [runner]`, `recover [runner]`, `stop <connection>`, which asks first); review what runners handed back (`artifacts`, `review <artifact>`, `export <runner> [--to <file>]`, `artifact-export <artifact> [--to <file>]`, `rerun-local <artifact>`, `import <file>`); runner pools (`pools`, `pool <pool>`, `create-pool <id> [label]`, `assign <pool> <runner>`, `unassign <pool> <runner>`); set up another machine (`setup`, `setup-export <file>`, `env`, `env-export <file>`, `tunnel`, `tunnel-export <file>`, `bootstrap-export <file>`, `bootstrap-inspect <file>`); move runners between sessions (`session-export`, `session-inspect`, `session-import`); and `open` for the full-screen view. Each action picks runners, pools and artifacts from lists.

- `/remote dispatch port the parser to Rust --template engineer` starts an ACP subagent (the command `goodvibes acp`, or `ACP_AGENT_CMD`) as a remote runner.
- `/remote dispatch-pool <pool> <task>` dispatches into a pool; a full pool is refused with what to remove.
- `/remote review <artifact>` reviews the runner's result; `/remote rerun-local <artifact>` asks before running its task locally with only the tools it recorded (the artifact list shows them).
- `/remote dispatch`, `dispatch-pool` and `rerun-local` refuse unless the owner typed them in the terminal or chose them from the list.

`/remote env` prints the shell lines (including `ACP_AGENT_CMD`) a remote machine needs.
`/release` shows release readiness (`review`, its report), a checklist (`checklist`), and keeps the evidence as a file (`save <file> [--replace]`, `read <file>`).
`/helpers` (one action) lists the local helper interfaces remote clients can use.

### Memory and knowledge

`/memory` and `/knowledge` are described under "Memory and knowledge" below.

### Extensions

`/mcp`, `/plugin`, `/skills`, `/marketplace`, `/hooks` and `/services` are described under "MCP servers", "Plugins", "Skills", "The marketplace", "Hooks" and "Named API services" below.

### Daemon-owned features

These commands work through the daemon. The features are described in the automation part ("Scheduled routines", "Supervised triggers", "Notifications", "Mail", "Calendar", "Chat channels", "Voice", "Purchases and payments", "CI watch") and the daemon part ("Credentials and pairing", "The relay", "Hosted sessions", clusters); this list gives each command's forms and an example.

`/schedule` manages scheduled routines kept by the daemon; its actions and lines are the same in both programs (see "`/schedule`, in both programs" in the automation part).

```text
/schedule add --cron "0 9 * * 1-5" --tz America/Chicago summarize yesterday's commits
/schedule add --every 30m check the deploy
/schedule add --at 2026-12-01T09:00 renew the certificate
/schedule add --when "every weekday at 9am" triage the inbox
```

`--when` sends the words to the decision model, prints `Read as: <schedule>` and keeps it.
A time already passed is refused: `Not kept: <time> has already passed.`
With no daemon: `Schedules are kept and run by the GoodVibes daemon, so each runs once with or without a terminal open; it cannot be reached: <reason> Nothing was scheduled or changed.`
`/schedule run <schedule>` prints `Started <schedule>.` and the run's id.

`/triggers` manages the daemon's supervised triggers; its actions are the same in both programs (see "`/triggers`" in the automation part).

```text
/triggers watch "Build finished" -- npm run build
/triggers allow-command tests -- npm run test
```

`/notify add <address> | remove <n> | list [--show] | clear | test | send <message>` manages webhook notification addresses in ntfy.sh format, the same command in both apps (`/notify add https://ntfy.sh/my-topic`). `/notify failed` lists failed deliveries and `/notify resend <id|all>` sends them again; one whose Slack or Discord destination changed since it failed is not sent until you add `--to-current`.

`/channels` is one command in both apps: the daemon's channels, their setup and repairs, who may reach the assistant (`rules`, `set-rules`, which asks first), what each channel's sessions get (`profiles`, `profile`, `set-profile`, `remove-profile`), a test message (`test <channel>`), and here the route and delivery snapshots (`overview`, `routes`, `delivery`, `open`). `/channels` alone lists them; a model or script gets `status`. Pairing a channel is `/devices pair channel <channel>`, which asks for each required value with masked input, then enables the surface; `/channels test slack` sends a real test message.
`/telegram` holds a Telegram chat's messages for your decision, the same command in both apps: `list` (what `/telegram` alone gives a model or script), `configure <chat> <bot> [--hold 1h] [--for 7d]`, `approve <message> [--keep 1h] [--record 7d]`, `deny <message>`, `status <message>`, `read <message>`, `cancel <message>` (asks first), `revoke <configuration>` (asks first), `release <chat>`. Every action but `list` and `status` is the owner's own.

`/mail` is one command in both apps: `status` (what `/mail` alone gives a model or script), `list [n]`, `read <message>`, `draft <to> --subject <subject> <message>`, `send <to> --subject <subject> <message>` (asks first). A repeated identical send is refused unless `--again`. The mailbox settings (`settings`, `set`, `password`) are the Agent's; here they are in `/settings`.
`/calendar` is one command in both apps; here it works on the daemon's calendar: `upcoming [--days N]` (what `/calendar` alone gives a model or script), `get <event>`, `add --title Standup --start 2026-12-01T09:00 --end 2026-12-01T09:15`, `change <event> [--title|--start|--end ...]` and `delete <event>` (both ask first), `status`.
`/ci` checks CI per job and manages standing watches, the same command in both apps: `watches` (what `/ci` alone gives a model or script), `status <repo>`, `watch <repo> <channel> [--fix-session]`, `run <watch>`, `unwatch <watch>` (asks first). For example `/ci status my-org/my-repo#42`, `/ci watch my-org/my-repo@main slack:C123`.
`/checkin` shows the proactive check-in settings and the last ten check-ins (`status`, the report), or runs one now (`run`; it may send a message to the check-in channel, so it asks first).
`/principals` maps channel identities to named people, the same command in both apps: `list`, `get <who>`, `resolve <channel> <identity>`, `create <name> <kind> [--identity channel:value]...`, `update <who> [--name ...] [--kind ...] [--identities c:v,c:v|none]`, `delete <who>` (asks first). For example `/principals create "Sam Lee" user --identity slack:U123 --identity email:sam@example.com`.
`/about-me` reads and corrects what the platform knows about you, the same command in both apps: `show` (the report), `field <fact>`, `person <name>`, `where <fact>`, `status`, `set <fact> <value...>`, `note [<section>] <line...>`, `undo <fact>`, `forget <fact>` and `forget-line <section> <line...>` (both forgets ask first). A fact is picked from the ones recorded, or given by its id or label. `/about-me where location.timezone` says where a fact came from; a write counts only when you type it.
`/payments [card [remove <id>]|status|pending|approve <merchant> <item> <maximum>|standing [list|add <shops> <item> <per-purchase> <per-period> <days> [<last day>]|remove <id>]]` sets up payment cards and purchase approvals.
`/devices` is one command in both apps: what is paired with the daemon, and "Pair something". `list` (what `/devices` alone gives a model or script), `pair <what>`, `rename <device> <name>`, `revoke <device>` (asks first), `migrate-shared [name]`, `revoke-shared` (asks first), `host-status`, `unpair-host`, `relay-status`, `relay-codes`, `relay-revoke <code>` (asks first), `nodes`, `grants`, `revoke-grant <grant>`, `captures`, `delete-capture <capture>` (asks first).
`list`, `rename`, `revoke` and `migrate-shared` act on the devices of the daemon this terminal talks to, through its operator API, so with `daemon.connectedHost.url` set they change that daemon (`Paired devices on the daemon at <origin>:`). Only when the selected daemon is this machine's and does not answer do they use this machine's pairing file, which the daemon reads when it starts.
`/payments add-card` fixes the daemon before the first field; if the selection changes while the card is typed, it is not sent (`The selected daemon changed while the card was being entered ... Nothing was sent.`).
`/devices pair` asks what to pair. `/devices pair device` opens the device-pairing view (a QR of an offer; `r` there shows a new one). `/devices pair host [--bootstrap-shared] [--name <name>] [--apply]` pairs this terminal with a daemon on another machine; only the owner typing it counts, and `--apply` reviews and confirms. `/devices pair relay [--name <name>]` mints a relay pairing payload for one device (it carries a relay code for that device alone, labelled with the name); with `relay.enabled` off it answers `Relay is disabled: turn on relay.enabled in /settings open relay first.` `/devices pair channel <channel>` asks for each of a channel's required values with masked input, then switches it on. `/devices unpair-host` forgets this terminal's host credential (the owner's only); `/devices relay-revoke <code>` refuses that device through the relay from its next request while every other keeps working.
`/cluster` shares inbound channel work with other machines: `status` (what `/cluster` alone shows a model or script), `groups`, `join <group> --key <key>`, `create [--name ...]`, `nodes`, `key [--qr]`, `rename <name>`, `rotate [--now]`, `forget <machine>`, `leave`, `publish <setting>`, `accept <setting>`. Every action takes "Which machine" (`--host https://host:port`, this machine when left out) and, for another machine whose token is not stored, `--token`. `forget`, `leave`, `publish`, `accept` and `rotate --now` ask first.
`/cloudflare [status|setup|requirements|create-token|discover|validate|provision|verify|disable] [flags]` (alias `/cf`) manages the optional Cloudflare integration: `/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME> [--new]`.
`/voice [review|status|setup|enable|disable|wake status|wake setup [yes]|bundle export <path>|bundle inspect <path>|bundle import <path>]` manages always-speak mode and installs the managed local voice runtime and wake-word models.
`/tts <prompt>|stop|on|off` sends one prompt whose answer is also spoken, stops playback, or turns always-speak on or off. Live local playback needs `mpv` or `ffplay` on `PATH`.

## Sessions

A session is one saved conversation.
Saved sessions of the terminal app live in `<project>/.goodvibes/tui/sessions/`, one file per session; the first line of the file carries the title, model and message count.
A session file names the program, the project and the session id, so a terminal-app session and an Agent session with the same name are different sessions.

### When a session is saved

- After every completed turn the whole conversation is written (one temporary file, one rename).
- `/save [name]`, `/clear` and `/quit` also save it.
- `behavior.saveHistory` (default on) controls whether conversations are kept at all.
- Saved sessions are kept until they are deleted (`/session delete <id>`); the retention sweep never removes them.

### Crash snapshots

A crash snapshot is a second copy written only while the conversation holds something the saved session does not:

- when a prompt is accepted;
- after a batch of tool calls, at most once every five seconds;
- when the save at the end of a turn fails;
- for a change made outside a turn (`/undo`, `/title`, a branch switch), at most once a minute;
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
A load takes the session's lock before it replaces the conversation, so of two terminals loading one session at the same moment one gets it and the other is refused; `/session resume <id> --force` takes the session over instead.
Saving under another name or moving to a session another running terminal has open (`/session save <name> --switch`, a fork onto that name) is refused the same way and nothing is switched.
A save of a session that another terminal saved after this one read it is refused (`Session <name> was saved by another terminal since this one read it ... nothing was saved`): run `/session resume <name>` to continue from that save, or `/session save <new name>` to keep this conversation under another name. A rename changes the title on the file as it is, keeping the other terminal's turns.
A headless `run` on a session another terminal has open is refused (see "Headless runs").

### Starting on a session

| Want | Command |
| --- | --- |
| Continue the last session of this project | `goodvibes --continue` |
| Open a session by id | `goodvibes --resume user-0008b454` or `goodvibes -r user-0008b454` |
| Open the last session | `goodvibes --resume` |
| Fork the active session at start | `goodvibes --fork` |
| Open a session, then fork it | `goodvibes --fork user-0008b454` |
| Pick from a list inside the app | `/resume` |

When no last-session pointer exists, `--continue` prints `No previous conversation to continue. This is a new one; /session list shows saved ones.` and starts a new conversation.
A resumed session prints `Resumed session: <id>` with its message count and model.
A forked session prints `Session forked:` with the new id, the fork name, the source title and the message count.

### Branches

`/session branch <name>` keeps the conversation as a named branch inside the session; `/session switch-branch <name>` goes on from it; `/session merge-branch <name>` adds the messages a branch gained after it was made.
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
Lists are read again in the background, never on a request's path: at start-up (a list on disk younger than a day is used without a request), after a sign-in, when the model picker opens (again from disk while younger than a day), on `/model refresh` (always read), and when a provider refuses a model as unknown (at most once a minute per provider).
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
   - store it in the secret store: `printf '%s' '<your-api-key>' | goodvibes secrets set OPENAI_API_KEY --stdin --user`;
   - inside the app, select a model of that provider with `/model use` and type the key when the app asks for it.
3. Select a model: `goodvibes models use openai:gpt-5.4` or `/model use openai:gpt-5.4`.
4. Check it: `goodvibes providers inspect openai` shows the API-key route as configured and usable.

An environment variable wins over a stored key.
Cloud-account providers need their platform credentials: Amazon Bedrock reads `AWS_BEARER_TOKEN_BEDROCK`, an `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` pair, or `AWS_PROFILE`; Anthropic on Vertex reads a project id plus `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login` or metadata-based auth; GitHub Copilot reads `COPILOT_GITHUB_TOKEN` or a stored GitHub token for `github-copilot`.
`cloudflare-ai-gateway` also needs `cloudflare.accountId` and `cloudflare.aiGatewayId` (or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID`).

### Signing a provider in with a subscription

A subscription sign-in uses the provider's own account sign-in in a browser instead of an API key.
OpenAI (a ChatGPT subscription) is built in. The procedure is under "`goodvibes subscription` (alias `subscriptions`)" above; inside the app use `/provider sign-in openai`.
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

`/scan` probes localhost and the local network for model servers that answer an OpenAI-compatible `/v1/models` request, and registers each one as a provider.
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
The servers the last `/scan` found are saved (`~/.goodvibes/tui/discovered-providers.json`) and registered, without probing, by every command of the program: the interactive app, `goodvibes run`, `models`, `models current`, `models use`, `providers` and the rest. A scanned model is used like any other:

- for one launch, `goodvibes -m Ollama:llama3:8b` (the provider half is matched by id or display name without regard to case, so `-m ollama:llama3:8b` is the same model; `--provider Ollama -m llama3:8b` also works). This leaves the saved default alone; or
- `/model` and pick it, or `goodvibes models use Ollama:llama3:8b`. This saves it as the default (`provider.model`).

When a saved model's provider is no longer registered (the server was scanned away, or `discovered-providers.json` was removed), nothing stops working: `goodvibes models current` exits `1` with `The model '<key>' cannot be used: no registered provider is named '<provider>'.`, the registered providers and how to choose another, `goodvibes models` and `goodvibes providers` list as usual with that line at the top, `goodvibes models use <key>` changes it, and a turn fails with the same message. An unknown provider in `-m <provider>:<model>` or `models use <provider>:<model>` is refused the same way, listing the registered providers; it never becomes a model of another provider.
A dedicated adapter knows the server's tool calling and streaming; Ollama, LM Studio and llama.cpp also get the `instant`, `low`, `medium`, `high` reasoning levels.
An Ollama server that answers only `/api/tags` and not `/v1/models` cannot be used as an OpenAI-compatible provider and is reported as skipped.
To add one server by hand, run `/provider add <name> <baseURL>`, for example `/provider add box http://192.168.1.50:11434/v1`; it probes `<baseURL>/models`.
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

`/model` chooses a model for one of five roles. Each role writes its own settings, so a choice for one never changes another.

| Role | Picker label | Settings | Behavior |
| --- | --- | --- | --- |
| Main chat | Main Chat | `provider.provider`, `provider.model` | Normal turns. |
| Helper | Helper Model | `helper.globalProvider`, `helper.globalModel`, `helper.enabled` (default off) | Supporting work such as summaries; empty values use the main model. |
| Tool model | Tool LLM | `tools.llmProvider`, `tools.llmModel`, `tools.llmEnabled` | Model calls made inside tools; selecting a model turns it on. |
| TTS model | TTS LLM | `tts.llmProvider`, `tts.llmModel` | The model that answers `/tts` prompts; empty uses the main model. |
| Embeddings | Embeddings | `provider.embeddingProvider` | The embedding provider for memory search and the code index. It has no model choice. |

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
`/effort` shows the levels the current model offers; the saved preference is kept when a model that caps lower is selected, and the level in effect is shown.

### Making a model and reasoning effort the default

Each program keeps its own default model and reasoning effort, in its own user settings file:

| Program | File | Keys |
| --- | --- | --- |
| Terminal app | `~/.goodvibes/tui/settings.json` | `provider.model`, `provider.reasoningEffort` |
| Agent | `~/.goodvibes/agent/settings.json` | the same keys |

The shared file `~/.goodvibes/shared/settings.json` does not hold them: of the settings, only `tts.provider`, `tts.voice`, `tts.speed`, `tts.llmProvider` and `tts.llmModel` are read from it, and a `provider.model` written there is ignored. A project settings file cannot set `provider.*` either. So changing the default for both programs means changing it in each.

What writes the default:

| Action | Writes |
| --- | --- |
| `/model use <id>`, picking a model in the model picker, `@model:<id>` in a prompt | `provider.model` in the running program's own file. |
| `/effort set <level>` or picking a level in `/effort` | `provider.reasoningEffort` in the running program's own file. |
| `goodvibes models use <id>` / `goodvibes-agent models use <id>` | `provider.model` in that program's own file. |
| `/settings set provider.reasoningEffort high` (in either program) | That key in that program's own file. |
| `-m <id>`, `--provider`, `-c provider.reasoningEffort=high` on the command line | Nothing: this launch only. |

Procedure for the terminal app:

1. `goodvibes models use openai:gpt-5.4` (or `/model use openai:gpt-5.4` inside the app).
2. Inside the app, `/effort set high`. Without opening the app, add `"reasoningEffort": "high"` inside the `"provider"` object of `~/.goodvibes/tui/settings.json`, or run the app once with `/settings set provider.reasoningEffort high`.
3. Check: `goodvibes models current` and `goodvibes status` (the `provider`, `model` and `reasoning` lines).

Procedure for the Agent: the same with `goodvibes-agent models use openai:gpt-5.4`, then `/effort set high` or `/settings set provider.reasoningEffort high` inside the Agent; check with `goodvibes-agent models current` and `goodvibes-agent status`.

The level saved is a preference: on a model that does not offer it, a level that model offers is used instead (`/model` and `/effort` print which), and the saved preference stays for the next model.

### Failover

A failed request never moves to a model the owner did not choose. The same rule holds everywhere a turn runs: the terminal app (interactive and `goodvibes run`), the Agent (interactive and `run`), the daemon's hosted sessions and its agents. The engine's turn loop applies it, in this order:

1. **Another sign-in.** Inside the request, a provider with two sign-ins tries the second when the first fails. Only `openai` has two built in: a request the ChatGPT subscription fails is sent again to the same model with the API key, and the turn says once which sign-in answered and why (in a headless run, one line on standard error and `signIn.movedFrom` in `USAGE`).
2. **Synthetic backends.** A `synthetic` model moves between the providers that serve it (see "Synthetic failover").
3. **Retries.** A failure that a wait can clear (a rate limit with a short `Retry-After`, a network error, a 5xx) is retried on the same model, and the stream shows `STREAM_RETRY`. With nowhere else to go the waits are 5, 10, 20, 40 and 60 seconds. When `provider.fallbackModels` has an entry not yet tried whose provider is signed in, the model gets one retry after 2 seconds and then the turn moves on; a server asking to wait longer than that (`Retry-After`) is not waited for, the turn moves at once.
4. **The fallback order.** When the model still fails (every sign-in, every synthetic backend and every retry), the turn moves to the first entry of `provider.fallbackModels` not yet tried this turn whose provider is signed in, and sends the failed request again to it; the rest of the turn, tool calls already made included, continues on that model. Entries are registry keys such as `["anthropic:claude-sonnet-5"]`; the provider half is matched by id or display name without regard to case. A worker agent given its own `fallbackModels` uses that order instead, and one whose routing says `providerFailurePolicy: "fail"` uses none.
5. **Stop.** With no order set, or every entry tried, the turn ends with the error (`provider_error`, or `provider_exhausted` for a spent `synthetic` model). The failed turn's row says so (see "Turn errors"), with the reason nothing else was tried in its details (`alt+i`, the `Fallback` row); a headless run's `TURN_ERROR` carries the same reason as `fallbackNote`.

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
A provider can move a model from free to paid; a session running longer than 24 hours without a model refresh cannot know. Run `/model refresh` daily in long sessions.
`goodvibes models chain [filter] [--json]` prints each synthetic model's backend order.

To make failover possible, give keys for several free providers, for example `GROQ_API_KEY`, `HF_API_KEY`, `NVIDIA_API_KEY`, `OLLAMA_CLOUD_API_KEY`, `OPENROUTER_API_KEY`, `AIHUBMIX_API_KEY`, then pick a model from the `synthetic` provider.

### Settings for providers and routing

<!-- generated: settings:provider -->

<!-- generated: settings:helper -->

## Tools

The model works only through tools. Every tool call passes the permission gate before it runs.
`/tools` lists the tools available in this session; `goodvibes doctor explain <tool> <args>` shows how one call would be decided.

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
| `work_plan` | The project work plan the owner sees in `/todo`. |
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
| `goodvibes_settings` | Apply a GoodVibes setting the owner gave a concrete value for. It runs only as a call the permission gate admitted (a `write`); nothing in its own arguments confirms it. A change that loosens security is put to the owner, and is written only when he, his standing rule or the mode settled the call; in a channel guest's turn it is refused. |
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
- `query` posts a question to the owner inbox and returns at once; the owner answers with `/questions answer <id> <answer>`, in the web UI or from a phone, and the answer reaches the asking session on its next model request, or when that session is next opened. It needs no permission in any mode: its category is `read` and it touches only the app's own state (the inbox), so asking the owner a question is never itself an approval. On a turn a guest started on a channel it is still put to the owner, like every call that reads the app's own state.
- MCP tools are named `mcp:<server>:<tool>`; the model calls them through the `mcp` tool with `mode: "call"`.

## Helper agents and worktrees

A helper agent is a subagent the model starts with the `agent` tool, or the owner starts with `/agents start`, `/agents recipe`, `/remote dispatch` or `/agents host`.
It has its own conversation and a tool set narrowed by its archetype; an agent that runs a contract unit in worktree mode also has its own git worktree (see "Worktrees").
Helper agents run beside the main conversation and report back through the agent message bus.
Ask for one in plain words (`spawn an engineer agent to refactor src/utils.ts`) or let the model decide.

### The `agent` tool

Its modes: `spawn`, `batch-spawn`, `status`, `list`, `templates` (the archetypes with their tool sets), `get` (details with recent messages), `wait` (returns at once when the agent has ended, else waits up to `timeoutMs`, at most `contract.heartbeatTimeoutMs`, default 10 minutes), `cancel`, `message` (send it a message), `budget` (token use), `plan` (task, template and tools), `contracts` and `contract-history` (the session's contracts and one contract's decisions, checks and escalations), `cohort-status` and `cohort-report` (a team started under one `cohort` name).
Work given to `spawn` or `batch-spawn` runs as a contract unless `outsideContract` is set: a planner splits it into units and each unit is checked against its acceptance criteria. With `outsideContract`, the agent runs on its own task, and only then are `model`, `provider`, `fallbackModels`, `reasoningEffort`, `tools` and `executionIntent` applied.
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
- `/health stop-agent <agent-id> [--note <why>]` stops one from the composer.

### Worktrees

Only contract work runs in git worktrees. A helper agent started outside a contract (`outsideContract: true`, `/agents start`, `/agents host`, `/remote dispatch`) works in the main working tree; no tool input or command gives it a worktree.

Who gets a worktree:

- Work handed to the `agent` tool (`spawn` or `batch-spawn` without `outsideContract`) and `/workstream start`/`launch` becomes a contract. A planner splits it into units; each unit is run by its own helper agent.
- The setting `contract.isolation` decides where units run: `auto` (default) uses worktrees when the project is a git repository with at least one commit, else the shared working tree; `worktree` always uses worktrees; `shared` never does (units then run one at a time).
- In worktree mode each unit gets its own worktree on a private branch named `ws-owned/<id>`, under `<repository root>/.goodvibes/.worktrees/`. Up to `contract.maxParallelUnits` (default 64) units of one group (see "Contracts") run at once.
- New worktrees run the cold-start setup in `worktree.setup.commands` and copy the files matched by `worktree.setup.carryOverGlobs`.

How to ask for parallel work in worktrees:

1. Make sure the project is a git repository with a commit (`/git init`, then commit once), or set `/settings set contract.isolation worktree`.
2. Ask in plain words for the work and name its parts, for example: `Add rate limiting to the API, a health endpoint, and retry logic in the client, as three independent pieces of work.` The model starts a contract; the planner decides how many units there are. The owner cannot force exactly N units or N worktrees; naming independent parts is what leads the planner to separate units.
3. Or plan first: `/workstream plan <goal>`, check the steps with `/workstream show <plan>`, change them, then `/workstream approve <plan>` and `/workstream launch <plan>` (see "Workstreams").

How to watch:

- `F2` or `Ctrl+O` opens Your agents, with each unit's agent; `Enter` opens one (its composer steers it), `s` stops it (asks first).
- `/agents contract [<contract>]` and `/workstream status <workstream>` show units and their states; `/graph <workstream>` draws the task graph.
- `/worktree` lists each worktree with its age, size and why it is kept.
- In a headless run, the `AGENT_*` and `CONTRACT_*` frames report progress.

How results come back:

1. When a unit passes, its branch joins one integration lane and is merged into the contract's branch, one unit at a time, in the order units finish.
2. A unit whose branch conflicts during that merge is not merged; its worktree and `ws-owned/<id>` branch are kept, the lane continues with the next unit, and the conflict is never resolved automatically.
3. When every unit has passed and the contract's checks pass, the contract's result is published to the project's branch. With `contract.autoCommit` on (default) it is merged with `git merge --no-ff` and the commit message names the contract; `contract.commitScope` `off` leaves it as uncommitted changes.
4. If the project's files changed after the contract started, the result is applied as uncommitted changes on top of those edits, and the automatic commit is deferred.
5. If the publication merge conflicts, the merge is aborted, the project's tree is put back as it was, and the contract records `not applied: ...; the work stays on branch <branch>`. The owner is asked to clear the obstacle and reply `retry` or `cancel`. To take the work by hand, run `git merge <branch>` and resolve the conflicts.

What is left behind:

- A unit that passed and merged: its worktree is removed.
- A unit that failed or was cancelled: its worktree is removed only when it holds nothing unique (no uncommitted changes, no unmerged commits); otherwise it is kept, and the oldest kept worktrees are removed first when too many are kept.
- A unit whose merge conflicted: worktree and branch kept.
- On restart, a passed unit whose branch had not been merged is put back on the integration lane, and worktrees on disk that belong to known units are adopted or reported, never deleted.
- `/worktree discard <worktree>` removes a kept worktree after asking (refused with the reason when it holds unique work); `/worktree keep <worktree>` marks one to keep. A keep, pause, resume or attach made while the retention sweep is already removing that worktree is refused with the reason, never recorded and then ignored; one made before the sweep claims the tree keeps it.

`/worktree` subcommands:

`/worktree` alone opens these actions (a model or script running it alone gets the review); a worktree is picked from the list of this project's worktrees.

| Line | Effect |
| --- | --- |
| `/worktree review` | Every tracked worktree with its age, size and why it is kept. |
| `open` | Open Agents on the worktree list. |
| `inspect <worktree>` | One worktree's metadata. Unknown: `No tracked worktree at <path>.` |
| `setup <worktree>` | Run the cold-start setup again. When both settings are empty: `Setup skipped: ...`. |
| `attach <worktree> <id> --to session\|task` | Tie a worktree to a session or task. |
| `attached session\|task <id>` | Worktrees of one session or task. |
| `recover session\|task <id>` | The worktrees of a session or task and the line that brings each back. |
| `pause <worktree>`, `resume <worktree>`, `keep <worktree>` | Change a worktree's state (`<path> is <state>.`). |
| `discard <worktree>` | Asks, then has the daemon remove it; a worktree with unique work is refused with the reason. |
| `cleanup <worktree>` | Asks, then removes a worktree's tracking after it is gone (`Stopped tracking <path>.`). |

<!-- generated: settings:worktree -->

<!-- generated: settings:agents -->

<!-- generated: settings:orchestration -->

## Contracts, workstreams and work plans

### Contracts

A contract is a tracked piece of delegated work: a goal, units of work, acceptance criteria checked when the work ends, a budget, and an owner who answers its questions.
The planner arranges a contract's units in groups. A group is a set of units that may run at the same time; a group starts once every group it depends on has passed, its units run side by side (up to `contract.maxParallelUnits` in worktree mode, one at a time in shared mode), and when all of them have passed the group as a whole is checked before the groups that depend on it start. The contract passes when its last group and the whole deliverable pass their checks.
Contracts show in Your agents and in `/agents contracts-view`.
A contract that needs the owner raises a question (an escalation) in `/questions`; the work continues after the answer.
`contract.*` settings control gates, budgets and limits; `contract.gateTimeoutMs` (default 900000) bounds the test gate.
At start the daemon resumes the contracts that had not ended. One it cannot run is held, not run, and its status (`contracts.status`) carries `held` with the code and reason: `input-unavailable` when its recorded input could not be restored (cancelling it ends it as cancelled), `claim-unavailable` when no run claim could be taken in the project's `.goodvibes/contracts` directory (another process may be running it, so it is not cancelled from here: `CONTRACT_HELD`).
A kill of a workstream unit while its gates run stops the gates and commits nothing; the phase reads cancelled.
A reply that a failure question does not accept is refused before anything is taken, so a shared-tree contract does not take the tree for it.

<!-- generated: settings:contract -->

### Workstreams

A workstream is a contract started from an owner's request.
The owner either starts one at once or plans it first.
`/workstream` alone opens its list of actions ("See your workstreams" first); each action asks for what it needs, choosing workstreams, plans, steps and questions from lists, and ends by printing the line that does the same.
Run by a model or a script, `/workstream` alone prints the list of workstreams.

Start at once (the request must be the owner's own words, typed in the terminal or in the form):

```text
/workstream start add rate limiting to the public API
```

Plan first, review, then launch:

1. `/workstream plan add rate limiting to the public API` makes a plan and prints it. Nothing runs until launch.
2. `/workstream plans` lists plans; `/workstream show <plan>` prints one.
3. Change the plan: `/workstream edit <plan> <step> <brief>`, `/workstream drop <plan> <step>`, `/workstream move <plan> <step> --to <position>`, or plan again from a new goal with `/workstream replan <plan> <goal>`.
4. `/workstream approve <plan>` approves it.
5. `/workstream launch <plan>` starts it. An unapproved plan is refused: `Plan <id> is not approved.`, with `Approve it with /workstream approve <id>, then launch it.`
6. `/workstream discard <plan>` throws a plan away (it asks first; this cannot be undone).

Running workstreams:

| Action | Line | Effect |
| --- | --- | --- |
| See your workstreams | `/workstream list` | Workstreams of this session with status and request. |
| See how a workstream is going | `/workstream status <workstream>` | Steps, states, spending limit and open questions. |
| Stop a workstream | `/workstream stop <workstream>` | Asks first (it cannot be resumed), then `Stopped workstream <id>.` |
| Answer a workstream's question | `/workstream answer <workstream> <question> <answer>` | Answer an owner question. A closed question is refused: `That question is no longer open.` |
| Run a step of a workstream again | `/workstream retry <workstream> <step>` | Give one step a fresh agent. |
| Change a workstream's spending limit | `/workstream budget <workstream> <dollars>` | Asks first (it spends money), then `Workstream <id>'s limit is now $<n>.` |

An id may be any unambiguous prefix. An unknown id is refused: `No workstream in this session matches <id>.`
`/graph <workstream>` draws the workstream's task graph: nodes, edges, states and pool posture; `/graph` alone asks which workstream, from the ones the daemon knows.

### The work plan

The work plan is a persistent, workspace-scoped checklist, the project's to-do list; it records work and does not run it.
The model edits it with the `work_plan` tool; helper agents share it; its open items reach the model once per turn.
`/todo` is its command, the same in both apps; `/todo` alone opens its list of actions ("See your to-do list" first), and a model or script running it alone gets the list.
Changes are the owner's: a model running a `/todo` change is refused and keeps its own plan with the `work_plan` tool.

| Action | Line | Effect |
| --- | --- | --- |
| See your to-do list | `/todo list` | Print the items. |
| Open the to-do panel | `/todo open` | Open the to-do panel (terminal app only). |
| See it as a Markdown checklist | `/todo markdown` | Print the list as Markdown. |
| Save it as a Markdown file | `/todo export` | Write the list as Markdown and print the path. |
| Add an item | `/todo add <title> [--owner <for whom>] [--notes <notes>] [--source <where it came from>]` | `Added item <id>.` |
| Change an item | `/todo edit <item> <title> [--owner ...] [--notes ...] [--source ...]` | Change an item. |
| Mark an item done, blocked or another state | `/todo mark <item> <state>` | State is one of `pending`, `in_progress`, `blocked`, `done`, `failed`, `cancelled`. |
| Move an item to its next state | `/todo next <item>` | Not started, in progress, done, then back. |
| Remove an item | `/todo remove <item>` | Asks first, then deletes it. |
| Remove the finished items | `/todo clear-done` | Asks first, then removes done and cancelled items: `Removed N finished items.` |

### Native work and work requests

`/work` is native work on the host, the same command in both apps (the work view is the Agent's Work section there). Alone it opens its actions; `/work open [<project>]` opens the work view at a daemon project. Its actions, grouped:

- `request <what you want done...>`: submits the exact request, as you typed it, through native conversation intake on the daemon (the terminal app's; only the owner typing it counts). When intake is unavailable it says so and starts nothing.
- Work: `start <work>`, `status <work>`, `cancel <work>` (asks first), `resume <work>`.
- From a file: `submit-file <JSON-file>`, `submission`, `submission-retry`, `submission-discard` (asks first).
- Input waiting to be admitted: `intake`, `intake-retry`, `intake-resume`, `intake-cancel` (asks first).
- Old planning records: `import-preview <project>`, `import <project>`, `import-status <project>`, `import-reconsider <project> [request]`, `import-recover <project> [request]` (resends a request whose answer was lost; the host applies it once), `import-cancel <project> [request]` (asks first), `import-restart <project> [request]`. The host decides whether an import is admitted.
- The planner and past plans (the terminal app's): `planner` (its mode, any forced way and its latest choice), `planner-explain`, `planner-mode <auto|single|cohort|background|remote>`, `planner-override <strategy>`, `planner-reset`, `history` (saved planning records, read only), `plans` and `plan <id>`.

`/work` is different from `/plan`, which only turns plan mode on and off.

## Memory and knowledge

### Session memory

Session memory is text pinned to this session; it survives compaction.
Add to it with `/keep <text>`, `/note add <text>`, `!# <text>` (pins and sends) or `# <text>` (saves and sends nothing).
Durable records that apply to this session only are `/memory` records with `--scope session` (`/memory add <kind> <summary> --scope session`, `/memory queue --scope session`).

### Durable memory

Durable memory is a store of records shared by every GoodVibes program on the machine, in `~/.goodvibes/shared/memory.sqlite` (read and written through the daemon while it serves memory).
Each record has a class, a scope, a summary, optional detail and tags, a confidence, a review state and its provenance (where it came from).

| Field | Values |
| --- | --- |
| class | `decision`, `constraint`, `incident`, `pattern`, `fact`, `risk`, `runbook`, `architecture`, `ownership` |
| scope | `session`, `project`, `team` |
| review state | `fresh`, `reviewed`, `stale`, `contradicted` |

Records that match a turn can be added to the model's context; `/memory explain <task>` shows which would be, and `Alt+M` lists the memories the last turn used.

`/memory` is described once for both programs (the Agent has the same command). Bare, it opens its list of actions with "See your memory" first and the rest grouped ("Correct or review a record", "See what a task is given", "Keep memory as files, or move it", "Copies of memory and the search index"); a model or a script running it bare gets the list of records. Each action asks for what it needs, from the live list of records or copies where there is one, says what it will do in one sentence, and ends with the line that does the same. The typed lines:

| Line | Action |
| --- | --- |
| `list [--class <kind>] [--scope session\|project\|team]` | See your memory: records by kind. |
| `add <kind> <summary...> [--detail <text>] [--tags <t,t>] [--scope <scope>] [--session <id>] [--task <id>] [--file <path>]` | Remember something (scope `project` unless given): `Remembered "<summary>".` with `Its id is <id>.` |
| `search [<words...>] [--class <kind>] [--scope <scope>] [--limit <n>] [--semantic]` | Search memory by the words, or by what they mean with `--semantic`. |
| `show <record>` | See one record: where it applies, detail, tags, where it came from, links. |
| `edit <record> [--summary <text>] [--detail <text>] [--tags <t,t>] [--scope <scope>]` | Correct a record in place; what is not given is kept, and the record keeps its id, kind, origin and links. |
| `review <record> <fresh\|reviewed\|stale\|contradicted> [--confidence <0-100>] [--reason <text>] [--by <name>]` | Say whether a record is still right. |
| `promote <record> <session\|project\|team>` | Change where a record applies. |
| `link <from> <to> <relation...>` | Link two records. |
| `remove <record>` | Forget a record (asks first; it cannot be undone). |
| `queue [<n>] [--scope <scope>]` | See records waiting for review. |
| `explain <task...> [--scope <path>]...` | See what memory a task would be given. |
| `injections [<agent id>]` | See what memory each recent turn (of this session, or of one agent) was given; terminal app only. |
| `sync-files [--dir <folder>]`, `review-files [--dir <folder>]`, `apply-files <id\|all> [--dir <folder>]` | Keep memory as Markdown files in their own repository (`memory.projection.dir`, default `.goodvibes/memory/projection`), see what your edits to them would change, and take chosen changes into memory. A file still as `sync-files` wrote it is never read as an edit, and a file whose top lines were broken is reported as unreadable, never as a deletion. When the store holds more records than one read takes (5000), files of records past that are left as they are and not compared. `apply-files` only counts when you type it. |
| `export <file> [--scope <scope>] [--class <kind>]`, `inspect <file>`, `import <file>` | Save memory to a file (a team handoff is `--scope team`), read one before loading it, load one (records already there are left as they are). A line the model runs may only use paths inside the project. |
| `snapshots`, `restore <copy\|latest\|date>` | Copies of memory (daily, before a migration, before a restore); `restore` replaces all memory with one, copying the current records first, and only counts when you type it. |
| `index`, `rebuild-index` | The semantic search index: each stored vector records the embedding space it was made in (provider, model and width); a search compares only vectors of the current space, so after `provider.embeddingProvider` or its model changes, `index` shows `waiting to be embedded again: <n>` and semantic search says how many memories it left out until `rebuild-index` embeds them again. |
| `capture <incident\|policy\|mcp\|plugin> [<which>]` | Remember an incident report, the last policy check, or an MCP server's or plugin's trust as a record. |
| `open` | The Memory screen (terminal app; the Agent opens its workspace's Memory page). |

Worked example:

```text
/memory add decision Use Postgres advisory locks for the job queue --tags queue,db
Remembered "Use Postgres advisory locks for the job queue".
Its id is <record-id>.
The command for this is: /memory add decision Use Postgres advisory locks for the job queue --tags queue,db
```

### Knowledge

Knowledge is a source-backed graph of ingested pages, bookmarks and notes, kept by the daemon.
`/knowledge` is one command in both apps; alone it opens its actions, and from a model or script it prints `status`. Here it works on the terminal app's own knowledge:

| Action | Effect |
| --- | --- |
| `status` | Store status (the report). `open` opens the knowledge view. |
| `ask <question...> [--space <knowledge space>] [--limit <n>] [--mode <concise\|standard\|detailed>]` | A source-backed answer with sources, facts and confidence. |
| `ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] [--allow-private-hosts]` | Add one page. |
| `import-bookmarks <file> [--allow-private-hosts]`, `import-urls <file> [--allow-private-hosts]` | Add a browser bookmarks export, or a file with one URL per line. |
| `list [--kind <sources\|nodes\|issues>] [--limit <n>]`, `search <words...> [--limit <n>]`, `get <id>` | Read the store. |
| `queue [limit]`, `review-issue <issue> <accept\|reject\|resolve\|reopen\|edit\|forget> [--reviewer <name>] [--value <json-object>]` | Review issues the store raised (`forget` asks first). |
| `candidates [limit]`, `reports [limit]`, `schedules`, `lint` | What tidying could merge, its reports, its schedules and a consistency check. |
| `packet <task...> [--scope <path> ...]` | The compact knowledge a model would be given for a task. |
| `reindex`, `consolidate [light\|deep]`, `cancel-run <run>` | Rebuild the index, tidy (merge and fill gaps), stop a job (asks first). |

Files, artifacts, browser history, connectors and the map are Agent Knowledge's; here they are refused with the reason. A private-network URL is refused unless `--allow-private-hosts` is given, which loosens a protection: it asks first and a model cannot use it.

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

Project files start no server until the workspace is trusted (`/security trust-folder`); an undecided workspace counts as untrusted.
A file that cannot be read is skipped with one warning.

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
4. With `constrained` or `ask-on-risk`, a call whose path arguments are inside `allowedPaths` and whose URL arguments use `allowedHosts` is allowed. One outside them is refused under `constrained`: `request exceeds configured scope for server '<name>': ... Call it with values inside the scope, or ask the owner to widen the server's scope.` Under `ask-on-risk` it is put to you on an approval card, in every permission mode (`yolo` included; held for you in `just-vibes`), with the reason `The MCP server '<name>' is trusted ask-on-risk and this call to '<tool>' is outside its configured scope: <which argument>.`; it is sent only if you allow it, otherwise the model gets `MCP call '<qualified name>' was not allowed: <reason>`. Where nobody can be asked (a host with no permission owner), it is refused: `... Nobody can be asked from here, so it was not sent.`

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

- `/mcp trust` and `/mcp role` write `trustMode` or `role` into the file that holds the server's entry (`<project>/.goodvibes/mcp.json` or `~/.config/mcp/mcp.json`) and apply it at once; it holds after a restart: `<server> is set to "<mode>". Kept in <scope> MCP config <path>; it applies now and after a restart.` A server that comes only from a read-only file gets the value for this session only, and the line says why: `It is set for this session only (<reason>).` `/mcp restore-trust <server>` and `/mcp restore-role <server>` end a value set for this session only. Both programs take `allow-all` and `ask-on-risk` from `/mcp trust` and `/mcp add --trust`; each loosens a protection, so the line asks first and a model's line is refused. Settings → MCP keeps a trust mode the same way (`<server> trust mode is <mode>, kept in <scope> MCP config <path>: it applies now and after a restart.`). `allow-all` is read only from `~/.config/mcp/mcp.json`: written to a project file it is ignored when the file is read.
- `/mcp block <server> <tool>` lasts for the session. With `--keep` it is written as `deniedTools` into the file that holds the server's entry (`<project>/.goodvibes/mcp.json` or `~/.config/mcp/mcp.json`). `/mcp unblock` removes the block, this session's and the kept one.
- `/mcp exempt` writes `allowedTools` into `~/.config/mcp/mcp.json` only; for a project server it is refused. `/mcp unexempt` removes it. `unblock` and `unexempt` each drop only their own kind of rule, and say so when the tool has none: `<tool> on <server> is not blocked; nothing changed.`
- On a server's row in Settings → MCP, typing `block`, `unblock`, `exempt` or `unexempt` (a tool name after it is optional) closes Settings and opens that `/mcp` action for the server: it asks for the tool and how long when they are missing, and says what it will do before it does it.
- A server that comes only from a read-only file (`.mcp/mcp.json`, `~/.mcp/mcp.json`, Claude Desktop's file) cannot keep per-tool rules: `Add <server> to your own MCP config (/mcp add with --scope global) to keep per-tool rules, or block it for this session only: /mcp block <server> <tool>.`
- A rule written while a server runs applies at once.
- The daemon runs the same actions for the web UI and scripts, each method named by the action's word: `mcp.servers.tools.block`, `.unblock`, `.exempt`, `.unexempt` (each kept with the server's entry; a block for one terminal's session is that terminal's), `mcp.servers.trust.set`, `mcp.servers.role.set`, `mcp.servers.reload`, `mcp.servers.quarantine.accept`, `mcp.servers.upsert` (Add a server) and `mcp.servers.remove`. `unblock`, `exempt`, a looser trust level and accepting changed tools are the owner's own acts: refused for the Agent's model. Going back to a saved trust level or role and holding tools back act on one terminal's session, so they are done there.
- `deniedTools`, `trustMode` `blocked`, the path and host scope and quarantine are enforced by the MCP registry itself, so they apply in every permission mode, `yolo` included.

### `/mcp`

`/mcp` alone opens a short list: "See your servers" (with how many are connected beside it), "Add a server…", "Choose what a server may do…" and "Check a server that isn't working…"; the last two open short lists of their actions. An action with blanks opens a form a step at a time ("Add a server · step 1 of 2": how it starts, the command or address, and its name, suggested from the command; step 2, what it may do): Enter goes on, tab moves between blanks, left and right change a choice, a blank chosen from a list (your servers, the tools a server offers right now, the tools you blocked) opens that list, Esc goes back a step. Under the form, "This will run:" shows the line it will run as you type. Then one sentence says what is about to happen, and after it runs the app prints what happened, how to undo it and "The command for this is: <line>". A typed line that leaves a blank out opens the same form with what it gave filled in; a complete line runs at once (asking first when the action is marked). From a model, or where no list can be shown, a line with a blank missing is refused with the blank's name and its current choices, and `/mcp` alone shows the servers. `/help mcp` lists every action with its sentence and its line; completion after `/mcp ` offers the actions, then the blank being typed (`/mcp block ` lists servers, `/mcp block github ` that server's tools), then options after `--`. The same actions, names and sentences are in both programs.

| Action | Line | Risk |
| --- | --- | --- |
| See your servers | `/mcp servers` (each server's connection, trust level, role and per-tool rules) | |
| See a server's tools | `/mcp tools [<server>]` | |
| Block a tool | `/mcp block <server> <tool> [--keep]` (this session only; `--keep`: until you unblock it, as `deniedTools`) | |
| Stop blocking a tool | `/mcp unblock <server> <tool>` (picks from the tools blocked) | loosens a protection |
| Let a tool go beyond its server's limits | `/mcp exempt <server> <tool>` (`allowedTools` in the global file) | loosens a protection |
| Make a tool follow its server's limits again | `/mcp unexempt <server> <tool>` | |
| Add a server | `/mcp add <name> [--url <https address>] [--scope project\|global] [--trust <mode>] [--role <role>] [--path <dir>]... [--host <host>]... [--env NAME=VALUE]... [--header Name=Value]... [-- <command and its arguments>...]`, for example `/mcp add weather -- npx -y @acme/weather-mcp` (see "Adding a server with `/mcp add`") | `allow-all` and `ask-on-risk` loosen a protection |
| Remove a server | `/mcp remove <server> [--scope project\|global]` | cannot be undone |
| Reconnect every server from its config | `/mcp reload` | |
| Set a server's trust level | `/mcp trust <server> <constrained\|ask-on-risk\|blocked\|allow-all>` | `ask-on-risk` and `allow-all` loosen a protection |
| Go back to the saved trust level | `/mcp restore-trust <server>` | loosens a protection |
| Set a server's role | `/mcp role <server> <general\|docs\|filesystem\|git\|database\|browser\|automation\|ops\|remote>` | |
| Go back to the saved role | `/mcp restore-role <server>` | |
| Hold back a server's tools for review | `/mcp quarantine <server> [<why>]` (this session only) | |
| Accept a server's changed tools | `/mcp accept-tools <server>` | loosens a protection |
| See which servers need attention | `/mcp review` (`✓ Every MCP server is working.`, or one `✕` line per server with `Fix: /mcp repair <server>` under it) | |
| See how to fix a server | `/mcp repair [<server>]` | |
| See where servers are configured | `/mcp files` | |
| Open the MCP screen | `/mcp open` | |

An action marked "loosens a protection" only counts when you type it or choose it: a model's line is refused before anything is asked. Old spellings (`deny`, `allow`, `clear`, `config`, `auth-review`, `trust <server> config`, `quarantine <server> approve`) are not accepted; the refusal lists the actions.

### Adding a server with `/mcp add`

`/mcp add <name> -- <command> [words...]` (or `/mcp add <name> --url <https address>`) writes the server to `<project>/.goodvibes/mcp.json` (`--scope project`, the default) or `~/.config/mcp/mcp.json` (`--scope global`) and reloads.
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

A server that fails to connect is retried after 1, 2, 4, 8 and 16 seconds while `runtime.mcpLifecycle` is on (the default); after five failures it stays disconnected until `/mcp reload`.
A server that never completes its handshake is given up after 30 seconds.
`/security contain-mcp` runs MCP servers inside the command sandbox.

## Plugins

A plugin is code loaded into the app process that registers commands, tools, providers, hooks, views and more.

### Where plugins live

The loader searches exactly these directories, in this order; a project plugin overrides a global one with the same manifest name:

1. `<project>/.goodvibes/plugins/<name>/`
2. `~/.goodvibes/plugins/<name>/`

`/plugin dirs` prints them. Each plugin directory holds `manifest.json` and an entry file (`index.js` unless `main` names another):

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

A plugin that is found is not loaded until it is enabled. `/plugin enable <name>` loads and starts it at once and records the choice (with the directory it was enabled from) in `~/.goodvibes/tui/plugins.json`; from then on it starts with the app. `/plugin disable <name>` stops it and records that. A newly written plugin therefore needs `/plugin enable`, not only a restart.

### The entry file

The entry file is an ES module. It must export `init(api)`, called once after the plugin is loaded; it may also export `activate()` (called after `init`) and `deactivate()` (called before the plugin is unloaded). Each may be `async`.

The `api` object has exactly these members:

| Member | What it does | Needs |
| --- | --- | --- |
| `registerCommand(name, description, handler)` | Adds the slash command `/<name>`. `handler(args, context)` receives the typed words and `context.print(text)`, which shows text in the session that typed the command; an error it throws is shown there. | Any tier. |
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
4. In the app: `/plugin enable word-count`. It prints `Plugin 'word-count' enabled and activated.`, or the reason it did not start (an undeclared capability, a tier too low, an error thrown by `init`).
5. Confirm: `/plugin list` shows `[active]` before the plugin's name (`[loading]` while it starts, `[disabled]` when it is not enabled); `/plugin inspect word-count` shows `state: active`, its trust tier and the capabilities its tier withheld; `/wc a b c` prints `3 words`; `/tools` lists `word_count`.
6. After editing the plugin, `/plugin reload` loads it again and names each plugin that did not start, with the reason.

### Trust tiers

| Tier | The plugin gets |
| --- | --- |
| `untrusted` (default) | Views, commands and reading files. |
| `limited` | Also the tools, providers and hooks it declares, gateway methods, channels and delivery strategies. |
| `trusted` | Also the high-risk capabilities it declares. |

A plugin that declares a high-risk capability does not start below `trusted`.
The tier is one decision per plugin for every GoodVibes program on the machine, kept in `~/.goodvibes/plugin-trust.json`.
A tier is given to one copy of the plugin: the copy in the directory it was enabled from (or, when it was never enabled, the first one found), and that copy's manifest and entry file as they were then. A same-named copy in another directory (a repository's own `.goodvibes/plugins`), or the same copy after its code changed, starts `untrusted` until its trust is set again. The tier is not a sandbox: a plugin's code runs inside the program with its access.
`trusted` is set by a verified signature against the publisher's Ed25519 key (saved once with `/plugin trust-key <name> <key.pem>`), or by the owner's confirmation when it does not verify.

### `/plugin`

`/plugin` alone opens its actions ("See your plugins" first; a model or script running it alone gets the list); a plugin is picked from the plugins found on this machine.

| Line | Effect |
| --- | --- |
| `list`, `dirs`, `inspect <plugin>`, `review` | Plugins, search directories, one plugin's trust, quarantine and capabilities. |
| `enable <plugin>`, `disable <plugin>` | Switch a plugin on (`Plugin '<name>' switched on and started.`) or off. |
| `reload` | Reload plugins and report each that did not start and why. |
| `trust <plugin> <untrusted\|limited\|trusted> [note]`, `trust-key <plugin> <key.pem>`, `verify <plugin>`, `capabilities <plugin>` | Set and check trust. `trusted` asks first and only the owner can choose it. |
| `quarantine <plugin> [reason]`, `lift <plugin>` | Stop a plugin and keep it from loading; `lift` (the owner's only) lets it load again. |
| `publish-local <id> <folder> <summary>`, `unpublish <id>` | Publish a plugin folder into the local curated catalog, or take it out (asks first). |
| `open` | The plugins screen. |

Installing, updating and uninstalling a catalog plugin is `/marketplace` (`/marketplace install plugin <id>`).

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
`/skills` lists skills: `list` (what `/skills` alone gives a model or script), `show <skill>`, `origins`, `publish-local <id> <folder> <summary>`, `unpublish <id>` and `open` (the skills screen). `/skills show` of an unknown skill is refused: `Unknown skill: <name>`. Installing, updating and uninstalling a catalog skill is `/marketplace` (`/marketplace install skill <id>`).

## The marketplace

The marketplace is a local-first curated catalog of plugins, skills, hook packs and policy packs, kept in `.goodvibes/ecosystem/*.json` (global under `~/.goodvibes/ecosystem/`, project under `<project>/.goodvibes/ecosystem/`).
`/marketplace` alone opens its actions ("See the marketplace at a glance" first); `<kind>` is `plugin`, `skill`, `hook-pack` or `policy-pack`, and entries are picked from the catalog or from what is installed:

| Line | Effect |
| --- | --- |
| `overview`, `recommend`, `browse [words]`, `installed`, `open` | Browse. |
| `review <kind> <entry>`, `provenance <kind> <entry>`, `install-hint <kind> <entry>` | Inspect one entry. |
| `install <kind> <entry> [--scope project\|user]` | Install: `Installed curated <kind> <id> into <path>`. |
| `update`, `history`, `rollback [--backup <id>]`, `receipt`, `uninstall` (each `<kind> <entry> [--scope ...]`) | Manage an installed entry; `uninstall` asks first. |
| `bundle-export <file> [--scope ...]`, `bundle-inspect <file>`, `bundle-import <file> [--scope ...]` | Move a set of entries. |

"Install for" (`--scope`) is `project` (this project, the default) or `user` (all your projects).

## Hooks

A hook runs an action when an event happens: before or after a tool call, a file write, a model call, an agent lifecycle step and more.

### The hooks file

Hooks are read from `hooks.json` in the working directory, or from the file `tools.hooksFile` names (resolved against the working directory).
A hooks file inside an untrusted workspace is not loaded; `/security trust-folder` loads it.
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
`/hooks contracts [words]` lists every hook point.
A key that matches no hook point is not loaded; `goodvibes hooks validate` reports it.

### Hook types and fields

| Type | Action |
| --- | --- |
| `command` | Run a shell command; the event is passed as JSON on standard input. |
| `prompt` | Send a prompt to a model; `$ARGUMENTS` is replaced with the event JSON. |
| `agent` | Start a helper agent for the event. |
| `http` | POST the event to `url` (redirects are not followed). |
| `ts` | Run a TypeScript module (`path`) whose default export handles the event. |

Fields: `match`, `matcher` (an exact, case-sensitive string compared with the event's third segment, its specific name: under `Pre:tool:*`, `"matcher": "exec"` limits the hook to `exec` calls; there are no wildcards or patterns; or `effect:<class>`, which matches every tool call the permission gate classes as `read`, `write`, `execute` or `delegate`, whichever tool made it: under `Pre:tool:*`, `"matcher": "effect:execute"` fires for every tool that runs a command, not only `exec`), `type`, `command` / `prompt` / `url` / `path`, `headers`, `model`, `timeout` (seconds; default 30, 60 for `agent`), `statusMessage`, `async`, `once`, `description`, `name`, `enabled` (default true).
A chain step takes `match`, `capture`, `within` (`30s`, `5m`), `condition`, `optional` and `debounce`.

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

The other categories carry their own payloads; `/hooks contracts` lists each point, and `/hooks simulate <eventPath>` shows what fires.

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
| `agent_harness` | Agent | modes such as `run_background_process` and `run_workspace_action` |
| `agent_operator_method` | Agent | daemon methods, including running a command on a paired peer or registered backend |

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
4. If the workspace is not trusted yet, run `/security trust-folder`: in either program the waiting hooks file loads at once. After editing `hooks.json` later, run `/hooks reload` in the terminal app, or restart the Agent.
5. Check it: `/hooks simulate Pre:tool:exec` lists the hook.

Tested inputs, refused: `cd x && git -C repo push` (`exec`), the base64 form of `git push origin main`, a `terminal` command `git push`, `process` `action: "start"` with `git push origin main`, `process` `action: "write"` with data `git push`, `repl` code `Bun.spawnSync(["git","push"])`, a `trigger` with `command: "git"` and `args: ["push"]` (either key order), a `state` command hook `git push`, a `workflow` schedule `git push`, and `agent_harness` `run_background_process` with `git push`. Passed: `git status`, `npm run dev`, a `trigger` running `git status`.

It also refuses harmless commands that contain the two words in that order, for example `git commit -m "push fix"` or `git log --grep push`.

What it does not stop:

- A command whose words are not in that order or are built when it runs: `echo push | xargs git`, `g''it push`, `$(printf git) push`, a variable holding `push` (including one set in `exec`'s `env`), a script file the model wrote earlier and then runs (`sh publish.sh`), a git alias (`git config alias.p push` followed by `git p`), or text sent to a running shell in pieces (`process` `write` of `git ` and then `push`).
- Tools of MCP servers (a git MCP server's push tool is the call `mcp` with `mode: "call"`); add a `Pre:tool:mcp` entry with a script that inspects `.payload.args.qualifiedName` to cover a specific server tool.
- Agents hosted with `/agents host` and runners started with `/remote dispatch`, which run their own tools in their own process.
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

### `/hooks`

`/hooks` alone opens its actions ("See the hook points and your hooks" first; a model or script running it alone gets that list); a hook is picked from the managed hooks and chains.

| Line | Effect |
| --- | --- |
| `contracts [words]` | List hook points. |
| `reload` | Reload hooks from the file. |
| `scaffold <name> <match> --type command\|prompt\|agent\|http\|ts` | Add a named hook skeleton to the file. |
| `chain <name> <event1,event2,...>` | Add a chain skeleton. |
| `enable <hook>`, `disable <hook>`, `remove <hook>` | Change a named hook; `remove` asks first. |
| `simulate <eventPath>` | Show what fires for an event. |
| `inspect <file>`, `import <file> [--strategy merge\|replace]`, `export [file]` | Move hook sets between files; `--strategy replace` asks first. |
| `open` | The hooks screen. |

Every `/hooks` change (`scaffold`, `chain`, `enable`, `disable`, `remove`, `import`) edits the hooks file itself: the file the setting `tools.hooksFile` names, resolved against the working directory, which is `<project>/hooks.json` by default.
Before writing, the command reads the file again; a file that is not valid JSON, is writable by other users, or is owned by another user is not changed (`The hooks file <path> was not changed: it was not loaded because <reason>. Fix the file, then retry.`).
The file is written to a temporary file and renamed over the old one, keeping its permissions, with two-space JSON indentation; the hooks are then loaded again at once.

`/hooks scaffold lint-after-write Post:tool:write --type command` prints `Made managed hook lint-after-write at Post:tool:write in /home/me/work/project/hooks.json; fill in what it runs there.` and adds this entry under the key `Post:tool:write`:

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

A scaffolded hook starts disabled. Replace its placeholder, then run `/hooks enable lint-after-write`.
The placeholder for each type: `command` gets `"command": "echo implement-hook"`; `prompt` gets `"prompt": "Return a HookResult JSON object for $ARGUMENTS."`; `agent` gets `"prompt": "Handle this hook event: $ARGUMENTS"`; `http` gets `"url": "http://localhost:3000/hooks"`; `ts` gets `"path": "./hooks/handler.ts"`.

`/hooks chain notify-done Lifecycle:agent:spawned,Lifecycle:agent:completed` appends to the file's `chains` list:

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
A project's `.goodvibes/tui/services.json` adds services only when they name keys in the owner's secret store and the owner confirms each with `/services trust <name>`.
`/services` (both programs) is described: `list` ("See your services", the report), `show <service>`, `check` ("Check every service": a missing key, password or address, counted by how each signs in), `test <service>` (sends one request with its credentials), `check-auth <service>` (names the sign-in headers its credentials make, never their values), `trust <service>` ("Use a service this project defines": it loosens a protection, so it asks with exactly what the entry sends and where and approves only that entry; a model cannot run it, and without a dialog it is refused), `export <file>`, `import <file>` (replaces the whole list; the old file is kept as `.bak`) and `open` (the terminal app's services screen).
With none: `No services yet. Add entries to ~/.goodvibes/tui/services.json, or load a list: /services import <file>.`
`/services check-auth <name>` with a missing credential is refused: `<name> cannot sign in right now: a credential it needs is not stored.` with `/services show <name> shows which.`

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

When no decision model was in use for the run, its one-line explanation (for example `No decision model is in use: none is set, so decisions take their fallbacks. Next: to use one, set judgment.model, judgment.endpoint or TYPESAFE_API_KEY.`) goes to standard error in every format, and the JSON formats also carry it in `diagnostics`.
When a request moves from one sign-in of a provider to another (OpenAI: subscription to API key), one line goes to standard error in every format, once per move: `<model> answered through your <provider> <sign-in>: the <previous sign-in> failed (<reason>).` The reason is a fixed phrase for the kind of failure with the HTTP status and the provider's short error code, for example `it reached its rate limit (HTTP 429), code rate_limit_exceeded`; the provider's own error text is never repeated.
Free text in any frame (`error`, `reason`, `question`, `summary`, `detail`, a tool's error) has credentials masked and is cut at 1000 characters followed by `...`. Tool arguments, agent task text, agent output and the full contract request are never included.
Consumers ignore frame types and fields they do not know. A field shown as optional is left out when it has no value; it is never sent as `null`, except `sessionId` and `usage` in the final frame.

### Stream frames

Every stream frame is one JSON object whose first two keys are `schemaVersion` (always `1`) and `type`.

| `type` | Field | Type | Meaning |
| --- | --- | --- | --- |
| `STREAM_DELTA` | `content` | string | The new text of this chunk. |
| | `accumulated` | string | The whole answer streamed so far in this model response. Left out with `--omit-accumulated`. |
| `DRAFT_WITHDRAWN` | `reason` | string | The completion check sent the streamed answer back. Discard the text received so far; the replacement streams from empty. |
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
| `PERMISSION_PROMPT` | `callId`, `tool`, `category` | string | With `--answer-permissions` only: the owner is asked, and the run waits for an answer on standard input. |
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
| `heldForOwner` | when `just-vibes` held calls | array | One object per held call: `id`, `tool`, `summary`, `reason`. Nothing was run for them; run again in `ask-me`, or answer them with `--answer-permissions`, to decide each. |
| `kind` | on some failures | string | `outcome-unknown` (the daemon may have acted) or `unavailable` (nothing was sent). |
| `cause` | with `kind`, when known | string | `journal_conflict`, `journal`, `principal`, `network`, `schema`, `host_changed`, `unknown`. |
| `native` | for native intake | object | `status` (`pending`, `recorded`, `unknown`, `invalid`, `unavailable`), `message`, `cause`, `request` (`requestId`, `inputId`), `result` (the host's record, whose `kind` is for example `captured`, `processing`, `turn`, `work`, `blocked`, `refused`, `cancelled`), `execution`, `nextStep` (`retry`, `resume`, `cancel` or `inspect`; run `--intake-<nextStep>`, where `inspect` means `--intake-status`), `notSent: true` (this run's own text was not sent because an earlier input must move first), `hostedTurn` (the daemon-hosted reply: `state`, `sessionId`, and on failure `failure` with `summary` and `retryable`). |
| `refusal` | when refused before starting | object | `code` (`SESSION_OPEN_ELSEWHERE`), `state`, `reason`, `next` (array of steps). |
| `recovery` | when restored from a crash snapshot | object | `sessionId`, `applied` (boolean), `refusal` (when not applied: `no-snapshot`, `unusable-snapshot`, `apply-failed`), `snapshotAt` (ISO time), `snapshotKept` (boolean), `messages` (number), `turns` (number), `interruptedTurn` (`prompt` masked and cut at 1000 characters, `toolResults` number, `interruptedToolCalls` as `{ callId, tool }`, `partialReply` boolean), `lost` (array of sentences). |
| `diagnostics` | when no decision model was in use | object | `decisionModel`: `inUse: false`, `policy` (`Hybrid`, `Decision Model Only` or `No Decision Model`), `reason` (`not-set`, `selected`, `unavailable`), `line`, and `failure` (`model`, `what`, `nextStep`) when the set model was failing. |

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
{"schemaVersion":1,"type":"PERMISSION_DECIDED","callId":"call-1","tool":"exec","category":"execute","approved":true,"source":"jev_decision","ownerPrompt":false,"reasonCode":"jev_act"}
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
2. For each call that needs the owner, the run writes a `PERMISSION_PROMPT` frame and waits.
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
| `2` | Invalid input: a usage error, a missing prompt, or a prompt given with an `--intake-*` flag (`Recovery uses the original journal input; do not supply a replacement prompt.`). |
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
Editor threads share the one embedded daemon of the home directory (`GOODVIBES_HOME` selects it); a thread whose working directory lies outside it gets its own; `session/close` ends a thread.

Zed configuration:

```json
{ "agent_servers": { "GoodVibes": { "command": "goodvibes", "args": ["acp"] } } }
```

To expose the operator API to an MCP client instead, use `goodvibes-daemon mcp serve` (described under "`mcp serve`" in the daemon part).
`/remote dispatch` and `/remote dispatch-pool` start this same command as their subagent; `ACP_AGENT_CMD` replaces it. (There is no model tool named `delegate`.)

## Project instructions

The model's standing instructions are built from these files, each present and non-empty file appended in this order (a later file takes precedence where they disagree):

1. `~/.goodvibes/SYSTEM.md`
2. `~/.goodvibes/GOODVIBES.md` (the owner's global instructions)
3. the nearest `AGENTS.md`, found by walking up from the working directory
4. `<project>/.goodvibes/GOODVIBES.md` (the project's instructions)
5. the file named by the setting `provider.systemPromptFile`

To give the terminal app standing instructions for one project, write them to `<project>/.goodvibes/GOODVIBES.md`; for every project, to `~/.goodvibes/GOODVIBES.md`.

## Settings the terminal app reads most

Every key is listed under "Settings" in the reference part. The prefixes that change the terminal app's own behavior:

<!-- generated: settings:display -->

<!-- generated: settings:behavior -->

<!-- generated: settings:ui -->

<!-- generated: settings:tools -->

<!-- generated: settings:checkpoints -->

<!-- generated: settings:runtime -->
