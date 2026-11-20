# CLI flags

Most flags below are global (available regardless of the subcommand in use). `--continue`, `--resume` and `--fork` are evaluated at TUI startup. `run` restores the transcript for `--continue`, `--resume` and `--session` and fails with "No saved conversation is available to resume" when there is none; other commands ignore `--continue` and `--resume`, refuse `--session`, and `run` refuses `--fork`. A few flags are specific to one command; those are listed separately in [Command-specific flags](#command-specific-flags).

## Session lifecycle

### `--continue`

Resume the most recently active session for the current working directory. Reads the last-session pointer file written by `persistConversation`. When no pointer file exists it says so in the transcript and starts a new conversation the way a plain launch does (onboarding included for a new user).

```sh
goodvibes --continue
```

### `--resume [id]`, `-r [id]`

Resume a specific session by id. When the id is omitted, resolves via the same last-session pointer as `--continue`.

```sh
goodvibes --resume                  # resolve latest pointer
goodvibes --resume user-sess-1234   # explicit id
goodvibes -r user-sess-1234
goodvibes --resume=user-sess-1234   # inline-value form
```

### `--fork [id]`

Fork a session into a new branch.

- **Bare `--fork`** (no id) forks the session that is already active when the TUI starts.
- **`--fork <id>`** resumes the named session first, then forks it.

Sessions whose id happens to be the string `current` can be forked by passing the id explicitly (`--fork current`), which is distinct from the bare `--fork` form.

```sh
goodvibes --fork                       # fork active session
goodvibes --fork user-source-session   # resume then fork
goodvibes --fork=user-source-session   # inline-value form
goodvibes --fork current               # fork the session literally named "current"
```

## Session targeting

### `--session <id>`, `-s <id>`

Attach to a named session. Only `run` reads it (it restores that session's transcript before submitting the prompt and fails when the session does not exist). Any other command refuses it with an error, so use `--resume <id>` to reopen a session in the interactive TUI.

```sh
goodvibes run --session user-sess-1234 "prompt"
goodvibes --resume user-sess-1234
```

## Commit gate

### `--yes`, `-y`

Most CLI commands act immediately and never ask for confirmation, so this flag has no effect on them. It has an effect on two lines. On `plugin bundles install`, without it the command only verifies the bundle and prints the activation plan, and with it the bundle is installed: its files are unpacked into the same install directory `/marketplace` uses (`.goodvibes/plugins`, `skills`, `hooks/packs` or `policies/packs`), with an install receipt that records the pin and the granted and withheld capabilities. `/marketplace rollback`, `history` and `uninstall` work on it like any installed entry, and `goodvibes plugin bundles uninstall <id>` removes it from the command line (`goodvibes-agent plugin bundles` takes the same words).

```sh
goodvibes plugin bundles install <ref> --sha256 <pin>          # preview only
goodvibes plugin bundles install <ref> --sha256 <pin> --yes    # installs it
goodvibes plugin bundles install <remote> --ref <tag> --sha256 <pin> --yes
```

It also answers the one question `plugin trust` asks: marking a plugin `trusted` when its manifest signature does not verify against the publisher key saved with `/plugin trust-key` is refused without `--yes`. `goodvibes plugin trust <name> <untrusted|limited|trusted>`, `plugin verify <name>` and `plugin capabilities <name>` set and inspect what a plugin may register without starting the app; the tier is shared by every GoodVibes app on the machine (`~/.goodvibes/plugin-trust.json`), and each applies it the next time it starts the plugin.

```sh
goodvibes plugin trust my-plugin limited
goodvibes plugin trust my-plugin trusted --yes   # signature does not verify; recorded in its trust note
```

A bundle is a tar archive whose top-level `goodvibes-bundle.json` is the capability manifest and whose other files are installed beside it (a bare manifest is a bundle with no payload); the pin is the SHA-256 of the archive bytes (for a git source, of `git archive --format=tar` of the ref). Links, absolute paths and paths with `..` in an archive are refused. A bundle reference may be a file path, an `https` URL or a git remote with `--ref`. The command refuses a URL that is not `https` or that names this machine or an internal network address (redirects are checked the same way), a bundle larger than 64 MiB, a fetch or git archive that takes longer than 60 seconds, and a git remote or ref that begins with `-` or uses a `name::address` helper transport. A refusal names the reason and happens before anything is fetched or checked against the pin.

### `--non-interactive`

Sets `--yes` and additionally suppresses any interactive prompt a command might otherwise open. Useful for scripted or CI contexts where no TTY is available.

```sh
goodvibes --non-interactive run 'do something'
```

## Output format

### `--output <format>`, `-o <format>` (canonical)

Set the output encoding for `run` and other machine-readable commands. Three formats are valid, each with its own shape:

| Format | What it prints |
| --- | --- |
| `text` (default) | The final assistant response on stdout. Errors, and the status message of a run that never reached the model, go to stderr |
| `json` | One JSON object on one line at the end (the [final frame](#final-frame)) |
| `stream-json` | Newline-delimited JSON: the [stream frames](#stream-frames) as they happen, then the final frame |

```sh
goodvibes run 'list files' --output json
goodvibes -o stream-json run 'stream output'
```

See [Headless `run`](#headless-run) for the frame shapes and exit codes.

### `--output-format <format>` (deprecated alias)

Deprecated alias for `--output/-o`. Prints a deprecation warning to stderr and maps to the same `outputFormat` field. Use `--output` or `-o` instead. When both appear on the same command line, the last one wins.

### `--json` (alias)

Shorthand for `--output json`.

```sh
goodvibes run 'list files' --json
```

### `--print`

Run in non-interactive print mode. Implies `run` command when no subcommand is given. Prints assistant output to stdout and exits.

## Provider and model

### `--provider <name>`

Override the active provider.

```sh
goodvibes --provider openai
```

### `--model <id>`, `-m <id>`

Override the active model. When the model id starts with the id of a built-in or local provider and a colon (`openai:gpt-5.2`, `ollama:llama3:8b`), that provider is used unless `--provider` is also set. Any other colon belongs to the model id (`llama3:8b`) and the configured provider stays; name a provider that only your own config defines with `--provider`. A slash id such as `meta-llama/Llama-3.1-8B` is not split: the model registry resolves it, so pass `--provider` to name the provider explicitly.

```sh
goodvibes --model openai:gpt-5.2
goodvibes -m anthropic:claude-sonnet-4-6
```

## Network and serving

### `--port <number>`

Override the port for `web`, `surfaces enable`, or other network-bound commands. Must be 1–65535.

### `--hostname <address>`, `--host <address>`

Override the bind address. `--host` is an alias; both map to the same `hostname` field.

```sh
goodvibes web --hostname 0.0.0.0 --port 3423
goodvibes surfaces enable web --host 0.0.0.0
```

### `--open`

Open the browser automatically after the web UI starts.

## Display

### `--no-alt-screen`

Disable the alternate screen buffer. Useful for terminals that do not support it or when capturing TUI output in a log.

## Paths

### `--daemon-home <path>`

Override the daemon home directory (default `~/.goodvibes/daemon`). The flag wins over `GOODVIBES_DAEMON_HOME`; every command that reads the operator token, the daemon settings or the companion token uses the same directory, including `auth status` and `bundle export`.

### `--working-dir <path>`, `--cd <path>`, `-C <path>`

Override the working directory used for session storage and project-scoped config resolution.

## Runtime

### `--just-vibes`

Run this launch in the `just-vibes` execution mode: the agent does as much as
it can without interrupting you, Jev decides judgment calls when a decision
model works, and anything that needs you is held and listed at the end of the
run. Shorthand for `--config permissions.mode=just-vibes`; no settings change
is saved.

### `--yolo`

Run this launch in the `yolo` execution mode: no general safety denial or
prompt. Shorthand for `--config permissions.mode=yolo`; no settings change is
saved. Read, search and repository-map tools also honor it for access outside
the project, including resolved symlink targets. Authentication, capability
scopes, revocation, input ownership, operating-system access, host containment,
secret storage and payment limits still apply.

```sh
goodvibes --yolo
goodvibes --just-vibes --prompt 'Tidy the test fixtures and tell me what you could not do.'
```

### `--config <key=value>`, `-c <key=value>`

Apply a settings override at startup. May be repeated.

```sh
goodvibes --config log.level=debug --config feature.x=true
```

### `--enable <feature>`, `--disable <feature>`

Enable or disable a named feature at startup. The value is a feature id (for example `output-schema-fingerprint`), not a settings key; an unknown id is refused and the error lists the known ids. A capability with no off switch (the `surfaces.*` features, `fetch-sanitization`) is refused with a message saying so. May be repeated.

## Prompt injection

### `--prompt <text>`, `-p <text>`

Send a prompt directly to the selected model, print the response, and exit.
Jev does not approve, reject or reroute the prompt. Implies `run` when no subcommand is given.

```sh
goodvibes --prompt 'explain this file'
goodvibes -p 'summarize the diff'
```

Parser limits to know about:

- A flag that takes a value refuses a value that begins with `-`. Use the long form with an equals sign: `--prompt='- item'`.
- Unquoted words in a prompt that equal a command name or alias (`doctor`, `auth`, `task`) are read as that command. Quote the whole prompt.
- The `secrets` and `cluster` helpers read the word after any `--flag` as its value, so put flags after the positional arguments.
- After any command word an option the command does not take (`run --max-turn 3`, `run --timout=5m`, `secrets set K v --plaintxt`) is refused with exit `2` instead of being ignored, and the error lists the options that command accepts. Commands with options of their own (`secrets`, `auth`, `pair` and the like) declare them in the one command table and receive them unchanged.
- A lone first word of five or more letters that is a command with two neighbouring letters swapped or one letter doubled (`goodvibes stauts`, `goodvibes modles`) is refused as a mistyped command, exit code `2`, and the error names the command. To start with that word as the first prompt, put `--` before it: `goodvibes -- stauts`. Any other lone word (`goodvibes hello`, `goodvibes fix`, `goodvibes frobnicate`) starts the app with it as the first prompt; when it is one or two letters from a command a warning names that command.

## Meta

### `--help`, `-h`

Print usage information and exit.

### `--version`, `-v`

Print the version string and exit.

## Protocol commands

### `goodvibes acp`

Runs GoodVibes as an [Agent Client Protocol](../../../packages/engine/docs/acp-agent.md) agent on stdin/stdout, for editors that launch an agent server (Zed and others). It takes no flags. Stdout carries only protocol frames; anything meant for a person (including a missing ACP library, exit `1`) is one line on stderr. It exits `0` when the editor closes stdin or the process receives SIGINT/SIGTERM, and `2` for an unexpected argument. `GOODVIBES_HOME` selects the home directory for the embedded sessions, as in the engine reference.

Editor launch line (Zed `agent_servers` entry, or any ACP client that takes a command and arguments):

```json
{ "agent_servers": { "GoodVibes": { "command": "goodvibes", "args": ["acp"] } } }
```

Unsupported capabilities are reported as such in `initialize`: `loadSession` is `false` (no session restore over ACP) and prompt input is text only. Editor threads share the one embedded daemon of the home directory (a thread whose working directory lies outside the daemon's gets its own); `session/close` ends a thread and the daemon stops once no thread uses it.

`/remote dispatch` and the `delegate` tool start this same command as their subagent. `ACP_AGENT_CMD` replaces it; give it as a JSON array of program and arguments (`["/path/to/agent","acp"]`) so a path with a space survives. `/remote env` prints that form.

To expose the operator surface to an MCP client instead, use `goodvibes-daemon mcp serve` (see the [daemon command reference](../../daemon/docs/commands-reference.md#mcp)).

### `goodvibes open <link>`

Starts the app and opens the view a `goodvibes://open/<view>[?target=<id>[:<kind>]]` link names, the same link `/deeplink open` and `/startup link` use. In a process view (agents, tasks, orchestration) the target selects that process; another view opens and says the target was not used. The transcript's first line says what was opened. A missing or unparsable link prints the expected form on stderr and exits `2`. Registering the `goodvibes://` scheme with the operating system, so a click in another program runs this command, is left to the installer.

## Argument terminator

`--` stops flag parsing. All subsequent tokens are passed through as positional arguments or subcommand arguments.

```sh
goodvibes run -- --flag-for-subprocess
```

## Command-specific flags

These apply to one command only, not globally.

### `--timeout <duration>` (`run` only)

Cancel the run when it takes longer than this. A bare number is seconds; `ms`, `s`, `m` and `h` suffixes are accepted (`90`, `90s`, `5m`, `1h`). The run is cancelled exactly as Ctrl-C would cancel it, then exits with code `124` and `stopReason` `timeout`.

### `--max-turns <n>` (`run` only)

Stop once the model has answered `n` times in this run's own turn loop and still asks for tools. Agents the run delegates to, and helper models, answer on their own and do not count against `n`; their cost still appears in `usage`. The run exits with code `1` and `stopReason` `max_turns`; tools the model asked for in its last response are not run.

### `--answer-permissions` (`run` only)

With `--output stream-json`, a script answers the owner prompts the run raises. Each one is written as a `PERMISSION_PROMPT` frame; answer with a line on stdin, `{"type":"PERMISSION_ANSWER","callId":"<callId>","approved":true}` (optional `remember`, and `note` for a refusal). Every answer line is acknowledged with a `PERMISSION_ANSWERED` frame, or a `PERMISSION_ANSWER_REJECTED` frame naming the reason and the call ids still waiting. A call that is never answered is refused when stdin ends, the run is cancelled or the run finishes. Without the flag, a call that needs the owner is refused. Using it with another output format is a usage error (exit `2`).

### `--omit-accumulated` (`run` only)

With `--output stream-json`, leave `accumulated` (the whole response so far) out of `STREAM_DELTA` frames, so each frame carries only its new `content`. Without it, frames keep `accumulated`.

```sh
goodvibes run --output stream-json --omit-accumulated --timeout 10m --max-turns 20 'fix the failing test'
```

### `--intake-status`, `--intake-retry`, `--intake-resume`, `--intake-cancel` (`run` only)

Inspect or recover an input that was captured for native daemon admission but whose outcome is not settled. They take no value and no prompt: recovery always reuses the exact saved input. Use exactly one.

| Flag | Effect |
| --- | --- |
| `--intake-status` | Read-only. Prints the saved input's server state; exits `0` when the host has a record of it. |
| `--intake-retry` | Request admission again for the same saved input. |
| `--intake-resume` | Explicit recovery of an input the host reports as processing. |
| `--intake-cancel` | Cancel the saved input (or its admitted work) on the host. |

```sh
goodvibes run --intake-status --output json
goodvibes run --intake-retry
```

Messages that would name a slash command inside the TUI (`/work intake-status`) name these flags in `run` output instead.

### `--strict` (`doctor` only)

Also fail on advisory findings, for CI. Without it, `doctor` exits non-zero only for a must-fix finding.

```sh
goodvibes doctor --strict
```

### `--password <value>`, `--password-stdin`, `--role <role>` (`auth add-user` / `auth rotate-password` only)

Set the new user's password inline, or read it from stdin (`--password-stdin`) instead of putting it on the command line. Falls back to the `GOODVIBES_AUTH_PASSWORD` environment variable when neither is given. `--role` assigns a role and may be repeated; `auth add-user` defaults to the `user` role when none is given. `auth rotate-password` takes `--password`/`--password-stdin` but not `--role`.

```sh
goodvibes auth add-user alice --password-stdin --role admin
goodvibes auth rotate-password alice --password-stdin
```

`auth` runs in its own short-lived process and writes the user store. A running daemon or TUI re-reads the user file at its next sign-in or session check, so a deleted user or rotated password takes effect there within a few seconds and ends that user's sessions, with no restart; a write the host makes meanwhile keeps the change instead of undoing it. Sessions live in memory in the running daemon: `auth sessions`, `auth revoke-session` and `auth revoke-sessions` ask the daemon on this machine (its loopback address, this machine's operator token) and act on its sessions at once.

## Headless `run`

`goodvibes run` (alias `exec`, or `--prompt`/`--print` with no command) runs one turn without the terminal UI and exits.

### Crash recovery

Every `run` writes its session's crash snapshot at the same moments the TUI does: when the prompt is accepted and after batches of tool calls, at most once every five seconds. That is one atomic write (temp file and rename) of the whole conversation each time, the size of the session's messages as JSON lines; the first one also records the session as the last one, so `--continue` reaches a run that was killed. When the run's session is saved at the end, the snapshot is removed. While the run has its session open it holds the session's lock, the same one an open terminal holds; the operating system releases it if the run is killed.

`run --continue`, `run --resume [id]` or `run --session <id>` on a session with a crash snapshot newer than its saved copy restores the snapshot before the first request, without asking (the flag is the ask). The new prompt then continues from the recovered conversation; the interrupted turn is not run again:

- its prompt is kept and marked cancelled, as Esc marks a cancelled prompt;
- the tool results it had already obtained are kept as they were;
- a reply that was still arriving when the run stopped keeps its text, followed by a line saying it was cut off and is incomplete; it is never presented as a finished reply (each snapshot records the moment it was taken and whether a reply was still arriving);
- a tool call the model had made whose result never reached disk gets a result that says it was interrupted and that its effect is unknown (outcome `cancelled`), never a success.

A session another running copy has open (a terminal app, or another run) is refused before anything is sent (before the runtime starts and before any `--intake-*` recovery reaches the host): exit `1`, `stopReason` `session-open-elsewhere`, and a `refusal` field (`code` `SESSION_OPEN_ELSEWHERE`, `state`, `reason`, `next`); in text mode the refusal is printed on stderr. Close the session there and run again, or run without the flag. A run takes the session's lock before it loads it, so two runs started at once cannot both write it. A session killed before its first save has only the snapshot, and resuming it restores that. If the snapshot cannot be applied, the run continues from the saved copy and says why (a session with no saved copy fails with that reason instead). A snapshot whose session another running terminal has open is that terminal's live state and is left alone. A run without one of these flags restores nothing and offers nothing; a snapshot nobody resumes is removed by the retention sweep after `atRest.retentionMaxAgeDays` (30 days by default), with the other crash snapshots.

The run says what it recovered: in text mode one `[Recovery]` line on stderr before the answer, in `stream-json` a `SESSION_RECOVERED` frame before the first model frame, and in both JSON formats the final frame's `recovery` field. Exit codes do not change.

### Exit codes

All programs in one table: [Exit codes](../../../docs/exit-codes.md).

| Code | Meaning |
| --- | --- |
| `0` | Completed. |
| `1` | Failed: model or provider error, empty response, delegated work failed, `--max-turns` reached, or the native host is unavailable or refused the input. Nothing further is pending. |
| `2` | Invalid input: a usage error, a missing prompt, or a prompt given with a recovery flag. |
| `3` | Outcome unknown: a native input may have taken effect on the host. Inspect with `run --intake-status` before retrying. |
| `124` | `--timeout` reached; the run was cancelled. |
| `130` | Cancelled (Ctrl-C, SIGTERM, or the saved input was cancelled). |

The GitHub Action passes `--timeout 30m --max-turns 50` to a prompt run unless its `timeout` and `max-turns` inputs say otherwise, and exposes the exit code, `stopReason` and a file with the run's output as step outputs ([GitHub Action](github-action.md)).

### Final frame

`json` prints this object; `stream-json` prints it last with `type` set to `TURN_RESULT` (or `NATIVE_INTAKE_RESULT` when the run went through native intake).

| Field | Always | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Frame shape version, currently `1`. |
| `ok` | yes | `true` exactly when the exit code is `0`. |
| `response` | yes | The answer, or the native status message. |
| `stopReason` | yes | Why the run ended. Model turn: `completed`, `empty_response`, `max_turns`, `timeout`, `cancelled` (Ctrl-C, SIGTERM, or work the run delegated was cancelled by the run itself), `contract-failed` or `agent-failed` (delegated work ended without a result; `error` says why), `awaiting-owner` (delegated work stopped for an owner decision: open the session interactively, answer it, and the work continues), `preflight_failed` or `context_overflow` (the turn was refused before it started: an equivalent turn already in flight, or a conversation too large for the model's context window; exit `1`, `error` says why), `turn-unsettled` (the turn ended without a final event), `session-open-elsewhere` (the session to resume is open in another running copy; see Crash recovery), `invalid-input`. Native intake: `native-<kind>` for the recorded outcome (for example `native-turn`, `native-work`, `native-blocked`, `native-refused`, `native-cancelled`), `native-unknown`, `native-unavailable`. |
| `sessionId` | yes | The conversation session, or `null` when no model turn ran. |
| `usage` | yes | `{ modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdCents? }` summed over the run, or `null` when no model turn ran. `costUsdCents` is present only when every response was priced. |
| `error` | no | What went wrong. |
| `model`, `provider`, `events` | no | Present when a model turn ran. |
| `kind` | no | On failures: `outcome-unknown` (the host may have acted) or `unavailable` (nothing was sent). |
| `cause` | no | With `kind`, a non-secret reason code: `journal_conflict`, `journal`, `principal`, `network`, `schema`, `host_changed`, `unknown`. |
| `native` | no | The native intake state: `status`, `message`, `request`, `result`, `execution`; `nextStep` (`retry`, `resume`, `cancel` or `inspect`: run `--intake-<nextStep>`, with `inspect` meaning `--intake-status`) when an earlier input must be moved forward first; `notSent: true` when this run's own text was not sent because of that earlier input; `hostedTurn` (`state`, `sessionId`, and on `failed` a `failure` with `summary` and `retryable`) when the host runs the reply. |
| `refusal` | no | Present when the run was refused before it started: `code`, `state`, `reason`, `next`. |
| `recovery` | no | Present when the run restored its session from a crash snapshot: `sessionId`, `applied`, `refusal` (when not applied: `no-snapshot`, `unusable-snapshot`, `apply-failed`), `snapshotAt` (ISO time the snapshot was written), `snapshotKept` (still on disk), `messages`, `turns` (prompts), `interruptedTurn` (`prompt` masked and cut at 1000 characters, `toolResults` already obtained, `interruptedToolCalls` as `{ callId, tool }`, `partialReply` when a reply was cut off), `lost` (what could not be brought back, one sentence each). |
| `diagnostics` | no | Present when no decision model was in use: `decisionModel` with `inUse: false`, `policy`, `reason` (`not-set`, `selected` for No Decision Model, or `unavailable`), `line` (the sentence also printed on stderr) and, when the set model was failing, `failure` (`model`, `what`, `nextStep`). The exit code is what the work earned; a run that finished without the decision model still exits `0`. |

### Stream frames

Every `stream-json` line carries `schemaVersion` and `type`. Consumers should ignore types they do not know.

| `type` | Fields | When |
| --- | --- | --- |
| `STREAM_DELTA` | `content`, `accumulated` (omitted with `--omit-accumulated`) | Each chunk of model output. |
| `DRAFT_WITHDRAWN` | `reason` | The completion check sent back the answer streamed so far. Drop that text; the replacement streams from empty. |
| `TOOL_EXECUTING` | `turnId`, `callId`, `tool` | A tool call starts. |
| `TOOL_SUCCEEDED` | `turnId`, `callId`, `tool`, `durationMs` | It finished. |
| `TOOL_FAILED` | `turnId`, `callId`, `tool`, `durationMs`, `error` | It failed. |
| `TOOL_CANCELLED` | `turnId`, `callId`, `tool`, `reason` | It was cancelled. |
| `PERMISSION_REQUESTED` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `ownerPrompt` | A tool call reached the permission gate. Sent when the gate reports its decision, so nothing waits behind it; `ownerPrompt` says whether the owner was asked. |
| `PERMISSION_DECIDED` | `callId`, `tool`, `category`, `approved`, `source`, `reasonCode`, `ownerPrompt` | The gate decided it. `ownerPrompt` is `true` when the owner was asked, `false` when a rule, preset or remembered approval decided. |
| `PERMISSION_PROMPT` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `answer` | With `--answer-permissions`: the owner is being asked; the run waits for a `PERMISSION_ANSWER` line on stdin. |
| `PERMISSION_ANSWERED` | `callId`, `approved` | A `PERMISSION_ANSWER` line was accepted for that call. |
| `PERMISSION_ANSWER_REJECTED` | `callId` (when it was a string), `reason`, `waiting` | A `PERMISSION_ANSWER` line was not used: `reason` says why, `waiting` lists the call ids still waiting. |
| `AGENT_SPAWNING`, `AGENT_RUNNING` | `agentId`, `taskId`, `parentAgentId`, `contractId`, `contractRole` | A delegated agent starts. |
| `AGENT_COMPLETED`, `AGENT_FAILED`, `AGENT_CANCELLED` | `agentId`, `taskId`; `durationMs` and `toolCallsMade`, `error` or `reason` | It ended. |
| `CONTRACT_CREATED`, `CONTRACT_STATUS_CHANGED` | `contractId`; `sessionId`, `origin`, `ownerAgentId` or `from`, `to` | Delegated work was set up or moved. |
| `CONTRACT_ESCALATED` | `contractId`, `escalationId`, `scope`, `targetId`, `reason`, `question` | The contract is waiting on its owner. |
| `CONTRACT_PASSED`, `CONTRACT_FAILED`, `CONTRACT_CANCELLED` | `contractId`; `criteriaMet`, `criteriaJudged`, or `reason` and `failureKind` | It ended. |
| `USAGE` | `turnId`, `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsdCents` | Each model response. |
| `SESSION_RECOVERED` | the `recovery` fields of the final frame | The resumed session was restored from a crash snapshot, before the first request. |

Tool arguments are never included, and neither are agent task text, agent output or the contract's ask. Fields shown that are optional are omitted when unknown.

`PERMISSION_REQUESTED` is sent for every tool call that reaches the permission gate, not only the ones that ask someone; `ownerPrompt` on it and on `PERMISSION_DECIDED` is `true` when the owner was asked and `false` when a rule, preset or remembered approval decided. The turn runs in the `run` process itself, so these frames are always the turn's own.
