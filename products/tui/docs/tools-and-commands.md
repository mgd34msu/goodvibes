# Tools and commands

## Built-in tools

GoodVibes ships a broad built-in tool set, organized into families. Every tool named here has its own entry in the [Tool reference](#tool-reference) below:

| Family | Tools |
| --- | --- |
| File and code operations | `read`, `write`, `edit`, `find`, `repo_map` |
| Execution and inspection | `exec`, `analyze`, `inspect` |
| Network and research | `fetch`, `web_search` |
| Orchestration | `agent`, `workflow`, `task`, `work_plan` |
| Runtime/control surfaces | `state`, `registry`, `control`, `channel`, `remote` |
| External integration surfaces | `mcp` |
| Structured query/eval surfaces | `repl`, `query` |

The tool registry is part of the main runtime and is shared across the TUI, agents, automation, and daemon-backed flows.

## High-value tool families

### File and code work

| Tool | What it does |
| --- | --- |
| `read` | Token-efficient file reading, outlines, symbols, AST views, and paginated batch reads |
| `write` | Atomic writes, overwrite modes, and auto-heal pipelines |
| `edit` | Structural code edits with validation and rollback |
| `find` | Files, content, symbols, references, and structural search |
| `repo_map` | A ranked map of the repository's source files and their exports, within a default token budget that says what it left out |

### Execution and analysis

| Tool | What it does |
| --- | --- |
| `exec` | Shell execution, background processes, retries, and process tracking |
| `analyze` | Impact, dependencies, dead code, upgrade, semantic diff, and security checks |
| `inspect` | Project/frontend/runtime inspection |

### Research and retrieval

| Tool | What it does |
| --- | --- |
| `fetch` | HTTP retrieval and extraction |
| `web_search` | Provider-backed search and evidence shaping |
| `query` | Leave the owner a question and carry on; his answer comes back on a later request |
| `repl` | Evaluate a JavaScript or TypeScript snippet inside the command sandbox |

### Coordination and product control

| Tool | What it does |
| --- | --- |
| `agent` | In-process agent work |
| `workflow` | Scheduled and multi-step execution flows |
| `remote` | Distributed runtime control |
| `channel` | Channel-aware runtime and delivery surfaces |
| `control` and `state` | Product/runtime introspection |

## Tool reference

Deeper detail on the built-in tool families introduced above.

### REPL and eval runtimes

The `repl` tool evaluates one JavaScript or TypeScript snippet with Bun and returns its printed value and console output. Each evaluation is one command through the same path as `exec`, so the command sandbox, its containment and the credential scrub apply to it unchanged. It is offered only where that path is contained: the per-command sandbox is on (`sandbox.enabled` and the `exec-sandbox` feature) and the host has bubblewrap. Elsewhere the tool is not in the model's tool list.

- Each evaluation is stateless: no variables carry over between calls; `bindings` passes JSON values in as globals
- `timeout_ms` bounds an evaluation (default 120000; 0 waits for it to finish or be cancelled)
- `history` lists this session's evaluations; it is kept in memory, not written to disk

### read

Read files with token-efficient extraction modes.

- Extract modes: `content` (full text), `outline` (signatures only), `symbols` (exported names only, the most compact mode), `ast` (structural), `lines` (specific ranges)
- Tree-sitter powered outline and symbol extraction with regex fallback
- Token-budget pagination for large batch reads: request many files, get pages that fit within a budget
- Built-in image, PDF, and Jupyter notebook reading
- Per-file caching with optimistic concurrency control (OCC) conflict detection: tracks what you've read and warns if it changed externally

### write

Write files with atomic operations, backup modes, and auto-heal.

- Atomic writes via temp file + rename: no partial writes on crash
- Modes: `fail_if_exists`, `overwrite`, `backup` (copies the original to `.goodvibes/.backups/` and keeps the newest 5 copies per file), `restore` (puts the newest backup of the file back; it takes no content). The result names each backup copy and each restored backup at every verbosity
- Atomic batches (`transaction.mode: atomic`) refuse to overwrite a file another program changed while the call was running and roll back what the call already wrote; writing through a symbolic link writes the file it points to
- Auto-heal pipeline: if a written file has syntax errors and `tools.autoHeal` is enabled, runs formatter -> linter -> LLM fix automatically and rewrites the file (each stage starts from what was written, so an accepted repair differs from it only by that stage's fix, and the result names the stage); the result then lists it under `healed` at every verbosity, because the file no longer holds the content that was sent. The formatter and linter are the ones your user `languages/<language>.json` file sets for the file's language (`"formatter": { "command": "black", "args": ["-q", "{file}"] }`), otherwise the project's own prettier (or biome) and eslint, from its node_modules/.bin or PATH, run asynchronously in the project directory on the file's real path so the project's configuration applies.
- Diagnostics after a write or edit: syntax errors from the built-in parser, plus type errors from a language server that is already running for the file's language
- Base64 content support for files with special characters
- Batch writes in a single call with per-file mode control
- `validate.after` (`typecheck`, `lint`, `test`, `build`) runs the project's own command for each check: its `package.json` script (`typecheck`, `lint`, `test`, `build`) through the project's package manager (from the `packageManager` field or its one lockfile, npm otherwise), or the Cargo or Go toolchain's own command. A check the project does not declare is refused before anything is written. A failed check makes the call unsuccessful; the written files stay on disk, and each check's output is returned once, its last 8000 characters per stream. `edit` takes the same `validate.before` and `validate.after`

### edit

Structural code editing with AST matching, scope hints, and transactional rollback.

- Match modes: `exact`, `fuzzy` (whitespace-insensitive; when nothing matches, the one closest run of lines is applied after a single decision-model check), `regex` (with capture groups), `ast` (tree-sitter structural), `ast_pattern` (ast-grep with metavariables like `$VAR` and `$$$ARGS`). In `exact` mode, text that is not in the file fails at once with the closest lines to copy
- Scope hints: `in_function`, `in_class`, `near_line`, to disambiguate matches without adding more context
- Occurrence selection: `first`, `last`, `all`, or a specific Nth occurrence, with an ambiguity guard by default
- Atomic transactions: all edits succeed or all roll back; `partial` applies what succeeds and reports the rest (`none` is an older name for `partial`)
- Every result has a `status` (`applied`, `not_found`, `ambiguous`, `conflict`, `failed`) set by the matcher that refused the edit; `output.format: "verbose"` adds untruncated diffs and each changed file's content before and after
- After an edit of a source file, the result names the files that import it (nearest first), read from one import graph per project shared with `find` and `repo_map` and updated for each edit instead of rescanned
- Notebook (`.ipynb`) cell operations `replace`, `insert`, `delete`; any other operation is refused by name. Notebook edits appear in the changed-files list and can be undone like text edits
- Pre/post validation: run `typecheck`, `lint`, `test`, or `build` before and after edits, with auto-rollback on failure
- Auto-heal on validation failure (same pipeline as `write`)

### find

Multi-mode search across files, content, symbols, references, and structural AST patterns.

- Search modes: `files` (glob), `content` (regex grep), `symbols` (exported declarations), `references` (find all references via LSP with grep fallback), `structural` (AST pattern matching via ast-grep)
- Structural search uses ast-grep to find code patterns like `console.log($$$ARGS)` across TypeScript, JavaScript, CSS, and HTML
- Scope expansion: expand content matches to their enclosing `function` or `class` using tree-sitter
- Multiple queries per call, executed in parallel
- Progressive output: `count_only` -> `files_only` -> `locations` -> `matches` -> `context`

### repo_map

A model-invoked orientation tool, not passive always-on context injection. It returns a map of the repository: a per-directory source-file count plus the source files, ranked by import-graph centrality with file size as a tie-break, each with its top-level exported symbols. Call it to get oriented in an unfamiliar codebase before reading individual files.

- Optional `path` argument scopes the map to a subdirectory; default is the whole project
- Optional `budgetTokens` argument sets an approximate token budget for the symbol detail; the default is 25000 tokens. The map stops at that size and says how many files it left out and how to see them (a `path`, a larger budget, or `structure`). Pass 0 to list every indexed source file with its exports, which can be large on a big repository
- Optional `detail` argument: `symbols` (default) is the ranked import graph with exported symbols; `structure` reads no source bodies and lists directories with their source-file counts, plus every file name when a `path` is given or the project has at most 400 source files
- The import graph is built once per project and reused until files change; a second call does not rescan the tree
- Files the owner has denied reads for keep their path but are flagged `[access-restricted]` with their symbols withheld; files that could not be read are flagged `[unreadable]`, and what the scan skipped is listed under "Discovery warnings"
- Read-only, safe to run in parallel with other tool calls
- Covers TypeScript and JavaScript source files

### exec

Shell execution with background processes, retry, progress tracking, and file operations.

- Background execution with process tracking: spawn, poll status, read output, kill. `bg_output <id>` shows the most recent 256 KB of a process's output; for a chattier process the full output is saved privately and `bg_output <id> tail=<bytes>` or `bg_output <id> from=<byte>` reads any part of it. A finished process's record is kept for 30 minutes (at most 100 of them); after that `bg_output` says when it finished and that its output was discarded
- Retry with exponential backoff on transient failures
- `until` pattern: watch stdout for a regex match, then stop or promote to background
- Pre-command file operations: copy, move, delete files before running commands
- Progress file streaming for long-running commands (auto-enabled above 30s)
- Fail-fast mode: stop sequential execution on first failure, report remaining commands as skipped

### fetch

HTTP client with extraction modes, service registry auth, and batch operations.

- Extraction modes include `raw`, `text`, `json`, `markdown`, `readable` (strips nav/sidebar/footer), `code_blocks`, `links`, `tables`, `metadata` (og-tags), `structured` (CSS selectors), and `pdf`
- Named service registry: configure API credentials once in `~/.goodvibes/tui/services.json`, reference by name in fetch calls (a project's `.goodvibes/tui/services.json` adds services only when they name keys in your secret store; references and `oauth` blocks are used only from your own file)
- Inline auth: `bearer`, `basic`, `api-key` per request
- Batch parallel fetches in a single tool call

### web_search

Higher-level provider-backed search built on top of the lower-level fetch/runtime stack. `fetch` is the base HTTP/extraction tool; `web_search` is the search/evidence surface built on top of it. Reach for `fetch` when you already have a URL, and `web_search` when you need ranked results and evidence shaping first. See [Providers and routing](providers-and-routing.md) for the current search provider list.

### analyze

A code analysis suite spanning impact analysis through upgrade compatibility.

- `impact`: trace exported symbols across the project to find what breaks when you change a file
- `dependencies`: build the import graph, detect circular dependencies, list external packages
- `dead_code`: find exported symbols with zero references outside their own file
- `security`: scan for hardcoded secrets, world-writable files, and missing `.env` keys
- `breaking`: compare git refs and detect removed/changed export signatures
- `semantic_diff`: LLM-powered diff summary with risk assessment (low/medium/high)
- `upgrade`: check the npm registry for outdated packages and flag breaking version bumps
- Also: `coverage` (lcov/istanbul parse), `bundle` (stats.json), `surface` (public API), `preview` (dry-run edit), `diff` (git ref diff), `permissions` (dangerous pattern scan), `env_audit` (`.env` key comparison), `test_find` (locate test files for source files)

### inspect

A project and frontend inspection tool.

- `project`: detect project type, package manager, test framework, entry points, monorepo status
- `api` + `api_spec` + `api_validate` + `api_sync`: discover API routes across Next.js (App + Pages Router), Express, Fastify, and Hono; generate OpenAPI 3.0 specs; validate specs against code; detect frontend/backend drift by scanning `fetch()` calls
- `database`: parse Prisma schemas into structured model/field/relation data
- `components`: extract the React component tree with props, hooks, and child components
- `scaffold`: generate a module skeleton (types, implementation, tests, barrel export); a plan by default, and with `dryRun: false` the files are created through the write tool (approved, undoable, refused for an agent without `write`)
- Frontend analysis: `layout` (CSS/Tailwind layout hierarchy), `accessibility` (a11y issue detection), `component_state` (useState/useReducer/useContext tracing), `render_triggers` (what causes re-renders), `hooks` (dependency array auditing with missing-dep detection), `overflow`/`sizing`/`stacking` (CSS issue detection), `responsive` (Tailwind breakpoint analysis), `events` (handler analysis), `tailwind` (class conflict detection), `client_boundary` (Next.js directive analysis), `error_boundary` (coverage analysis)

### agent

In-process subagent management. See [Agent system](#agent-system) below for archetypes, custom archetypes, and worktree isolation.

- Spawn agents from named archetypes or custom archetypes in `.goodvibes/agents/*.md`
- Full lifecycle: `spawn`, `status`, `cancel`, `list`, `get` (detailed view with recent messages), `wait` (block until completion with timeout)
- Inter-agent messaging via `message` mode
- Token budget estimation via `budget` mode
- Execution plan introspection via `plan` mode
- Batch spawning via `batch-spawn` mode
- contract introspection via `contracts` and `contract-history` modes
- Cohort tracking via `cohort-status` and `cohort-report` modes

### state

Session state, persistent memory, telemetry, hooks, and the print level, all in one tool.

- KV state: session-scoped key-value store with atomic persistence
- Memory by key (`mode: "memory"`): get, set, list and delete project memories; each is one record in the project memory store, the record prompts retrieve, read and written through the daemon while it serves memory (the full durable-memory workflow lives under `/recall` and the knowledge modals)
- Hook management: list, enable, disable, add, and remove hooks at runtime
- Print level: read or set how much the app prints (`quiet`, `balanced`, `operator`), the same setting as `/mode` (`behavior.hitlMode`)
- Analytics: every tool call this process ran (name, status, duration, result size; never arguments or results), queried by filter, exported as JSON/CSV, or summarized; kept in memory, the newest 10,000
- Budget and context: the session's measured token usage and turns, and its context window (last request size, window size, compaction), with how many files this product has read or written in the workspace

### workflow

Workflow state machines, hook actions, and scheduled commands. See [Automation and scheduling](#automation-and-scheduling) below for the underlying contract model.

- Named workflow definitions: `contract` (starts a contract whose units are checked against acceptance criteria), `fix_loop`, `test_then_fix`, `review_only`
- State machine with validated transitions: prevents invalid state changes
- Hook actions (`mode: "hook-actions"`): run a command when a hook event fires, with an optional condition over `event.*` and `payload.*`; schedules (`mode: "schedule"`) run a command on an interval and can be paused and resumed. Both are judged once when added, by the same permission questions an `exec` command gets (a refusal says why), run in the project root with credential variables withheld and inside the exec sandbox when it is on, list their last run, exit code and error, and last until the app exits; `/schedule` routines survive restarts
- Scheduled jobs run by the automation manager: 5-field cron expressions read in an IANA timezone (a leap-day `0 0 29 2 *` is accepted; a day no named month has, such as `0 0 31 2 *`, is refused), fixed intervals and one-shot times, missed-run recording, per-job run history, and enable/disable control; persists to `.goodvibes/tui/automation-jobs.json`
- Full lifecycle: start, transition, cancel, list active instances

### task / work_plan / teams

Structured execution and coordination beyond a single conversation turn.

- `task`: create, inspect, block, cancel, depend, and hand off tasks across sessions
- `work_plan`: the project work plan `/work-plan` shows: add items, set their status, owner and notes, remove them, clear finished ones; spawned agents keep the same plan
- Teams are `agent` cohorts: spawn the members with one `cohort` name, each with its template as its role and its `communicationLane`; brief each with `context` and `successCriteria`; `cohort-status` and `cohort-report` read the team back, and the fleet view shows the cohort beside each agent

### query

- `query`: leave the owner a question and carry on working. `ask` posts it to the owner inbox and returns its id at once; the owner sees it in `/questions` (alias `/inbox`) in either terminal app and, when push is on, as a notification on his phone, and answers it there. The question is recorded as asked by the session. When the owner answers, the answer is passed to the asker on its next model request: a spawned agent while it runs, otherwise the conversation that asked or spawned it. If that session is not open when he answers, he is told the answer is saved and will be delivered when the session is next opened, and it is put into the conversation once when the session is resumed (`/session resume`, `/load`, the session picker, `--continue`/`--resume`, headless runs included). Deleting the session withdraws its open questions and marks its waiting answers not deliverable. `/questions all` and `/decisions` show each answer as delivered, waiting for its session to be opened, or not deliverable with the reason (an agent or hosted session that has ended, a deleted session); the answer stays on the question in every case. `show` and `list` read it back at any time; `withdraw` takes back a question that no longer matters. A `key` makes a repeated ask return the first open question instead of posting a second one. The questions go to the daemon's inbox when it is reachable; with no daemon the terminal keeps its own inbox (`~/.goodvibes/tui/owner-inbox.jsonl`), created by the first question, and the same rules apply

### mcp / remote / control

Product-control tools that expose runtime breadth directly. See [MCP integration](#mcp-integration) below for the connection and config model.

- `mcp`: call a connected server's tool (`mode: "call"` with `qualifiedName` and `input`), and inspect MCP servers, tools, schemas, schema freshness, security posture, auth posture, and quarantine controls
- `remote`: inspect and manage distributed peers, node-host contracts, work queues, artifacts, and review flows
- `control`: list this app's own slash commands (every visible one, with its description) and views, built-in subscription providers, and sandbox presets; a session with no command surface answers `available: false`

### channel

The `channel` tool exposes the omnichannel runtime directly to the model and operator flows.

- list accounts per surface and inspect individual account/setup state
- run account lifecycle actions such as setup, inspect, retest, connect, disconnect, login, and logout
- query shared channel directories and resolve targets across supported surfaces
- inspect channel capabilities, tools, agent-tools, and operator actions
- run channel-owned tools/actions and perform authorization checks through the same surface registry used by the daemon and reply pipeline

### registry

Discover and introspect skills, agents, and tools.

- Fuzzy search across skills (`.goodvibes/skills/*.md`), agents (`.goodvibes/agents/*.md`), and built-in tools
- Task-based recommendations: describe what you want to do, get ranked suggestions
- Dependency chain resolution for skills
- Full content retrieval for any registry item

## Slash-command families

Representative slash-command families, with a one-line summary of each:

| Command | Summary |
| --- | --- |
| `/model` | Select or display the current LLM model |
| `/settings` | Open the fullscreen configuration workspace |
| `/config` | Open the fullscreen configuration workspace, or set a key directly |
| `/recall` | Project memory: bare opens the Memory modal, subcommands add decisions, constraints, incidents, and patterns with provenance |
| `/knowledge` | Structured knowledge graph: ingest URLs and bookmarks, inspect issues, and build compact prompt packets |
| `/remote` | Inspect, dispatch, and review self-hosted remote runners and artifacts |
| `/sandbox` | Review and configure VM isolation policy for MCP and evaluation runtimes |
| `/plugin` | Manage plugins, trust, review, and ecosystem paths |
| `/marketplace` | Browse the unified plugin and skill marketplace |
| `/share` | Export the current session to a shareable HTML, JSON, or Markdown file |
| `/schedule` | Manage automation jobs and scheduled runs |
| `/voice` | Toggle always-speak mode and provision the managed local voice runtime and wake-word models |
| `/tts` | Submit a prompt for live TTS playback, or control always-speak mode |
| `/cloudflare` | Inspect and manage optional Cloudflare batch and control-plane integration |
| `/mcp` | Manage MCP servers and their tools |
| `/incident` | Open, export, and capture incident review bundles |
| `/replay` | Deterministic replay: load, step, seek, diff, and export recorded runs |
| `/eval` | Evaluation harness: run benchmark suites, compare baselines, and gate regressions |
| `/session` | Session lifecycle and orchestration: list, resume, fork, save, export, and cross-session task handoff |
| `/work-plan` | Track a persistent, workspace-scoped work plan |
| `/search` | Provider-backed web search with ranked results and source labels |
| `/imagine` | Generate an image from a prompt through a configured provider that makes images, or collect a job still running |
| `/codebase` | Build, inspect, and search the repo source-tree code index |
| `/workstream` | Author and oversee multi-phase agent workstreams (orchestration engine) |
| `/checkpoint` | Create a manual workspace checkpoint for forensic retention |
| `/editor` | Edit the current composer draft in your `$EDITOR`, then resume with the result |

`/editor` (alias `/ed`) opens the current composer draft in your `$VISUAL`/`$EDITOR`, suspends the TUI while the editor runs, and loads the edited text back into the composer when you save and quit. Set `$EDITOR` (e.g. `export EDITOR=nvim`) for it to work.

Composer capture markers: a single line beginning with `#` saves the rest as a session-memory note and does NOT send a turn (a quick "jot this down"), and a confirmation names what was saved and where. (`## ...` markdown headings and multi-line text that starts with `#` are left alone and sent normally.) The existing `!# <text>` still pins to session memory and also sends the text as a prompt.

A typed line that starts with `!` runs the rest as a shell command in the working directory, beside the composer: the output is shown and goes in front of your next message as context, and `Esc` stops a command that is still running. Spoken input is never run as a shell command.

`/schedule add when "<natural language>" <prompt...>` accepts natural-language times parsed locally, for example `every weekday at 9am`, `daily at 6pm`, `every 30 minutes`, `every monday at 08:00`, or `in 2 hours`. The command always echoes back the concrete interpretation (the resulting cron/interval/one-shot schedule) before the job is saved, so you can see exactly what was understood.

`/search <query> [--limit <n>]` runs a provider-backed web search directly (bypassing the agent-tool JSON wrapper) and renders ranked results, an instant answer, and the source label into the transcript; it degrades honestly using the web-search service's own status note.

`/imagine <prompt>` generates an image through the first configured provider that makes images; a provider that only makes video is never sent the request. Built-in providers stream the result into the artifact store, so the saved image keeps opening after the provider's own link expires. When no configured provider makes images, it prints each generation provider's status, what it makes, and the key it needs. A job the provider accepted but had not finished when the wait ended is reported with the command that collects it later: `/imagine --collect <provider> <task-id> [key=value ...]`. (`/image` is a different command; it attaches a local image file to the next message for multimodal analysis.)

`/session` is the single front-door for all session work, split across two domains. The lifecycle subcommands operate on sessions themselves:

| Subcommand | Does |
| --- | --- |
| `list` | List saved sessions for the workspace |
| `rename` | Rename the current or a named session |
| `resume` | Reopen a saved session |
| `fork` | Branch a session into a new one |
| `save [name] [--yes]` | Save the current session. Refuses to replace a different saved conversation that already uses the name; `--yes` replaces it deliberately |
| `info` | Show the current session's details |
| `export <id\|.> [format]` | Export a session (`.` is the current one) |
| `search <query>` | Search saved sessions |
| `delete <id>` | Delete a saved session |
| `events [kind]` | List transcript events, optionally filtered to one kind |
| `groups [kind]` | List transcript events grouped, with per-group event counts and message ranges |
| `hotspots` | Show per-kind event counts and the busiest transcript groups |

The orchestration subcommands manage a cross-session task DAG with cycle detection:

| Subcommand | Does |
| --- | --- |
| `link-task <taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]` | Register a task in the graph, optionally with a dependency edge |
| `handoff <taskId> --to <sid>` | Hand a task off to another session |
| `graph [--session <sid>] [--format text\|json]` | Render the task graph |
| `cancel <taskId> [--scope task\|subtree\|session]` | Cancel a task, its subtree, or the session's tasks |

Alias: `/sess`. Run `/session` with no arguments to see current session info.

`/model` opens the fullscreen provider/model workspace. The left rail chooses the target route (`Main Chat`, `Helper Model`, `Tool LLM`, `TTS LLM`, or `Embeddings`), and the main table filters large model catalogs by search, price tier, capability, availability, benchmark sort, and grouping. `/provider` opens the same workspace in provider-first mode so users can choose a provider and then a model for the active target.

`/project-plan` (alias `/planning`) opens native work and recovery; `/project-plan panel` does the same. `/project-plan <goal>` submits the exact original terminal request through native conversation intake, with no historical planning fallback. `/project-plan history` opens saved historical records without readiness evaluation, suggested answers, approval controls, or a planning interview. Saved records are read-only: `/project-plan answer` and `/project-plan approve` are retired, change nothing and point at the work plan and `/workstream`. The active plan is the project work plan (`/work-plan`): `/project-plan list` and `show <id>` print it, its open items reach the model once per request turn, and `/project-plan dismiss` changes nothing and names the `/work-plan` commands that clear, cancel or remove items. This is distinct from `/plan`, which only toggles the read-only permission plan mode (see [Keyboard shortcuts](#keyboard-shortcuts) below, `Shift+Tab`).

`/paste` (`/clip`) explicitly reads the system clipboard and inserts supported text or image data into the prompt. Use this when terminal paste does not deliver image clipboard contents to the TUI; the command uses the clipboard helper path instead of relying on the terminal paste stream.

`/mcp` opens the fullscreen MCP workspace. `/mcp add <name> <command> [args...] [--scope project|global]` writes a project server to `.goodvibes/mcp.json` or a global server to `~/.config/mcp/mcp.json`, then reloads the live MCP runtime without restarting. Use `/mcp remove <server> [--scope project|global]`, `/mcp reload`, `/mcp config`, and `/mcp tools [server]` for the same operations from the command line. See [MCP integration](#mcp-integration) below for the config file shape and connection model.

## Keyboard shortcuts

Most shortcuts are customizable via `~/.goodvibes/tui/keybindings.json`. Use `/keybindings` to view current bindings.

Four keys are fixed and are not in the rebindable table: `F2` (open or close Agents), `Esc` (exit the current mode), `?` (help/command picker on an empty prompt), and `@` (file picker). `Shift+Tab` is `cycle-permission-mode` in the table. Everything else below resolves through the keybindings table and can be reassigned.

### Input and editing

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Tab` | Path completion, else toggle block collapse |
| `Ctrl+U` | Kill from cursor to start of line (push to kill ring) |
| `Alt+U` | Clear entire prompt (no kill-ring push) |
| `Ctrl+W` | Kill word backward (push to kill ring) |
| `Alt+K` | Kill from cursor to end of line (push to kill ring) |
| `Alt+D` | Kill word forward (push to kill ring) |
| `Ctrl+Shift+Y` | Yank from kill ring |
| `Alt+Y` | Yank-pop (rotate kill ring, replace last yank); only valid immediately after a yank |
| `Alt+B` | Move word backward |
| `Alt+F` | Move word forward |
| `Ctrl+Z` | Undo prompt edit |
| `Ctrl+Shift+Z` | Redo prompt edit |
| `Ctrl+V` | Paste (image or text) |
| `@` | Open file picker (insert file path) |
| `?` | Open help/command picker (empty prompt) |
| `r` / `m` | After a turn error: retry the turn / open the model picker (any other key dismisses) |

`Ctrl+W` uses whitespace-delimited word boundaries (readline/unix-word-rubout semantics), while `Alt+D`, `Alt+B`, and `Alt+F` use Unicode word boundaries (letters, digits, underscore).

`Ctrl+K` is the command palette, not kill-to-end-of-line. The readline kill that historically owned `Ctrl+K` is bound to `Alt+K` instead, so the capability is kept rather than lost. `Ctrl+U` and `Alt+U` are likewise split. `Ctrl+U` kills to the start of the line and pushes the text onto the kill ring (readline convention), while `Alt+U` clears the whole buffer regardless of cursor position and pushes nothing.

### Navigation

| Key | Action |
|-----|--------|
| `Arrow Up / Down` | Scroll conversation / recall input history |
| `PageUp / PageDown` | Scroll by page |
| `Ctrl+R` | Reverse input history search |
| `Ctrl+E` | Move to end of line / next error |
| `Ctrl+A` | Move to start of line / apply nearest diff |
| `Mouse wheel` | Scroll the conversation (or the open modal) |
| `Click drag` | Select text |
| `Middle click` | Paste |
| `n` / `N` | Next / previous match in locked search mode; wraps with a `(wrap)` marker |
| `Escape` | Close the top modal (one level), then clear the composer, then interrupt the turn; inside Agents it backs out one level and never stops work |

### Blocks and content

| Key | Action |
|-----|--------|
| `Ctrl+Y` | Copy nearest block to clipboard |
| `Ctrl+S` | Save nearest block to file |
| `Ctrl+B` | Bookmark nearest block |
| `Ctrl+F` | Open conversation search overlay |
| `Ctrl+L` | Clear screen |
| `Ctrl+Shift+C` | Copy selection |

### Views

Every view opens as a modal over the dimmed conversation, and `Esc` closes one level at a time.

| Key | Action |
|-----|--------|
| `Ctrl+P` / `Ctrl+K` | Command palette: every command, view and setting; older view names (fleet, tokens, git, …) are search words too |
| `F2` / `Ctrl+O` | Agents: running and finished agents, WRFC chains, workflows and hosted sessions; steer (`s`), stop (`Ctrl+X`, asks first; `Ctrl+X` again confirms), open an agent or background process full screen (`Enter`) |
| `/usage` | Usage: context bar with the compaction threshold, session totals, per-turn bars, fleet cost split, compact now |
| `/changes` | Changes: changed files with +/- counts, a tinted syntax-colored diff, the semantic summary, hunk navigation (`]` `[`), stage hunk (`space`), review comments (`c`), mark reviewed (`m`), open in editor (`o`) |
| `/notifications` | Notification history |
| `/sessions` | Session picker, with hosted sessions in a Hosted group |

An agent or a background process can take over the whole terminal. `Enter` on an agent's lane in the work tree (or on its row in Agents) opens the agent: its work is the spine, its own children branch off it, the header reads `main › engineer` in the agent's color, and the composer steers the agent while main keeps running. `Enter` on a `▶` bead (or a process row) opens the process: live output with timestamps, errors in red, follow mode on. The process view takes no input, because GoodVibes cannot write to a background process's stdin; `/` searches its output and `y` copies it. While more than one session exists, a row of session chips under the header lists them, and `Tab` / `Shift+Tab` switch between them when the composer is empty.

`Esc` in a view goes back up one level (a child agent returns to the agent that started it, then main) and never stops anything. Stopping is `Ctrl+X`: the first press asks, the second stops. The status line always says what the next `Esc` does.

### Selection modals

The recovery offer, session picker, profile picker, and config rows are all pickers built on the selection modal, and they share one key vocabulary:

| Key | Action |
|-----|--------|
| `Enter` | Run the selected row's primary action |
| `Space` | Toggle the selected row when it has a toggle action |
| `Left` / `Right` | Decrement / increment an adjustable row without leaving the modal |
| `Shift+Left` / `Shift+Right` | The same adjustment with the row's step multiplied by 10 (a row with no explicit step moves by 10) |
| `Esc` | Close the modal, in one press, whatever the search state |
| `Backspace` | Clear the in-progress search query one character at a time |

In a searchable modal, `/` focuses the filter, and any keystroke that no row hotkey claims also arms the filter and starts the query with that character.

### System

| Key | Action |
|-----|--------|
| `Ctrl+C` | Clear input / cancel generation / exit (double-press to quit) |
| `Ctrl+K` | Open the command palette (search and run any command) |
| `Shift+Tab` | Cycle this session's execution mode: safe-owner → safe-jev → yolo, asking before yolo; the saved default changes only in `/permissions` or Settings (plan is outside the cycle; `/plan` toggles it). While the session chips show (an agent or background process is running) and the composer is empty, it switches to the previous session instead, and `Tab` to the next |
| `Ctrl+X` | Inside an agent or process view: stop what it shows (the first press asks, the second stops) |
| `Alt+C` | Cancel the running tool call (the turn continues) |
| `Alt+A` | Toggle keep-awake (the "sleep disabled" chip) |
| `Alt+M` | List or hide the memories a turn used (provenance chip drill-in) |
| `Alt+V` | Voice input: press to start recording, press again to stop and transcribe into the composer |

A single `Ctrl+C` on an empty composer arms a roughly one-second "press again to exit" confirmation; the footer shows this as `Ctrl+C x2 quit`.

## Agent system

Agents are in-process subagents with isolated conversation history, a scoped tool registry, and an optional git worktree. They run asynchronously and report back through the agent message bus. Use the `agent` tool (see [Tool reference](#tool-reference) above) to spawn and manage them.

### Built-in archetypes

Eight archetypes ship built in. A markdown file in `.goodvibes/agents/` with the same `name` overrides the built-in entry.

| Archetype | Tools | Description |
|-----------|-------|-------------|
| `orchestrator` | read, find, analyze, inspect, registry | WRFC coordination and decomposition agent |
| `planner` | read, find, analyze, inspect | Read-only goal-decomposition agent (no write/edit/exec/delegate) |
| `engineer` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Full-stack implementation agent |
| `reviewer` | read, find, analyze, inspect, fetch, registry | Code review and quality assessment |
| `tester` | read, write, find, exec, analyze, inspect | Test writing and execution |
| `researcher` | read, find, analyze, inspect, fetch, registry | Codebase exploration and analysis |
| `integrator` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Cross-deliverable integration agent |
| `general` | read, write, edit, find, exec, analyze, inspect, fetch, registry | General purpose agent |

### Custom archetypes

Drop a Markdown file into `.goodvibes/agents/` with YAML frontmatter:

```markdown
---
name: documenter
description: API documentation writer
tools: [read, find, write]
model: claude-haiku-4-5
---

You are a technical documentation specialist. Focus on clarity and completeness.
```

The markdown body becomes the agent's system prompt.

### Spawning an agent

Ask for it in conversation (`spawn an engineer agent to refactor src/utils.ts`), or call the `agent` tool directly using its spawn mode, specifying an archetype and task.

### Git worktree isolation

When an agent is spawned, it can be given its own git worktree. On completion, changes are merged back. On cancellation or error, a worktree with nothing unique in it is removed at once; one with uncommitted changes or unmerged commits is kept (see Worktree retention in the orchestration runtime doc), and `/worktree review` shows how old it is, how large, and why it is kept.

## Hook system

Hooks fire on lifecycle events throughout a session. They are configured in `hooks.json` in the project working directory (or a custom file set in `tools.hooksFile`, also resolved against the project working directory).

### Event path format

```
Phase:Category:Specific
```

The phase says when the hook fires relative to the event, and what authority it has:

| Phase | Fires | Authority |
| --- | --- | --- |
| `Pre` | Before the operation runs | Blocking intercept; can deny the operation or mutate its input |
| `Post` | After the operation succeeds | Observe only, non-blocking |
| `Fail` | When the operation fails | Observe only |
| `Change` | When tracked state changes (config, budget, files, and similar) | Observe only |
| `Lifecycle` | On lifecycle transitions (spawned, completed, connected, and similar) | Observe only |

The category names which subsystem's events the hook watches:

| Category | Covers |
| --- | --- |
| `tool` | Built-in tool calls |
| `file` | File writes and edits |
| `git` | Git operations |
| `agent` | Agent lifecycle events |
| `compact` | Context compaction |
| `llm` | Chat/model calls |
| `mcp` | MCP calls and server lifecycle |
| `config` | Config changes |
| `budget` | Budget changes and breaches |
| `session` | Session lifecycle |
| `contract` | Work contract lifecycle and spawn-guard refusals |
| `communication` | Communication state and lifecycle |
| `permission` | Permission requests and decisions |
| `transport` | Transport lifecycle |
| `webhook` | Events posted to the daemon's webhook route (any phase the sender names) |

Wildcards are supported: `Pre:tool:*` matches all pre-tool events. `/hooks contracts` lists every hook point; `/hooks contracts <words>` filters the list.

A hook fires on the key it is listed under in `hooks.json`. A key that is not exactly `Phase:Category:Specific`, or that no hook point matches (segments are case-sensitive, so `pre:tool:exec` never fires), is not loaded: the reason is logged as a warning and shown in the hook activity list, and `goodvibes hooks validate` reports it.

Tool hooks fire for every tool call: the conversation's own, and those of spawned agents, background workers and contract units. A `Pre:tool:*` hook runs before the call is admitted (in `yolo` mode it does not run). It can refuse the call (`decision: "deny"`), rewrite its arguments (`updatedInput`, which is what the permission check sees and what runs), or add a note (`additionalContext`) that the model reads with that call's result. A `Pre:tool:*` hook that fails (an error, a timeout, a non-zero exit) refuses the call and says which hook failed. `Post:tool:*`, `Fail:tool:*` and the file hooks observe: they run beside the turn, so the next call does not wait for them.

### Hook types

| Type | Description |
|------|-------------|
| `command` | Run a shell command. Event data is passed via stdin as JSON. |
| `prompt` | Send a prompt to an LLM. `$ARGUMENTS` is replaced with the event JSON. |
| `agent` | Spawn a subagent to handle the event. |
| `http` | POST the event payload to a URL. |
| `ts` | Execute a TypeScript module that exports a default handler function. |

### Example hooks.json

```json
{
  "hooks": {
    "Post:tool:write": [
      {
        "type": "command",
        "command": "echo 'File written: $FILE' >> .goodvibes/write-log.txt",
        "async": true,
        "description": "Log all file writes"
      }
    ],
    "Pre:tool:exec": [
      {
        "type": "prompt",
        "prompt": "Review this command for safety: $ARGUMENTS",
        "model": "claude-haiku-4-5",
        "description": "Safety check before exec"
      }
    ]
  }
}
```

Hooks files other users can write (or that another user owns) are not loaded, because hook commands run with your privileges; reloading hooks replaces only what came from the file and keeps hooks added at runtime. An HTTP hook never follows a redirect.

### Hook chains

Chains trigger an action only after a sequence of events occurs, with optional time windows and conditions:

```json
{
  "chains": [
    {
      "name": "notify-after-agent-completes",
      "steps": [
        { "match": "Lifecycle:agent:spawned" },
        { "match": "Lifecycle:agent:completed", "within": "5m" }
      ],
      "action": {
        "match": "Lifecycle:agent:completed",
        "type": "command",
        "command": "notify-send 'Agent finished'"
      }
    }
  ]
}
```

A hook definition supports these properties:

| Property | Meaning |
| --- | --- |
| `match` | Optional; when present it must equal the key the hook is listed under, or the hook is not loaded. In a chain's `action` it is the event path the action reports |
| `matcher` | A further filter within the match, such as a specific tool name |
| `type` | One of the five hook types above |
| `command` / `prompt` / `url` / `path` | The action payload for `command`, `prompt`/`agent`, `http`, and `ts` hooks respectively |
| `headers` | Custom headers for `http` hooks |
| `model` | The LLM model for `prompt`/`agent` hooks |
| `timeout` | Timeout in seconds (default 30; 60 for `agent` hooks) |
| `statusMessage` | Custom status text shown while the hook runs |
| `async` | Run in the background without blocking |
| `once` | Run once, then auto-remove |
| `description` | Documentation text |
| `name` | Optional name for programmatic enable/disable/remove |
| `enabled` | Whether the hook is active (default `true`) |

The `HookDefinition` type in the engine's `platform/hooks/types.ts` is the authoritative field
set and carries a small number of advanced, situational fields beyond this
table.

## Automation and scheduling

Beyond individual hook definitions, GoodVibes treats hook points, workflow runs, and scheduled tasks as a managed contract rather than plain fire-and-forget shell calls.

- Hook-point contracts carry execution authority, mutation/injection permissions, timeout policy, and failure policy metadata: a hook point declares what it is allowed to do, not just what triggers it
- Managed hooks support scaffold, chain, enable/disable, inspect, import/export, and simulation flows through `/hooks` and the `state` tool's hook management modes
- Workflow state machines (`fix_loop`, `test_then_fix`, `review_only`) drive validated transitions for multi-step review/fix cycles. See [Tool reference: workflow](#workflow) above
- Cron-like scheduled agent tasks support timezone-aware schedules, missed-run tracking, run history, and manual trigger support, managed via `/schedule`

Project planning and the persistent `/work-plan` checklist are a related but separate surface. See [Project planning](#project-planning) below and [Project planning](project-planning.md).

## MCP integration

Connect to any MCP-compatible server from inside the running TUI. Project-scoped servers live in `.goodvibes/mcp.json`; global servers live in `~/.config/mcp/mcp.json`. You can also edit either file directly:

GoodVibes also reads MCP servers already configured for other tools, read-only: a project's `.mcp/mcp.json`, a user's `~/.mcp/mcp.json`, and Claude Desktop's `~/.config/claude/claude_desktop_config.json`. Servers found there show up alongside your GoodVibes-configured servers, but `/mcp add` and `/mcp remove` only write to the two GoodVibes-owned files above. Those other files are never moved or rewritten: one that cannot be read, or holds no server list GoodVibes recognises, is skipped with one warning. In the GoodVibes-owned files an entry missing its name, or a command or url, is skipped with a warning and kept as written when the file is next saved. A server whose entry names no `trustMode` runs as `ask-on-risk`, and the `/mcp` workspace shows and keeps that default until you change the trust field.

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  ]
}
```

A server with a `url` instead of a `command` is a remote HTTP server. Give it a `headers` object (for example `"headers": { "Authorization": "Bearer ..." }`) to send credentials on every request; the headers are never shown by the read routes, and an edit that does not resend them keeps them. Fields GoodVibes does not model are kept when it rewrites the file. A server name may not contain `:` or `/`; such an entry is skipped with a warning rather than blocking other edits. `trustMode: "allow-all"` is honoured only from the global config: in a project file it is ignored (with a warning) and the default trust mode applies, so a checked-out repository cannot grant its own servers unrestricted trust.

MCP tools are named `mcp:<server-name>:<tool-name>`; the assistant lists them with the `mcp` tool (`mode: "tools"`) and runs one with `mode: "call"`, passing that name as `qualifiedName` and the tool's arguments as `input`. A call waits up to 120 seconds for the server's answer; then it is cancelled, the server is told, and the result says whether the server still answers a health check (the tool is slow and may still finish its work) or not (reload it). Set `toolTimeoutMs` on a server's entry to give its tools a different deadline, or `0` for none. The call goes through the server's trust mode, quarantine state and permissions, and its answer is treated as untrusted content. Tool schemas load progressively: names and descriptions at startup, full parameter schemas on first use. A server whose connect fails, or a stdio server that exits unexpectedly, is reconnected automatically while `runtime.mcpLifecycle` is on (the default): attempts wait 1 s, 2 s, 4 s, 8 s and 16 s (never more than 30 s), each one a full connect through the same checks as the first, and the count resets once the server is connected again or you run `/mcp reload`. After five failed attempts the server stays disconnected. A stdio server that starts but never answers the handshake is given up on after 30 seconds (its process is stopped), so one silent server cannot hold up the others; configured servers connect a few at a time rather than one after another. A server whose output stream closes while its process keeps running is stopped and reconnected the same way as a crash. `/mcp servers`, the MCP workspace and the `mcp` tool report each server's phase (`starting`, `negotiating`, `ready`, `restart-wait` while a reconnect is scheduled, `gave-up`, `closed`), its last error, and the reconnect attempt, limit and time to the next attempt, or why reconnecting stopped. A tool call to a server that is not connected says which of these it is in and what to do next: call again after the next attempt, or fix the server and run `/mcp reload`. With `runtime.mcpLifecycle` off, a server that drops stays disconnected until `/mcp reload`.

MCP tool calls respect the `permissions.tools.mcp` setting (default: `prompt`).

Beyond the connection mechanics, the current MCP product loops also cover:

- trust posture and quarantine review for newly added or unverified servers
- auth-review and reconnect flows for servers whose credentials or connections have degraded
- sandbox-backed execution when isolation is configured for a server
- routing into dedicated MCP and Health workspaces for operator review

See the `/mcp` command usage above in Slash-command families for the command-line surface, and the `mcp` / `remote` / `control` entry in [Tool reference](#tool-reference) for model-facing inspection.

## Plugin system and ecosystem

Extend goodvibes-tui with custom plugins, and optionally distribute or install plugins, skills, hook-packs, and policy-packs through a curated ecosystem catalog.

### Plugin folder layout

Place plugin folders in `~/.goodvibes/plugins/` (global) or `.goodvibes/plugins/` in the project directory (project-local; overrides a global plugin with the same manifest name). Each plugin has a `manifest.json` and an entry file (default `index.js`, or a relative path given in the manifest's `main` field):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin"
}
```

### Plugin API

Plugins receive a sandboxed API:

- `registerCommand()`: add custom slash commands; the handler receives the arguments and a context whose `print(text)` shows text in the session that typed the command, and an error it throws (or a refusal while the plugin reloads) is shown there too
- `registerProvider()` / `registerProviderInstance()`: add OpenAI-compatible or fully custom LLM providers
- `registerTool()`: add custom tools available to the LLM; registering a tool name the plugin already registered throws, so the plugin does not start and `/plugin enable` or `/plugin reload` says why
- `registerGatewayMethod()`: add control-plane/API methods
- `registerChannelPlugin()` / `registerDeliveryStrategy()`: extend omnichannel surfaces
- `registerMemoryEmbeddingProvider()`: extend sqlite-vec-backed memory indexing
- `registerVoiceProvider()` / `registerMediaProvider()` / `registerWebSearchProvider()`: extend voice, media, and search families
- `onEvent()`: subscribe to typed runtime events
- `getConfig()`: read plugin-specific settings
- `log()`: emit structured plugin logs

Manage installed plugins via `/plugin enable|disable|reload|list`. `/plugin reload` names each plugin that did not start (with its reason), each one left on its current version because calls into it were still running, each one skipped because it is quarantined, and each one whose earlier copy reported an error while stopping.

### Trust, quarantine, and discovery

- local plugin discovery across configured search directories
- plugin inspect/review output with trust tier, quarantine posture, capability counts, and signature fingerprint visibility
- `/plugin list|inspect|review|browse|catalog-review|publish-local|install|update|uninstall`

### Curated ecosystem catalogs

Beyond direct local plugins, a local-first curated distribution channel covers plugins, skills, hook-packs, and policy-packs:

- curated ecosystem catalogs with publish-local, unpublish, catalog review, install, update, uninstall, and installed-receipt flows
- local-first curated plugin distribution via `.goodvibes/ecosystem/*.json` (global under `~/.goodvibes/ecosystem/`, project-local under `.goodvibes/ecosystem/` in the workspace), shared across GoodVibes surfaces rather than scoped to the TUI
- recommendations tied to installed state, denials, and missing capabilities
- `/marketplace` browses the curated plugin, skill, hook-pack, and policy-pack surfaces

## Operator surfaces

> **note.** Operator read/navigate surfaces open as
> **modals**: providers/health, services, subscription, remote, sandbox,
> settings-sync and marketplace, plugins, skills, hooks, policy, security,
> knowledge, memory, docs→keybindings, qr-code→pairing, work-plan,
> project-planning→planning. The runtime-ops consoles (cockpit, orchestration,
> tasks, worktrees, approvals, communication, …) open **Agents**; tokens and
> cost open **Usage**; git, diff and review open **Changes**. The old names
> still work as `/panel <name>` and as command palette search words. The
> command front-doors below are unchanged.

Many commands also have matching modals and control rooms. High-signal examples:

- provider accounts and health: `/health <pillar>` reviews one domain at a time, with pillars for `setup` (install/setup issues), `services` (service registry inspections), `sandbox` (isolation posture), `accounts` and `auth` (provider accounts and auth users), `settings` (settings integrity), `remote` (remote runtime), `continuity` (last-session pointer and recovery-file state), `worktrees` (tracked worktree cleanup state), `maintenance` (context usage and session upkeep), and `term` (terminal capability posture such as color depth and synchronized output)
- knowledge and memory review
- remote peers and work queues
- channels and deliveries
- MCP trust and reconnect posture
- approvals, policy, security, and diagnostics
- tasks, orchestration, worktrees, and agents
- contract state and verification results
- project planning readiness, decisions, project language, task graph, verification gates, and agent handoff metadata
- persistent work-plan task tracking for ongoing local implementation work

## Evaluation, replay, diagnostics, and incidents

GoodVibes includes a post-execution and operator-repair stack:

- `/eval` runs built-in evaluation suites, compares baselines, and applies regression gates
- `/replay` loads and steps deterministic replay runs
- `/incident` opens, exports, and captures forensics bundles
- Health and diagnostics surfaces expose repair actions, transport issues, task failure state, and replay hooks
- the state inspector subsystem tracks transitions, time-travel snapshots, and selector hotspots
- telemetry exporters can write to local ledgers, console sinks, or OTLP bridges
- retention and pruning policy keeps checkpoint/snapshot growth bounded
- idempotency keys prevent duplicate tool execution across replay, reconnect, and retry scenarios
- operational playbooks describe symptoms, checks, and resolution steps for runtime failure classes

Adjacent reliability subsystems: notifications; performance budgets and render-health monitoring; retention and pruning; idempotency protection; and the machine-readable recovery playbooks used by the diagnostics surface.

## Project planning

Project planning is TUI-owned. When a normal chat turn clearly asks for an implementation plan, dependency graph, verification strategy, or agent handoff, the TUI opens the Planning modal, stores state in the platform `ProjectPlanningService`, evaluates readiness, and asks one focused planning question before execution.

Planning artifacts are stored in a project knowledge space named `project:<projectId>`, where the project id is derived from the workspace path. The platform supplies passive daemon routes and operator methods, but daemon/non-TUI surfaces do not enter planning loops.

See [Project planning](project-planning.md) for the modal layout, `/project-plan` behavior, and route/method list.

`/work-plan` is the separate persistent checklist surface. Use it when the work already has concrete tasks and you want durable status tracking rather than another planning interview.

## Context maintenance

GoodVibes automatically compacts the conversation context when token usage reaches the configured threshold. The default threshold is 80% (`behavior.autoCompactThreshold`). You can adjust this in Settings → Behavior; the valid range is 10–100.

When auto-compaction fires, a before/after notice appears in the transcript. The current context fill level is shown in the shell footer when usage exceeds 50%.

Use `/compact` to compact manually at any time.

## Knowledge ask

`/knowledge ask <query>` asks the platform knowledge/wiki layer for a source-backed semantic answer. Use `--space <knowledgeSpaceId>` to target a specific space such as a Home Assistant graph, `--limit <n>` to bound evidence, and `--mode concise|standard|detailed` to select answer detail.

The TUI displays the platform-returned answer text, sources, facts, linked objects, gaps, confidence, and synthesized state directly. It does not turn search results into local snippets.

## Live TTS commands

`/tts <prompt>` submits a normal chat turn and adds live spoken output for that one turn. Text still renders normally in the transcript. Assistant deltas are chunked at sentence or phrase boundaries and streamed through the configured TTS provider.

`/tts stop` cancels active playback and pending TTS requests without deleting the text response.

`/config tts` opens the TTS category in the fullscreen configuration workspace. It manages the defaults used by spoken-output clients:

| Key | What its row does |
| --- | --- |
| `tts.provider` | Choose a provider with streaming TTS support |
| `tts.voice` | Choose a voice from that provider |
| `tts.llmProvider` / `tts.llmModel` | Choose an optional `/tts` response model override through the fullscreen provider/model workspace |

Without that override, `/tts` uses the current chat provider/model. Live local playback requires `mpv` or `ffplay` on `PATH`.

## Cloudflare batch commands

Cloudflare integration is optional and keeps local immediate daemon behavior by default. Select `Use Cloudflare for batch or remote daemon work` in onboarding to configure it visually, or use `/cloudflare` for runtime actions.

The high-signal subcommands, in the order a setup normally uses them:

| Command | Does |
| --- | --- |
| `/cloudflare status` | Show the integration's enabled/ready posture and every configured resource |
| `/cloudflare requirements` | List the API-token permissions the integration needs |
| `/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME>` | Create the scoped API token from a bootstrap token |
| `/cloudflare discover` | Discover existing account resources usable by the integration |
| `/cloudflare validate` | Validate the token and configuration without changing anything |
| `/cloudflare provision --batch-mode explicit` | Provision the Workers/Queues resources |
| `/cloudflare verify` | Verify the provisioned resources end to end |
| `/cloudflare disable` | Turn the integration off |

The TUI calls platform daemon routes only. It does not call Cloudflare APIs directly. See [Cloudflare batch and control plane](cloudflare-batch.md) for token setup, supported components, and provisioning behavior.

## Workflow-oriented commands

Some command families are especially important when you are running GoodVibes as an operational console rather than just a chat surface:

- `/teamwork` for the packaged task modes and orchestration recipes that produce WRFC and related execution chains
- `/schedule` for cron-like and interval-based automation
- `/hooks` for managed hook inspection and simulation
- `/remote` for dispatching and recovering distributed work
- `/sandbox` for isolation review and the live sandbox session

There is no standalone `/workflow` command; contract and workflow state is visible in Agents (`F2`, `Ctrl+O` or `/agents`).

For the exec sandbox and what REPL and MCP isolation currently is, see [Sandbox](sandbox.md).

## CLI session lifecycle flags

Three flags control which session is active when the TUI opens:

- `--continue`: resumes the most recently active session for the current working directory (reads the last-session pointer file; when no pointer exists it says so and starts a new conversation as a plain launch would).
- `--resume [id]`, `-r [id]`: resumes a specific session by id. When the id is omitted, resolves via the same last-session pointer as `--continue`.
- `--fork [id]`: forks a session into a new branch. Bare `--fork` forks the session already active when the TUI starts; `--fork <id>` resumes the named session first, then forks it.

Only one of `--continue`, `--resume`, and `--fork` may be used in a single invocation. Combining them is an error.

When a session is resumed, the TUI prints `Resumed session: <id>` with message count and model to the transcript. When a session is forked, it prints `Session forked:` with the new id, fork name, source title, and message count.

A session that crashed before saving is offered back through the startup recovery modal instead of any of these flags. See [the startup recovery modal](getting-started.md#the-startup-recovery-modal).

See [CLI flags reference](cli-flags.md) for full syntax, inline-value forms, and examples.

## Related docs

- [Getting started](getting-started.md)
- [CLI flags reference](cli-flags.md)
- [/share: session export](share-command.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
- [Project planning](project-planning.md)
