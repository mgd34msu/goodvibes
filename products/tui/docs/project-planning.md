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

`/project-plan` and its alias `/planning` open native work and recovery. `/project-plan panel` does the same. `/project-plan <goal>` submits the original owner-authored terminal source through native conversation intake, just like ordinary terminal input. A generic/model/nested command call cannot fabricate that original source.

Command syntax and its first whitespace separator are removed; the remaining text is retained exactly, including additional leading spaces, trailing whitespace, line breaks and Unicode. A CRLF delimiter is one separator. Folded paste/image markers and file/context references remain unsupported source references instead of being expanded into replacement authority.

There is no legacy planning or ordinary-turn fallback when native intake, the paired host, the verified principal or durable journal is unavailable. Uncertain submissions retain the original IDs and source. Use `/work intake-status`, `/work intake-retry`, `/work intake-resume` and `/work intake-cancel` to inspect or recover them. Historical inspection does not replace that source or silently retry it. See [terminal workstream intake](../README.md#terminal-workstream-intake) for the shared recovery boundary.

Plain conversation, including planning-related language, uses native intake. It does not open an interview or become an answer to a saved question. A new complete request must come from new original terminal input; opening saved history never manufactures one from saved goal/scope/task fields.

## Historical planning modal

Open the historical view with `/project-plan history`. The workspace-derived project id scopes its saved records to the matching knowledge space.

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

## `/project-plan`

| Command | Does |
| --- | --- |
| `/project-plan` or `/project-plan panel` | Open native work and recovery |
| `/project-plan history` | Inspect saved historical planning records without evaluating or starting an interview |
| `/project-plan <goal>` | Submit the exact original terminal request through native conversation intake |
| `/project-plan dismiss` | Archive the active execution plan; refused while it is mid-execution, with `/workstream cancel` guidance. Saved planning records are not changed |
| `/project-plan list` and `/project-plan show <id>` | Inspect older execution-plan records |
| `/project-plan mode\|explain\|override\|status\|clear` | Route to the existing adaptive runtime controls |

`/project-plan approve` and `/project-plan answer` are retired. They change nothing, say so, and point at the work plan and `/workstream`; `/project-plan -- approve ...` submits the words as a goal instead.

`/project-plan` is unrelated to `/plan`, which toggles the session's existing read-only permission plan mode. `/plan` never touches project-planning state; `Shift+Tab` cycles that same permission mode. These retained compatibility controls do not claim that other legacy permission/runtime consumers have already completed their autonomous migration.

## Work Plan

GoodVibes also has a lightweight persistent work-plan tracker for concrete implementation tasks. It is separate from the saved historical planning records and is intended for visible, durable checklists while work is in progress.

The command surface (aliases `/wp`, `/todo`, `/workplan`):

| Command | Does |
| --- | --- |
| `/work-plan` or `/work-plan panel` | Open the Work Plan modal |
| `/work-plan add <title> [--owner name] [--source label] [--notes text]` | Add an item |
| `/work-plan edit <id> [<new title>] [--owner name] [--source label] [--notes text]` | Edit an item's title or fields |
| `/work-plan list` | Print the plan as a list |
| `/work-plan show` (alias `markdown`) | Print the plan rendered as Markdown |
| `/work-plan export` | Write that same Markdown rendering to a file next to the JSON store |
| `/work-plan done\|start\|block\|fail\|cancel\|pending <id>` | Set an item's status directly |
| `/work-plan cycle <id>` (alias `toggle`) | Advance the item to its next status |
| `/work-plan remove <id>` | Remove an item |
| `/work-plan clear-done` | Clear completed (done/cancelled) items |

The TUI stores work-plan state under `~/.goodvibes/tui/work-plans/` and renders it in the `Work Plan` modal. Each project's plan is one file named from its exact project ID and root, so different projects never share a plan because their names look alike, and opening a plan costs the same however many projects you have used. Plans saved by an earlier build are moved to their new names, with every item, the first time the store opens; older files with unreadable or missing project metadata stay where they are, and the modal and `/work-plan show` name them once for recovery. Two GoodVibes programs editing the same project's plan take turns, so neither overwrites the other's change. A plan file with items this version cannot read in full, such as an unknown status written by a newer build, is copied aside before it is rewritten, and the Work Plan modal and `/work-plan show` name the copy.

Terminal items (done or cancelled) age out automatically once they pass a time and count bound; open, in-progress, blocked, and failed items are never reclaimed. Anything a sweep removes is recorded on the plan as a housekeeping note rather than deleted silently, and an assigned plan file that is unreadable (for example torn by a crash) is quarantined alongside the original rather than overwritten, so the list can still be recovered by hand.

The modal's keys:

| Key | Action |
| --- | --- |
| Up/Down | Navigate items |
| `Enter` / `Space` | Cycle the selected item's status |
| `1`-`6` | Set status directly (pending/active/blocked/done/failed/cancelled) |
| `a` | Open an inline add form (title/owner/notes fields) |
| `e` | Open the same form pre-filled to edit the selected item |
| `Tab` / `Enter` / `Esc` | In the form: cycle fields, save, cancel |
| `d` / `Delete` | Remove the selected item |
| `c` | Clear completed (done/cancelled) items |
| `r` | Refresh from disk |
| `x` | Export to a Markdown file next to the JSON store (`<store-file>.md`), the same rendering `/work-plan show` prints |
| `i` / `w` | On an item with linked ids, open the Agents modal on the linked agent or on the linked WRFC chain |

When the selected item has linked ids (`item.linked` holds any of `agentId`, `wrfcId`, `taskId`, `sessionId`), the detail block shows them with their jump key.

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
