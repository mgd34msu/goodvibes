# Tools and commands

GoodVibes Agent is a TUI-first operator assistant. The places of the menu (`Ctrl+G` then `m`) are the primary user surface; the few slash commands that remain are typed routes inside the TUI; CLI subcommands are scriptable mirrors.

## Boundaries

- Normal chat stays in the main Agent conversation.
- Agent Knowledge uses only `/api/goodvibes-agent/knowledge/*`.
- Agent does not query default knowledge or other product knowledge spaces.
- Connected-host lifecycle is external. Agent reports and uses public routes, but does not start, stop, restart, install, expose, or mutate the host listener. The two exceptions are the boot-time start of a host that is installed on this machine but stopped, and the daemon repair at start, which turns "Use the background daemon" back on and installs or starts the service with nothing asked, said in one line; both are described in `connected-host.md`.
- Local read/edit/exec is available for explicit work in the current Agent workspace when permissions are sufficient. `execution action:"status|route"` exposes process monitor, live tail, tool inspector, browser/desktop ready-attention-setup state, workflow cards, setup checklists, fallback routes, sudo posture, tracked process routes, and delegation decision cards for local work.
- `execution action:"history|record|processes|process|recovery"` gives direct read-only access to activity cards, exact records, tracked local processes, bounded redacted output, and file edit recovery.
- First-class `terminal` and `process` adapters expose the expected `terminal(command, background:true)` and `process(action:"list|poll|wait|log|kill|write")` UX over the same tracked ProcessManager lifecycle.
- Lower-level `execution_posture`, `execution_route`, `background_processes`, `background_process`, `run_background_process`, `execution_history`, `execution_history_item`, `file_recovery`, and `run_file_recovery` modes remain available for detailed compatibility inspection and confirmed recovery/lifecycle effects.
- Visible Agent subagents stay serial-by-default unless parallelism helps the user. `agent_orchestration` and `agent_orchestration_agent` expose live Agent state, managed multi-agent plan cards, work-plan links, dispatch receipts, closeout review cards, remote-runner evidence, certified daemon/platform live remote capture/export/closeout outcome records, and certified workspace/worktree isolation evidence with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata and missing-signal surfacing.
- The same orchestration modes carry auto-attached remote artifact review routes, spawn/batch-spawn policy, and safe first-class `agent` control routes, while `agent_work_plan` is the Agent's todo list: it records work and its status and does not run it. Work you ask for is sent from the Work place (New work, Work from a file) or the chat; sending it and starting it are separate. Work handed to agents goes through the `agent` tool (`mode:"spawn"` or `mode:"batch-spawn"`). Agents start when you asked for them earlier in the conversation and have not since forbidden or limited them (a later message about something else does not withdraw that); a plain "do not use agents" or "do it yourself" refuses the call with your words quoted. Only when your words do not settle it is the decision model asked; when it cannot answer, `yolo` and `just-vibes` start the agents and `ask-me` asks you once in the approval prompt, and your answer stands for the rest of the conversation.
- Delegation is for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review; `delegation action:"status|routes|route"` exposes local-first, TUI handoff, delegated-review, remote-inspection, and hidden-fanout-blocked lanes with required fields, success evidence, status routes, and recovery routes.
- External delivery, notifications, reminders, media generation, setting writes, keybinding writes, UI routing, slash-command execution, workspace-action execution, local destructive changes, and connected-host operator actions require the user's explicit request and a current recorded admission.
- Autonomous scheduled work uses the first-class `schedule` adapter, `schedule action:"list|create|remind|edit|run|pause|resume|delete"`. Creation still requires an explicit task or reminder, cadence, success criteria for autonomous work, and a current recorded admission (`confirm` and `explicitUserRequest` are optional request context).

## User-facing surfaces

High-signal TUI routes:

| Surface | Purpose |
| --- | --- |
| `Ctrl+G` then `m` | Open the menu of every place. |
| `/work` | Opens the Work place: your work, its plans and results, past work, what has no answer yet, the checklist and the tasks running in the background. Every act is a control there. |
| `/work` | Opens the Work place: your work and its plans (a plan can wait for your approval before it runs, with its steps changed, moved or taken out), the questions it asks, a failed step run again, its spending limit, past work, the checklist and the tasks running in the background. |
| `/help` | Every command and every key in one searchable list (also `?` and `Ctrl+P`). |
| `/model`, Models and providers (the menu) | Choose this conversation's model (`/model`); the default model, pins, backups, providers and their sign-ins, routing, services, comparisons, media providers and moving sign-ins are Models and providers; how hard the model thinks is in This conversation (the menu). |
| `/memory` | Opens Memory and knowledge (also the menu, `Ctrl+G` then `m`): memory, your knowledge, what is known about you, your templates. |
| Memory and knowledge (the menu): Notes, Personas (VIBE.md too), Routines, Drafts, Artifacts, Agent homes, Starters | Your notes, personas, VIBE.md personality, routines, drafts (with the review packet reports), saved artifacts, the Agent's separate homes and the starters they are made from, kept by the daemon; switching a routine on and putting it on a schedule are also on the Routines tab of Automation; skills are in Tools and extensions (the menu). |
| Waiting for you (the menu) | What waits on you (questions, approvals, held calls, held sends, Telegram messages), what Jev decided, what was answered, and what each kind of approval asks about; answer or change one with its keys. Schedules and their runs (run, pause, stop or retry), triggers, CI watches and check-ins are in Automation (the menu). |
| Mail, calendar and channels, Devices and network (`Ctrl+G` then `m`) | Pair companions (Devices and network, Pair something), inspect channel readiness, review delivery receipts, and send confirmed messages. |
| Models and providers (Media), Tools and extensions (Tools, `M`), the System place | See the media providers and make media; hear answers spoken ("ask and hear it", System, This session). |
| `/mcp`, `/settings`, Permissions and safety | Inspect or update Agent-local configuration; secrets are on the Secrets tab of Permissions and safety. |
| Work and agents (the menu): Handed off | Hand explicit build/fix/review work to the terminal app with a handoff brief (`h`, or typed `/agents hand-off`). The daemon makes the shared session and keeps every hand-off; the tab lists them with each session's state and latest answer. A hand-off whose task could not be delivered removes the empty session it created. |
| Work and agents (the menu): Research, Sources | Research a question or look at a page in the conversation (`Q`, `W`); start a research run the daemon collects sources for (`s`), add a source to the queue (`a`), save a sourced report (`w`). |
| Work and agents (the menu): your briefing | `O` shows a concise Agent operator briefing and next actions. |

An agent or a background process can take over the whole terminal. `Enter` on an agent's lane in the work tree (or on its row in Your agents, `F2` or `Ctrl+O`) opens the agent: its work is the spine, its own children branch off it, the header reads `main › researcher` in the agent's color, and the composer steers the agent while main keeps running. `Enter` on a `▶` bead (or a row in the process monitor) opens the process: live output with timestamps, errors in red, follow mode on. The process view takes no input, because the Agent cannot write to a background process's stdin; `/` searches its output and `y` copies it. While more than one session exists, a row of session chips under the header lists them, and `Ctrl+G` `n` / `Ctrl+G` `p` (the rebindable `next-session` and `previous-session`) switch between them; the row ends with those keys. `Shift+Tab` always changes when the Agent asks.

Composer markers: a line that starts with `!` runs the rest as a shell command and shows its output, and that output goes in front of your next message as context; `!@<path>` in a message is replaced by the file's text, and `@<path>` or `@<url>` adds the file, a folder listing or a link note (each file is capped, and the cut is stated); an image cannot be sent with a message and is refused with your text back in the composer; `!# <text>` pins the text to session memory and sends it; a single line that starts with `# ` (a hash and a space) saves the rest as a session-memory note and sends nothing (`#482`, `## headings` and text of several lines that starts with `#` are sent as typed). The TUI reads these markers the same way.

A typed message that starts or ends with `@model:<id>` (`@model:opus summarize this`, `summarize this @model:opus`) switches to that model, saves it as the selected model, and sends the rest; a line names the model it switched to. Only a whole token at either end counts, so `scp user@model:/srv` is sent as written. An id that names no model is reported and stays in the message, which is sent as typed. Text from a form, a workspace field or speech is never read for `@model:` or the markers above.

`Esc` in a view goes back up one level (a child agent returns to the agent that started it, then main) and never stops anything. Stopping is `Ctrl+X`: the first press asks, the second stops. The status line always says what the next `Esc` does.

## Model tools

| Tool | Use |
| --- | --- |
| `route` | Pick the best visible Agent route for a plain user task without executing tools or creating hidden work. |
| `agent` | Spawn, batch-spawn, inspect, message, wait, cancel, and report visible Agent subagents. |
| `agent_harness` | Discover and operate Agent harness routes, including visible surfaces and operator/audit inspection. |
| `agent_knowledge` | Read isolated Agent Knowledge: status, ask/search, lists, item, map, connectors. |
| `agent_knowledge_ingest` | Confirmed URL, file, artifact-id, browser, bookmark, or connector ingest into isolated Agent Knowledge. File and import paths must be inside the workspace; the file is read once by the Agent and its bytes are sent, so a connected host on another machine ingests exactly that file. Browser-history imports are capped at 500 rows, and private-host sources are ingested by the owner, not the model. |
| `agent_learning_consolidation` | Preview, apply, rollback, or exact-id recreate one confirmed Agent-local duplicate-consolidation phase with receipts. |
| `agent_local_registry` | Inspect or update Agent-local memory, notes, personas, skills, bundles, and routines. |
| `agent_work_plan` | The Agent's todo list for the project: list, create, update, set the status of, remove and clear finished items. It records work; it does not run it. |
| `agent_operator_briefing` | Read native reported/verification counts, historical legacy planning, approvals, automation, schedules, and capacity posture. |
| `schedule` | List, create, edit, run, pause, resume, and delete connected schedules through existing confirmation gates. |
| `setup` | Inspect first-run setup, choose the next safe setup repair route, show one setup row, inspect/save/clear checkpoints, repair token auth, read the setup smoke checklist or save its evidence, finish onboarding, and import GoodVibes settings through existing gates. |
| `security` | Read security posture/findings and explain why one model action is allowed, denied, or needs confirmation. |
| `vibe` | Inspect VIBE.md status/show, create project/global VIBE.md, or import VIBE.md as an Agent-local persona through existing gates. |
| `browser` | Drive a real web browser: open pages, take an element snapshot, click, type, select, scroll, wait, read the page text, extract data by selector or ref, screenshot, and manage tabs. Provisions its own browser on first use and keeps sign-ins in a saved profile. It runs no caller-supplied script in a page: `extract` names the fields it wants, so a page cannot be made to transmit anything. |
| `computer` | Inspect browser/PWA readiness, plan browser/screenshot/desktop-control workflows, inspect MCP/setup posture, and open the browser cockpit through confirmation-gated visible routes. |
| `device` | Inspect device capability, companion/mobile, voice/media, and provider posture; open TTS pickers through confirmation-gated visible routes. Its `browser`, `open_browser` and `control` actions forward to the `computer` tool, the primary route for them. |
| `import_goodvibes_settings` | Give the Agent the settings the terminal app has: runs the capability `settings.copy-from-terminal-app` (`security:"yes"` also copies those that loosen a protection). |
| `agent_operator_action` | Run exact confirmed approval/automation/schedule actions. |
| `agent_schedule_edit` | Edit one confirmed connected schedule by id. |
| `agent_documents` | Create, revise, review, comment on, suggest changes to, list, show, attach saved artifacts to, insert saved artifacts into, and export project-scoped drafts with reviewer appendices. |
| `agent_review_packet_presets` | Save, list, show, freshness-check, and refresh reusable Document Ops review packet presets without changing drafts, routes, handoffs, archives, or source presets. |
| `agent_review_packet_share` | Share one confirmed reviewer handoff archive through a configured channel, a bound route or a webhook; the ZIP is attached where the surface carries attachments and is never printed. |
| `agent_artifacts` | Browse, preview, export, package, and archive saved Agent artifacts. |
| `agent_research_runs` | Create, start, checkpoint, pause, resume, cancel, complete, fail, list, and show log tails for project-local visible research run records. `start` begins a planned run, `resume` continues a paused or blocked run, and `pause` applies only to a running run; a refused action names the one that applies. Cancelled, completed and failed runs are final. A run is named by its id, or by a title only one run has; a title several runs share is refused with their ids. A run left running by a session that ended (closed terminal, killed process) is paused with a note at the next start, and `resume` continues it. A run keeps its first and newest checkpoints, 50 in all. |
| `agent_research_sources` | Capture, review, reject, mark used, list, and bundle project-local research source queue records. |
| `agent_research_report` | Save one confirmed sourced research report artifact with source map, citation coverage metadata, repair hints, and optional visual report packet sections. |
| `research` | Plan research, inspect runs/sources, bundle reviewed sources, and perform confirmed run/source/report actions through one user-facing route. |
| `agent_channel_send` | Send one confirmed channel message and return a receipt id when receipt storage is available. |
| `agent_notify` | Send one confirmed notification through configured webhook targets. |
| `agent_autonomy_schedule` | Create one confirmed visible autonomous Agent schedule. |
| `agent_reminder_schedule` | Create one confirmed connected reminder/schedule. |
| `agent_media_generate` | Generate one confirmed image/video artifact, or collect a job an earlier call left pending (`taskId`, `providerId`, `resume`). |
| `agent_model_compare` | Run, review, side-by-side view, handoffDiff with section jumps, judge, routeDecision receipts, task/document/benchmark-filtered analytics/synthesis, apply, export, handoff, handoffArchive, or reveal one blind model comparison, optionally from a saved text artifact. |
| `agent_operator_method` | Run one exact public daemon method. Read-only methods run directly; write/admin methods require `confirm:true` plus `explicitUserRequest`. |
| `accounts` | List, alias, record, forget, and sweep the register of accounts created for the owner. |
| `audit` | Read operator/audit release readiness, evidence, single inventory items, and release artifacts. |
| `autonomy` | Turn an ongoing-work request into the safest visible route and inspect the visible autonomy queue and its cards. |
| `capability_status` | Report what this build can do, read from its live runtime state, before answering capability questions from memory. |
| `channels` | Inspect channel readiness, one channel, the ordered setup guide, channel triage, and redacted delivery receipts. |
| `context` | Inspect secret-scanned project context files and the applied prompt composition, receipts, and token budget. |
| `delegation` | Inspect delegation posture and routes for isolation, parallelism, remote execution, separate worktrees, and delegated review. |
| `execution` | Inspect local-vs-delegated execution posture, tracked processes, PTY/stdin/sudo capability, activity history, and file edit recovery. |
| `google` | Connect the owner's Google account, then read and send Gmail and read and write Google Calendar through the granted scopes. |
| `host` | Inspect connected-host status, the capability map, service endpoint posture, and the public daemon method catalog. |
| `memory` | Inspect Agent-local memory posture, external memory providers, and the learning curator; confirmed record create/update/review/stale/delete forwards to the local registry's gates. |
| `models` | Inspect provider/model route readiness, provider posture, and the local model cookbook; run confirmed local server smoke checks. |
| `occasions` | Raise occasions and trips, answer yes/no/later, run the gift interview, and capture occasion facts. |
| `personal_ops` | Read the daily briefing, saved review queue, connector readiness, and request intake; run one confirmed read-only inbox/calendar read. |
| `process` | List, poll, read bounded logs from, wait on, stop, and write to tracked background processes through confirmation gates. |
| `profile` | Read and record what GoodVibes knows about the owner, field by field, with provenance. |
| `query` | Leave the owner a question in the owner inbox (one per home, `~/.goodvibes/shared/owner-inbox.sqlite`, shared by the daemon, this app, the TUI and every other terminal at once; read through the connected host while it is reachable) and carry on; the question is recorded as asked by the session. The owner answers in Waiting for you, the web UI or from a phone push, and the answer comes back on the next model request of the agent that asked while it runs, otherwise of the asking conversation: on its next model request while that session is open, otherwise once when it is next opened (any resume, headless included), and the owner is told which. Deleting the session withdraws its open questions and marks waiting answers not deliverable. Waiting for you's Answered tab shows each answer as delivered, waiting for its session, or not deliverable with the reason. `show`, `list` and `withdraw` read or take back a question. |
| `sessions` | List, search, and inspect saved sessions and bookmark posture. |
| `settings` | List, get, set, and reset Agent settings; preview and apply shared GoodVibes settings import. |
| `support` | Read redacted support bundle posture and bundle routes. |
| `terminal` | Start one tracked background command (`background:true` is required; foreground work uses `exec`) through the shared ProcessManager lifecycle. |
| `screens_keys_commands` | This program's own screen in front of the person: list and open its places, read and press its keys, read and run its typed commands, read its command-line commands. Binding a key is the capability `keys.bind`; every other action is a capability (`capability_find`, `capability_run`). |

## `agent_harness`

Use `route action:"plan" query:"..."` first when a plain user task could map to several GoodVibes surfaces. It returns the preferred visible route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without running tools. When the route choice itself is unsure, the plan has `status:"uncertain"`, names the unsure reading, and lists the candidate routes at low confidence with no preferred one: pick the candidate that matches the request, or ask the user.

Routing wording maps to these surfaces before any mutation or live effect:

- Host/daemon health, doctor, readiness, service, and compatibility diagnostics route to `host action:"status"` before any repair or service lifecycle effect.
- Normal settings/configuration requests route to `settings action:"list"` before any set/reset mutation.
- Model provider, local cookbook, local server smoke, and route-fit wording routes to `models action:"provider|local|smoke|route"` before credential, smoke, benchmark, or route-change effects.
- Personal Ops briefing, saved queue, fresh inbox/calendar read, and connector setup wording routes to `personal_ops action:"briefing|queue|intake|lane"` before live provider reads or effects.
- Direct reminder, schedule, cron, and schedule lifecycle requests route to `schedule action:"list"` before confirmed schedule effects; broader ongoing work stays on autonomy intake.
- Command-shaped background work routes to `execution action:"processes"` and the first-class `terminal`/`process` UX; interactive PTY/stdin/sudo wording routes to `execution action:"process_capabilities"` before any hidden process start or credential effect; scheduled or watcher-like background work stays on autonomy intake.
- External-memory provider, backend, cross-session sync, import/export, or named-provider wording routes to `memory action:"provider"` or the external provider checklist before any provider write, sync, credential, or import/export effect.
- Browser-backed research runner wording routes to `research action:"runner"` readiness, and visual research report rendering routes to `research action:"plan"` plus report artifacts before claiming browser/PWA rendering.
- Voice workflow and TTS-provider wording routes to `device action:"voice|provider"` before capture, playback, or picker effects.
- Browser cockpit/PWA wording routes to `computer action:"browser"` before confirmed visible browser handoff.
- Channel setup, triage, delivery receipts, and send requests route to `channels action:"setup|triage|deliveries|channel"` before confirmed external delivery.
- Permission posture, security finding, and blocked-action questions route to `security action:"status|finding|explain"`.
- Support-bundle requests route to `support action:"status|bundle"` before bundle export/import/share effects.
- Saved-session, bookmark, transcript, and continuity requests route to `sessions action:"list|search|get"` before session lifecycle effects.
- Release readiness, release evidence, verification ledger, and operator/audit requests route to `audit action:"readiness|evidence|item|artifact"`.
- File undo/redo/recovery requests route to `execution action:"recovery"` before any snapshot is applied; the owner can also type `/undo file` and `/redo file`.
- Media generation requests route to media provider readiness and confirmed `agent_media_generate` saved artifacts.
- Requests to open, read, or act on a web page route to the `browser` tool.
- Screen-observation and desktop-control requests, and browser/PWA readiness questions, still route to `computer action:"plan"` before live UI tools are considered.

Use `setup action:"repair"` first when the user asks to fix setup or the connected host; it chooses the next safe token repair, status, services.status receipt, user-run bootstrap, or no-action route without executing it.

Use `agent_harness mode:"summary"` for the map. It reads no live status: it lists the assistant lanes (setup, chat/model, project work, Personal Ops, research/docs, background work, safety/recovery) with their routes, the counts held in memory, and `statusRoutes`, the route that reads each area's live status when you need it. Use `mode:"modes"` to search every harness mode by task, family, effect type, id, alias, or parameter name. Use `mode:"mode"` to inspect one mode contract.

Summary and plural catalog modes are compact by default. They return counts, ids, labels, state, effect class, and short `modelRoute` or `modelAccess` hints when a route decision is needed. Use `includeParameters:true` or a singular inspect mode when the model needs full schemas, policy detail, editor fields, redacted log tail, release artifact data, route hints, or tool parameters.

Discovery modes:

| Mode | What It Lists |
| --- | --- |
| `summary` | Assistant cockpit lanes, compact counts, status, and drill-in guide. |
| `modes` | Searchable catalog of every `agent_harness` mode and its task fit. |
| `route action:"plan"` plus lower-level `route_decision` | User-task route planning across Agent setup, Personal Ops, research runner/report workflows, autonomy, execution, delegation, computer/browser/PWA, screens, keys and commands, host, device/voice/TTS, channel, security, support bundles, saved sessions/bookmarks, release/audit evidence, Local Context, external memory-provider setup, and Knowledge surfaces. |
| `capability_find`, `capability_run` | Every action a person can do in the places: say the need, get a few capabilities with their inputs, run one. |
| `screens_keys_commands action:"commands\|command\|cli_commands\|cli_command"` plus lower-level `commands`, `cli_commands` | Slash commands and top-level package CLI mirrors with compact policy and route hints. |
| `screens_keys_commands action:"surfaces\|surface"` plus lower-level `ui_surfaces` | Visible places, modals, overlays and pickers. |
| `screens_keys_commands action:"shortcuts\|keybindings\|keybinding"` plus lower-level `shortcuts`, `keybindings` | Fixed shortcuts and configurable keybindings with direct route/access metadata. |
| `settings` | Compact Agent setting rows with category, prefix, query, hidden, and limit filters. |
| `tools` | First-class model tool definitions with compact harness inspection routes; schema details require `includeParameters:true` or `tool`. |
| `channels action:"status\|channel\|setup\|triage\|deliveries"`, `notifications` | Channel readiness, ordered setup guide state, blockers/retry triage, redacted confirmed-send receipts, and redacted notification targets. |
| `context action:"files\|file"` | Secret-scanned `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `HERMES_HOME/SOUL.md`, `.cursorrules`, and `.cursor/rules/*.mdc` files, including target-aware subdirectory context. |
| `context action:"prompt\|receipts\|receipt"` | Applied prompt composition order, recent durable receipt ids, exact receipt/turn/outcome filters, sanitized turn outcomes, selected context records, suppressed records, prompt previews on request, and approximate token budget; a person sees what the last turns were given from This conversation. |
| `memory action:"status\|provider\|curator\|candidate\|list\|search\|get"` plus lower-level `memory_posture`, `memory_provider` | Agent-local memory counts, prompt-active recall, vector stats, embedding-provider doctor warnings, provider inspection, curator review queues, direct memory record lookup/search, and external memory providers connected as MCP servers (Mem0, Supermemory, Honcho, OpenViking, Hindsight, Holographic, RetainDB, ByteRover, or any server whose tools read and write memory): each shows whether it is connected and the exact MCP tools for read, write, forget and sync. External records never enter the prompt on their own. With none connected the status says so in one line and names `/mcp add`. |
| `agent_orchestration` | Live visible Agent records, managed multi-agent plan cards with milestones, work-plan links, dispatch receipt counts, closeout cards, remote-runner contract/artifact evidence, certified daemon/platform live capture/export/closeout outcome records, certified workspace/worktree isolation evidence with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata and missing-signal surfacing, auto-attached remote artifact review routes, serial-by-default policy, approved work-plan dispatch route, spawn/batch-spawn decision cards, templates, and first-class `agent` routes for list/inspect/message/wait/cancel. |
| `models action:"status\|route\|local\|providers\|provider\|smoke"` plus lower-level `provider_accounts`, `model_routing`, `model_route`, `run_local_model_smoke` | Provider auth, provider/model route posture, visible route-readiness inspection, readiness scores backed by exact route-level provider-health records when published, hardware-scored local model cookbook with setup plans, exact local endpoint inspection, certified daemon-published local serving diagnostics with schema/provenance/publication and host-published start/repair routes when available, confirmed local model-list smoke checks, models-endpoint smoke criteria and refresh/provider-add hints, confirmed benchmark action/history/evidence review, and compatibility detail routes. |
| `execution action:"status\|route\|history\|record\|processes\|process_capabilities\|process\|recovery"`, `terminal`, `process`, plus lower-level execution harness modes | Local-vs-delegated execution routing, tracked process inspection, interactive PTY/stdin/sudo posture, direct process parity/doctor reports, first-class background-process start/manage adapters, process substrate probes with future stdin-write dispatch, grouped execution activity cards with redacted records, and file edit recovery. |
| `personal_ops action:"briefing\|status\|queue\|intake\|lane\|read"` plus lower-level `personal_ops_briefing`, `personal_ops`, `personal_ops_queue`, `personal_ops_intake`, `personal_ops_lane`, `run_personal_ops_read` | Read-only daily briefing plan across inbox, agenda, tasks, reminders, routines, delivery, notes, and autonomy queue; read-only saved inbox/calendar review queue with refresh routes and follow-up boundaries; inbox/calendar connector readiness, request intake that chooses the safest lane/route/fields/confirmation boundary, classified MCP read/write tool hints, schema-derived operation records with fresh-read routes, triage/draft/agenda/conflict workflow cards, ordered connector-read/local-compose/confirmed-effect execution plans, confirmed read-only MCP inbox/calendar reads with bounded redacted output, normalized review cards, optional saved redacted review-card artifacts surfaced as redacted inbox thread/calendar event queue records with artifact inspect routes, freshness status, confirmed refresh routes when a matching read connector is ready, local draft/reminder follow-up routes, a receipt with its outcome for every mail sent, event created and reminder scheduled by the Agent, confirmed provider-effect boundaries, matching MCP setup routes, and live Agent-owned note, routine, schedule-receipt, and delivery records. |
| `autonomy action:"intake\|queue\|item\|status"` | Ongoing-work route selection, visible autonomous work owners, schedule/watcher trigger posture, watcher receipt criteria, source-owned watcher evidence contracts, status, live task/approval/automation/schedule/watcher records, log tails, task/run diagnostics, host task and watcher output routes/previews, provider-source inspect/refresh controls, inspect routes, and normalized checkpoint/pause/resume/cancel/recovery controls. Lower-level `autonomy_intake`, `autonomy_queue`, and `autonomy_queue_item` modes remain available for detailed compatibility inspection. |
| `memory action:"curator\|candidate\|curate"` plus lower-level `learning_curator`, `learning_candidate`, `learning_curation_pass` | Score-driven prompt plan, ranked local memory, note, persona, skill, bundle, routine, VIBE.md personality health, duplicate-consolidation batch review, completed-work, completed-research, and saved-session review/proposal candidates. The curator asks no model: review, setup and VIBE flags are decided in code, and proposals, duplicate groups and priorities come from the last `memory action:"curate"` pass, which reads only records that are new or changed since the pass before. |
| `document_ops`, `document_ops_lane` | Documents, review packet timeline, review packet wizard, packet presets/defaults/freshness, reviewer-readiness checks, uploads, exports, sources, artifact browse/promotion, media artifacts, and blind model comparison. |
| `mcp_servers`, `setup_posture`, `setup_repair`, `pairing_posture`, `delegation action:"status\|routes\|route"` | MCP, first-run setup wizard with direct `setup action:"status\|item\|repair\|checkpoint\|token\|smoke\|finish"` route hints, progress/current-step/checkpoint/backtracking routes, checkpoint auto-advance evidence, repeated-smoke-blocker focus, setup closeout decisions, read-only repair decisions for token/status/bootstrap/lifecycle/no-action routes, setup plan with probe-fed connected-host repair/auth cards, service lifecycle receipt gates, service repair success criteria, certified receipt outcomes, exact service lifecycle decisions, sudo execution posture, primary handoffs for actionable setup rows, confirmed local token provisioning, token-safe install smoke checks, confirmed setup smoke execution, saved redacted smoke evidence artifacts with history/trend surfacing, local model readiness with endpoint smoke-test follow-through, pairing/device capability posture, and build-delegation posture. Lower-level `delegation_posture` and `delegation_route` remain compatibility routes. |
| `security action:"status\|finding\|explain"` plus lower-level `security_posture`, `security_finding`, `policy_explain` | Redacted security posture, exact findings, and how the permission gate would decide one exact model action now (allowed, denied, the owner's to decide, or decided by the decision model when made), computed by the gate's own classifier without running it or asking anyone; route planning prefers status for active permission/approval questions, finding for incidents or leaked-secret records, and explain for one blocked or risky action. |
| `support action:"status\|bundle"`, `media_posture`, `sessions action:"list\|search\|get"` | Redacted support bundle posture, voice/media posture, and saved session/bookmark posture; lower-level support/session modes remain available for detailed compatibility inspection. |
| `host action:"status\|capabilities\|capability\|services\|service\|methods\|method"` | Connected-host status, capability map/detail, service endpoint posture/detail, and public daemon method catalog/detail. |
| `operator_methods`, `service_posture`, `connected_host`, `daemon` | Lower-level compatibility/detail routes for public operator methods, endpoint posture, connected-host posture, and daemon aliases. |
| `audit action:"readiness\|evidence\|item\|artifact"` | Operator/audit release artifacts and release-quality inventory; lower-level release evidence/readiness modes remain available for detailed compatibility inspection. |

Single-item inspect modes:

| Mode | Lookup Fields |
| --- | --- |
| `mode` | `target` or `query` |
| `command`, `cli_command` | `command`, `commandName`, `cliCommand`, `target`, `query` |
| `ui_surface`, `keybinding`, `tool` | Exact id/name or `target`/`query` |
| `channels action:"channel\|setup\|triage"`, `notification_target`, `provider_account`, `mcp_server` | Exact id or `target`/`query`; channel triage also accepts `limit` |
| `project_context_file` | `contextFileId`, `target`, or `query` |
| `agent_orchestration_agent` | `agentId`, `target`, or `query` |
| `setup_item`, `setup_repair`, `model_route`, `execution action:"route"`, `pairing_route`, `delegation action:"route"` | Exact id/model key or `target`/`query` |
| `personal_ops_briefing`, `personal_ops_queue`, `personal_ops_intake` | `query` or `target` |
| `personal_ops_lane`, `document_ops_lane` | `laneId`, `target`, or `query` |
| `memory action:"candidate"` or lower-level `learning_candidate` | `candidateId`, `target`, or `query` |
| `security action:"finding\|explain"`, lower-level `security_finding`, `policy_explain`, `support_bundle`, `media_provider`, `session` | Exact id/path/tool name or `target`/`query`; `policy_explain` also accepts `toolArgs`; `support_bundle` takes `bundlePath` or `target` (not `query`) and reads only files inside the workspace |
| `get_setting`, `service_endpoint`, `operator_method` | Exact key/id or `target`/`query` |
| `connected_host_capability` | `capabilityId`, `target`, `query` |
| `connected_host_status`, `daemon_status` | Live read-only status, no lookup required |
| `release_evidence_artifact`, `release_readiness_item` | `artifactId`/`itemId`, `target`, `query` |

Effect modes:

| Mode | Effect |
| --- | --- |
| `setup` tool | Preferred first-run setup route: `action:"status\|item\|repair"` reads (status lists the setup topics as `setupTopics`, each with its control on System, Setup and its capability `setup.<topic>`), including setup wizard closeout plus saved/artifact/live-read-model/ordered-event-stream receipt evidence; `action:"token\|smoke"` delegates to existing confirmed setup effects, `action:"finish"` runs the capability `setup.mark-done` for the Agent, and `action:"import_settings"` (or `import`) runs the capability `settings.copy-from-terminal-app`. |
| `capability_run` | Runs one capability by id with its inputs, through the same gate as every other call under the person's mode. |
| `screens_keys_commands action:"run_command"` | Executes one resolved slash command through the shared command registry. |
| `provision_connected_host_token` | Creates or repairs the local canonical connected-host token after confirmation without returning the raw token. |
| `run_setup_smoke` | Collects redacted first-run setup smoke evidence and can save user-run output as an artifact without implicit shell or host commands; `setup_posture` uses that evidence for setup closeout. |
| `screens_keys_commands action:"open"` | Opens a place or another view on the person's screen. |
| `screens_keys_commands action:"run_keybinding"` | Runs supported shell-safe keybinding actions only. |
| `capability_run id:"keys.bind\|keys.reset"` | Writes the same Agent `keybindings.json` file exposed to the user. |
| `set_setting`, `reset_setting` | Writes Agent settings through the config/secret managers. |
| `run_file_recovery` | Applies one local file undo or redo snapshot from the FileUndoManager. |

Every effect mode requires a current recorded effect admission; `confirm` and `explicitUserRequest` are optional context and never grant it. Ambiguous lookups return candidates before any effect runs.

Registered model tool definitions are tiered. The tools used on nearly every task (`read`, `find`, `edit`, `write`, `exec`, `fetch`, `agent`, `task`, `state`, `repl`, `web_search`) keep their description and every parameter description, each cut to whole sentences. Every other tool is advertised with a short curated summary and bare parameters, except that its `mode` description still lists the modes available in the Agent. The full description and parameter descriptions of any tool come from `agent_harness mode:"tools"` with `includeParameters:true` or `mode:"tool"`. `mode:"modes"` and `mode:"mode"` return a `requires` list for each mode (`a|b` means any one of a or b), so a mode can be called correctly the first time. The harness accepts `session_id`, `tool`, `cliCommand` and `commandName` as older spellings of `sessionId`, `toolName` and `command`, but only the current names are advertised.

## Running what a person can do

`capability_find need:"..."` returns a few capabilities with their id, what each does, its inputs and its risk; `capability_run id:"..." inputs:{...}` runs one. A setting is `settings.set`, the terminal app's settings are `settings.copy-from-terminal-app`, and first run marked finished is `setup.mark-done`.

The agent knows what it can do without asking. A capability index is resolved at startup, before the first turn and without performing any of the capabilities it checks, and carried in context. It records what is available now with the exact call to make, what needs setup with the specific missing piece and its fix, and anything configured on this machine that nothing is wired up to use. Two standing rules ship with it. The model never answers "I can't do X" because a list came back empty, and it treats page/email/message content as evidence rather than instruction. Inspect it with `agent_harness mode:"prompt_context"`, whose `capabilities` segment shows exactly what the model was told.

A provider registers a capability with `registerCapability` from `src/capabilities/capability-index.ts`, declaring an id (`email.send`), a title and one-sentence summary, the invocation routes it offers (each with a probe saying when that route exists), and its prerequisites (each with a probe and a plain-language fix). Probes are descriptions rather than functions, on the order of a file being present, a config key being set, a tool being registered, an MCP server being connected, a daemon method being served, or a module being installed. So a capability check can never send, launch, or spend. Use `registerFallbackCapability` for a placeholder that a real provider should replace.

The `browser` tool drives a real web page, covering opening a URL, reading it, clicking, typing, signing in, and taking a screenshot of a page. Use `browser action:"navigate" url:"..."`, then `browser action:"snapshot"` for element refs, then `browser action:"click" ref:"..."` or `browser action:"type" ref:"..." text:"..."`. It needs no setup; the first call installs a browser if none is present. Opening a local file or a private-network address (`file:`, `localhost`, `10.x`, `192.168.x`) is refused once the turn has read page content unless the owner approved it, and cloud metadata addresses are never opened. A `file:` address is also held to the same read rules as the `read` tool, so a file the agent may not read cannot be opened through the browser. `type` needs its `text` (an explicit empty string clears the field) and `select` needs its `values`. A screenshot `path` must be inside the screenshot folder and never replaces an existing file.

`browser action:"launch" headless:false profileName:"..."` opens a visible window for a sign-in, and that sign-in persists in the profile for later runs. One launched browser is open at a time: a `launch` that states the open one's profile and headless setting (or neither) gets it back with `reused:true`, and one that states another profile or headless setting is refused, naming the open session, until that session is closed with `browser action:"close"`. A browser that does not finish starting within 20 seconds ends the call with the browser it waited for, whether its process started or ended, its last lines and the next step (`launch` again, then `provision` with `repair:true`); a read of a page whose script is stuck (snapshot, extract, scroll) ends after 15 seconds. A browser the agent attached to with `browser action:"attach"` can never be closed by the agent. `browser action:"release"` disconnects and leaves it running. `computer` remains the readiness and setup planner for browser/PWA and desktop-control posture; it does not drive pages.

Use `computer action:"browser"` for the connected browser cockpit/PWA readiness summary and `computer action:"open_browser" confirm:true explicitUserRequest:"..."` for the visible browser handoff. Use `computer action:"plan"` (or `action:"control"`) to see what can drive a browser right now: the invocable routes, blockers, browser, screenshot and desktop-control rows with their status (desktop control is `unavailable` unless a registered tool declares it), one list of safety notes, and setup/review/fallback routes; it ranks nothing and asks no model. Use `computer action:"control|setup|mcp"` for browser/desktop control posture, repair routes, and trusted tool/server discovery. `screens_keys_commands action:"surfaces|surface|open"` is the normal visible UI route; lower-level `browser_control_route`, `ui_surfaces`, and `ui_surface` remain detailed compatibility routes.

The connected browser cockpit/PWA is `surfaceId:"connected-browser-cockpit"`; it resolves the configured connected-host web URL, opens only through confirmed `computer action:"open_browser"` or `screens_keys_commands action:"open"`, returns service/web setup routes when disabled, and reports the web URL, whether the endpoint is enabled, and the Agent onboarding marker status. The web UI's own views (chat, work, library, personal, phone, settings) are named.

Execution routes:

- GoodVibes settings import previews changed setting/subscription counts without mutation; confirmed execution imports only Agent-owned settings and provider subscription state, redacts secret values, stores raw secret-backed values through the secret manager, and does not mutate source package stores. A project settings file travels with a repository, so it is not trusted for permission, approval, provider, tool, surface, automation or helper settings: the preview lists those keys as skipped with a reason, and only the user settings file can change them.
- VIBE.md personality files are discovered from project/global locations, secret-scanned, surfaced in setup and the learning curator when blocked or truncated, and applied to the serial Agent prompt. Use `vibe action:"status|show"` for direct read-only inspection, `vibe action:"init|import_persona" confirm:true explicitUserRequest:"..."` for confirmed changes, or the VIBE.md actions on the Personas tab of Memory and knowledge. Unconfirmed init/import previews return model and CLI `confirmationRoutes` so users can approve the exact same personality action without reconstructing syntax.
- Project context files are discovered from the sources tabled in [getting-started.md](getting-started.md), secret-scanned, bounded, target-aware for subdirectory work, and inspectable through `context action:"files"` and `context action:"file"`.
- Local memory posture, provider inspection, curator review, search, and lookup prefer `memory`. Confirmed memory record create/update/review/stale/delete actions on `memory` forward to the local registry's confirmation gates; notes, personas, skills, routines, bundles, and detailed local record mutations dispatch through `agent_local_registry`. Marking a memory record, note, persona, skill, bundle or routine reviewed is the owner's act: the model's request is refused with `OWNER_REVIEW_REQUIRED` and the owner's own way to do it (`v` on the record, the note, the persona or the routine in Memory and knowledge; a skill or bundle is marked reviewed on its tab in Tools and extensions).
- Runtime prompt context applies safe VIBE.md files, safe project context files, and only reviewed, high-confidence memory plus reviewed setup-ready behavior. Blocked or truncated VIBE.md/context files and enabled but unreviewed, stale, low-confidence, or setup-blocked local behavior are surfaced as suppressed review work.
- Prompt builds write durable receipts with ids, turn/source/model/provider, selected and suppressed record refs, segment counts, prompt hash, size, timestamp, and sanitized completed/error/cancelled outcome without storing raw prompt or response text; "See what the last turns were given" in This conversation shows a person what the last turns were given. Use `context action:"prompt|receipts|receipt"` for current applied order, recent receipt ids, `receiptId`/`turnId`/`outcomeStatus` filters, turn outcomes, selected records, suppressed records, and approximate token budget before relying on persistent context; use setup, project context inspection, the Memory -> Prompt plan action, or the learning curator to fix suppressed work.
- Read-only learning review uses `memory action:"curator"` and `memory action:"candidate"`, over what the last `memory action:"curate"` pass stored; the curator returns a prompt plan with prompt-active records, suppressed review/setup/low-confidence/personality/consolidation counts, proposal queues, consolidation queues, usefulness/freshness/source-quality/risk ordering rules, and exact routes before durable context expands.
- Duplicate-consolidation candidates expose survivor ids, visible field diffs, low-level update/stale/delete/rollback routes, and first-class `agent_learning_consolidation` preview/stale/delete/rollback/recreate phase routes. Stale writes a durable receipt with a rollback route (earlier merge receipts can still be rolled back), delete refuses records that have not already been staged stale, and post-delete receipts preserve snapshots plus exact-id recreate guidance. Confirmed recreate is separate from rollback and refuses when current records would force a different id. Each phase writes its receipt before it changes any record, so a failure partway leaves the earlier state recoverable; a rollback is recorded and cannot be repeated, and delete receipts are kept until their records are recreated. An unreadable receipts file stops the phase instead of being replaced. `mode:"receipts"` lists ids, phases and routes; `receiptId` shows one receipt with its recreate guidance. Rolling back a stale phase restores each record's review state only; content edited since stays.
- Reviewed-note, completed-work, completed-research, and saved-session memory/behavior proposals reuse selected-note promotion (`notes.to-*`) or memory-create (`memory.add`) capabilities. Non-consolidation writes stay on `agent_local_registry` or capabilities.
- Agent document draft browse/show/create/revise/review/comment/suggest/accept-suggestion/reject-suggestion/artifact-insert/export dispatches through `agent_documents`; export artifacts include reviewer-ready comment and suggestion summaries.
- Reviewer-readiness checks are "Check a draft is ready for review" (`d` on the Drafts tab of Memory and knowledge, `documents.readiness`) and read-only through `agent_harness mode:"document_ops"` or `mode:"document_ops_lane" laneId:"reviewer_readiness"`; they return exact routes for resolving comments, accepting/rejecting suggestions, attaching evidence, revealing comparisons, applying or leaving model-route decisions, and repairing handoff evidence before export/archive/apply.
- The review packet steps are "See the review packet steps" (`t` on the Drafts tab, `documents.packet-steps`) and read-only through `mode:"document_ops_lane" laneId:"review_packet_wizard"`; it reports six-step progress, the current user/model route, backtracking routes, refreshed-preset lineage when a packet preset was repaired, final archive review guidance, and the confirmed share route.
- "Save a review packet preset" (`p` on a draft, `documents.save-preset`) and `agent_review_packet_presets mode:"save"` store one reusable local packet preset artifact with document/export/comparison/judgment/route-decision/handoff/archive/related artifact ids; `mode:"list"` and `mode:"show"` inspect presets, flag missing or superseded saved ids, and recommend newer matching reuse routes when metadata is sufficient, without mutation.
- "Refresh as a preset" (`u` on an artifact, `documents.refresh-preset`) and `mode:"refresh"` save a new local preset artifact from those freshness recommendations after confirmation, preserving the source preset for audit history and never mutating documents, model routes, handoffs, or archives.
- "Send as a review packet" (`d` on an artifact, `documents.share-packet`) and `agent_review_packet_share` validate one saved handoff archive artifact, preview the delivery target and packet evidence ids, and after explicit confirmation send the packet evidence with the ZIP attached where the surface carries attachments (otherwise the message names it, and `agent_artifacts mode:"export"` writes the file to send by hand).
- `agent_model_compare mode:"apply"` saves an apply-winner route-decision receipt after a confirmed route update, while `mode:"routeDecision" decision:"left-unchanged"` saves a receipt without changing the selected model; `mode:"handoffArchive"` carries matching route-decision receipt artifacts into the ZIP, README, archive metadata, and redacted manifest, except for a handoff that hides model identities, whose archive leaves out the source comparison and route-decision receipts. Candidate labels are shuffled before a run so candidate A is not always the model in use, and `apply` and `routeDecision` read the winner model from the judged comparison, so a blind judgment can be applied; analytics and synthesis count one judgment per comparison, the newest.
- Review packet defaults use the latest document/export/comparison/judgment/route-decision/handoff evidence, falling back to saved preset metadata only when live packet evidence is missing, to prefill document export, compare handoff/archive, winner-apply, leave-unchanged decision, save-preset, and share forms while preserving editable fields and confirmation gates.
- Start deep research routing with `research action:"briefing"` when the model needs one read-only next-action queue across visible runs, source review, saved report artifacts, certified live platform/daemon runner/render evidence, browser readiness, and exact follow-up routes.
- Use `research action:"plan"` when it needs one ordered route plan across visible run state, public web/fetch or browser posture, browser-runner contract readiness, source capture/review, visual-report packet saving, and optional Knowledge promotion.
- Use `research action:"search"` for bounded public web research that returns capture-ready source candidates and exact confirmed `add_source` routes without writing local source state; pass `runId` to use the visible run's saved question and receive run-specific start/checkpoint follow-up routes.
- Use `research action:"runner"` for the direct browser-backed runner readiness contract without the full workflow plan. The browser-runner contract names setup/fallback routes, visible run controls, source-capture receipts, bounded logs, report handoff, and certified live runner read-model fields before live browser-backed execution is treated as ready.
- The visual-report contract names report sections, source-map/citation acceptance criteria, certified browser/PWA render evidence, `research action:"report" visualReport:true` save routes, review-packet, and ZIP archive routes without saving anything by itself.
- Use `research action:"reports"` to list saved sourced report artifacts and `research action:"report_artifact" artifactId:"..."` to preview one report packet before export, archive, share, or Knowledge promotion.
- Visible research run creation/checkpoint/pause/resume/cancel/complete, log-tail inspection, source capture/review/bundles, certified live browser-runner/source-receipt evidence, certified visual-report render evidence, and confirmed sourced report saves all have direct `research` actions; run detail and mutation outputs include next-route packets for inspect, briefing, workflow, run-bound search, source queue, checkpoint, report save, artifact inspection, and Knowledge promotion when a report artifact exists.
- Source detail and mutation outputs include next-route packets for review/reject, bundle, sourced report save, mark-used, report artifact inspection, and optional URL/artifact Knowledge promotion while preserving the separate confirmation gate.
- Confirmed report saves include next-route packets for high-level report inspection, artifact export/archive, Knowledge promotion, report listing, and visible run completion when `runId` is supplied. Lower-level `agent_research_runs`, `agent_research_sources`, and `agent_research_report` remain available for detailed compatibility routes.
- Confirmed Agent Knowledge URL/file/artifact-id/bookmark/browser-history/connector ingest dispatches through `agent_knowledge_ingest`.
- Command-backed editors dispatch through `screens_keys_commands action:"run_command"`.
- Learned-behavior and profile creation use the Agent-local or slash-command route.
- Document, artifact, review-packet, model-compare and research forms run their one tool call directly when the owner types yes in the workspace, with exactly the values entered, and show the tool's answer in the result pane; no chat turn is involved. A deny rule or plan mode still refuses.
- Web research/fetch forms return a main-conversation prompt instead of starting hidden nested work.
- Selection-based actions accept `recordId` so the model can use the same selected-record flows as the TUI.

## Background processes

Use `execution action:"processes"` for a compact list of tracked local processes, `execution action:"process" processId:"..."` for one process with bounded redacted stdout/stderr tails plus byte/count/truncation metadata, and `execution action:"capabilities"` or `action:"process_capabilities"` for the read-only terminal/process/PTY/sudo parity report.

Use `terminal` for the simple model-facing start path, as in `terminal command:"pytest -v tests/" background:true confirm:true explicitUserRequest:"..."`. A start ends with the Agent and at its `timeoutMs` by default (`lifetime:"task"`); `lifetime:"detached"` keeps a dev server or editor running after the Agent exits, writes its output to a log file, and records it so later sessions list it under `process action:"list"`, read its log and stop it with `process action:"kill"`. The record holds the boot and the start time of the process, so after a reboot or when its process number has been reused by another program it is dropped, never listed or stopped. Use `process` for the simple lifecycle path, through `process action:"list"`, `process action:"poll" processId:"..."`, `process action:"log" processId:"..."`, `process action:"wait" processId:"..."`, `process action:"kill" processId:"..." confirm:true explicitUserRequest:"..."`, `process action:"write" processId:"..." data:"..." confirm:true explicitUserRequest:"..."`, and `process action:"capabilities"`. Answers carry the id once as `processId`; `session_id`, `sessionId` and `processSessionId` are accepted as input. A write to a process that has ended answers `not_running` with its exit code.

When the platform or daemon publishes certified interactive runtime read models, `execution action:"status"` and `process action:"capabilities"` also show live process output chunks, typed PTY session routes, sudo credential mediation routes, and browser/desktop command receipts with schema/version/publication/publisher/provenance evidence, bounded redacted output, exact confirmed control routes, and missing certification signals. Certified browser/desktop receipts can make `computer action:"plan|control"` ready through the published daemon route; uncertified or absent records remain setup/review posture.

Use lower-level `background_processes` and `background_process` only when detailed compatibility route inspection is needed, and confirmed `run_background_process` when the lower-level harness lifecycle route is needed. The route accepts the process-tool wording `start`, `wait`, `stop`, `kill`, `poll`, `log`, and `write`; `poll` maps to status, `log` maps to output with the same explicit truncation metadata, `kill` maps to stop, and `write` requires `confirm:true`, `explicitUserRequest`, one process id, and non-empty `data`.

With the current platform, `write` returns unsupported guidance; if the shared ProcessManager exposes a safe stdin method such as `writeInput`, Agent dispatches through that method without echoing the input back. `processId`, `processSessionId`, `sessionId`, or `session_id` all resolve the tracked process id.

Foreground `exec` remains the default for tests, builds, and one-shot commands. Raw exec background flags and `bg_*` controls are blocked in Agent so long-running work has a visible process id, process monitor/live-tail routes, timeout, and cancellation path. PTY mode returns unsupported guidance until the platform/daemon process substrate exposes a typed interactive session API.

Background sudo prompts are blocked; privileged commands should stay visible and user-supervised. `setup action:"item" setupItemId:"sudo-execution-posture"` shows SUDO_PASSWORD presence only, the expected `~/.goodvibes/.env` location for future mediated support, blocked background sudo/stdin password routes, missing platform/daemon contracts, and the foreground shell route without printing or storing raw password values.

## Settings and keybindings

Settings discovery accepts `settings action:"list"` with `category`, `prefix`, `query`, `includeHidden:true`, and `limit`. It is compact by default and each row includes a short first-class `modelRoute` that distinguishes read-only settings from set/reset-capable settings; use `includeParameters:true` or `settings action:"get"` for full descriptions/defaults. Single setting reads/writes resolve by `key`, `target`, or `query`; ambiguous matches are refused.

Secret-backed setting writes through `settings action:"set"` store raw values through the secret manager and return redacted output. The terminal app's settings reach the Agent through one capability, `settings.copy-from-terminal-app`: `capability_run id:"settings.copy-from-terminal-app"`, and `settings action:"import"`, `setup action:"import_settings"` and `import_goodvibes_settings`, which run it as a nested `capability_run`. It copies each setting the terminal app has set that the Agent holds differently and names every one; one that loosens a protection only with `security:"yes"`. The terminal app's settings are not changed. Connected-host lifecycle/listener settings are read-only in Agent.

Workspace-checkpoint root and retention guards are ordinary settings: they appear in the settings screen and `settings action:"list" prefix:"checkpoints."`, are changed with `settings action:"set"`, and a wrong value is reported at start (the default then applies). They are passed to the platform's workspace checkpoint manager:

| Key | Default | What it does |
| --- | --- | --- |
| `checkpoints.preferGitRoot` | on | Prefer the enclosing git repository's top level over the raw working directory |
| `checkpoints.allowBroadRoot` | off | Opt in to snapshotting a broad root such as the filesystem root, the home directory, or `~/.goodvibes` |
| `checkpoints.allowLargeFirstSnapshot` | off | Opt in to a first snapshot whose full sweep exceeds the file ceiling |
| `checkpoints.maxFirstSnapshotFiles` | platform default | The ceiling for the first-ever snapshot's file sweep |
| `checkpoints.autoRetention` | on | Run a retention sweep automatically after each successful checkpoint and once at init |
| `checkpoints.unregisteredWorkspaces` | `off` | `guarded` takes checkpoints in a workspace that is not registered (see below) |

Any key you omit falls back to the manager's own default. These guards are defense in depth; even a registered workspace can still be refused as too broad or too large.

Automatic (turn-end/lifecycle) checkpoints are restricted to workspaces COVERED by the shared registration store (restricted since 2026-07-10; store migrated to the platform's platform/workspace/registration in platform 1.6.1). `goodvibes-agent workspaces list|register [path] [--label <label>] --yes|unregister [path] --yes` manages the registry (path defaults to the current working directory); it is user-scoped, agent-local state, not a connected-host concept.

Coverage flows down a registered root's subtree and is inherited through the git worktree→main-repo link, so an orchestration-spawned sibling worktree of a registered repo checkpoints automatically without being registered itself. An unregistered/uncovered workspace gets no automatic checkpoints, and an explicit `checkpoints.create` gateway call against it is refused with a registration hint rather than silently registering the workspace on the caller's behalf.

`checkpoints.unregisteredWorkspaces` (`"off"` default, or `"guarded"`) is the opt-out; `"guarded"` restores the pre-restriction behavior for that workspace (automatic checkpoints subscribe, explicit create proceeds) subject only to the root/retention guards above. `goodvibes-agent status`/`doctor` state the posture honestly: `checkpoints off: workspace not registered` when off, never silent.

Best-of-N attempt groups (platform 1.6.1 orchestration engine) are reviewed and resolved with `goodvibes-agent fleet attempts list [--workstream <workstreamId>]|pick <groupId> <winnerItemId> --yes|judge <groupId>`. The command asks the connected host's contract runner through the `fleet.attempts.*` verbs (the control plane's invoke-by-id endpoint); it starts no runner of its own, so it never takes up a contract another process left on disk. When no host answers it says so and exits 1. Groups held by contracts an open Agent is running are reviewed from that Agent.

`list` shows every held-merge group (siblings that ran in isolated worktrees and are held for a winner pick instead of auto-merging) with each candidate's diff, usage, and any prior judge proposal. `judge` runs the optional judge model and PROPOSES a winner, always rendered as a clearly labeled model proposal, never a decision, and `pick` is the confirm-gated action that actually merges the winner and cleans losing worktrees.

Keybinding discovery returns fixed shortcuts plus the live resolved binding table. Fixed shortcuts and configurable bindings include direct `modelRoute` and `modelAccess` metadata so the model can distinguish supported routes from direct-user-only controls. `screens_keys_commands action:"run_keybinding"` only executes actions with faithful current-shell routes. Prompt-editor-only shortcuts, terminal text selection, category cycling, and reserved shortcuts stay direct user interaction.

## Connected host and daemon

The connected host is external. Agent can inspect it through:

- `host action:"services|service"` for endpoint binding, network-facing posture, issues, optional probes, and redacted log tail.
- `host action:"capabilities|capability"` for compact connected-host posture, direct `modelRoute` hints, route families, allowed capabilities, blocked lifecycle/non-Agent surfaces, and first-class tool availability.
- `host action:"status"` for live read-only readiness checks and the next diagnostic route.
- `setup action:"repair"` for the current setup blocker or a named host/auth/service target; it returns the safest next route without executing lifecycle, token, import, or UI effects.
- `setup action:"item" setupItemId:"connected-host-readiness"` for the missing-host bootstrap plan: user-run Bun, GoodVibes host install/trust, binary verification, service start, and Agent reconnect commands before operator methods are reachable.
- `host action:"methods|method"` for the public method catalog.

None of those modes expose host start (the boot-time start and the repair at start described in `connected-host.md` are not tool modes), stop, restart, install, expose-listener, connected-host account or route mutation, default knowledge access, hidden background Agent jobs, or implicit delegated review. Those daemon mutations are reached through `agent_operator_method` with `confirm:true` instead. This says nothing about signing up for a third-party service; that is authorized, and it is recorded with `accounts action:"record"` rather than gated.

## Visible autonomy

Use `autonomy action:"intake"` first when the user asks for ongoing work and the safest route is not obvious. It is read-only and returns the likely route, missing fields, confirmation boundary, and trigger workflow posture for time-based wakeups/schedules, incoming webhooks/watchers, Gmail/email connector triggers, and control-plane event streams.

Webhook, watcher, Gmail, or event-trigger requests point to the published `watchers.create` contract when applicable, but watcher creation is an admin connected-host mutation that requires trusted source/scope, a task or run target, success criteria, `confirm:true`, and `explicitUserRequest`. The intake action also returns watcher receipt success criteria plus a read-only watcher evidence contract for platform/daemon-owned durable run-history receipts, provider source records, redacted event payload descriptors, and autonomy queue correlation. Confirmed `agent_operator_method` calls summarize `watchers.create/update/run/start/stop/delete` receipts into certified or follow-up outcomes without exposing operator tokens.

Use `schedule action:"create"` for one visible autonomous schedule, `schedule action:"remind"` for reminders, `schedule action:"edit"` for one exact schedule edit, and `schedule action:"run|pause|resume|delete"` for lifecycle controls; it forwards to the same preview, read-only current-state diff, confirmation, and connected-host routes as `agent_autonomy_schedule`, `agent_reminder_schedule`, `agent_schedule_edit`, and allowlisted `agent_operator_action`, then returns post-action next routes for schedule list, autonomy queue inspection, run, edit, pause, resume, and delete where the schedule still exists. Unconfirmed schedule and routine-promotion previews return `confirmationRoutes` so the user or model can confirm the same intent without guessing the next command. Routine schedule promotion through "Run a routine on a schedule" (Memory and knowledge or Automation) or `goodvibes-agent do routines.promote` returns the same post-action schedule next routes. A routine is promoted only when it is enabled, reviewed (`v` on it, Routines tab of Memory and knowledge) and has no missing requirements; the preview lists what is missing and a confirmed promotion is refused until it is fixed, from the terminal and from the command line alike.

Use `autonomy action:"queue"` before creating recurring autonomous work, reminders, routine schedules, delegated work, run controls, schedule edits, approval decisions, watcher triggers, or follow-up delivery. The queue is read-only and normalizes work-plan, research-run, connected task, approval, automation, schedule, reminder, routine-promotion, delegated-agent (counting running and pending agents), tracked background process, and delivery cards. A list longer than the queue shows is reported as "N of M". Research runs, connected-host tasks, approvals, automation runs, platform/daemon watcher run/source records, and schedules include live records with status/progress, source ids, next steps, log tails when available, task retry/output/correlation diagnostics, bounded redacted host task and watcher output route/preview descriptors, automation telemetry/delivery/route diagnostics, watcher run-history/source diagnostics, available controls, unavailable controls with reasons, and exact inspect/checkpoint/pause/resume/cancel/approve/deny/retry/run/edit/enable/disable/delete routes where supported.

Provider-source watcher records are read-only context with inspect/refresh controls; watcher run effects appear only when the owning platform or daemon publishes exact confirmed routes. Schedule records expose pause/resume aliases over daemon enable/disable lifecycle routes so users do not have to translate scheduler terminology. Connected-host task cancel/retry uses `agent_operator_method` exact daemon methods with `confirm:true` plus `explicitUserRequest`; the Agent's tasks in the Work place are read only.

Inspect one card with `autonomy action:"item"`; lower-level `agent_harness mode:"autonomy_intake|autonomy_queue|autonomy_queue_item"` remains available for detailed route inspection. Create, edit, run, pause, resume, cancel, approve, deny, send, schedule, and schedule lifecycle effects stay on the owning confirmed route returned by that card.

## Agent Knowledge

Use Memory and knowledge first (the menu, `Ctrl+G` then `m`). Scriptable mirrors:

```sh
goodvibes-agent ask "<query>"
goodvibes-agent search "<query>"
goodvibes-agent knowledge list --kind sources
goodvibes-agent knowledge get <id>
goodvibes-agent knowledge map
goodvibes-agent knowledge connectors
goodvibes-agent knowledge connector <connector-id>
goodvibes-agent knowledge connector-doctor <connector-id>
goodvibes-agent knowledge ingest-url <url> --yes
goodvibes-agent knowledge ingest-file <path> --yes
goodvibes-agent knowledge ingest-connector <connector-id> --yes
goodvibes-agent knowledge import-urls <path> --yes
goodvibes-agent knowledge import-bookmarks <path> --yes
goodvibes-agent knowledge import-browser-history --yes
goodvibes-agent knowledge reindex --yes
```

Inside the Agent the same is Memory and knowledge (the menu, `Ctrl+G` then `m`, or `/memory`): its Issues tab reviews an issue (`v`), its Entries tab shows what a task would get (`k`) and tidies (`z`), and every tab reads by itself. These routes and the place reach the daemon's one knowledge store, the terminal app's too.

Agent rejects route-selection flags that would target another knowledge space, including `--space`, `--knowledge-space`, `--knowledge-space-id`, and `--include-all-spaces`. Parseable public Agent-route scope aliases are normalized.

## Approvals, automation, and schedules

Read views are safe by default. An approval is answered in Waiting for you (the menu) with its own keys; its Kinds tab says what each kind of approval asks about. A schedule and its runs are changed in Automation (the menu, the leader then `m`), kept on the connected host: on the Schedules tab `n` makes one, and on a schedule `g` runs it now, `p` pauses or resumes it, `c` changes it (its timing, name, what it does, or a task with the result that shows it is done) and `x` removes it; on the Runs tab `s` stops a run and `t` runs a failed one again. A pressed key is the request and runs at once; only what cannot be undone asks first. Triggers, the commands they may run, CI watches and check-ins are its other tabs.

Routine promotion is an explicit scheduling route. Local routines stay local until a user confirms promotion. Delivery targets are opt-in with explicit channel/route/webhook/link flags.

## Slash command catalog

| Command | Purpose |
| --- | --- |
| Models and providers (the menu) | The daemon's models, providers and sign-ins for every program: Models (make one the default, pin, back up, send every request to it), Providers (sign in with a subscription and finish with the code, sign out, store a key, remove your own, each one's account and how to fix it), Routing, Services (see, test and check them, use one a project defines), Comparisons (blind model comparisons: compare models on a prompt, it spends money; benchmark the local models; judge; switch to the winner or record keeping the model; save a report, handoff or ZIP), Media and Move (sign-ins, a sign-in summary and the services list to and from a file); add a provider of your own, read the model lists again and find model servers on this computer from anywhere in it. |
| `/agents open` | Your agents: what is waiting for you, running, scheduled and finished (also F2 and Ctrl+O). |
| `/agents` | Your agents: open the live view, and hand build, fix or review work to the terminal app (`hand-off`, with reason, success criteria, workspace hint, priority and review intent) and follow it (`handed-off`); both are the Handed off tab of the Work place too. |
| Waiting for you (the menu) | What each kind of approval asks about, and the approvals waiting on you; answer one with its keys there. |
| System place, Health | What needs attention (with what fixes each), one area in detail, a problem described, the runtime store, and the connected host's compatibility (health has no slash command). |
| System place, Support and transfer | Save this Agent's settings and setup to a redacted file, check one, or load settings back from one (the support bundle has no slash command); with the host on another machine the file is read and written on this computer. |
| Mail, calendar and channels: Calendar, Calendar accounts, Calendar feeds (the menu) | The daemon's one calendar: what is coming up, every event, add, change or remove one, import or export .ics files, subscribe to feeds, sign in or out of Google or Outlook. The Agent's own 3.5.0 events, feeds and sign-ins are carried into it once. |
| `/checkpoint` | The workspace checkpoints: `list` (newest first), `restore <n\|id>` (shows the files that would change, asks, and restores them; files only). `make` and `rewind` are refused: the Agent takes checkpoints by itself in a registered workspace and does not go back to a turn. |
| Mail, calendar and channels: Channels (the menu) | The daemon's channels: status, setup, repairs, who may reach the assistant, per-channel profiles, a test message, readiness, the setup guide, what came in, a message sent through the daemon and what was sent (the Agent's 3.5.0 receipts carried in once). |
| `/clear` | Start a fresh conversation; the current one is saved as its own session first. |
| `/compact` | Summarize the conversation to free context window. |
| This conversation (menu) | What fills the context: "See what fills the context" (token breakdown), "See the project instruction files", "See what the last turns were given"; the context window size, the daemon's for every program: "See the context window size", "Set the context window size", "Go back to the automatic window size". |
| Devices and network (menu) | The connected host's devices and network: Paired (rename; revoke, which cuts the device off for good; pair it again to bring it back), Pair something on every tab (A phone or another device mints a named, separately revocable device token and shows its link and QR; This program with its daemon makes this Agent your own device on its connected host with the sign-in code your own screen shows, the same capability as System, Setup's "Pair with a host"; A device through the relay), how this terminal connects and forgetting its daemon pairing (the same as System, Setup's "Unpair from the host"), Relay (is it reachable, cut a device off), Waiting to pair, Phones, Always allowed, Captures (delete one for good), the machine group, Cloudflare (creating the token, deploying and turning it off are the owner's own acts), the network scan and settings sync. |
| Sessions (menu) | Your conversations: this one and the saved ones (searched in place as you type, resumed, renamed, copied, written to a file, deleted), the open conversation's record and bookmarked blocks, and the project's cross-session task graph (read here; the terminal app changes it). Folding and opening blocks and saving this conversation as a Markdown or text file are controls of This conversation. |
| `/fork` | Continue in a copy of this session. |
| `/help` | The commands that remain and every key in one searchable list (also `?` and `Ctrl+P`); everything else is in the menu (`Ctrl+G`, then `m`); `/help <command>` prints one command's actions. |
| `/help keys` | List keyboard bindings and the file that changes them. |
| `/resume` | Resume a saved Agent session. |
| Tools and extensions (the menu, the leader then `m`) | The terminal app's place, with the same tabs and keys: your hooks, the hooks that ran (in this Agent and the terminal app, from the daemon's one trace) and the hook points; the tools the model can call; tool servers (MCP) and their files; plugins and their trust; the marketplace and what you installed; skills, presets and managed settings. |
| `/mcp` | Opens Tools and extensions on its Servers tab: MCP servers, trust posture, and tool inventory. |
| Memory and knowledge (the menu; `/memory` opens it) | Opens Memory and knowledge: memory records (remember, search, correct, review, forget), the copies of memory and replacing memory with one, memory kept as files in the project (write them, see what your edits change, take edits in: the model may write and compare but not take them in), your knowledge, what is known about you (People listed, since you are reading it), and your templates. Each is a key on the thing it acts on. |
| System, This session (the menu) | How much the Agent prints (quiet, balanced or operator) and each kind of notification's level; there is no `/verbosity`. |
| `/model` | Choose this conversation's model in the picker; its list also switches the model, chooses backups and reads the list of models again. The default every conversation uses is set in Models and providers. |
| System, Notices (the menu; `Ctrl+N`) | Every notice and notification in full, newest first. The status bar counts unread notices. |
| Money (the menu) | No slash command: Cards (see them; `n` adds one, each field hidden; `x` removes one), Addresses (`Enter` sets the billing or shipping address), Repeat purchases (see them; `n` allows one, `x` stops one, `a` approves one purchase ahead of time) and Spending (this conversation, then what the daemon recorded by what it was for; `p` your own price for a model, `w` the spending alert, `b` every split). The purchases waiting for your answer are on Waiting for you's Purchases tab. Card material is stored at daemon scope and never shown back; budgets, windows and security-code handling live in Settings > Payments. |
| Permissions and safety (the menu, the leader then `m`; `/permissions` opens it) | This conversation's permissions, the rules, your secrets (stored, pointed at a password manager, checked, tested, confirmed and deleted; never shown), this folder's trust (until you trust the folder, its repository's hooks file is not loaded and the MCP servers its `.mcp/mcp.json` and `.goodvibes/mcp.json` name do not start), who may sign in, who is who on the connected host (a sender no person or device is known for shows as "someone you have not added yet"), device tokens, phone grants, the policy bundles and what is trusted, and the sandbox setting; and what needs attention, the whole review and risky MCP routes. |
| `/quit` | Close this program (a model cannot run it). |
| `/redo` | Redo the last undone conversation turn; `/redo file` re-applies the last reverted file change. |
| `/retry` | Re-send the last user message, optionally with modified text. |
| Automation (the menu, the leader then `m`) | Your schedules and their runs, triggers and the commands they may run, CI watches (a repository's CI job by job, and standing watches that tell you when it fails) and what the check-ins did, all on the connected host, each acted on from its tab. |
| `/settings` | Open, inspect, set, or reset Agent settings. |
| System, Setup (the menu) | Set GoodVibes up, one topic at a time: each topic's row opens one form; `Run first-run again` runs the three-step first run again. There is no `/setup`. |
| Tools and extensions (the menu, the leader then `m`) | Your skills and skill bundles (the one skill store every program reads), the skill folders you published to the local catalog, your presets and your managed settings, each acted on from its tab. |
| `/status` | Shows the current model and its context window, with where the window came from (its catalog provider, the consensus of catalog providers, a family default, or a user override). |
| This conversation (the menu, the leader then `m`) | The controls on the conversation itself, each run with `Enter` from its row: name it, send an image with a message, paste the clipboard, read the folded pastes, see what fills the context and the project instruction files, see and choose how hard the model thinks, save this session under a name or as a file, fold or open its blocks, and see or put back the workspace checkpoints. |
| System place, This session and Voice | Hear answers spoken, the local voice runtime, the wake word and the voice settings as a file (voice has no slash command). |
| `/undo` | Undo the last conversation turn; `/undo file` reverts every file the last write/edit call changed. |
| `/update` | Opens its list: see whether a newer release is out (`check`), install it (`apply`), go back to the version before (`rollback`), see the daemon's updates (`daemon [--check]`), and review this install (`review`), save that review to a file (`save-review <file> [--replace]`) or read a saved one back (`read-review <file>`). |

## Related docs

- [Getting started](getting-started.md)
- [Connected host](connected-host.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Channels, remote access, and API](channels-remote-and-api.md)

## Work

The Work place (the menu's "Work and agents" row, or `/work`) is the same in the
Agent as in the terminal app: your work on the connected daemon, each piece with
where it stands, its plan and results, a plan that waits for you, past work, the
checklist and the tasks running in the background. It is read by itself and again
whenever anything in it changes. The daemon checks your access on every read; a
connection that cannot be read says so in the list instead of showing it empty.
See [the terminal app's work page](../../tui/docs/native-work.md) for the keys.
