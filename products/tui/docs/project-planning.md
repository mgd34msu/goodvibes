# Native planning and saved historical records

New terminal requests use native conversation intake. The historical project-planning interview is retired: the TUI does not generate clarification questions, propose answers, request execution approval, or turn a saved goal into a new native request. This follows the autonomous Jev decision contract.

## Boundary

| Responsibility | Owner |
| --- | --- |
| Exact original terminal input capture and native request/recovery display | TUI |
| Semantic routing, admission and autonomous execution decisions | Native engine and Jev |
| Passive display of saved historical planning records | TUI |
| Durable project-scoped planning artifacts in `project:<projectId>` knowledge spaces | platform |
| Decision records and the work plan | platform |

Saved readiness, questions, answers and approval metadata describe historical artifacts. They are read-only: nothing answers, approves, re-evaluates or rewrites them, and they are not native criteria, current execution evidence or authority to admit/start/resume native work.

## Native input and recovery

`/work open` opens native work and recovery. `/work request <goal>` submits the original owner-authored terminal source through native conversation intake, just like ordinary terminal input. A generic/model/nested command call cannot fabricate that original source.

Command syntax and its first whitespace separator are removed; the remaining text is retained exactly, including additional leading spaces, trailing whitespace, line breaks and Unicode. A CRLF delimiter is one separator. Folded paste/image markers and file/context references remain unsupported source references instead of being expanded into replacement authority.

There is no legacy planning or ordinary-turn fallback when native intake, the paired host, the verified principal or durable journal is unavailable. Uncertain submissions retain the original IDs and source. Use `/work intake`, `/work intake-retry`, `/work intake-resume` and `/work intake-cancel` to inspect or recover them. Historical inspection does not replace that source or silently retry it. See [terminal workstream intake](../README.md#terminal-workstream-intake) for the shared recovery boundary.

Plain conversation, including planning-related language, uses native intake. It does not open an interview or become an answer to a saved question. A new complete request must come from new original terminal input; opening saved history never manufactures one from saved goal/scope/task fields.

## Historical planning modal

Open the historical view with `/work history`. The workspace-derived project id scopes its saved records to the matching knowledge space.

The modal displays persisted planning content, including:

- Saved readiness and approval metadata, explicitly historical
- Saved goal, scope, known context, questions and recorded answers
- Tasks, dependencies, verification gates and agent-assignment metadata
- Durable decisions and project language records
- Workspace project and knowledge-space identity

Opening and refreshing are passive reads. The modal does not call readiness evaluation, choose a next question, create synthetic question rows, generate answer suggestions, offer approval/dismiss actions, or submit a new native request. Existing saved questions and answers remain inspectable even when the current native request is blocked or recovering.

| Key | Action |
| --- | --- |
| `r` | Reload saved platform-backed records |
| Navigation keys | Inspect and scroll saved content |
| `Esc` | Close the view |

Closing, reopening, refreshing or repeatedly pressing former action keys cannot write historical state or dispatch native work.

## Native work and saved plans (`/work`)

| Command | Does |
| --- | --- |
| `/work open` | Open native work and recovery |
| `/work history` | Inspect saved historical planning records without evaluating or starting an interview |
| `/work request <goal>` | Submit the exact original terminal request through native conversation intake |
| `/work plans` and `/work plan <id>` | Show saved plans, read only; the live plan is the project work plan (`/todo`) |
| `/work planner`, `planner-explain`, `planner-mode <strategy>`, `planner-override <strategy>`, `planner-reset` | The adaptive planner's state and controls |

Saved planning records are read only; nothing answers or approves them.

`/work` is unrelated to `/plan`, which toggles the session's existing read-only permission plan mode. `/plan` never touches project-planning state; `Shift+Tab` cycles that same permission mode. These retained compatibility controls do not claim that other legacy permission/runtime consumers have already completed their autonomous migration.

## Work Plan

GoodVibes also has a lightweight persistent work-plan tracker for concrete implementation tasks. It is separate from the saved historical planning records and is intended for visible, durable checklists while work is in progress.

The command is `/todo`, the same in the Agent. `/todo` alone opens its list of actions ("See your to-do list" first); each action asks for what it needs and picks items from the list.

| Command | Does |
| --- | --- |
| `/todo open` | Open the to-do panel |
| `/todo add <title> [--owner <for whom>] [--notes <notes>] [--source <where it came from>]` | Add an item; `/todo add` alone opens the form |
| `/todo edit <item> <title> [--owner ...] [--notes ...] [--source ...]` | Change an item; `/todo edit <item>` alone opens the form with the item chosen. A detail left out stays as it is; `-` clears it (`--owner -`) |
| `/todo list` | Print the list |
| `/todo markdown` | Print the list rendered as Markdown |
| `/todo export` | Write that same Markdown rendering to a file under `~/.goodvibes/tui/work-plans/` and print its path |
| `/todo mark <item> pending\|in_progress\|blocked\|done\|failed\|cancelled` | Set an item's state |
| `/todo next <item>` | Advance the item to its next state |
| `/todo remove <item>` | Remove an item for good (`/todo add` puts it back) |
| `/todo clear-done` | Clear finished (done/cancelled) items for good |

The work plan is the project's task list, kept in one file for all your GoodVibes programs: `~/.goodvibes/work-plans.sqlite`. The terminal app, the Agent and the daemon all open it, so a project has one plan whichever of them edits it, alone or together, attached to a daemon or not; the web UI shows the same plan through the daemon. Each item is its own row, the same rows the model keeps with the `work_plan` tool, a spawned worker keeps with its own `work_plan`, contracts link their units to, and the daemon serves through the `projectPlanning.workPlan.*` methods. An edit writes only the item it changes, in one transaction, so two GoodVibes programs editing the same project's plan never overwrite each other, and each edit prints one line on where the plan stands. An item can be named by its id or by a unique start of it. A plan an earlier build kept in this program's knowledge database is moved into the shared file the first time the plan is opened. Plan files written by older builds under `~/.goodvibes/tui/work-plans/` are not read; their items do not appear in the plan.

Finished (done or cancelled) items are removed automatically once they have been untouched for 30 days, or when they fall outside the 200 most recently touched finished items. The removal happens as part of the edit that finishes an item, and that edit's line says how many it removed. Pending, in-progress, blocked and failed items are never removed this way. `/todo clear-done` (or `c` in the panel) clears all finished items at once; failed and blocked items are never cleared by it.

The open Work Plan modal follows the plan: an edit made here, in the Agent, by the daemon or in the web UI shows up without pressing `r`.

The modal's keys:

| Key | Action |
| --- | --- |
| Up/Down | Navigate items |
| `Enter` | Cycle the selected item's status |
| `1`-`6` | Set status directly (pending/active/blocked/done/failed/cancelled) |
| `a` | Close the panel and open the form of `/todo add` |
| `e` | Close the panel and open the form of `/todo edit` for the selected item |
| `d` | Remove the selected item |
| `c` | Clear completed (done/cancelled) items |
| `r` | Read the plan again |
| `x` | Close the modal and export to a Markdown file under `~/.goodvibes/tui/work-plans/`, the same rendering `/todo markdown` prints; the path is printed |
| `i` / `w` | On an item with a linked agent or contract, open the Agents modal on it |

`a` and `e` leave a draft already in the composer untouched; the usage line is printed instead. Each row starts with its status: `[ ]` pending, `[>]` in progress, `[!]` blocked, `[x]` done, `[✕]` failed, `[-]` cancelled. Linked ids (`agent:`, `contract:`, `task:`, `session:`) are shown on the row.

## platform routes and operator methods

The platform serves saved planning records read-only. Opening or refreshing the TUI historical view only reads them. The former state, evaluate and language write routes answer `410` with code `PLANNING_STATE_READ_ONLY`:

| Route | Operator method(s) | Purpose |
| --- | --- | --- |
| `GET /api/projects/planning/status` | `projectPlanning.status` | Read artifact counts and capabilities |
| `GET /api/projects/planning/state` | `projectPlanning.state.get` | Read a saved planning state |
| `GET\|POST /api/projects/planning/decisions` | `projectPlanning.decisions.list` / `projectPlanning.decisions.record` | List or record durable decisions |
| `GET /api/projects/planning/language` | `projectPlanning.language.get` | Read saved project-language records |

A separate set of routes covers the task graph shown in the modal:

| Route | Operator method |
| --- | --- |
| `GET /api/projects/planning/work-plan` | `projectPlanning.workPlan.snapshot` |
| `GET /api/projects/planning/work-plan/tasks` | `projectPlanning.workPlan.tasks.list` |
| `GET /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.get` |
| `POST /api/projects/planning/work-plan/tasks` | `projectPlanning.workPlan.task.create` |
| `PATCH /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.update` |
| `POST /api/projects/planning/work-plan/tasks/{taskId}/status` | `projectPlanning.workPlan.task.status` |
| `POST /api/projects/planning/work-plan/tasks/reorder` | `projectPlanning.workPlan.tasks.reorder` |
| `DELETE /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.delete` |
| `POST /api/projects/planning/work-plan/clear-completed` | `projectPlanning.workPlan.clearCompleted` |
