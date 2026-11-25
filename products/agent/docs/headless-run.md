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
| `--answer-permissions` | With `--output stream-json`, a script answers the owner prompts the run raises (see below). Without it a call that needs the owner is held for him: one the daemon can run waits in Waiting for you (see below), any other is not run. |
| `--prompt-file <path>` | Read the prompt from a file (a relative path is read from the working folder); `--prompt-file -` reads all of standard input (`cat task.md \| goodvibes-agent run --prompt-file -`). A prompt also given as text, an unreadable file, or `-` together with `--answer-permissions` (both read standard input) is a usage error, exit `2`. |
| `--intake-status` | Read-only: print the server state of the saved input; exit `0` when the host has a record of it. |
| `--intake-retry` | Request admission again for the same saved input. |
| `--intake-resume` | Explicit recovery of an input the host reports as processing. |
| `--intake-cancel` | Cancel the saved input, or the work admitted from it, on the host. |
| `--continue`, `--resume [id]`, `--session <id>` | Continue the last session, or the named one, instead of a new one; fails when there is none. A crash snapshot newer than its saved copy is restored first (see below). |

The `--intake-*` flags take no value and no prompt (recovery reuses the exact saved input); use one at a time. `--timeout`, `--max-turns`, `--omit-accumulated`, `--answer-permissions` and `--prompt-file` apply only to `run`. Status messages that would name a workspace slash command (`/work intake`) name these flags instead.

Parser limits to know about:

- A flag that takes a value refuses a value that begins with `-`. Use the long form with an equals sign: `--prompt='- item'`.
- Unquoted words in a prompt that equal a command name or alias (`doctor`, `auth`, `task`) are read as that command. Quote the whole prompt.
- In the `secrets` helper (and the daemon's `cluster`) a flag that takes no value (`--user`, `--plaintext`, `--stdin`; `--json`, `--yes`) never takes the next word, so it may go before or after the positional arguments.
- After any command word an option the command does not take (`run --max-turn 3`, `run --timout=5m`, `secrets set K v --plaintxt`) is refused with exit `2` instead of being ignored, and the error lists the options that command accepts. Commands with options of their own (`secrets`, `auth`, `pair` and the like) declare them in the one command table and receive them unchanged.
- A lone first word of five or more letters that is a command with two neighbouring letters swapped or one letter doubled (`goodvibes-agent stauts`, `goodvibes-agent modles`) is refused as a mistyped command, exit code `2`, and the error names the command. To start with that word as the first prompt, put `--` before it: `goodvibes-agent -- stauts`. Any other lone word (`goodvibes-agent hello`, `goodvibes-agent fix`) starts the Agent with it as the first prompt; when it is one or two letters from a command a warning names that command.

## Crash recovery

Every `run` writes its session's crash snapshot at the same moments the workspace does: when the prompt is accepted and after batches of tool calls, at most once every five seconds. That is one atomic write (temp file and rename) of the whole conversation each time, the size of the session's messages as JSON lines; the first one also records the session as the last one, so `--continue` reaches a run that was killed. When the run's session is saved at the end, the snapshot is removed. While the run has its session open it holds the session's lock, the same one an open workspace holds; the operating system releases it if the run is killed.

`run --continue`, `--resume [id]` or `--session <id>` on a session with a crash snapshot newer than its saved copy restores the snapshot before the first request, without asking (the flag is the ask). The new prompt then continues from the recovered conversation; the interrupted turn is not run again:

- its prompt is kept and marked cancelled, as Esc marks a cancelled prompt;
- the tool results it had already obtained are kept as they were;
- a reply that was still arriving when the run stopped keeps its text, followed by a line saying it was cut off and is incomplete; it is never presented as a finished reply (each snapshot records the moment it was taken and whether a reply was still arriving);
- a tool call the model had made whose result never reached disk gets a result that says it was interrupted and that its effect is unknown (outcome `cancelled`), never a success.

A session another running copy has open (a workspace or the TUI, or another run) is refused before anything is sent, before the prompt goes to native intake, so the host records no input for it: exit `1`, `stopReason` `session-open-elsewhere`, and a `refusal` field (`code` `SESSION_OPEN_ELSEWHERE`, `state`, `reason`, `next`); in text mode the refusal is printed on stderr. Close the session there and run again, or run without the flag. A run takes the session's lock before it loads it, so two runs started at once cannot both write it. A session killed before its first save has only the snapshot, and resuming it restores that. If the snapshot cannot be applied, the run continues from the saved copy and says why (a session with no saved copy fails with that reason instead). A snapshot whose session another running workspace has open is that workspace's live state and is left alone. A run without one of these flags restores nothing and offers nothing; a snapshot nobody resumes is removed by the retention sweep after `atRest.retentionMaxAgeDays` (30 days by default), with the other crash snapshots.

The run says what it recovered: in text mode one `[Recovery]` line on stderr before the answer, in `stream-json` a `SESSION_RECOVERED` frame before the first model frame, and in both JSON formats the final frame's `recovery` field. Exit codes do not change.

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
| `native` | no | The intake state: `status`, `message`, `request`, `result`, `execution`; `nextStep` (`retry`, `resume`, `cancel` or `inspect`: run `--intake-<nextStep>`, with `inspect` meaning `--intake-status`) when an earlier input must be moved forward first; `notSent: true` when this run's own text was not sent because of that earlier input; `hostedTurn` (`state`, `sessionId`, and on `failed` a `failure` with `summary` and `retryable`) when the host runs the reply. |
| `refusal` | no | Present when the run was refused before it started (`stopReason` `session-open-elsewhere` or `session-not-found`): `code`, `state`, `reason`, `next`. |
| `recovery` | no | Present when the run restored its session from a crash snapshot: `sessionId`, `applied`, `refusal` (when not applied), `snapshotAt`, `snapshotKept`, `messages`, `turns`, `interruptedTurn` (`prompt` masked and cut at 1000 characters, `toolResults`, `interruptedToolCalls` as `{ callId, tool }`, `partialReply`), `lost`. |
| `diagnostics` | no | Present when no decision model was in use: `decisionModel` with `inUse: false`, `policy` (the stored "If Jev can't answer" value: `Hybrid` for Ask me, `Decision Model Only` for Refuse the action), `reason` (`not-set` or `unavailable`), `line` (the sentence also printed on stderr) and, when the set model was failing, `failure` (`model`, `what`, `nextStep`). The exit code is what the work earned; a run that finished without the decision model still exits `0`. |

### Stream frames

| `type` | Fields |
| --- | --- |
| `SESSION` | `sessionId`, `model`, `provider`, `workingDirectory`, `version` (the GoodVibes version), `permissionMode` (the mode in force), `chosenMode` (the mode chosen in settings), `modeReason` (one sentence, only when the two differ): the first frame of a run that reached a session, before the first request |
| `PERMISSION_MODE_CHANGED` | `permissionMode`, `previousMode`, `chosenMode`, `modeReason` (when the new mode in force is not the chosen one): the mode in force changed during the run (a setting changed, or the decision model stopped or started answering) |
| `STREAM_DELTA` | `content`, `accumulated` (unless `--omit-accumulated`) |
| `DRAFT_WITHDRAWN` | `reason`: the answer streamed so far was withdrawn (the turn moved to another model after it had begun); drop that text, the replacement streams from empty |
| `TOOL_EXECUTING`, `TOOL_SUCCEEDED`, `TOOL_FAILED`, `TOOL_CANCELLED` | `turnId`, `callId`, `tool`; plus `durationMs`, `error` or `reason` |
| `PERMISSION_REQUESTED` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `ownerPrompt` (one per gated tool call, written when its decision is known) |
| `PERMISSION_DECIDED` | `callId`, `tool`, `category`, `approved`, `source`, `reasonCode`, `reason` (why: Jev's reason when Jev decided, the explanation on a refusal), `ownerPrompt` (follows its request) |
| `PERMISSION_PROMPT` | `callId`, `tool`, `category`, `riskLevel`, `summary`, `lines`, `answer` (only with `--answer-permissions`; the run waits for the answer). For a capability (`capability_run`) `summary` is the capability's own question ("Keep this computer awake?") and `lines` its sentence, then each input on a labelled line ("What it does: tidy the inbox"), a secret one hidden; `lines` is left out for a call its tool does not word itself |
| `PERMISSION_ANSWERED` | `callId`, `approved` (an answer line was accepted) |
| `PERMISSION_ANSWER_REJECTED` | `callId` (when it was a string), `reason`, `waiting` (an answer line was not used, and which call ids still wait) |
| `AGENT_SPAWNING`, `AGENT_RUNNING` | `agentId`, `taskId`, `parentAgentId`, `contractId`, `contractRole` |
| `AGENT_COMPLETED`, `AGENT_FAILED`, `AGENT_CANCELLED` | `agentId`, `taskId`; plus `durationMs` and `toolCallsMade`, `error` or `reason` |
| `CONTRACT_CREATED`, `CONTRACT_STATUS_CHANGED` | `contractId`; `sessionId`, `origin`, `ownerAgentId` or `from`, `to` |
| `CONTRACT_ESCALATED` | `contractId`, `escalationId`, `scope`, `targetId`, `reason`, `question` (the contract is waiting on its owner) |
| `CONTRACT_PASSED`, `CONTRACT_FAILED`, `CONTRACT_CANCELLED` | `contractId`; plus `criteriaMet`, `criteriaJudged`, or `reason` and `failureKind` |
| `USAGE` | `turnId`, `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsdCents` |
| `SESSION_RECOVERED` | the `recovery` fields of the final frame (written before the first request) |

Tool arguments are never included, and neither are agent task text, agent output or the contract's ask: those can hold file contents or credentials.

### Answering permission prompts

Pass `--answer-permissions` with `--output stream-json`. For each call the gate wants the owner for, the run writes a `PERMISSION_PROMPT` frame and waits. Answer on stdin with one line of JSON:

```json
{"type":"PERMISSION_ANSWER","callId":"<callId from the frame>","approved":true}
```

`remember` (boolean) and `note` (text the model sees when you refuse) are optional. Each `PERMISSION_ANSWER` line gets a `PERMISSION_ANSWERED` frame when it is used, or a `PERMISSION_ANSWER_REJECTED` frame with the reason (approved not a boolean, no prompt waiting for that call id) and the call ids still waiting. Lines that are not a `PERMISSION_ANSWER` are ignored, so other input can share the pipe. A call that is never answered is refused, never approved: when stdin ends, when the run is cancelled (Ctrl-C, `--timeout`) or when the run finishes. The refusal names the call and says nothing ran. `PERMISSION_DECIDED` then reports the outcome with `ownerPrompt: true`. The script is the one place each question is asked: it is not put in the daemon's approvals as well, and that holds for every question the run's calls raise, a method the daemon would otherwise decide itself (a schedule, a channel route or draft, a profile fact) included: the run asks the script and sends the call saying so, and the daemon asks nobody again. No time limit decides a question: a call waiting on one waits until it is answered or the run ends (`--timeout` ends the run).

Without `--answer-permissions` nobody in the run can answer, so a call that needs the owner is held for him. A capability the daemon runs (`capability_run` of one of its capabilities) is handed to the daemon, which puts it to him once in Waiting for you, worded as the capability (its label, its sentence, each input on its own line, a secret one hidden), and runs it when he approves it. The run's `PERMISSION_DECIDED` frame has `approved: false`, `reasonCode` `mode_queued_for_owner` and a `reason` that says the call is held and names the approval, for example `held for you: Keep this computer awake is waiting for the owner: nothing ran yet. It is in Waiting for you as approval approval-0878e76d, ...`. Any other call (a command, a file write) can only run inside this run, which goes on without it.

`PERMISSION_REQUESTED` is sent for every tool call that reaches the permission gate, not only the ones that ask someone. It is sent when the gate reports its decision, so no call is ever left waiting behind it. `ownerPrompt` is `true` when the owner was asked to answer that call, and `false` when a rule, preset or remembered approval decided it. Both frames carry the same value; it is absent only on a request the gate never decided.

The turn runs in the process of the `run` command (a fresh runtime that exists only for this invocation), so its tool, permission and usage frames are always the turn's own. A conversation that an interactive Agent session hosts on the daemon is not driven by `run`, and its frames are not part of this stream.

## Exit codes

One table for all programs, including where the same number means something else: [Exit codes](../../../docs/exit-codes.md).

| Code | Meaning |
| --- | --- |
| `0` | Completed, or admitted work was recorded with its execution state. |
| `1` | Failed: model or provider error, empty response, `--max-turns` reached, or the host is unavailable, blocked or refused the input. |
| `2` | Invalid input: a usage error, a missing prompt, or a prompt given with a recovery flag. A usage error prints the error and the command's one usage line on stderr, not the whole help; with `--output json` or `stream-json` it is the run's final frame on stdout instead (`ok` `false`, `stopReason` `invalid-input`, `error` the message). A `-c key=value` the settings refuse names the key and the nearest setting, or what the setting takes. |
| `3` | Outcome unknown: the input may have taken effect on the host. Run `goodvibes-agent run --intake-status` before retrying. |
| `124` | `--timeout` reached; the run was cancelled. |
| `130` | Cancelled (Ctrl-C, SIGTERM, or the saved input was cancelled). |
