# Project planning

Project Planning holds the project's **work plan**: the durable task checklist
that agent tools, the web SDK, the session briefing and `/workstream` read and
write. The work plan is the one plan.

The same space also keeps the **planning state** and **project language**
records written by the retired planning interview. They are read-only history:
nothing writes, evaluates, answers or approves them any more, and a saved
approval authorises no work. Their write routes answer `410` with code
`PLANNING_STATE_READ_ONLY`. New planning starts from native intake and the work
plan; decision records are still written.

Accessible via `@goodvibes-jev/engine/platform/platform/knowledge` (daemon embedders). Consumer apps interact through operator methods documented below.

## Work plans

Project work plans are the shared durable task model for TUI, WebUI, APK,
daemon planning, and contract correlation. They replace surface-local task lists
when a client needs project-scoped work tracking that survives process restarts
and is visible across surfaces.

Work-plan task records include a stable task id, title, notes, owner, status,
priority/order, timestamps, source, tags, an optional parent task id, linked
artifact/source/node ids, and the origin surface. A set of correlation fields
ties each visible task back to the machinery that produced or worked it, so
contract units and planning decisions never appear as unrelated work.

| Correlation field | What it links the task to |
| --- | --- |
| `contractId` | The contract the task belongs to |
| `phaseId` | The specific phase within that chain |
| `agentId` | The agent currently or last working the task |
| `turnId` | The conversation turn that produced the task |
| `decisionId` | The recorded planning decision behind the task |
| `sourceMessageId` | The message the task originated from |

The platform validates the work-plan status vocabulary
(`ProjectWorkPlanTaskStatus`). A task is a checklist item: any status may move to
any other status, including out of `done`, `failed` and `cancelled`, because the
contract plan sync reopens a task when later checks fail. The dedicated status
route and a task patch that sets `status` follow the same rule and emit the same
status-changed event. A status change without a `reason` clears the previous
`statusReason` and sets or clears `completedAt` for the new status.

Tasks with `source` of `planning` were copied from a planning state by the
retired interview. They are ordinary work-plan tasks now: nothing updates them
from a planning state again.

| Status | What it means |
| --- | --- |
| `pending` | Created and waiting to be picked up |
| `in_progress` | Actively being worked |
| `blocked` | Cannot proceed until something else resolves |
| `done` | Completed successfully |
| `failed` | Ended without completing |
| `cancelled` | Deliberately abandoned |

Do not confuse this with `ProjectPlanningTaskStatus`, the separate enum used by
the planning-state `tasks` field (`ProjectPlanningTask`). Its members are
hyphenated (`in-progress` rather than `in_progress`), it says `completed`
rather than `done`, it has no `failed` or `cancelled`, and it adds `deferred`
for work postponed by a planning decision.

Operator methods are exposed under `projectPlanning.workPlan.*` and daemon
routes under `/api/projects/planning/work-plan`. A remote client (the web UI,
the companion app) uses those routes.

### One plan per project, whichever program edits it

The plan's tasks are stored one row each in one SQLite file per user,
`~/.goodvibes/work-plans.sqlite`, next to the project identity registry that
names the projects (`~/.goodvibes/project-identities/`). The terminal app, the
Agent and the daemon all open that file, so a project has one plan whether one
of them runs alone or several run together, and whether or not a terminal app
is attached to a daemon. A daemon on another machine keeps the plan of the
projects on that machine in that machine's file. The file runs in WAL mode (a
reader never waits for a writer), waits up to 5 s for another program's write,
and every edit is one immediate transaction, so two programs editing the same
plan never overwrite each other.

Changing one task writes that one row, whatever the size of the plan, and
tasks never appear in knowledge search, listings, enrichment or answers. Every
committed edit moves the plan's `revision` up by one. An edit returns what it
changed and the revision, not the plan: create, update and status return
`task` (and `previousTask`), delete returns `deletedTask`, clear-completed
returns `clearedTaskIds`, reorder returns `tasks` (only the tasks whose
position changed); every result has `changed`, `revision`, `updatedAt` and the
plan's `counts`. An edit that changes nothing returns `changed: false` and
writes and announces nothing. `projectPlanning.workPlan.task.get` returns one
task and the revision. A client that shows the whole plan reads
`projectPlanning.workPlan.snapshot`, which carries the same `revision`, and
reads it again only when a work-plan event (or its own edit) carries a
different revision.

### Finished tasks are removed automatically

Done and cancelled tasks are removed once they are past either bound: untouched
for 30 days, or older than the 200 most recently touched finished tasks of the
plan. The removal runs inside the edit that finishes a task (a status change
to `done` or `cancelled`, or a task created finished), as one statement over an
index of the plan's finished tasks; no other edit, read or start-up pays for
it. That edit's result lists the removed task ids in `reclaimedTaskIds`, and a
`WORK_PLAN_TASK_DELETED` event is sent for each. Pending, in-progress, blocked
and failed tasks are never removed this way. `clearCompleted` removes finished
tasks at once.

### Plans kept by earlier versions

Earlier versions kept a program's plan in that program's own knowledge
database (task rows, or one stored record). The first time a program opens a
plan, it moves its own earlier copy into the shared file, once: in one
transaction, a task the file already holds is kept when it was changed later,
and the copy's other tasks go after the plan's own. The copy is then removed
from the knowledge database.

Task changes emit planner-domain events so clients can refresh snapshots or
apply deltas instead of polling. Every event carries the plan's `revision`. One
edit announces only the tasks it changed, then one
`WORK_PLAN_SNAPSHOT_INVALIDATED` with the new revision and no tasks: a snapshot
read at an older revision is stale.

| Event | When it fires |
| --- | --- |
| `WORK_PLAN_TASK_CREATED` | A new task was created |
| `WORK_PLAN_TASK_UPDATED` | A task's fields were patched, or a reorder moved it |
| `WORK_PLAN_TASK_STATUS_CHANGED` | A task's status changed, by the status route or a patch |
| `WORK_PLAN_TASK_DELETED` | A task was removed, by delete or clear-completed |
| `WORK_PLAN_SNAPSHOT_INVALIDATED` | Once after every committed edit |

The work-ledger legacy import (`workLedger.prepareLegacyImport`) captures the
project's work-plan tasks itself, each as one record of kind `work-plan-task`,
in addition to the planning sources the client names.

The contract runner keeps the work plan in step with each contract
(`contract/plan-sync.ts`). Each contract gets a task `contract-<contractId>`
and each of its units a child task `contract-<contractId>-<unitId>`, all with
`source: 'contract'` and the contract's id in `contractId`. The contract's task
is `in_progress` from shaping through committing, `pending` while queued, and
`blocked` while it waits on its owner. Unit statuses map onto task statuses:

| Unit status | Task status |
| --- | --- |
| `pending`, `blocked` | `pending` |
| `running`, `checking`, `held`, `nudged`, `fixing`, `held-merge` | `in_progress` |
| `awaiting-owner` | `blocked` |
| `passed` | `done` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

Other planning integrations should likewise link visible tasks through the
correlation fields rather than presenting child agents as unrelated work.

## Knowledge spaces

Planning artifacts live in project knowledge spaces:

```text
project:<projectId>
```

Routes accept either `projectId` or a full `knowledgeSpaceId`. If neither is
provided, the daemon uses a stable project id derived from its working
directory. TUI clients should still pass their own stable project id so
workspace-specific planning, language, decisions, and future wiki pages do not
bleed across unrelated projects.

Project spaces are isolated by default. Related projects can link records
explicitly later, but reads and writes for this feature default to the current
project space only.

## Artifacts

Planning records are stored as `KnowledgeSourceRecord` rows with:

- `connectorId: "goodvibes-project-planning"`
- `sourceType: "dataset"`
- `metadata.projectPlanning: true`
- `metadata.planningArtifactKind`, one of the four kinds below
- `metadata.planningArtifactId`, the id of the individual record (a task id, a decision id)
- `metadata.projectId`
- `metadata.knowledgeSpaceId`
- `metadata.value`, the artifact itself

Artifact kinds:

| Kind | Purpose |
|---|---|
| `state` | Saved planning state from the retired interview (read-only history) |
| `decision` | Durable decision record for meaningful choices |
| `language` | Saved project vocabulary and resolved ambiguities (read-only history) |
| `work-plan` | Shared durable project task list; persisted as a planning artifact (see Work Plans above) |

This keeps planning integrated with the knowledge/wiki store without adding a
separate persistence system.

## Planning state

A saved planning state, as `projectPlanning.state.get` returns it:

```ts
{
  id: string;
  projectId: string;
  knowledgeSpaceId: string;
  goal: string;
  scope?: string;
  knownContext: string[];
  openQuestions: ProjectPlanningQuestion[];
  answeredQuestions: ProjectPlanningQuestion[];
  decisions: ProjectPlanningDecision[];
  assumptions: string[];
  constraints: string[];
  risks: string[];
  tasks: ProjectPlanningTask[];
  dependencies: ProjectPlanningDependency[];
  verificationGates: ProjectPlanningVerificationGate[];
  agentAssignments: ProjectPlanningAgentAssignment[];
  readiness: "not-ready" | "needs-user-input" | "executable";
  executionApproved: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}
```

`readiness` and `executionApproved` are what the record held when it was saved.
Nothing re-evaluates them, and neither one starts or permits work.

## Decision records

Decision records should be used for meaningful project choices, not every small
implementation detail. A decision belongs here when reversal would be expensive,
when maintainers need context beyond the code, or when real alternatives and
tradeoffs existed.

Stored fields include:

- title
- context
- chosen decision
- rejected alternatives
- reasoning
- consequences
- status

## Project language

Saved project language records hold the vocabulary the retired interview
collected. They are read-only and can hold:

- canonical terms
- terms to avoid because they are ambiguous
- aliases
- relationships between concepts
- example scenarios
- resolved ambiguity records

Example:

```json
{
  "terms": [
    {
      "term": "Surface",
      "definition": "A user-facing channel where GoodVibes can receive or send interaction.",
      "avoid": ["client", "integration"]
    }
  ],
  "ambiguities": [
    {
      "phrase": "agent channel",
      "resolution": "Use ntfy chat channel for normal chat and ntfy agent channel for background agent work."
    }
  ]
}
```

## Routes

| Route | Method | Admin | Purpose |
|---|---|---:|---|
| `/api/projects/planning/status` | `GET` | no | Return artifact counts and passive capabilities |
| `/api/projects/planning/state` | `GET` | no | Read a saved planning state |
| `/api/projects/planning/decisions` | `GET` | no | List project decisions |
| `/api/projects/planning/decisions` | `POST` | yes | Record a project decision |
| `/api/projects/planning/language` | `GET` | no | Read saved project vocabulary and ambiguity records |
| `/api/projects/planning/work-plan` | `GET` | no | Read the work-plan snapshot |
| `/api/projects/planning/work-plan/tasks` | `GET` | no | Read the work-plan snapshot (task view) |
| `/api/projects/planning/work-plan/tasks` | `POST` | yes | Create a work-plan task |
| `/api/projects/planning/work-plan/tasks/reorder` | `POST` | yes | Reorder work-plan tasks |
| `/api/projects/planning/work-plan/clear-completed` | `POST` | yes | Clear completed work-plan tasks |
| `/api/projects/planning/work-plan/tasks/:taskId` | `GET` | no | Get a single work-plan task |
| `/api/projects/planning/work-plan/tasks/:taskId` | `PATCH` | yes | Update a work-plan task |
| `/api/projects/planning/work-plan/tasks/:taskId` | `DELETE` | yes | Delete a work-plan task |
| `/api/projects/planning/work-plan/tasks/:taskId/status` | `POST` | yes | Set a work-plan task status |

Each operator method mirrors one of the routes above; the planning-state and
language methods read the saved interview records, the decision methods keep
decision records, and the work-plan methods manage the live task checklist.

| Method | What it does |
| --- | --- |
| `projectPlanning.status` | Return passive planning artifact counts and capabilities without starting a planning loop |
| `projectPlanning.state.get` | Return a saved planning state record |
| `projectPlanning.decisions.list` | Return durable decision records from the project planning space |
| `projectPlanning.decisions.record` | Persist a meaningful project decision for future context |
| `projectPlanning.language.get` | Return saved project vocabulary and resolved ambiguity records |
| `projectPlanning.workPlan.snapshot` | Return the durable work-plan snapshot with tasks and status counts |
| `projectPlanning.workPlan.tasks.list` | List tasks with optional status, owner, parent, or contract filters |
| `projectPlanning.workPlan.task.create` | Create a durable work-plan task |
| `projectPlanning.workPlan.task.get` | Fetch one task by id |
| `projectPlanning.workPlan.task.update` | Patch a task |
| `projectPlanning.workPlan.task.status` | Set a task's status and optional reason |
| `projectPlanning.workPlan.task.delete` | Delete a task |
| `projectPlanning.workPlan.tasks.reorder` | Replace the work plan's task ordering |
| `projectPlanning.workPlan.clearCompleted` | Remove completed tasks, clearing `done` only by default |

## Terminal integration

The terminal apps show saved planning state records as read-only history
(`/work history` and the planning modal) and drive real work through
the work plan and `/workstream`; nothing answers or approves a saved
planning record.

## Next reads

- [Runtime orchestration](./runtime-orchestration.md): how contracts and agent work correlate to work-plan tasks.
- [Automation and watchers](./automation.md): operator-method families for daemon-hosted jobs and schedules.
