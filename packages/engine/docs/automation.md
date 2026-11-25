# Automation and watchers

The automation system runs prompts on a schedule instead of waiting for a
conversation to start one. A **job** is the durable record of what to run and
when; each time it fires it produces a **run**, the record of one execution
attempt with its own status, timing, and output. A job's trigger is described
by a **source** (a cron expression, a fixed interval, a one-off time, a
webhook, or an external watcher), and where its output goes is described by a
**route binding** and a **delivery**, the record of what actually happened
when that output tried to reach a surface. **Schedules** are the host-owned
records that turn a source description into something the engine actually
fires on. Consumer apps interact with all of this through the operator
methods documented below; daemon embedders wire automation through host
runtime composition rather than a catch-all platform namespace.

The method lists in this document are an index, not the full contract. For
the request and response shape of each method, including the category it is
registered under (for example `watchers.list` under `watchers`,
`services.status` under `services`), see the generated
[Operator method reference](./reference-operator.md), or fetch the live
catalog at `GET /api/control-plane/methods` for the registration in your
daemon build.

## Automation domain

Automation records split into jobs, runs, sources, routes, schedules, and
deliveries, each covering one piece of "what runs, when, and what happened."

The operator methods cover the job lifecycle, run history and intervention,
heartbeat processing, and scheduler capacity.

| Method | What it does |
| --- | --- |
| `automation.integration.snapshot` | Return the automation integration snapshot |
| `automation.jobs.list` | Return automation jobs and recent runs, optionally paginated with `limit`/`cursor` |
| `automation.jobs.create` | Create a durable automation job |
| `automation.jobs.update` | Update a durable automation job |
| `automation.jobs.delete` | Delete a durable automation job |
| `automation.jobs.enable` / `automation.jobs.disable` | Turn a job on or off without deleting it |
| `automation.jobs.run` | Trigger a job immediately |
| `automation.runs.list` | Return run history, optionally paginated and filterable with `since` for away-digest reads |
| `automation.runs.get` | Return a single run record |
| `automation.runs.cancel` | Cancel an active run |
| `automation.runs.retry` | Retry a failed, cancelled or missed run; a run that is still running or completed is refused |
| `automation.heartbeat.list` | Return jobs queued for the next heartbeat |
| `automation.heartbeat.run` | Process jobs queued for the next heartbeat |
| `scheduler.capacity` | Return the scheduler capacity snapshot: total slots, in-use slots, queue depth, and oldest queued run age |

A cancelled run stays cancelled. If its evaluator or execution finishes after
the cancel, that late result does not change the stored run. A cancellation is
the same whoever made it: cancelling the run, stopping its agent from any agent
view, or deleting its job. The run is recorded as cancelled and its ordinary
run message is sent; it does not count as a failure and is not retried.
Deleting a job cancels a run of it that is still in flight.

A run ends at its timeout: the job's `execution.timeoutMs`, or
`automation.defaultTimeoutMs` (two hours unless changed) when the job sets
none; a job stores only a timeout of its own, so changing the default applies
to every other job at once. Past it, the run's agent is stopped and the run
fails with `Timed out after <duration>`; the job's failure policy then applies
as for any other failure. A run that was in flight when the daemon or app
stopped is failed when it starts again ("Agent state lost before completion",
or "Check-in interrupted by a restart"), since nothing can report on it any
more, and the retry policy applies at once. A run reported on by a remote peer
waits for that report or its deadline.

A run uses the permission posture and sandbox of the owner who created its
job (`permissions.mode`, `sandbox.enabled`); a job has no setting of its own
for either. Delivery sends the run's result when `includeSummary` is on and
its links when `includeLinks` is on.

Editing a job's name, prompt, delivery or failure policy keeps its next run
time; only a change to its schedule or to whether it is enabled moves it. An
`every` schedule counts from when it was set. An edit made against a job's
revision stays valid while the job runs: running a job does not change its
revision, only a change to what the job is does.

When a run fails, the job's failure policy decides what follows. With the
`retry` action the failed run is tried again up to the retry policy's
`maxAttempts` (a job's own `execution.maxAttempts`, when set, takes
precedence), waiting by the policy's `delayMs`, `strategy`, `maxDelayMs` and
`jitterMs`, and only when the failure could succeed on another attempt. A run
that fails to start (for example its target session is missing or the agent
cannot be spawned) is handled the same way: its failure notice goes to the
job's delivery targets (or its explicit failure route), the job is reported as
auto-disabled when the failure threshold pauses it, and the retry policy
applies. A failed run produces one failure message, not a failure notice plus
the ordinary run message. A scheduled occurrence that comes due while an
earlier run of the same job is still running is skipped rather than started
alongside it.

A one-time (`at`) job is finished once its time has come: if the daemon was
down past the catch-up window, the missed occurrence is recorded and the job is
disabled with `one-shot-complete`. Enabling a one-time job whose time has
already passed leaves it disabled with the reason `schedule-expired`.

`automation.jobs.create` accepts a `kind` of `cron`, `every`, or `at`, and the
schedule field required alongside it depends on which kind is chosen. It is a cron
expression for `cron` (also accepted nested as `schedule.expression`), an
interval for `every`, or a fixed timestamp for `at`. A bare `{ prompt }` with
no schedule information is never a complete call; the job also carries the
model and provider to run it under, an execution intent describing how the
session is created, a delivery policy for where the output goes, and a
failure policy for what happens after a run fails.

Automation config controls whether the subsystem runs at all, how much of it
runs at once, and how long its history is kept:

| Key | Default | What it controls |
|---|---|---|
| `automation.enabled` | `true` | Master gate for the subsystem: durable jobs, schedule evaluation, run history. With no jobs defined it idles. |
| `automation.maxConcurrentRuns` | `4` | How many automation runs may execute at the same time. |
| `automation.runHistoryLimit` | `100` | Run history entries retained per job before the oldest are dropped. |
| `automation.defaultTimeoutMs` | `7200000` (two hours) | Timeout in milliseconds for a run whose job sets no `timeoutMs`: past it the run's agent is stopped and the run fails. `0` means such a run has no deadline and ends only when it finishes or is cancelled. |
| `automation.catchUpWindowMinutes` | `30` | How long after daemon startup the engine will still catch up runs it missed while it was down. |
| `automation.failureCooldownMs` | `300000` (5 minutes) | Cooldown enforced after a failed run before the job is eligible to run again. |
| `automation.deleteAfterRun` | `false` | Whether a one-shot job (`kind: 'at'`) deletes itself after its first successful run. |

> **Core-verb rename (see CHANGELOG 1.0.0):** `automation.jobs.patch` was renamed to
> `automation.jobs.update`. The canonical verb is `update`, not `patch`; the
> HTTP method on the route (`PATCH /api/automation/jobs/{jobId}`) is
> unaffected, only the operator-method id changed. The separate
> `automation.jobs.pause` / `automation.jobs.resume` methods were retired.
> They were a byte-identical redundant lifecycle pair with
> `automation.jobs.disable` / `automation.jobs.enable` (same `{id, enabled}`
> output, same semantics, pause==disable, resume==enable). A caller-facing
> "pause"/"resume" verb should now invoke `automation.jobs.disable` /
> `automation.jobs.enable`. `patch`, `pause`, and `resume` are permanently
> banned verb tails (`packages/engine/contracts/src/core-verbs.ts`) and cannot
> reappear under any automation method id. See
> [`packages/engine/contracts/src/core-verbs.ts`](../contracts/src/core-verbs.ts).

## Schedules

A schedule is a host-owned record of a recurring or one-off trigger,
independent of the job it fires. The schedule endpoints manage those records.

| Method | What it does |
| --- | --- |
| `automation.schedules.list` | Return schedule records |
| `automation.schedules.create` | Create a schedule record |
| `automation.schedules.delete` | Delete a schedule record |
| `automation.schedules.pause` / `automation.schedules.resume` | Pause a schedule or resume it, without deleting it |
| `automation.schedules.preview` | Read a schedule as typed (a time in words, an ISO time, a cron pattern, `every 30m`, `in 2h`) and return the reading and the next run; nothing is kept |
| `automation.schedules.run` | Trigger a schedule immediately |

> **Core-verb rename (see CHANGELOG 1.0.0):** this family was renamed from the bare
> `schedules.*` (no namespace prefix) to `automation.schedules.*`. The bare
> name collided with two unrelated things that also used the word "schedule":
> the agent's own reminder/routine tooling (which called these methods under
> the bare name) and `knowledge.schedule(s).*` below (a different resource:
> recurring knowledge-ingestion jobs, not automation prompt jobs). The HTTP
> paths were already `/api/automation/schedules/*`. Only the operator method
> id was inconsistent with its own route. The rename brings the two in line
> and removes the bare top-level `schedules` namespace entirely, leaving only
> two clearly-scoped "schedule" families: `automation.schedules.*` (this one)
> and `knowledge.schedule(s).*` (below).

Knowledge jobs have their own, separate schedule API for recurring
knowledge-ingestion work, not automation prompt jobs. Its single-record
methods are singular, `knowledge.schedule.get`, `knowledge.schedule.save`,
`knowledge.schedule.delete`, and `knowledge.schedule.enable`, while the list
method is the plural `knowledge.schedules.list`. This singular-item and
plural-list split is the canonical namespace convention
(`packages/engine/contracts/src/core-verbs.ts`) for a resource family that has both
a per-item action surface and a collection surface where the plural form
alone would be ambiguous about which one an action targets, not a special
case invented for knowledge. `automation.schedules.*` above has no separate
singular family because nothing needs one yet; introducing one defensively
"for symmetry" is explicitly against the convention.

## Route bindings

A route binding is the daemon's memory of which external conversation a piece
of state belongs to, a Telegram thread, an ntfy topic, a Home Assistant
callback, a companion-app chat session. Automation delivery, channel replies,
and other daemon-hosted work read and write these bindings so a reply lands
back in the same place the original message came from.

| Method | What it does |
| --- | --- |
| `routes.snapshot` | Return the route and binding integration snapshot |
| `surfaces.list` | Return registered channel and control surfaces |
| `routes.bindings.list` | Return configured route bindings |
| `routes.bindings.create` | Create or upsert a route binding |
| `routes.bindings.update` | Update an existing route binding |
| `routes.bindings.delete` | Delete an existing route binding |

> **Core-verb rename (see CHANGELOG 1.0.0):** `routes.bindings.patch` was renamed to
> `routes.bindings.update`, the same rename applied to `automation.jobs.patch`
> and `watchers.patch` below, for the same reason: `update` is the one
> canonical partial-mutation verb, and `patch` mirrored the HTTP method name
> instead of the operator-method vocabulary. The HTTP route
> (`PATCH /api/routes/bindings/{bindingId}`) is unaffected.

A route binding can carry surface kind, external id, thread id, channel id,
session id, job id, run id, and metadata, so a single record can describe
where a job's output should land regardless of which of those identifiers the
destination surface actually organizes around.

## Deliveries

A delivery is the outcome of one attempt to get a message to a surface:
whether it landed, how many times it was retried, and whether it ended up
dead-lettered after exhausting its retries.

Operator methods:

- `deliveries.list`
- `deliveries.get`

The `integrations.delivery.sloEnforced` setting (default `true`) controls how
strictly a failure is tracked. On, a failure is classified retryable or
terminal from its own facts (a stated class, Retry-After, HTTP status,
connection code; no model reads the error text), retried with exponential
backoff, and a dead letter is logged at error level and surfaced in
integration diagnostics. Off, dead letters are logged at warn level only. An
explicit per-queue `sloEnforced` option, when a caller sets one, overrides
this default for that queue alone.

### Notifications

Agent and workstream outcomes (an agent completed, failed or was cancelled; a
workstream passed, failed or was cancelled) are announced with the same
events and the same words to every notification transport: Slack, Discord
and the generic webhook URLs (the daemon's one list, on the Notifications tab
of Mail, calendar and channels). Slack and Discord get a
notification channel only when they have somewhere to post: an
incoming-webhook URL (the service's `webhookUrl`, or `SLACK_WEBHOOK_URL` /
`DISCORD_WEBHOOK_URL`), or a bot token together with
`surfaces.slack.defaultChannel` / `surfaces.discord.defaultChannelId`. A bot
token alone connects chat but not notifications; the integration row says so
and names what to add.

Every transport retries a failed notification with the same policy, then
keeps it in a failed-notification list. The daemon stores its list on disk,
so it survives a restart; list and resend it with the operator methods
`notifications.deadLetters.list` and `notifications.deadLetters.replay`, or on
the Failed notifications tab of Mail, calendar and channels. A notification a
terminal program sent on its own events and could not deliver stays in that
program's own failed list on disk. A
resent notification is delivered, queued again for retry, or back in the
list; a webhook notification is not sent to a URL that was removed since it
failed.

## Watchers

A watcher is a managed, checkpointed poller or listener over an external
source, CI status, a webhook endpoint, a health check, with its own recovery
behavior if the daemon restarts mid-poll. This is a different subsystem from
the automation jobs above. A job runs a prompt on a schedule, while a watcher
tracks the state of something external between polls and recovers a missed
window rather than re-running from scratch.

| Method | What it does |
| --- | --- |
| `watchers.list` | Return configured watchers and their runtime posture |
| `watchers.create` | Register a new watcher |
| `watchers.update` | Update an existing watcher |
| `watchers.delete` | Delete an existing watcher |
| `watchers.start` / `watchers.stop` | Start or stop a watcher instance |
| `watchers.run` | Trigger a watcher immediately |

> **Core-verb rename (see CHANGELOG 1.0.0):** `watchers.patch` was renamed to
> `watchers.update`, the same rename applied to `automation.jobs.patch` and
> `routes.bindings.patch` above. The HTTP route
> (`PATCH /api/watchers/{watcherId}`) is unaffected.

`watchers.create` makes a watcher the daemon can run on its own: kind
`webhook` or `polling` with a `url`, `filesystem` with a `path`, or `manual`.
A watcher with nothing to run (kind `socket` or `integration`, or a missing
url or path) is refused with `WATCHER_NOTHING_TO_RUN`; those kinds are
registered by the component that owns the connection. A `run` text is refused
with `WATCHER_RUN_TEXT_UNSUPPORTED`: it was never executed. After a restart, a
watcher whose work belongs to a component waits for that component to register
it again; until then it reads `awaiting its owner since <time>`, and start or
run is refused with `WATCHER_AWAITING_OWNER`. When the watcher store cannot be
saved, a change still takes effect and its answer carries `persisted: false`
with a notice: a restart would not keep it.

A url or webhook watcher can send request headers. A header that carries a
credential must be given as a `goodvibes://secrets/<name>` reference: the
watcher stores the reference, never the value, and the daemon reads the secret
when it makes the request. Creating or updating a watcher with a plain-text
header value is refused with `WATCHER_HEADER_LITERAL`. A run whose referenced
secret cannot be read fails without sending the request.

Watcher config controls whether the subsystem runs, how often it polls, and
how it recovers from a restart:

| Key | Default | What it controls |
|---|---|---|
| `watchers.enabled` | `true` | Master gate for managed watcher/listener services. With none configured the framework idles. |
| `watchers.pollIntervalMs` | `60000` | Polling interval for watcher sources. |
| `watchers.heartbeatIntervalMs` | `15000` | Heartbeat interval for watcher services, how often a running watcher checks in. |
| `watchers.ciPollIntervalMs` | `60000` | Cadence for the daemon's recurring CI-status poll specifically; the poller enforces a 15-second floor regardless of this setting, to respect the status source's rate limits. |
| `watchers.recoveryWindowMinutes` | `10` | How far back a restarted watcher looks to catch up on missed events. |

A separate, unrelated subsystem, the stream/condition/on-exit trigger family
under `platform/triggers/`, shares a confusingly similar config prefix
(`watchers.triggers.*`) but is a different feature. It supervises long-lived
child processes and fires on log patterns, declarative condition checks, or
process exit, rather than polling an external source. It has no operator
methods of its own today, so it is configuration-only; see the config keys
under `watchers.triggers.*` if you are looking for that feature rather than
the polling watchers documented above.

## Services

The service-management methods expose installation and runtime control for a
daemonized GoodVibes host, the platform service itself, not a job or a
watcher.

| Method | What it does |
| --- | --- |
| `services.status` | Return platform service installation and runtime posture |
| `services.install` / `services.uninstall` | Install or uninstall the GoodVibes platform service |
| `services.start` / `services.stop` / `services.restart` | Control the running platform service |

## Next reads

- [Runtime Orchestration](./runtime-orchestration.md)
- [Feature settings](./feature-settings.md)
- [Defaults](./defaults.md)

## Triggers: creating them, where they live, and who runs them

The trigger family (`watchers.triggers.enabled`) watches for something and
starts an agent turn when it happens, without holding a turn open: an
`on-exit` trigger runs a command and fires once when it ends, a `stream`
trigger runs a long-lived command and fires on matching output lines, and a
`condition` trigger checks a URL, file or command on an interval and fires
when its rule holds. A trigger may run a command the owner approved in
advance (an action grant); only the owner registers grants.

An agent creates, lists, cancels and resets triggers and reads their runs with
the `trigger` tool (actions `create`, `list`, `history`, `cancel`, `reset`), in
daemon-hosted sessions, in the TUI and the Agent (which use the daemon's
supervisor) and in the workers they start. The owner does the same in
Automation's Triggers tab (the `triggers.list`, `triggers.watch`,
`triggers.history`, `triggers.stop` and `triggers.restart` capabilities), and
lets triggers run a command from its Commands tab (`triggers.allow-command`;
`triggers.commands` lists them). Operators call
`watchers.triggers.list`, `.history`, `.create`, `.cancel`, `.reset`,
`.grant.list` and the owner-only `.grant.register`.

Triggers are saved in `triggers.db` under the selected surface directory, one
row per trigger: a check writes that one trigger's row, whatever the number of
triggers. An observation keeps at most a 512-character sample of the result
plus a digest, so a change past the sample is still seen.

Nothing runs and nothing is written until the family is on and a trigger
exists. Turning `watchers.triggers.enabled` on starts supervising stored
triggers at once.

One process supervises a surface's triggers; it holds a lock the operating
system releases if the process dies. Other terminal windows can list the
stored triggers, and report `executionOwnership: other-process`; a change from
one of them is refused and says which process to use. When the supervising
process exits, another takes over on its next supervision tick.

A save that fails (a full disk, an unreadable file) fails only that save: the
trigger keeps running, its `lastError` reads `not saved: <cause> (<path>)`,
and the save is retried on the next tick.

A trigger that has fired or been cancelled is finished. Reset applies only to
`idle`, `backoff`, `circuit-open` and `failed` triggers: resetting a running,
fired or cancelled trigger is refused, and the refusal says to wait, cancel, or
create a new trigger. Cancelling a trigger that is already fired or cancelled
returns it unchanged and adds no run to its history.

An on-exit trigger is `firing` while its action is delivered and `fired` only
once it was. An action that fails (the agent could not start, the provider is
down) is kept owed: the trigger backs off and delivers it again when due, or
after a reset once its breaker opened, and is never removed while it is owed.
If the daemon restarts while an action is being delivered, an agent turn is
delivered again; an approved command is not run twice unasked and waits for a
reset. If the daemon restarts while the watched command is still running, the
trigger waits (one liveness check per tick, up to the command's duration
limit) and fires once it ends, saying its exit status was not observed.

A stream trigger whose command ends after a healthy run (it stayed up for the
first backoff step, or matched a line) starts again without a strike; a clean
exit is a restart, not a failure. When a stream ends, the lines still queued
go to one final agent turn, and a batch whose action failed goes back at the
head of the queue. When the stream is already gone (its final batch, or a
batch in flight when the command ended), a failed batch is kept with the
trigger (`owedBatches` in its summary) and delivered again on the backoff
ladder until it is delivered or the trigger is cancelled; at most eight are
kept, and a dropped one is recorded in the trigger's runs.

## Inspect supervised triggers

Condition, stream and process-exit triggers belong to each surface’s native trigger supervisor. They are separate from workflow event triggers.

In the TUI and Agent, Automation's Triggers tab reads the daemon's trigger summaries and says when another process supervises them. In the WebUI, open the **Automation** screen. The administrative operator method is `watchers.triggers.status` (`read:watchers`); it reads the daemon supervisor, not the workflow event-trigger manager, and never claims execution ownership.

Another execution owner remains read-only: close that process and this one takes over on its next supervision tick. A newer saved format requires an updated installation; unreadable storage is named, with its cause, in the daemon log.
