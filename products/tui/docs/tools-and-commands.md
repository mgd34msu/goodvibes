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
| `query` | Leave the owner a question and carry on; their answer comes back on a later request |
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

The `repl` tool evaluates one snippet and returns its printed value and output. `runtime` picks the language:

- `javascript` (the default) or `typescript`: run with Bun; the value of the last expression is printed
- `python`: run by the system `python3` in isolated mode (`-I`); the `repr` of the last expression is printed, as the interactive interpreter does
- `sql`: run on a fresh in-memory SQLite database; the rows of the last statement that returns rows are printed as JSON (or, when it returns none, the changes and last inserted row id). A binding is passed to each statement that names it as `$name`, `:name` or `@name`
- `graphql`: the document is parsed and printed in normal form with its operations and fragments; with a `schema` binding (the schema as SDL text) it is also validated and every error is listed. Nothing is executed, so this runtime does not use the sandbox

Each JavaScript, TypeScript, Python or SQL evaluation is one command through the same path as `exec`, so the command sandbox, its containment and the credential scrub apply to it unchanged. It is offered only where that path is contained: the per-command sandbox is on (`sandbox.enabled` and the `exec-sandbox` feature) and the host has bubblewrap. Elsewhere the tool is not in the model's tool list.

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
- Named service registry: configure API credentials once in `~/.goodvibes/tui/services.json`, reference by name in fetch calls (a project's `.goodvibes/tui/services.json` adds services only when they name keys in your secret store and you confirm each with "Use a service this project defines" (`y` on the Services tab of Models and providers); references and `oauth` blocks are used only from your own file)
- Inline auth: `bearer`, `basic`, `api-key` per request
- Batch parallel fetches in a single tool call
- A call whose every request is `GET`, `HEAD` or `OPTIONS` is a read and runs beside the other reads of the same response; a call with a `POST`, `PUT`, `PATCH` or `DELETE` runs alone, in the model's order, and is decided as a change (plan mode refuses it)

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
- what the session's agents and contracts actually did (state, files read and changed, last report, also across a restart) via the `activity` mode
- Cohort tracking via `cohort-status` and `cohort-report` modes

Agents start when you asked for them earlier in the conversation ("fan out agents over these files", "assign these to a set of agents") and have not since forbidden or limited them; a later message about something else does not withdraw that. When you said "do not use agents" or "do it yourself", the call is refused with your words quoted. Only when your words do not settle it is the decision model asked; when it cannot answer, `yolo` and `just-vibes` start the agents and `ask-me` asks you once in the approval prompt, and your answer stands for the rest of the conversation.

### state

Session state, persistent memory, telemetry, hooks, and the print level, all in one tool.

- KV state: session-scoped key-value store with atomic persistence
- Memory by key (`mode: "memory"`): get, set, list and delete project memories; each is one record in the project memory store, the record prompts retrieve, read and written through the daemon while it serves memory (the full durable-memory workflow lives under `/memory` and the knowledge modals)
- Hook management: list, enable, disable, add, and remove hooks at runtime
- Print level: read or set how much the app prints (`quiet`, `balanced`, `operator`), the same setting as the print level row of System, This session (`behavior.hitlMode`)
- Analytics: every tool call this process ran (name, status, duration, result size; never arguments or results), queried by filter, exported as JSON/CSV, or summarized; kept in memory, the newest 10,000
- Budget and context: the session's measured token usage and turns, and its context window (last request size, window size, compaction), with how many files this product has read or written in the workspace

### workflow

Workflow state machines, hook actions, and scheduled commands. See [Automation and scheduling](#automation-and-scheduling) below for the underlying contract model.

- Named workflow definitions: `contract` (starts a contract whose units are checked against acceptance criteria), `fix_loop`, `test_then_fix`, `review_only`
- State machine with validated transitions: prevents invalid state changes
- Hook actions (`mode: "hook-actions"`): run a command when a hook event fires, with an optional condition over `event.*` and `payload.*`; schedules (`mode: "schedule"`) run a command on an interval and can be paused and resumed. Both are judged once when added, by the same permission questions an `exec` command gets (a refusal says why), run in the project root with credential variables withheld and inside the exec sandbox when it is on, list their last run, exit code and error, and last until the app exits; schedules made in Automation survive restarts
- Scheduled jobs run by the automation manager: 5-field cron expressions read in an IANA timezone (a leap-day `0 0 29 2 *` is accepted; a day no named month has, such as `0 0 31 2 *`, is refused), fixed intervals and one-shot times, missed-run recording, per-job run history, and enable/disable control; persists to `.goodvibes/tui/automation-jobs.json`
- Full lifecycle: start, transition, cancel, list active instances

### task / work_plan / teams

Structured execution and coordination beyond a single conversation turn.

- `task`: create, inspect, block, cancel, depend, and hand off tasks across sessions
- `work_plan`: the project's checklist, the one the Work place shows: add items, set their status, owner and notes, remove them, clear finished ones; spawned agents keep the same checklist
- Teams are `agent` cohorts: spawn the members with one `cohort` name, each with its template as its role and its `communicationLane`; brief each with `context` and `successCriteria`; `cohort-status` and `cohort-report` read the team back, and the fleet view shows the cohort beside each agent

### query

- `query`: leave the owner a question and carry on working. `ask` posts it to the owner inbox and returns its id at once; the owner sees it in Waiting for you in either terminal app and, when push is on, as a notification on their phone, and answers it there. The question is recorded as asked by the session. When the owner answers, the answer is passed to the asker on its next model request: a spawned agent while it runs, otherwise the conversation that asked or spawned it. If that session is not open when the owner answers, they are told the answer is saved and will be delivered when the session is next opened, and it is put into the conversation once when the session is resumed (the Sessions place, `/resume`, the session picker, `--continue`/`--resume`, headless runs included). Deleting the session withdraws its open questions and marks its waiting answers not deliverable. Waiting for you's Answered tab shows each answer as delivered, waiting for its session to be opened, or not deliverable with the reason (a deleted session, an agent that can never run again); the answer stays on the question in every case. `show` and `list` read it back at any time; `withdraw` takes back a question that no longer matters. A `key` makes a repeated ask return the first open question instead of posting a second one. There is one owner inbox per home (`~/.goodvibes/shared/owner-inbox.sqlite`), shared by the daemon, this app, the Agent and every other terminal at once: a question asked in one shows in Waiting for you in all of them, and an answer given in any of them reaches the asking session on its next model request, with no restart. While the daemon is reachable the inbox is read through it (so its permission asks are listed too and the phone is pushed)

### mcp / remote / control

Product-control tools that expose runtime breadth directly. See [MCP integration](#mcp-integration) below for the connection and config model.

- `mcp`: call a connected server's tool (`mode: "call"` with `qualifiedName` and `input`), and inspect MCP servers, tools, schemas, schema freshness, security posture, auth posture, and quarantine controls. The inspecting modes, and calls of server tools the server marks read-only (`readOnlyHint`), run beside the other reads of the same response; any other call runs alone
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
| `/model` | Your model and the others you can use, switching, backup models, and reading the list of models again |
| `/settings` | Open the settings screen at a setting (`/settings open <setting>`), see one (`get`), change one (`set <key> <value>`; a credential goes to the secret store) or put it back (`reset`) |
| `/memory` | Opens Memory and knowledge (also the menu, `Ctrl+G` then `m`): what the project remembers, your structured knowledge (pages, files, bookmarks, its entries, issues and jobs), what is known about you, and your prompt templates; every action is a key on the thing it acts on |
| Work and agents (the menu): Runners, Runner pools, Handed back | Start, follow, stop and review self-hosted remote runners and what they hand back; the daemon keeps them |
| `/permissions` | Opens Permissions and safety: this conversation's permissions and plan mode, rules, secrets, this folder's trust, who may sign in, who is who, device tokens, phone grants, the policy bundles, the sandbox setting and sessions, and what needs attention |
| Tools and extensions (the menu) | Hooks and the hooks that ran, hook points, the model's tools, tool servers (MCP), plugins and their trust, the marketplace and what you installed from it, skills, presets and managed settings; every action is a key on the thing it acts on |
| Sessions (the menu; `/resume` and `/fork` are typed) | Your conversations: resume, rename, copy, write to a file or upload for a link, delete, search, branches, the record, and cross-session tasks |
| System place, This session and Voice | Hear an answer spoken, speak every answer, stop playback, and set up the local voice runtime and the wake word (voice has no slash command) |
| `/mcp` | Opens Tools and extensions on its Servers tab: your MCP servers and their tools |
| Work and agents (the menu): Recorded runs | Deterministic replay: load, step, jump, compare and save the report of recorded runs |
| Work and agents (the menu): Evaluations | Evaluate the product on real tasks: run a task suite through goodvibes run, compare with the baseline, and gate regressions |
| Tools and extensions (the menu): Tools, `M` | Make an image or a video through a configured provider; a job still running is collected in Work ("collect a media job"); the providers are the Media tab of Models and providers |
| `/work` | Open the Work place: your work and its plans, a plan waiting for your approval, the questions it asks, a failed step run again, its spending limit, past work, the checklist and the tasks running in the background |
| `/checkpoint` | Workspace checkpoints: list them, make one, put the files back to one (`restore <n\|id>`, previewed), or go back to an earlier turn (`rewind`, previewed) |

Code and changes, in the menu or typed as `/changes` (`/changes staged`, `working` or `head` opens the Changes view on that set), is the place for the project's files: the changed files (`Enter` opens a file's diff in the Changes view, `c` commits every change, `v` reviews this session's changes), the recent commits, the worktrees (pause, resume, keep, run setup again, tie to a session or task, remove, stop tracking), the code index (how it stands, `b` builds it) and code intelligence (what is ready, the files with problems, the lookups and installing a language server), with `t` running the project's tests and `f` finding code in the index anywhere in it.

The controls on the conversation itself are in the menu's "This conversation" row (the leader, then `m`): each row is one control, with what it acts on now and the key or typed line that also reaches it, and `Enter` runs it (a form asks for what it needs). Among them: name this conversation, write the message in your editor, send an image with a message, paste the clipboard, read the folded pastes, see, change or take back a queued message, see what fills the context, see and choose how hard the model thinks, save this session under a name or as a file, branch it, fold or open its blocks, see what compaction removed, and the guidance. The model reaches the same controls through `capability_find` and `capability_run`.

"Write the message in your editor" opens the current composer draft in your `$VISUAL`/`$EDITOR`, suspends the TUI while the editor runs, and loads the edited text back into the composer when you save and quit. Set `$EDITOR` (e.g. `export EDITOR=nvim`) for it to work.

Composer capture markers: a single line beginning with `# ` (a hash and a space) saves the rest as a session-memory note and does NOT send a turn (a quick "jot this down"), and a confirmation names what was saved and where. (`#482 is failing` (no space), `## ...` markdown headings and multi-line text that starts with `#` are left alone and sent normally.) A typed prompt that starts or ends with `@model:<id>` (`@model:opus summarize this`, `summarize this @model:opus`) switches model exactly as `/model <id>` does (same label, reasoning effort and missing-key prompt) and then sends the rest; only a whole token at either end counts, the same rule as the Agent, and when the switch does not land the rest stays in the composer instead of going to the old model. The existing `!# <text>` still pins to session memory and also sends the text as a prompt. Text that is not typed into the composer (a skill's body found by its trigger, `/retry`, a template, an image sent from This conversation, a form, speech) is sent as written and never read for these markers.

A typed line that starts with `!` runs the rest as a shell command in the working directory, beside the composer: the output is shown and goes in front of your next message as context, and `Esc` stops a command that is still running. Spoken input is never run as a shell command.

Automation, in the menu (the leader, then `m`), is the place for what runs by itself, kept and run by the daemon: your schedules (`n` new schedule; on one `g` run now, `p` pause or resume, `c` change, `x` remove), their runs (`s` stop one that is going, `t` run a failed one again), your triggers (`n` watch for something; `h` what it did, `x` stop, `s` start one that gave up), the commands triggers may run (`n` let triggers run one), your CI watches (`n` watch a repository, `k` check one now; `g` check a watch now, `x` stop watching) and what the check-ins did (`g` check in now). Every list reads by itself and follows changes made anywhere. New schedule's "Describe it" accepts natural-language times, for example `every weekday at 9am`, `daily at 6pm`, `every 30 minutes`, `every monday at 08:00`, or `in 2 hours`; the daemon reads them, and the outcome line says the concrete interpretation it kept.

"Search the web" (`w` on the Tools tab of Tools and extensions, `tools.web-search`) runs a provider-backed web search through the daemon and shows ranked results, an instant answer, and where each came from; a failed search says why, using the web-search service's own status note.

"Make an image or a video" (`M` on the Tools tab, `media.make`) asks the daemon's first configured provider that makes images; a provider that only makes video is never sent the request. Each image is written to a file in the project, `generated/<prompt words>-<time>.<ext>` or the file given in the form inside the project (a file already there is never replaced), the path is said, and after your own press the terminal app opens it in the desktop's viewer (a model's call opens nothing). The daemon's artifact store keeps a second copy, so the image stays available after the provider's own link expires. When no configured provider makes images, it says each generation provider's status, what it makes, and the key it needs. A job the provider accepted but had not finished when the wait ended is reported with where to collect it later: "collect a media job" in the Work place. ("Send an image with a message", in This conversation, is the other direction; it sends a local image file with a message for multimodal analysis.)

Session work is the Sessions place (the menu, `Ctrl+G` then `m`); there is no `/session`, and `/resume` and `/fork` are the two typed commands that remain for it. Its tabs and keys:

| Tab | Keys |
| --- | --- |
| Sessions | `Enter` resume a saved one here, `e` rename, `f` continue in a copy (this one), `u` upload this one for a link (deleting the Gist on GitHub takes it down), `w` write one to a file, `x` delete a saved one, `v` its details, `s` search saved sessions |
| Branches | `Enter` switch to a branch, `m` bring its messages in |
| Record | `Enter` opens the transcript's events, groups, hotspots, restored entries or a bookmarked block; `i` this session, `p` what the message box waits on, `c` find words in it |
| Hand-offs | The cross-session task graph, with cycle detection: `g` the whole graph, `n` add a task, `o` hand a task to another session, `a` accept one, `w` take it back, `x` cancel it |
| Hosted, Joined here | Hosted sessions: `h` start one, `Enter` join, `x` end; in one joined here `t` send a message now, `l` leave |

Saving this session under a name (refused when a different saved conversation already uses it, unless you choose to replace it) and saving it as a Markdown or text file are controls of This conversation. Each is a capability (`session.*`, `hosted.*`) a model or a script runs too.

`/model` opens its list of actions: see your model and the others you can use (`list`), switch (`use <model>`), read the list of models again from every provider (`refresh`, which says for each provider how many models it found or why its list could not be read), and add or remove backup models (`backup`, `drop-backup`). Clicking the model in the status bar opens the fullscreen provider/model picker. It opens on `Main chat`; the other jobs (`Side work`, `Tool work`, `Spoken replies`, `Decision model`, `Search index`) sit behind `Other jobs (optional) ▸` and `Tab` reaches them. A model tab lists only models the catalog says read and write text, with models it does not describe last and marked `not in the catalog`, each row shows its price tier when known, and the list filters large model catalogs by search, price tier, capability, availability, benchmark sort, and grouping, with each filter key and its setting on the row under the search field.

The Work place (`/work`) holds your work: asking for it in your own words sends your exact words through the host's intake, with no historical planning fallback. Work brought in from old planning records is in its History list, read only. The checklist is its Checklist list. See [Work](native-work.md).

"Paste the clipboard into the prompt" (in This conversation, or `Ctrl+V`) explicitly reads the system clipboard and inserts supported text or image data into the prompt. Use this when terminal paste does not deliver image clipboard contents to the TUI; it uses the clipboard helper path instead of relying on the terminal paste stream.

`/mcp` opens its list of actions (See your servers, Add a server, Choose what a server may do…, Check a server that isn't working…); `/mcp open` opens the full-screen MCP screen. `/mcp add <name> -- <command> [args...] [--scope project|global]` writes a project server to `.goodvibes/mcp.json` or a global server to `~/.config/mcp/mcp.json`, then reloads the live MCP runtime without restarting. `/mcp remove <server> [--scope project|global]`, `/mcp reload`, `/mcp files` and `/mcp tools [<server>]` do the same from the command line; a line with a blank missing opens the guided step for it. See [MCP integration](#mcp-integration) below for the config file shape and connection model.

## Keyboard shortcuts

Most shortcuts are customizable via `~/.goodvibes/tui/keybindings.json`. Use `/help keys` to view current bindings.

Every key the program acts on is in that table, `Tab`, `Enter`, `Esc` and the arrows included (`next-field`, `choose`, `back`, `move-up` and the others): a key bound to one of them is that key on every screen, and one of those keys bound to another action does that action instead. Change one in the System place's Keys tab (`Ctrl+G` `m`, then System: `Enter` on a key, then press the new one; `d` puts back its default, `Shift+D` every default) or in the file. `F2` (Your agents, `open-agents`), `PageUp` / `PageDown` (`scroll-page-up`, `scroll-page-down`), and the question card's arrows, `Enter` and `Esc` are in the table too, and each place's letters are a group of it (`place.automation.pause`, listed in the Keys place under the place's name). These keys are fixed: `Shift+Enter` (new line), `?` (the list of every command and key, on an empty prompt), `@` (file picker), the mouse, and the letter keys inside an older view, search or picker (`n` / `N`, `Ctrl+X` to stop, and the selection-modal keys below), which move into the table as those views become places.

The leader (`Ctrl+G`, the rebindable `leader`) starts a two-key shortcut over every screen: after it, a strip at the bottom of the screen lists every key that can follow and what it does, and the next key completes the shortcut or cancels it (on a settings screen, the key after it is that screen's action letter when it has one, and the strip lists those letters first). There is no time limit. `Ctrl+G` `m` opens the menu of every place; `Ctrl+G` `g` groups the model list another way.

### Input and editing

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Tab` | Path completion, else toggle block collapse |
| `Ctrl+U` | Kill from cursor to start of line (push to kill ring) |
| `Ctrl+G` `u` | Clear entire prompt (no kill-ring push) |
| `Ctrl+W` | Kill word backward (push to kill ring) |
| `Ctrl+G` `k` or `Ctrl+X` | Kill from cursor to end of line (push to kill ring) |
| `Ctrl+G` `d` or `Ctrl+Delete` | Kill word forward (push to kill ring) |
| `Ctrl+G` `y` or `Ctrl+\` | Yank from kill ring |
| `Ctrl+G` `Y` or `Ctrl+]` | Yank-pop (rotate kill ring, replace last yank); only valid immediately after a yank |
| `Ctrl+G` `b` or `Ctrl+Left` | Move word backward |
| `Ctrl+G` `f` or `Ctrl+Right` | Move word forward |
| `Ctrl+Z` | Undo prompt edit |
| `Ctrl+G` `z` or `Ctrl+^` | Redo prompt edit |
| `Ctrl+V` | Paste (image or text) |
| `@` | Open file picker (insert file path) |
| `?` | Open the list of every command and key (empty prompt) |
| `Ctrl+G` `r` / `o` / `i` / `s` (or `F12` / `F9` / `F3` / `F4`) | On the newest failed turn's row: try again / use another model / details / sign in again |

The actions that sat on an `Alt` or `Ctrl+Shift` chord (which tmux, screen and macOS Terminal swallow) are a leader shortcut by default, each beside a second key every terminal sends: `Ctrl+G` `t` cancel the running tool `Ctrl+T`, `Ctrl+G` `a` keep-awake `F6`, `Ctrl+G` `e` memories used `F7`, `Ctrl+G` `v` voice `F8`, `Ctrl+G` `n` / `p` next and previous session `Ctrl+Q` / `Ctrl+_`, `Ctrl+G` `c` copy selection `F5` (and `Ctrl+Shift+C`, where the terminal passes it on), `Ctrl+G` `j` open the fix session `F10`. A chord can be bound back in `keybindings.json` (`{ "kill-line": { "key": "k", "alt": true } }`), and one bound there before this release stays bound.

`Ctrl+W` uses whitespace-delimited word boundaries (readline/unix-word-rubout semantics), while the word-forward, word-back and kill-word keys use Unicode word boundaries (letters, digits, underscore).

`Ctrl+K` opens the list of every command and key (the same as `Ctrl+P`, `?` and `/help`), not kill-to-end-of-line; that kill is `Ctrl+G` `k` or `Ctrl+X`. `Ctrl+U` kills to the start of the line and pushes the text onto the kill ring (readline convention), while `Ctrl+G` `u` clears the whole buffer regardless of cursor position and pushes nothing.

### Navigation

| Key | Action |
|-----|--------|
| `Arrow Up / Down` | Scroll conversation / recall input history (a recalled message keeps its folded pastes, with their text, across restarts) |
| `PageUp / PageDown` | Scroll by page |
| `Ctrl+R` | Reverse input history search |
| `Ctrl+E` | Move to end of line / next error |
| `Ctrl+A` | Move to start of line |
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
| `Ctrl+G` `c` or `F5` | Copy selection |

### Views

Every view opens as a modal over the dimmed conversation, and `Esc` closes one level at a time.

| Key | Action |
|-----|--------|
| `Ctrl+P` / `Ctrl+K` | The list of the commands that remain and every key (also `?` and `/help`); older view names (fleet, tokens, git, …) are search words too, and the keyboard shortcuts are the last group; everything else is in the menu (`Ctrl+G` `m`) |
| `F2` / `Ctrl+O` | Your agents: what is waiting for you, running, scheduled and finished, with background services behind one line; open an agent or background process full screen (`Enter`), stop it and what it started (`s` or `Ctrl+X`, asks first) |
| `Ctrl+N` | The notices the status bar counts |
| `Ctrl+G` `m`, Money | Spending: this conversation's context against the compaction threshold, totals and cost against the spending alert, its turns, its agents' costs; `c` shortens it now, `w` sets the spending alert |
| `/changes` | Changes: changed files with +/- counts, a tinted syntax-colored diff, the semantic summary, hunk navigation (`]` `[`), stage hunk (`space`), review comments (`c`), mark reviewed (`m`), open in editor (`o`) |
| `Ctrl+G` `m`, System, Notices | Notification history |
| `/resume` | Session picker, with hosted sessions in a Hosted group |

An agent or a background process can take over the whole terminal. `Enter` on an agent's lane in the work tree (or on its row in Your agents) opens the agent: its work is the spine, its own children branch off it, the header reads `main › engineer` in the agent's color, and the composer steers the agent while main keeps running. `Enter` on a `▶` bead (or a process row) opens the process: live output with timestamps, errors in red, follow mode on. The process view takes no input, because GoodVibes cannot write to a background process's stdin; `/` searches its output and `y` copies it. While more than one session exists, a row of session chips under the header lists them, and `Ctrl+G` `n` / `Ctrl+G` `p` (the rebindable `next-session` and `previous-session`) switch between them; the row ends with those keys.

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

The config modals (the ones built on the config-modal host) have an always-live search row: every typed character goes into the search and never fires an action. An action fires from `Enter`, from `Ctrl` plus its letter (the hint bar shows `^d delete`), or from the leader (`Ctrl+G` unless rebound) followed by its key (the hint bar shows `^G c` for the keys a terminal cannot send as a Ctrl chord: `c`, `h`, `i`, `j`, `m`, digits and capitals). An action that deletes, uninstalls or clears asks for the same keys a second time; `Esc` cancels it.

### System

| Key | Action |
|-----|--------|
| `Ctrl+C` | Clear input / cancel generation / exit (double-press to quit) |
| `Ctrl+K` | Open the list of every command and key (search and run any command) |
| `Shift+Tab` | Cycle this session's execution mode: ask-me → jev-decides → just-vibes → yolo, asking before yolo (declining moves on to ask-me); the saved default changes only in `/settings` (plan is outside the cycle; its row on This conversation in Permissions and safety toggles it). It does this in every state, also while the session chips show |
| `Ctrl+G` `n` / `Ctrl+G` `p` | While the session chips show: the next / previous agent or process (`next-session`, `previous-session`) |
| `Ctrl+X` | Inside an agent or process view: stop what it shows (the first press asks, the second stops) |
| `Ctrl+G` `t` or `Ctrl+T` | Cancel the running tool call (the turn continues) |
| `Ctrl+G` `a` or `F6` | Toggle keep-awake (the "sleep disabled" chip) |
| `Ctrl+G` `e` or `F7` | List or hide the memories a turn used (provenance chip drill-in) |
| `Ctrl+G` `v` or `F8` | Voice input: press to start recording, press again to stop and transcribe into the composer |
| `Ctrl+G` `m` | The menu of every place (also a click on `ctrl+g m menu` in the status bar) |

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

When an agent is spawned, it can be given its own git worktree. On completion, changes are merged back. On cancellation or error, a worktree with nothing unique in it is removed at once; one with uncommitted changes or unmerged commits is kept (see Worktree retention in the orchestration runtime doc), and the Worktrees list of Code and changes shows how old it is, how large, and why it is kept.

## Hook system

Hooks fire on lifecycle events throughout a session. They are configured in `hooks.json` in the project working directory (or a custom file set in `tools.hooksFile`, also resolved against the project working directory). A hooks file inside a workspace you have not trusted is not loaded and runs nothing: a cloned repository cannot bring commands that run on its first event. At start the app says once that the workspace's hooks wait on its trust; "Trust this folder" in Permissions and safety, This folder, loads them at once. A hooks file outside the workspace (an absolute `tools.hooksFile`), or a workspace that is your home directory, is yours and loads as before.

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

Wildcards are supported: `Pre:tool:*` matches all pre-tool events. The Hook points tab of Tools and extensions lists every hook point (`hooks.contracts`, which also takes words to filter the list).

A hook fires on the key it is listed under in `hooks.json`. A key that is not exactly `Phase:Category:Specific`, or that no hook point matches (segments are case-sensitive, so `pre:tool:exec` never fires), is not loaded: the reason is logged as a warning, and `goodvibes hooks validate` reports it.

Tool hooks fire for every tool call: the conversation's own, and those of spawned agents, background workers and contract units. A `Pre:tool:*` hook runs before the call is admitted, in every permission mode (`yolo` included). It can refuse the call (`decision: "deny"`), put it to you (`decision: "ask"`), rewrite its arguments (`updatedInput`, which is what the permission check sees and what runs), or add a note (`additionalContext`) that the model reads with that call's result. When several hooks answer, a deny outranks an ask and an ask outranks an allow, so one hook's `allow` never cancels another's `ask`. A `Pre:tool:*` hook that fails (an error, a timeout, a non-zero exit) refuses the call and says which hook failed. `Post:tool:*`, `Fail:tool:*` and the file hooks observe: they run beside the turn, so the next call does not wait for them.

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

A step's `within` and `debounce` are a number with `ms`, `s`, `m` or `h` (`500ms`, `30s`, `5m`, `1h`); a chain with any other value is not registered, and the reason is logged. An optional step is skipped when an event for the next step arrives, and that event also ends an optional step's `debounce` wait early. A chain cannot be switched on or off: switching on and off (`o` on the Hooks tab) acts on hooks, and removing (`x`) takes out a hook or a chain.

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
| `async` | Run in the background without blocking; its answer is discarded, so it is refused under a point that waits for its hooks to deny, ask or rewrite the call (a `Pre` point): an observer belongs under a `Post` or `Fail` point |
| `once` | Runs once per daemon or app run, then is removed; a restart or an edit to the entry arms it again |
| `description` | Documentation text |
| `name` | Optional name for programmatic enable/disable/remove |
| `enabled` | Whether the hook is active (default `true`) |

The `HookDefinition` type in the engine's `platform/hooks/types.ts` is the authoritative field
set and carries a small number of advanced, situational fields beyond this
table.

## Automation and scheduling

Beyond individual hook definitions, GoodVibes treats hook points, workflow runs, and scheduled tasks as a managed contract rather than plain fire-and-forget shell calls.

- Hook-point contracts carry execution authority, mutation/injection permissions, timeout policy, and failure policy metadata: a hook point declares what it is allowed to do, not just what triggers it
- Managed hooks support scaffold, chain, enable/disable, inspect, import/export, and simulation flows through the Hooks and Hook points tabs of Tools and extensions and the `state` tool's hook management modes; the Hook runs tab shows which hooks ran, when, on what, and what each did
- Workflow state machines (`fix_loop`, `test_then_fix`, `review_only`) drive validated transitions for multi-step review/fix cycles. See [Tool reference: workflow](#workflow) above
- Cron-like scheduled agent tasks support timezone-aware schedules, missed-run tracking, run history, and manual trigger support, managed in Automation (the menu)

A piece of work's plan and the project's checklist are related but separate. See [Project planning](#project-planning) below and [Project planning](project-planning.md).

## MCP integration

Connect to any MCP-compatible server from inside the running TUI. Project-scoped servers live in `.goodvibes/mcp.json`; global servers live in `~/.config/mcp/mcp.json`. You can also edit either file directly:

GoodVibes also reads MCP servers already configured for other tools, read-only: a project's `.mcp/mcp.json`, a user's `~/.mcp/mcp.json`, and Claude Desktop's `~/.config/claude/claude_desktop_config.json`. Servers found there show up alongside your GoodVibes-configured servers, but `/mcp add` and `/mcp remove` only write to the two GoodVibes-owned files above. When two files name the same server, they are taken in this order and a later one's entry is used: `~/.mcp/mcp.json`, Claude Desktop's file, the project's `.mcp/mcp.json`, your `~/.config/mcp/mcp.json`, then the project's `.goodvibes/mcp.json` (once the workspace is trusted); so your own global entry wins over another program's, and `/mcp add --scope global` takes a server over. A denial only tightens: the merged entry keeps every file's `deniedTools` for that server and the strictest `trustMode` any of them set. Those other files are never moved or rewritten: one that cannot be read, or holds no server list GoodVibes recognises, is skipped with one warning. In the GoodVibes-owned files an entry missing its name, or a command or url, is skipped with a warning and kept as written when the file is next saved. A server whose entry names no `trustMode` runs as `ask-on-risk`, and the `/mcp` workspace shows and keeps that default until you change the trust field.

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

A server with a `url` instead of a `command` is a remote HTTP server. Give it a `headers` object (for example `"headers": { "Authorization": "Bearer ..." }`) to send credentials on every request; the headers are never shown by the read routes, and an edit that does not resend them keeps them. Fields GoodVibes does not model are kept when it rewrites the file. A server name may not contain `:` or `/`; such an entry is skipped with a warning rather than blocking other edits. `trustMode: "allow-all"` is honoured only from the global config: in a project file it is ignored (with a warning) and the default trust mode applies, so a checked-out repository cannot grant its own servers unrestricted trust. The project files (`.mcp/mcp.json` and `.goodvibes/mcp.json` in the workspace) start no server until you trust the workspace (an undecided workspace counts as not trusted), and until then a server they name does not take the place of one of yours with the same name; the app says so once at start, and "Trust this folder" in Permissions and safety, This folder, starts them. Your own files (`~/.config/mcp/mcp.json`, `~/.mcp/mcp.json`, Claude Desktop's) are not affected.

One tool of a server can be ruled on its own. `/mcp block <server> <tool>` refuses every call to it for this session only, whatever the server's trust level and limits allow. `/mcp block <server> <tool> --keep` keeps the block with the server's entry as `"deniedTools": ["<tool>"]` until you change it, after a restart too. `/mcp exempt <server> <tool>` keeps `"allowedTools": ["<tool>"]`: calls to that tool pass the server's `allowedPaths` and `allowedHosts`, while a blocked server, held-back tools or a block of the same tool still refuse it. An exemption loosens what a server may do, so it is yours alone: it is refused when the model runs it (`/mcp unexempt` puts it back), the daemon refuses it for the Agent's model, and it is kept only in your global config (an `allowedTools` list in a project file is ignored with a warning, like `allow-all`). `/mcp unblock <server> <tool>` removes this session's block and the kept one, and says which it removed; it loosens, so it is refused when the model runs it (`/mcp block` puts it back). `/mcp unexempt <server> <tool>` removes only a kept exemption. On a server's row in Settings -> MCP, typing `block`, `unblock`, `exempt` or `unexempt` (a tool is optional) opens that `/mcp` action for the server, the `/mcp` screen's form edits the blocked tools, and the web app lists each server's tools with their rules under Settings > Permissions > MCP tool rules. A rule written while a server runs applies at once, without restarting it: a call not yet sent to a newly blocked tool ends. `/mcp servers` lists each rule with where it came from (this session or the config).

MCP tools are named `mcp:<server-name>:<tool-name>`; the assistant lists them with the `mcp` tool (`mode: "tools"`) and runs one with `mode: "call"`, passing that name as `qualifiedName` and the tool's arguments as `input`. A call waits up to 120 seconds for the server's answer; then it is cancelled, the server is told, and the result says whether the server still answers a health check (the tool is slow and may still finish its work) or not (reload it). Set `toolTimeoutMs` on a server's entry to give its tools a different deadline, or `0` for none. The call goes through the server's trust mode, quarantine state and permissions, and its answer is treated as untrusted content. Tool schemas load progressively: names and descriptions at startup, full parameter schemas on first use. A server whose connect fails, or a stdio server that exits unexpectedly, is reconnected automatically while `runtime.mcpLifecycle` is on (the default): attempts wait 1 s, 2 s, 4 s, 8 s and 16 s (never more than 30 s), each one a full connect through the same checks as the first, and the count resets once the server is connected again or you run `/mcp reload`. After five failed attempts the server stays disconnected. A stdio server that starts but never answers the handshake is given up on after 30 seconds (its process is stopped), so one silent server cannot hold up the others; configured servers connect a few at a time rather than one after another. A server whose output stream closes while its process keeps running is stopped and reconnected the same way as a crash. `/mcp servers`, the MCP workspace and the `mcp` tool report each server's phase (`starting`, `negotiating`, `ready`, `restart-wait` while a reconnect is scheduled, `gave-up`, `closed`), its last error, and the reconnect attempt, limit and time to the next attempt, or why reconnecting stopped. A tool call to a server that is not connected says which of these it is in and what to do next: call again after the next attempt, or fix the server and run `/mcp reload`. With `runtime.mcpLifecycle` off, a server that drops stays disconnected until `/mcp reload`.

MCP tool calls respect the `permissions.tools.mcp` setting (default: `prompt`).

A server's trust mode decides what its scope means. Under `ask-on-risk` (the default), a call whose paths and hosts are inside the server's `allowedPaths` and `allowedHosts` is decided like any other call under your permission mode, and a call outside them is put to you, in every mode including `yolo` (in `just-vibes` it is held for the end of the run); the decision model never answers it. Under `constrained` a call outside the scope is refused, under `allow-all` the scope does not limit calls, and a `blocked` server is not called. The same holds for the Agent's MCP calls. Where nobody can be asked, a call outside the scope is refused and not sent, and the tool result says so (`... Nobody can be asked from here, so it was not sent.`).

When a server asks for input in the middle of a tool call (an MCP form request), what it asks is treated as untrusted. GoodVibes answers only from facts the call already carries, and only when they fit the form exactly: it never fills in defaults, invents a value or gives consent on your behalf, and sending that answer to that server is decided like any other action. When several facts fit, the decision model picks one of them. When nothing in the call answers it (no fact fits, the request cannot be tied to a tool call, or it asks you to open a web page to sign in), the terminal apps put the question to you on the approval card, except in `yolo` and `plan` modes; otherwise, and always in the daemon, it is declined and the tool result carries the server's message and the fields it wanted, so the model can ask you and call the tool again with your answer. A form that asks for credentials or card data, or uses a field type GoodVibes cannot check, is declined. An answer is sent only while the call, the connection and the server's trust settings are unchanged; a server request GoodVibes cannot read is answered with JSON-RPC error `-32600`.

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
  "description": "My custom plugin",
  "capabilities": ["register.tool", "register.hook"]
}
```

`capabilities` declares what the plugin needs: `register.tool`, `register.provider`, `register.hook`, `register.panel`, `filesystem.read`, and the high-risk `filesystem.write`, `network.outbound`, `shell.exec`. A tool, provider or event-hook registration the manifest does not declare is refused and the plugin does not start, with the reason. Commands, gateway methods, channels and delivery strategies need no declaration, but an untrusted plugin may only register commands: a gateway method, channel or delivery strategy reaches the web UI, other devices or outside recipients, so it needs `limited`.

The plugin's trust tier decides what of its declaration it gets, checked at every start:

| Tier | Gets |
| --- | --- |
| `untrusted` (default) | panels, commands and reading files; its tool, provider, hook, gateway-method, channel and delivery registrations are refused |
| `limited` | also the tools, providers and hooks it declares, and gateway methods, channels and delivery strategies |
| `trusted` | also the high-risk capabilities it declares |

A plugin that declares a high-risk capability does not start below `trusted`: it runs inside this process, so a capability it was refused can only be withheld by not running it. The tier is one decision per plugin for every GoodVibes app on this machine (kept in `~/.goodvibes/plugin-trust.json`): "set what it may do" (`s` on the plugin in the Plugins tab of Tools and extensions, `plugin.trust`) sets it and starts a running plugin again at once, or starts a switched-on plugin its old tier kept from starting (`It was started at the new tier.`); switching on a plugin its tier refuses leaves it switched on, so setting the tier starts it whenever you set it, also after the app was restarted; lifting a quarantine (`u`) starts the plugin when it is switched on (`Plugin <name> quarantine lifted and the plugin started.`). The other apps (the agent app, the daemon) apply it the next time they start the plugin; `trusted` is set by a verified signature, or by your confirmation when the signature does not verify. The signature is checked against the publisher's Ed25519 public key, which you save once with `k` (save its publisher key).

### Plugin API

Plugins receive a sandboxed API:

- `registerCommand()`: add custom slash commands, each named `/plugin-<plugin name>-<command name>`; the handler receives the arguments and a context whose `print(text)` shows text in the session that typed the command, and an error it throws (or a refusal while the plugin reloads) is shown there too
- `registerProvider()` / `registerProviderInstance()`: add OpenAI-compatible or fully custom LLM providers
- `registerTool()`: add custom tools available to the LLM; registering a tool name the plugin already registered throws, so the plugin does not start and switching it on, or loading the plugins again, says why
- `registerGatewayMethod()`: add control-plane/API methods
- `registerChannelPlugin()` / `registerDeliveryStrategy()`: extend omnichannel surfaces
- `registerMemoryEmbeddingProvider()`: extend sqlite-vec-backed memory indexing
- `registerVoiceProvider()` / `registerMediaProvider()` / `registerWebSearchProvider()`: extend voice, media, and search families
- `onEvent()`: subscribe to typed runtime events
- `getConfig()`: read plugin-specific settings
- `log()`: emit structured plugin logs

Manage installed plugins on the Plugins tab of Tools and extensions: `o` switches one on or off, `R` loads them all again, and the tab lists them. Loading them again names each plugin that did not start (with its reason), each one left on its current version because calls into it were still running, each one skipped because it is quarantined, and each one whose earlier copy reported an error while stopping.

### Trust, quarantine, and discovery

- local plugin discovery across configured search directories
- plugin inspect/review output with trust tier, quarantine posture, declared and withheld capabilities, and signature fingerprint visibility
- every plugin action is a key on the Plugins and Published plugins tabs of Tools and extensions (see each, how much they may do, where they are looked for, what one asks to do, set what it may do, quarantine, lift it, check its signature, publish a folder, take one out); browsing, installing, updating and uninstalling from the catalog are the Marketplace and Installed tabs

### Curated ecosystem catalogs

Beyond direct local plugins, a local-first curated distribution channel covers plugins, skills, hook-packs, and policy-packs:

- curated ecosystem catalogs with bundle import and export, overview, review, install, update, rollback, uninstall, and installed-receipt flows
- local-first curated plugin distribution via `.goodvibes/tui/ecosystem/*.json` (for all your projects under `~/.goodvibes/tui/ecosystem/`, for one under `.goodvibes/tui/ecosystem/` in the workspace), managed by the daemon and shared across GoodVibes surfaces
- recommendations tied to installed state, denials, and missing capabilities
- the Marketplace tab of Tools and extensions browses the curated plugin, skill, hook-pack, and policy-pack entries; the Installed tab manages what was installed

## Operator surfaces

> **note.** Operator read/navigate surfaces open as
> **modals**: providers/health, services, subscription, remote, sandbox,
> settings-sync and marketplace, plugins, skills, hooks, policy, security,
> knowledge, memory, docs→keybindings, qr-code→pairing, work-plan,
> project-planning→planning. The runtime-ops consoles (cockpit, orchestration,
> tasks, worktrees, approvals, communication, …) open **Your agents**; tokens and
> cost open **Usage**; git, diff and review open **Changes**. The old names
> still work as search words in the list `/help`, `?` and `Ctrl+P` open.

Many commands also have matching modals and control rooms. High-signal examples:

- provider accounts and health: the Health tab of the System place says `✓ Everything is working.` or each thing that is not with what fixes it; "Check one area" there reviews one area: `setup`, `services`, `provider`, `sandbox`, `accounts`, `auth`, `settings`, `intelligence`, `remote`, `mcp`, `memory`, `metrics`, `continuity`, `worktrees`, `maintenance` and `terminal`
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

- Evaluations (Work place) runs a task suite (default `.goodvibes/eval/tasks`: one directory per task with a `task.json` instruction and a `verify.sh`) through headless `goodvibes run`, lets each task's script decide pass or fail, compares runs with a baseline, and gates on a failed or regressed task
- Recorded runs (Work place) loads and steps deterministic replay runs
- "This session's failures" on the same tab shows, saves and keeps this session's failure reports
- Health and diagnostics surfaces expose repair actions, transport issues, task failure state, and replay hooks
- telemetry exporters can write to local ledgers, console sinks, or OTLP bridges
- retention and pruning policy keeps checkpoint/snapshot growth bounded
- idempotency keys prevent duplicate tool execution across replay, reconnect, and retry scenarios
- operational playbooks describe symptoms, checks, and resolution steps for runtime failure classes

Adjacent reliability subsystems: notifications; performance budgets and render-health monitoring; retention and pruning; idempotency protection; and the machine-readable recovery playbooks used by the diagnostics surface.

## Project planning

Project planning is TUI-owned. When a normal chat turn clearly asks for an implementation plan, dependency graph, verification strategy, or agent handoff, the TUI opens the Planning modal, stores state in the platform `ProjectPlanningService`, evaluates readiness, and asks one focused planning question before execution.

Planning artifacts are stored in a project knowledge space named `project:<projectId>`, where the project id is derived from the workspace path. The platform supplies passive daemon routes and operator methods, but daemon/non-TUI surfaces do not enter planning loops.

See [Project planning](project-planning.md) for the modal layout, `/work` behavior, and route/method list.

The checklist, in the Work place, is the separate persistent list of things to do. Use it when the work already has concrete tasks and you want durable status tracking.

## Context maintenance

GoodVibes automatically compacts the conversation context when token usage reaches the configured threshold. The default threshold is 80% (`behavior.autoCompactThreshold`). You can adjust this in Settings → Behavior; the valid range is 10–100.

When auto-compaction fires, a before/after notice appears in the transcript. The current context fill level is shown in the shell footer when usage exceeds 50%.

Use `/compact` to compact manually at any time.

## Knowledge ask

"Ask your knowledge" (`q` anywhere in Memory and knowledge; the capability `knowledge.ask` for the model, an outside agent or `goodvibes do`) asks the daemon's knowledge for a source-backed answer. Its form takes the question, how long an answer (short, usual, detailed), how many sources at most, and a knowledge space to keep to, such as a Home Assistant graph.

The answer shows the text, the sources, facts and linked entries it used, the gaps, and how sure it is. It does not turn search results into local snippets.

## Live TTS commands

"Ask and hear it" (`p` on the "Speak answers aloud" row of This session, in the System place) submits a normal chat turn and adds live spoken output for that one turn. Text still renders normally in the transcript. Assistant deltas are chunked at sentence or phrase boundaries and streamed through the configured TTS provider.

"Stop speaking" (`t` on the Voice tab of the System place) cancels active playback and pending TTS requests without deleting the text response.

`/settings open tts` opens the TTS category in the fullscreen configuration workspace. It manages the defaults used by spoken-output clients:

| Key | What its row does |
| --- | --- |
| `tts.provider` | Choose a provider with streaming TTS support |
| `tts.voice` | Choose a voice from that provider |
| `tts.llmProvider` / `tts.llmModel` | Choose an optional response model override for spoken answers through the fullscreen provider/model workspace |

Without that override, "ask and hear it" uses the current chat provider/model. Live local playback requires `mpv` or `ffplay` on `PATH`.

## Cloudflare batch commands

Cloudflare integration is optional and keeps local immediate daemon behavior by default. "Use Cloudflare" on the Setup tab of System configures it in one form, and the Cloudflare tab of **Devices and network** (the menu, `Ctrl+G` then `m`) runs the actions, in the order a setup normally uses them:

| Key | Does |
| --- | --- |
| (the tab itself) | Shows the integration's enabled/ready posture and what is deployed, read by itself |
| `q` | Lists the API-token permissions the parts chosen need |
| `t` | Creates the scoped API token from a bootstrap token typed on the hidden line; the daemon reuses the token it made for the same selection while Cloudflare reports it active, and "Make a fresh one" makes a new one (the old one is revoked) |
| `d` | Finds existing account resources usable by the integration |
| `v` | Checks a token without changing anything |
| `e` | Deploys the Workers/Queues resources (it spends money) |
| `k` | Checks the deployed worker end to end |
| `x` | Turns the integration off (asks first: with a bootstrap token it cannot be undone) |

The TUI calls platform daemon routes only. It does not call Cloudflare APIs directly. See [Cloudflare batch and control plane](cloudflare-batch.md) for token setup, supported components, and provisioning behavior.

## Workflow-oriented commands

Some command families are especially important when you are running GoodVibes as an operational console rather than just a chat surface:

- `/agents` (`team`, `start`, `recipe`) for the packaged task modes and orchestration recipes that produce WRFC and related execution chains
- Automation (the menu) for cron-like and interval-based schedules, triggers, CI watches and check-ins
- the Hooks, Hook runs and Hook points tabs of Tools and extensions for managed hooks, which ran and what each did, and trying an event
- the Runners tab of the Work place for starting and recovering distributed work
- the Sandbox setting and Sandbox sessions tabs of Permissions and safety for isolation review and the live sandbox sessions

There is no standalone `/workflow` command; contract and workflow state is visible in Your agents (`F2`, `Ctrl+O` or `/agents`).

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
- [Saving and uploading a session](share-command.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
- [Project planning](project-planning.md)
