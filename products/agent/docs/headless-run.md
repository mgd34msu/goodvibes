# Headless run

`goodvibes-agent run "<prompt>"` (alias `exec`) runs one input without the workspace and exits. The prompt is captured exactly and sent through native admission on the connected host; when the host decides it is a conversation turn, the turn runs and its answer is printed. Use `--` before prompt text that starts with a dash.

```sh
goodvibes-agent run "summarize the current project"
goodvibes-agent run --output json "list risks"
goodvibes-agent exec --output stream-json --omit-accumulated --timeout 10m "check runtime status"
```

## Flags

| Flag | Effect |
| --- | --- |
| `--output text\|json\|stream-json`, `-o` | Output shape (see below). `--json` is shorthand for `--output json`. |
| `--timeout <duration>` | Cancel the run when it takes longer than this, as Ctrl-C would, and exit `124`. A bare number is seconds; `ms`, `s`, `m` and `h` suffixes are accepted. |
| `--max-turns <n>` | Stop once the model has answered `n` times in this run's own turn loop and still asks for tools; exit `1` with `stopReason` `max_turns`. Agents the run delegates to, and helper models, answer on their own and do not count against `n` (their cost still appears in `usage`). Tools from that last response are not run. |
| `--omit-accumulated` | With `stream-json`, leave `accumulated` (the whole response so far) out of `STREAM_DELTA` frames. |
| `--answer-permissions` | With `--output stream-json`, a script answers the owner prompts the run raises (see below). Without it a call that needs the owner is refused. |
| `--intake-status` | Read-only: print the server state of the saved input; exit `0` when the host has a record of it. |
| `--intake-retry` | Request admission again for the same saved input. |
| `--intake-resume` | Explicit recovery of an input the host reports as processing. |
| `--intake-cancel` | Cancel the saved input, or the work admitted from it, on the host. |

The `--intake-*` flags take no value and no prompt (recovery reuses the exact saved input); use one at a time. `--timeout`, `--max-turns`, `--omit-accumulated` and `--answer-permissions` apply only to `run`. Status messages that would name a workspace slash command (`/work intake-status`) name these flags instead.

Parser limits to know about:

- A flag that takes a value refuses a value that begins with `-`. Use the long form with an equals sign: `--prompt='- item'`.
- Unquoted words in a prompt that equal a command name or alias (`doctor`, `auth`, `task`) are read as that command. Quote the whole prompt.
- The `secrets` and `cluster` helpers read the word after any `--flag` as its value, so put flags after the positional arguments.
- After `run`, `status`, `help`, `completion` and the other commands that take only these global flags, an option the parser does not know (`--max-turn`, `--timout=5m`) is refused with exit `2` instead of being ignored. Commands with options of their own (`secrets`, `auth`, `sessions` and the like) read those options themselves.
- A lone first word one or two letters away from a command (`goodvibes-agent staus`) is refused as a mistyped command and the error names the command it is close to. To start with that word as the first prompt, put `--` before it: `goodvibes-agent -- staus`.

## Output

- `text`: the answer on stdout. Errors, and the status message of a run that never reached the model, go to stderr.
- `json`: one JSON object on one line, the final frame.
- `stream-json`: newline-delimited frames as they happen, then the final frame with `type` `NATIVE_INTAKE_RESULT`.

Every frame carries `schemaVersion` (currently `1`). Consumers should ignore frame types and fields they do not know.

### Final frame

| Field | Always | Meaning |
| --- | --- | --- |
| `schemaVersion`, `ok`, `response`, `stopReason` | yes | `ok` is `true` exactly when the exit code is `0`. |
| `sessionId` | yes | The conversation session, or `null` when no model turn ran. |
| `usage` | yes | `{ modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdCents? }` for the run, or `null` when no model turn ran. |
| `error`, `model`, `provider`, `events` | no | Present when known. |
| `kind` | no | On failures: `outcome-unknown` (the host may have acted) or `unavailable` (nothing was sent). |
| `cause` | no | With `kind`: `journal_conflict`, `journal`, `principal`, `network`, `schema`, `host_changed` or `unknown`. |
| `native` | no | The intake state: `status`, `message`, `request`, `result`, `execution`. |

### Stream frames

| `type` | Fields |
| --- | --- |
| `STREAM_DELTA` | `content`, `accumulated` (unless `--omit-accumulated`) |
| `TOOL_EXECUTING`, `TOOL_SUCCEEDED`, `TOOL_FAILED`, `TOOL_CANCELLED` | `turnId`, `callId`, `tool`; plus `durationMs`, `error` or `reason` |
| `PERMISSION_REQUESTED` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `ownerPrompt` (one per gated tool call, written when its decision is known) |
| `PERMISSION_DECIDED` | `callId`, `tool`, `category`, `approved`, `source`, `reasonCode`, `ownerPrompt` (follows its request) |
| `PERMISSION_PROMPT` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `answer` (only with `--answer-permissions`; the run waits for the answer) |
| `PERMISSION_ANSWERED` | `callId`, `approved` (an answer line was accepted) |
| `PERMISSION_ANSWER_REJECTED` | `callId` (when it was a string), `reason`, `waiting` (an answer line was not used, and which call ids still wait) |
| `AGENT_SPAWNING`, `AGENT_RUNNING` | `agentId`, `taskId`, `parentAgentId`, `contractId`, `contractRole` |
| `AGENT_COMPLETED`, `AGENT_FAILED`, `AGENT_CANCELLED` | `agentId`, `taskId`; plus `durationMs` and `toolCallsMade`, `error` or `reason` |
| `CONTRACT_CREATED`, `CONTRACT_STATUS_CHANGED` | `contractId`; `sessionId`, `origin`, `ownerAgentId` or `from`, `to` |
| `CONTRACT_ESCALATED` | `contractId`, `escalationId`, `scope`, `targetId`, `reason`, `question` (the contract is waiting on its owner) |
| `CONTRACT_PASSED`, `CONTRACT_FAILED`, `CONTRACT_CANCELLED` | `contractId`; plus `criteriaMet`, `criteriaJudged`, or `reason` and `failureKind` |
| `USAGE` | `turnId`, `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsdCents` |

Tool arguments are never included, and neither are agent task text, agent output or the contract's ask: those can hold file contents or credentials.

### Answering permission prompts

Pass `--answer-permissions` with `--output stream-json`. For each call the gate wants the owner for, the run writes a `PERMISSION_PROMPT` frame and waits. Answer on stdin with one line of JSON:

```json
{"type":"PERMISSION_ANSWER","callId":"<callId from the frame>","approved":true}
```

`remember` (boolean) and `note` (text the model sees when you refuse) are optional. Each `PERMISSION_ANSWER` line gets a `PERMISSION_ANSWERED` frame when it is used, or a `PERMISSION_ANSWER_REJECTED` frame with the reason (approved not a boolean, no prompt waiting for that call id) and the call ids still waiting. Lines that are not a `PERMISSION_ANSWER` are ignored, so other input can share the pipe. A call that is never answered is refused, never approved: when stdin ends, when the run is cancelled (Ctrl-C, `--timeout`) or when the run finishes. The refusal names the call and says nothing ran. `PERMISSION_DECIDED` then reports the outcome with `ownerPrompt: true`.

`PERMISSION_REQUESTED` is sent for every tool call that reaches the permission gate, not only the ones that ask someone. It is sent when the gate reports its decision, so no call is ever left waiting behind it. `ownerPrompt` is `true` when the owner was asked to answer that call, and `false` when a rule, preset or remembered approval decided it. Both frames carry the same value; it is absent only on a request the gate never decided.

The turn runs in the process of the `run` command (a fresh runtime that exists only for this invocation), so its tool, permission and usage frames are always the turn's own. A conversation that an interactive Agent session hosts on the daemon is not driven by `run`, and its frames are not part of this stream.

## Exit codes

One table for all programs, including where the same number means something else: [Exit codes](../../../docs/exit-codes.md).

| Code | Meaning |
| --- | --- |
| `0` | Completed, or admitted work was recorded with its execution state. |
| `1` | Failed: model or provider error, empty response, `--max-turns` reached, or the host is unavailable, blocked or refused the input. |
| `2` | Invalid input: a usage error, a missing prompt, or a prompt given with a recovery flag. |
| `3` | Outcome unknown: the input may have taken effect on the host. Run `goodvibes-agent run --intake-status` before retrying. |
| `124` | `--timeout` reached; the run was cancelled. |
| `130` | Cancelled (Ctrl-C, SIGTERM, or the saved input was cancelled). |
