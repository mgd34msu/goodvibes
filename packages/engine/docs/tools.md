# Tool system

The tool system is the daemon-side execution layer used by sessions, agents,
contracts, and remote surfaces. Tools are registered through
`registerAllTools()` and guarded by config permissions plus feature-flagged
contract checks.

Accessible via `@goodvibes-jev/engine/platform/platform/tools` (daemon embedders). Consumer apps interact through sessions and operator methods.

For how tool-call arguments are parsed, validated, and dropped when malformed, see [Tool Safety](./tool-safety.md).

## What a model request carries

Every model request (the TUI, the Agent, worker agents, contract units, daemon hosted sessions and companion chat) carries the core tools in full: those whose definition says `core: true` (`read`, `find`, `edit`, `write`, `exec`, `fetch`, `agent`, `task`, `state`, `repl`, `web_search`). Every other registered tool is one line: its name, the first sentence of its description and `[parameters: tool_schema]`. The `tool_schema` tool returns the full definitions of the tools it names, and from the next request on those tools are sent in full. A call to a one-line tool that was not loaded is not run: its result is a refusal (`decision.state: refused`) that carries the tool's full definition and says to send the call again; the tool is sent in full from then on. Every call is checked against the tool's full schema either way.

A tool can name the modes with which it only reads (`readModes` on its definition). A call in one of those modes is classed as a read; any other mode is decided by the permission gate as a change. The Agent sets these for `remote`, `channel`, `mcp`, `control`, `task`, `team`, `worklist`, `packet` and `query`.

## Built-in tools

| Tool | Purpose | Main modes or operations |
|---|---|---|
| `read` | Read text, structured files, and media-aware inputs | per-file extraction, image handling, global extraction defaults; one response is capped at `output.max_tokens` (25,000 by default) and clipped files are listed in `summary.truncated` with the line to continue from; standard output leaves out each file's `resolvedPath` and `readObservation` (which lines were actually returned), which travel on the result's host-only `hostEvidence.reads` for evidence collection and are never shown to the model; `verbose` keeps them in the text |
| `write` | Write files with project/cache/undo integration | create, overwrite, append, transaction modes |
| `edit` | Apply targeted edits | exact, fuzzy, regex, notebook operations, validation, rollback; an edit to a file that changed since it was last read is refused until the file is read again |
| `find` | Search the workspace | files, content, symbols, references, structural AST search; files mode lists paths relative to the reported `root`; each query's page fits `output.max_tokens` (about 10,000 tokens by default) and continues with `next_offset`; a query still running at `timeout_ms` (60 s by default) reports `timed_out`; the product's worktree directory `.goodvibes/.worktrees` is skipped by default (by path, not by name) unless the task runs inside it, and the result's `warnings` say what was skipped and that `path: '.goodvibes/.worktrees'` includes it |
| `exec` | Run shell commands through the process manager | retries, timeouts, expectations, pre-command file ops, AST guard |
| `fetch` | Fetch HTTP resources | raw/text/markdown/structured extraction, rate limits, sanitization, trusted hosts; a call where every URL failed or every response was an HTTP error (`summary.http_errors`) is an unsuccessful call, and the per-URL results are still returned |
| `analyze` | Analyze code and changes | impact, dependencies, dead code, security, diff, preview, upgrade, surface; output over `output.max_tokens` (25,000 tokens by default) is cut with a note saying how much was kept |
| `inspect` | Inspect project shape | project, API, database, components, layout, accessibility, scaffold (a plan by default; with `dryRun: false` it creates new files only, through the write tool, so the call is asked about and recorded as a write and can be undone, and an agent without `write` is refused); `output.max_tokens` caps the response (25,000 tokens by default) |
| `agent` | Spawn and manage agents | spawn, batch-spawn for independent roots, status, cancel, list, templates, get, budget, plan, wait, message, contracts, contract-history, cohorts |
| `goodvibes_context` | Inspect the current GoodVibes harness safely | runtime summary, redacted config reads/schema, integrations, tool catalog, Cloudflare status/token requirements |
| `goodvibes_settings` | Change GoodVibes settings through the config manager | set, reset with explicit confirmation; rejects raw credential persistence |
| `profile` | Record what the owner says about themselves into the owner profile | registered only when profile collaborators are provided; write authority is bound per turn by the composition root, never supplied by the model |
| `repo_map` | Model-invoked repository outline | directory summary plus source files and their exports, ranked by import-graph centrality, unbounded unless a token budget is passed; no LLM and no process spawn |
| `context_accounting` | Let the model read its own context composition | recall-contract floors and exclusions, per-turn injection records; measured token counts reported as fact, estimates flagged as estimates; for a worker agent it reports that worker's turns used and left (warning at 80% of the limit) once the host binds the worker as its source |
| `state` | Store and inspect runtime state | get, set, list, clear, budget, context, memory (get, set, list, delete: delete removes the file and its retrieval record), telemetry, mode; `list` returns the key inventory unless `view=full`; `set` of `runtime.workingDir` must be sent alone; `hooks` and `analytics` only when the host provides them; `analytics` reads recorded calls (the model cannot record rows) and its export is size-capped; an added hook needs a unique name and lasts for the session only; `hooks` lists registered hooks, and adding, enabling, disabling or removing one is always put to the owner (never settled by a mode, a category or a remembered answer, and never remembered), refused in plan mode, and refused when the session cannot ask |
| `workflow` | Start and control workflows | start, status, transition, cancel, triggers, schedule |
| `registry` | Discover skills/agents/tools | search, recommend, dependencies, preview, content; files are read only from `.goodvibes/skills` and `.goodvibes/agents` of the project and the home directory, after `..` and symlinks are resolved, and an `@include` that leaves those directories is refused |
| `task` | Manage cross-session tasks | create, list, show, status, depend, cancel, handoff, handoffs, acknowledge, withdraw; the graph is shared by every terminal open in the project, and each change is seen by the others; a handoff blocks its task until the destination accepts it (`acknowledge`), the source takes it back (`withdraw`), or it expires after 30 days, and each of these returns the task to its earlier status; every result lists the handoffs waiting for the calling session |
| `team` | Keep durable team notes | create, list, show, add/remove member, set lanes, delete; a record for the model and the user to read back, it does not change how agents are spawned or communicate |
| `worklist` | Manage worklists | create, list, show, add, complete, reopen, remove |
| `mcp` | Inspect and operate MCP servers | servers, tools, schema, security, auth, quarantine/trust |
| `packet` | Manage context packets | create, list, show, revise, publish |
| `query` | Ask and answer structured questions | ask, list, show, answer, close |
| `remote` | Manage distributed runners | create-pool, pools, assign, unassign, contracts, artifacts, review, import-artifact |
| `repl` | Evaluate bounded code when an isolating backend is available | eval, history |
| `control` | Inspect host control data | commands, panels, subscriptions, sandbox presets |
| `channel` | Use channel-owned runtime tools | surface-specific tool bridge |
| `contract_self_check` | Read how a contract unit's acceptance criteria read now | read-only, no parameters; answers for the calling worker's own unit from the last check without ending its turn; it passes nothing and describes the last check, not work done since |
| `web_search` | Run provider-backed web search | query, safe-search, evidence fetching |

## Record status rules

Tools that manage a record with a status refuse a move the record's lifecycle
does not allow. The call returns `success: false` and the error text names the
current status and the moves that remain, for example
`query is closed, which is final; it cannot become answered`. See
[Lifecycles](./runtime-orchestration.md#lifecycles).

| Tool | Rule |
|---|---|
| `query` | A query is `open`, then `answered`, then `closed`. An answer can be revised with another `answer` until the query is closed. A closed query cannot be answered or closed again. |
| `packet` | A packet is published once. A second `publish` is refused and reports the original publish time. `revise` still works on a published packet and does not change its status. |
| `workflow` | `cancel` applies to a workflow that is still in progress. Cancelling a workflow that already finished or was already cancelled is refused with the reason, and its completion time is unchanged. |
| `task` | `create` never replaces an existing task ref; use `status` to move it. A handoff to a session this host does not know, or of a finished task, is refused. A handoff marks the task `blocked` until the destination session runs `acknowledge` with the handoff id, which returns the task to the status it had. |

## Captured Bun commands

Captured `exec` consumes its construction-owned ordinary Bun admission directly;
it does not need an earlier REPL call or validator. Source hosts admit their
interpreter, while compiled products use their packaged `.bun` sibling. Runtime
source, canonical path and captured alias permissions, executable identity and
owner/view lifetime are checked before execution and output delivery.

A missing or refused runtime leaves an explicit refusal at the captured Bun
alias. Shell and separately admitted Node commands remain available. A compiled
product executable and known OS Bun aliases cannot substitute for that admission.
No package download or interpreter-mode environment override is introduced.
Authorized project Bun configuration and preloads retain their normal behavior;
generated files publish only to the mutable member view through existing checks.

## Captured REPL evaluation

Captured contract/Agent views support one-shot JavaScript and TypeScript eval
through the existing Linux bubblewrap projection backend and trusted Bun runtime.
The normal tool admission and exec safety reading still apply. The backend checks
the live original-owner and captured-view authority before projection reads,
execution and result delivery. A supplied workspace path cannot change that binding.

Each call starts a fresh process. JSON bindings become named globals, and the
printed completion value and console output are returned in `result`. Variables
do not survive the call. Authorized file changes persist only in mutable member
views; immutable views remain unchanged. Results report `stateless`, `isolated`
and `workspace_changes_persist`. Network access and the ambient host environment
are unavailable. Evaluation stops after `timeout_ms` (120 seconds when omitted;
`0` waits for completion or cancellation) and has a 64 KiB command limit, in
addition to the captured executor's output and workspace limits. A snippet that
exits non-zero without error output is reported with its exit code; a cancelled
eval says it was cancelled.

Captured `history` returns `{ count, history }` for the exact construction-owned
run and authority in the current process. Entries retain the runtime, expression,
timestamp, per-attempt session ID, actual backend metadata and result/error.
Authorized runtime/safety refusals are recorded, but malformed/oversized input
and cancelled or revoked attempts are not. Timed-out attempts retain the timeout
error without partial output. History never opens or updates the ordinary host
history file and does not store bindings. Recreated registries can retain the
same run's history; new runs (including wake/steer) and resumed/rebound authorities start empty,
even at the same path. Each history read revalidates current owner/view authority
and the original bindings' cumulative source-read provenance before disclosure.

Retention is limited to 100 entries and 2 MiB of encoded entries per run.
Oldest entries are evicted, and an individual entry above that byte limit is
omitted rather than truncated. When entries have been omitted, the response also
reports `omitted`; `count` is the number retained. This is in-process history,
not durable history or shared interpreter state.

Python, SQL and GraphQL evaluation remain explicitly unavailable. Ordinary
live-tree REPL behavior is unchanged: its local backend does not isolate code,
so eval refuses and history continues to list attempts. Neither path falls back
to host evaluation.

## Registration requirements

`registerAllTools()` requires host-owned collaborators instead of implicitly
constructing global state. Required collaborators include file undo, mode
manager, process manager, agent manager, message bus, workflow services,
config manager, provider registry, tool LLM resolver, sandbox session registry,
session orchestration, working directory, and surface root.

Optional collaborators enable web search, MCP, the contract runner, remote runners, channel
tools, overflow handling, change tracking, service-backed credential
resolution, and secret-aware integration status.

## Runtime and settings awareness

The platform registers `goodvibes_context` and `goodvibes_settings` for all full
tool runtimes, including TUI turns, companion remote chat, Home Assistant
chat, ntfy remote chat, agents, and channel-backed surfaces.

`goodvibes_context` is read-oriented. It lets the model inspect:

- the host surface root, working directory, and daemon home directory
- the current provider/model and provider/model catalog size
- all config keys by key, category, or prefix, with schema metadata
- configured channel surfaces, service registry posture, and available channel
  tools
- registered tool names and descriptions
- Cloudflare status and token requirement guidance

Credential-like values are always redacted. Sensitive keys report only whether
a credential is configured and whether it is a `goodvibes://` secret reference
or another credential-like value.

`goodvibes_settings` is write-capable and permissioned as a write tool. It can
set or reset scalar config keys through `ConfigManager`, requires
`confirm: true`, and refuses raw token/secret/password values. Clients should
store credentials through the secret system and set config keys to
`goodvibes://` references.

Every platform-owned turn path adds a small harness-awareness system instruction
that tells the model to call `goodvibes_context` before answering questions
about local settings, configured integrations, host capabilities, tools,
providers, or surfaces. The same instruction tells the model not to start
agent work for ordinary questions or direct environment inspection.

The instruction also treats a configuration value the user states (a bot name,
chat id, token, host, port, model, or path) as a request to set it. The model
is told to call `goodvibes_settings` and report the key and the store it
persisted to, rather than merely repeating the value back in prose. When the
key or intent is unclear it asks one short question instead of writing config
nobody asked for, and setup-style requests are held to a setup-intent contract
that asks what the setup is for before acting literally.

## Contract verification

The `tools.contractVerification` setting is enabled by default, so built-in
and registered tools are verified at registration time. Hosts can disable the
flag explicitly, but the safer default is verification on.

See [Tool safety: tool contract verification](./tool-safety.md#tool-contract-verification)
for what the verifier checks (schema shape, permission class, timeout/cancellation
support, output policy, and idempotency metadata) and how error- versus
warning-level violations are handled.

## Permissions

Tool permissions are configured under `permissions.tools.*` and enforced by the
runtime permission layer. `permissions.mode` selects the execution mode
(`safe-owner` default, `safe-jev`, `yolo`, or `plan`), and each tool category has its own
key with a built-in default:

| Config key | Default | Covers |
|---|---|---|
| `permissions.tools.read` | `allow` | the read tool (find and analyze have their own keys) |
| `permissions.tools.write` | `prompt` | file write |
| `permissions.tools.edit` | `prompt` | file edit/patch |
| `permissions.tools.exec` | `prompt` | shell command execution |
| `permissions.tools.find` | `allow` | file/directory search |
| `permissions.tools.fetch` | `prompt` | outbound network fetch |
| `permissions.tools.analyze` | `allow` | code/project analysis |
| `permissions.tools.inspect` | `allow` | runtime/object inspection |
| `permissions.tools.agent` | `prompt` | spawning subagents / delegating tasks |
| `permissions.tools.state` | `allow` | runtime/session state reads |
| `permissions.tools.workflow` | `prompt` | multi-step workflow automation |
| `permissions.tools.registry` | `allow` | tool/skill registry queries |
| `permissions.tools.mcp` | `prompt` | MCP (external server) tool calls |
| `permissions.tools.delegate` | `prompt` | unknown or unregistered tools (see below) |

In Classic operation the default posture therefore allows read/find/analyze/inspect/state/registry
and prompts for write/edit/exec/fetch/agent/workflow/delegate/MCP. These per-tool defaults are
read only in Classic operation; in the other operations the stakes reading decides whether a
call asks, and `fetch` is treated as a read-category tool.
For the broader security posture and how these keys interact with secrets, see
[Security](./security.md) and [Secrets](./secrets.md).

### The two meanings of `delegate`

`delegate` names two distinct things:

- **`permissions.tools.delegate`** is the catch-all permission category for
  unknown or unregistered tools. `PermissionManager.getCategory()` maps any tool
  name that is not in the built-in category table to `'delegate'`
  (`TOOL_CATEGORIES[toolName] ?? 'delegate'`), so this key gates anything the
  runtime does not otherwise recognize.
- A separate, **conditionally-registered ACP `delegate` tool** exists. It is
  registered by `Orchestrator.registerDelegateTool()` only after an `AcpManager`
  is attached, which is why it is absent from the Built-In Tools table above even
  though `delegate` appears in the permission list.

### Policy engine and tool capability settings

The permissions policy engine (`permissions.engine`), the shadow simulation
(`permissions.simulation`, default on), and the policy bundle registry
(`policy.registryEnabled`) add stricter policy evaluation when enabled.
Related tool settings:

- `permissions.divergenceDashboard` (default on): aggregates
  permission-simulation divergence by tool/prefix/mode and gates enforce-mode
  transitions on the divergence rate.
- `runtime.toolBudget.enforced` (default off): holds each tool call to the
  wall-clock, token, and cost limits (`runtime.toolBudget.maxMs`, `maxTokens`,
  `maxCostUsd`). The wall-clock limit stops the call when it is reached and the
  result says so. Token and cost are known only when the call returns, so a
  call over those is reported as failed with its output kept and a note that
  its action may already have happened.
- `tools.overflowSpillBackend`: selects the overflow spill backend
  (`file`, `ledger`, or `diagnostics`); `file` is the stock behavior. The
  choice is read when the runtime starts, so a change applies after a restart.

See [Feature settings](./feature-settings.md) for the full capability catalog.

## Fetch safety

The fetch tool sanitizes by default (`fetch.sanitizeMode`, default
`safe-text`). It classifies initial and redirected hosts, blocks
private/link-local/metadata targets absolutely, gates localhost dev servers
behind a one-tap approval saved in your own settings (`fetch.allowLocalhost`; a project file cannot turn it on), applies
safe-text handling for unknown hosts, and enforces streaming response-size
caps. `fetch.sanitizeMode: none` skips content sanitization only. Host
blocking is unaffected.

## Shell safety

The exec tool runs through `ProcessManager` and uses shell AST normalization
by default (`permissions.commandParser`, default `ast`). AST normalization
evaluates compound commands segment-by-segment and gives structured denial
reasons for unsafe command forms.

A foreground command runs with piped output and no controlling terminal. When
it fails because it needed one (`sudo` without `-S` or `-n`, an `ssh` password
ask), the result carries `tty_note` saying to rerun with `interactive: true` or
a non-interactive form. Interactive runs put prompts to the user; an answer the
user typed that was overtaken by more program output is counted in
`prompts_dropped`, the prompt is asked again, and a timeout, cancel or decline
stops the command's whole process tree, including `nohup`ed children.

## File safety

Read/write/edit tools share `FileStateCache`, `ProjectIndex`, and
`FileUndoManager` instances within a session. Write and edit operations support
transaction modes so hosts can roll back failed multi-file changes.

The file cache compares exact private text snapshots and tracks observation
versions. Its memory budget covers those snapshots in both response modes:
`metadata_only` returns bookkeeping; `with_content` also returns text and diffs.

## Agent and contract integration

The `agent` tool can spawn individual agents, spawn batches of independent
root work, group agents into cohorts, send messages, wait for completion,
inspect budgets and plans, and inspect contracts.

- **`spawn` and `batch-spawn`** start a contract through the contract runner
  unless `outsideContract` is set. The ask is `authoritativeTask` when given,
  otherwise the parent turn's text; the spawned tasks become the contract's
  proposed units, which the planner weighs when it writes the plan. The result
  JSON carries `contractStarted: true`, the contract id and the owner agent id.
  A contract's planner chooses each unit's tools and write scope, so a call
  that sets `tools`, `restrictTools`, `writeScope` or `executionIntent`
  without `outsideContract` is refused with the parameters named. Other
  per-agent settings (`model`, `successCriteria`, `cohort` and the like) are
  not carried into the contract; the result lists them under `notApplied`.
- **`outsideContract: true`** runs an ordinary agent with no contract and no
  checks, and keeps every per-agent setting. In a batch, tasks that find no
  free agent slot are not started and are not queued: the result lists them
  under `notStarted`, and a spawn that fails partway lists the agents already
  running and the tasks not started.
- **`cancel`** stops a running agent; an agent that already finished is
  refused with its state, and a cascade lists only the agents it stopped.
- **`message`** is read by the agent at the start of its next turn and stays
  queued until the agent reads it or is removed. The message is reported as
  delivered when that turn runs, not when it is queued.
- **`contracts`** lists the session's contracts with their status and units.
- **`contract-history`** shows one contract's events: plan, checks, nudges,
  escalations and outcome.

A batch is not the way to add reviewer, tester or fixer agents for one
deliverable. Jev checks every unit's work against its criteria while it runs
and nudges the unit's agent until the work passes, so the planner folds any
"tests pass" or "reviewed" requirement into the criteria of the unit that
does the work. A unit's own agent cannot spawn agents. See
[Runtime orchestration](./runtime-orchestration.md#contracts) and
[Contract criteria](./contract-criteria.md).
