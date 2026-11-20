# Automation and services

This part covers work that runs without a conversation (scheduled routines, supervised triggers, watchers, check-ins), notifications, and the services the platform connects to: mail, calendar, Google, chat channels, voice, the browser, purchases, CI watch, occasions and plans. It ends with the list-valued settings and the settings reference for each area.

## Before you start: who owns these services

- The daemon (`goodvibes-daemon`) owns every service in this part. Mail, calendar, channels, purchases, CI watches, occasions and daemon-kept routines run in the daemon, so they keep working with every terminal closed. The terminal apps and the web UI are clients of it.
- The daemon is on when `daemon.enabled` is `true` (the default). `goodvibes status` shows the service state under `Service:`.
- Settings under `surfaces.`, `payments.`, `occasions.` and the other daemon-owned prefixes are written to the daemon's settings file, `~/.goodvibes/daemon/settings.json`, whichever app writes them.
- How to change a setting:
  - Terminal app: `/settings <key>` opens the settings workspace at that key, and `/settings set <key> <value>` writes it directly. The value is read as JSON when it parses (`true`, `5`, `["a","b"]`, `{"k":1}`, `"quoted text"`); otherwise it is taken as text.
  - Agent: `/settings <key>` opens the workspace, and `/settings set <key> <value>` writes text, numbers, `true`/`false` and enum words. The Agent's `/settings set` takes no JSON list or object: set those in the settings screen (`/settings open <key>`).
  - Daemon command line: `goodvibes-daemon config set <key> <value>` (JSON or text, as the terminal app).

  The examples in this part use `/settings set`, the same line in both programs.
- A credential setting (a token, a password, a webhook URL) is never written into a settings file. `/settings set <key> <value>` stores the value in the secret store and writes a `goodvibes://secrets/...` reference into the key. A daemon-owned credential lands in the daemon's store, `~/.goodvibes/daemon/secrets.enc`. Example:

  ```text
  /settings set surfaces.telegram.botToken <your-bot-token>
  Set surfaces.telegram.botToken: stored in the daemon secret tier as GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN (value hidden).
    surfaces.telegram.botToken now holds the reference goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN; the value itself is never written to a config file.
    The daemon reads that tier, so this keeps working with this client closed.
  ```

  The secret key name is `GOODVIBES_` followed by the setting key in upper case with dots and camel-case boundaries turned into `_`. The same value can be stored directly with `/secrets set GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN <value>`.
- Everything a service sends as the owner passes the permission gate described in "Permissions, decisions and safety": a new recipient is the owner's to allow, and a change asked for on a channel is the owner's to approve.

## Scheduled routines

A routine is a prompt that runs on a schedule. Each time it fires it produces a run. The daemon keeps routines as automation jobs, so a routine runs once whether or not a terminal is open, and the list is the same in the web UI, channels and agents.

### Schedule kinds

| Kind | Value | Example |
| --- | --- | --- |
| `cron` | A five-field cron expression, optional `--tz <IANA zone>` and `--stagger <ms>` | `"*/30 * * * *"` |
| `every` | An interval such as `15m`, `2h`, `1d` | `15m` |
| `at` | One date and time, ISO form; read in this machine's zone when it has no zone | `2026-12-01T09:00` |
| `when` | Natural language, read by the decision model into one of the three above | `"every weekday at 9am"` |

### `/schedule`, in both programs

`/schedule` alone opens its list of actions (in a script or for a model it prints the schedules, as "See your schedules" does). Both programs take the same lines; the terminal app keeps a schedule with the daemon (or runs it itself while the daemon is off), the Agent keeps it on its connected host. A line with something missing opens the step that asks for it.

| Action | Line | Risk |
| --- | --- | --- |
| See your schedules | `/schedule list` | |
| Schedule something to run | `/schedule add (--when <words> \| --at <date> \| --every <interval> \| --cron <pattern>) [options] <what it does...>` | |
| Run a schedule now | `/schedule run <schedule>` | |
| Pause a schedule | `/schedule pause <schedule>` (picked from the ones that run) | |
| Resume a schedule | `/schedule resume <schedule>` (picked from the paused ones) | |
| Change a schedule | `/schedule change <schedule> [--when ... \| --at ... \| --every ... \| --cron ...] [--tz <zone>] [--stagger <duration>] [--name <name>] [--task <task> --success-criteria <result>] [<what it does...>]` | |
| Remove a schedule | `/schedule remove <schedule>` | cannot be undone |

```text
/schedule add --when "every weekday at 9am" post the standup summary
/schedule add --cron "0 9 * * 1-5" --tz America/Chicago summarize open pull requests
/schedule add --every 15m check the build status
/schedule add --at 2026-12-01T09:00 send the release reminder
/schedule pause weekly-report
```

A schedule is named by its id, its name or the start of its id (one that names more than one is refused with the candidates). Options of `add` ("Anything else?" in the guided form; each blank keeps the usual setting):

| Option | Meaning |
| --- | --- |
| `--name <name>` | Its name; default is the first 40 characters of what it does. |
| `--model <model>`, `--provider <provider>` | The model to run it with. |
| `--fallback <a,b>` | Fallback models. |
| `--reasoning <level>`, `--thinking <mode>` | Reasoning effort and thinking mode. |
| `--target isolated\|main\|background\|pinned` | Where it runs: a fresh conversation each time (the usual), the main conversation, a background session, or the pinned one. |
| `--wake now\|next-heartbeat` | Run at once when due, or with the next heartbeat. |
| `--template <tmpl>` | A prompt template. |
| `--tool <name>` | Allow only these tools (repeat the option). A run limited this way does not get the mail and calendar tool unless `--tool google` is given. |
| `--deliver <channel>` | Where each run's answer goes: a channel written as in settings, `telegram`, `slack:C123` and so on (`telegram` alone uses `surfaces.telegram.defaultChatId`). Without it the answer goes to the owner inbox. |
| `--external-source <kind>` | Marks where outside content comes from. |
| `--allow-unsafe-external-content` | May act on content from outside sources ("Yes" loosens a protection: it asks first, and a model's line is refused). |
| `--paused` | Kept, but runs only once resumed. |
| `--light-context` | Run with a small context. |
| `--tz <zone>`, `--stagger <duration>` | For a pattern or a description: its time zone, and a spread of the start (such as `5m`). |

In the web UI the same actions are the Schedules screen and its sheets (see "Slash command actions in the web UI" in the daemon part). There a time described in words is read by the daemon (`automation.schedules.preview`, in the browser's time zone when `--tz` is blank) and shown as `Read as: ...` with the next run before the button keeps it; nothing is kept by the reading.

Successful `add` output (the id is generated):

```text
Scheduled.
"check the build status": every 15m; next run 2026-11-18 10:15 America/Chicago (runs once, with or without a terminal open).
The answer goes to your owner inbox. Id job-3f9c2a1b7d.
```

With `daemon.enabled` off, the terminal that holds the routine lock keeps and runs the routines while it is open (`kept and run by this terminal (daemon off)`); another terminal can list them but not change them. When the daemon is turned on later, routines kept by a terminal are moved to the daemon and the move is reported.

Failures:

| Message | Fix |
| --- | --- |
| `Schedules are kept and run by the GoodVibes daemon ... it cannot be reached: <reason> Nothing was scheduled or changed.` | Start the daemon; check `goodvibes status`. |
| `Not kept: "<value>" is not a date and time. ...` | Use an ISO timestamp. |
| `Not kept: <time> has already passed.` | Pick a future time. |
| `Not kept: the timing is <reason>; give it as a date (--at), an interval (--every) or a pattern (--cron) instead.` | The decision model could not read the words, or none is set. Use `--at`, `--every` or `--cron`. |
| `/schedule add has no option --x.` | Use one of the listed options. |

### The Agent: `/routines promote`, and a schedule's runs

An Agent routine becomes a schedule on the connected host with `/routines promote <routine> --how <cron|every|at> --when <pattern, interval or time> [--timezone <tz>] [--name <name>] [--delivery-channel <channel[:route]>]... [--delivery-route <route>]... [--delivery-webhook <url>]... [--delivery-link <name>]... [--provider <id>] [--model <id>] [--disabled]` (or the guided form, "Run a routine on a schedule"); `/routines receipts`, `/routines receipt <receipt>` and `/routines reconcile` read what promotion recorded. From the shell: `goodvibes-agent routines promote <routine-id> --cron "0 9 * * *" --timezone America/Chicago --yes`.

A schedule's runs, in both programs, are `/schedule` actions: `run <schedule>`, `pause <schedule>`, `resume <schedule>`, `stop-run <run>` (asks first) and `retry-run <run>`.

### The model's `schedule` tool

The model can list and create schedules with the `schedule` tool (its inputs are in the tool reference). A routine the model creates passes the permission gate like any change.

### How runs behave

- A run uses the permission mode and sandbox of the owner who created its job; a job has no permission setting of its own. A run in a mode that would ask gets its asks through the owner inbox and the attached surfaces.
- A run ends at the job's own timeout, or `automation.defaultTimeoutMs` (two hours; `0` means no limit). Past it the run fails with `Timed out after <duration>`.
- A run in flight when the daemon stopped is failed when it starts again ("Agent state lost before completion").
- An occurrence that comes due while an earlier run of the same job is still running is skipped.
- A one-time job whose time passed while the daemon was down for longer than `automation.catchUpWindowMinutes` is recorded as missed and disabled.
- After a failure, the job waits `automation.failureCooldownMs` before it may run again.
- A cancelled run stays cancelled and is not retried. Cancelling a check-in that is still deciding stops it before its judgment and its delivery.
- A run still starting when the daemon stops starts no agent and saves no record afterwards; the next start reconciles what was recorded.
- At most `automation.maxConcurrentRuns` runs execute at once; `automation.runHistoryLimit` runs per job are kept.
- `automation.enabled` `false` stops the whole subsystem.
- In a group of machines (`cluster`), a routine made on any machine is listed on every machine and runs once in the group, on the machine holding the `automation` role; disabling or removing it on any machine applies on all of them, and when the role moves the new holder carries on from the last occurrence started. A run still starting on the machine that lost the role starts no agent and saves nothing more. See "What a cluster does and does not do" under "Clusters" in "The daemon, the web UI and networking". The scheduled check-in is the exception: it follows the `checkin` role.

### Where a routine's result goes, and what a routine can use

- Each run's answer goes to the surface named on the routine. `/schedule add` takes `--deliver <channel>` in both programs; `/routines promote` and the Agent model's schedule tools take `--delivery-channel <surface>` (for example `telegram`), `--delivery-channel <surface>:<route id>`, `--delivery-route <route id>`, `--delivery-webhook <url>` or `--delivery-link <name>`. In the Agent's flags the part after `:` is a route binding id, not a chat id. A Telegram delivery with no route or address goes to `surfaces.telegram.defaultChatId`; with neither, that send fails with `Missing Telegram chat id`.
- A routine that names no surface, or whose every named surface failed, leaves its answer in the owner inbox as a report titled `Scheduled run: <name>` (the answer, cut at about 3,800 characters; when a send failed, the reason first). It stays open until you answer it `read` (`/questions`, the web UI's Work view, or a channel). A failed or missed run of such a routine leaves `Scheduled run failed: <name>` (or `missed`) there too. Every run is also kept in the run history (the web UI and the `automation.runs.*` methods). The routine itself keeps how its last run ended for the person as `lastOutcome`: `delivered` (a named surface took it), `not-delivered` (every named surface failed; it went to the inbox instead), `inbox` (it names no surface) or `failed` (the run failed); It is on the routine's record (`automation.jobs.list`) and on its fleet node (`schedule.lastOutcome`).
- A routine the terminal app keeps itself (with `daemon.enabled` off) has no owner inbox to fall back to: an answer with no surface is kept only in its run history.
- A run's answer is owed from the moment the run ends (saved with the run's end) until its delivery is recorded. A daemon that stops in between delivers it at its next start, under the same identity, so a surface that drops repeats drops a second copy. A one-shot routine is removed only once its run's answer was delivered.
- The model's `schedule` tool with `action:"remind"` does not send its text as is: at each run a model turn is started with the text framed as a reminder ("GoodVibes Agent scheduled reminder. Reminder: <text> ... Keep the reminder concise and state any next action"), and its answer is delivered. `/schedule add` sends what it does as written.
- A scheduled run is an agent the daemon starts with the platform's tool set (files, shell, fetch, web search, MCP, channel tools, and the like). Once you have connected mail or a calendar (a Google account with `/google connect`, or a CalDAV server in `surfaces.calendar.caldavUrl` and `surfaces.calendar.caldavUser`), it also gets the `google` tool: `mail.list` and `mail.read` on the connected Gmail, and `calendar.list` on the daemon's calendar (the CalDAV server when one is set, otherwise the Google calendar). Its calls pass the same permission gate as any turn. A send or a calendar event it makes may not carry what it read from mail or a calendar, and `calendar.create` is refused in a scheduled run (nobody asked for that event at that moment). A routine limited with `--tool` gets the tool only when `google` is listed.

### A daily 8 am summary of mail and calendar delivered to Telegram

1. Connect the mail and calendar to the daemon: in the Agent, `/google connect` (Gmail and Google Calendar over OAuth, Path B in "Google" below: the model's `google` tool reads mail only through it, in a conversation as in a scheduled run), or set a CalDAV server for the calendar. `/google status` shows the connection.
2. Set up Telegram as in "Telegram" (owner claim accepted) and give it a delivery chat: `/settings set surfaces.telegram.defaultChatId <your-numeric-id>`.
3. Create the schedule (either program):

   ```text
   /schedule add --cron "0 8 * * *" --tz America/Chicago --deliver telegram Summarize my unread mail from the last 24 hours and today's calendar events. Group the mail by sender and give the events in time order.
   ```

   ```text
   Scheduled.
   "Summarize my unread mail from the last": 0 8 * * * [America/Chicago]; next run 2026-11-20 08:00 America/Chicago (runs once, with or without a terminal open).
   The answer goes to telegram. Id job-3f9c2a1b7d.
   ```

4. Try it at once: `/schedule run job-3f9c2a1b7d`. The run reads the mail and the calendar with the `google` tool and its answer arrives in your Telegram chat. If the send fails (the bot cannot reach the chat), the answer is in the owner inbox instead, with the reason.

In the Agent the same line keeps the schedule on the connected host; its run has the same tools.

## Supervised triggers

A trigger watches something and starts an agent turn when it happens, without holding a turn open. There are three kinds:

| Kind | What it does |
| --- | --- |
| `on-exit` | Runs a command and fires once when it ends, with its exit status and the tail of its output. |
| `stream` | Runs a long-lived command and fires on output lines that match a pattern, in batches. |
| `condition` | Checks a URL, file, command or platform tool on an interval and fires when a rule holds. |

### Turning triggers on

Triggers are off by default. Nothing runs and nothing is written until they are on and a trigger exists.

```text
/settings set watchers.triggers.enabled true
```

Stored triggers start being supervised at once. Triggers are saved in `triggers.db` inside the project tree of the process that supervises them: `<working directory>/.goodvibes/<surface>/triggers.db` (for the daemon, its own working directory and `tui`). `/triggers` reads and changes the triggers of the daemon the terminal app is connected to. A trigger's agent turn is started by that process's agent manager, so it runs in the daemon under the daemon's own settings. One process supervises a store at a time; another window can list them and reports `another process supervises them`; a change from that window is refused and names the process to use.

### `/triggers`

`/triggers` alone opens its list of actions (in a script or for a model it prints the supervisor's state and the triggers, as "See your triggers" does). A line with something missing opens the step that asks for it.

| Action | Line | Risk |
| --- | --- | --- |
| See your triggers | `/triggers list` (who supervises them, then each trigger) | |
| Watch for something | `/triggers watch <name> [-- <command>...] [--match <pattern>] [--url <address>] [--file <path>] [--definition <json>] [--every <interval>] [--say <text>] [--deliver <channel>] [--run <approved command>]` | |
| See what a trigger did | `/triggers history <trigger> [--count <1-200>]` | |
| Stop a trigger | `/triggers stop <trigger>` | cannot be undone |
| Start a trigger that gave up | `/triggers restart <trigger>` | |
| See commands triggers may run | `/triggers commands` | |
| Let triggers run a command | `/triggers allow-command <name> -- <command>...` | loosens a protection |

"Watch for something" asks what to watch: a command finishing (the command after `--`; an `on-exit` trigger), a line a command prints (`--match`; a `stream` trigger), a web address changing (`--url`, looked at `--every`, default 5m; a `condition` with an `http` probe and a `change` rule), a file changing (`--file`, likewise with a `file` probe), or something else written out (`--definition`, the `{ "spec": ..., "action": ... }` JSON below, for any probe, rule or action). Its id is made from the name. Then it asks what happens: the agent looks at it (`--say` adds your instructions; `--deliver` names the channel its answer goes to, else the owner inbox), or a command you let triggers run (`--run`).

The model creates, lists, cancels and resets triggers with the `trigger` tool. Only the owner lets triggers run a command: `/triggers allow-command` from a model is refused before anything is asked.

The web UI's Triggers screen has the same actions; its "Watch for something" sheet asks the same blanks, and the daemon reads them into the definition (`watchers.triggers.preview`, the same reading as the terminal apps') and shows what it will watch before `Watch` makes it.

### Definition JSON

```json
{
  "id": "build",
  "label": "Build finished",
  "spec": { "kind": "on-exit", "command": "npm", "args": ["run", "build"] }
}
```

The definition also takes an optional `description` (the trigger's purpose). `action` is optional; the default is `{"kind":"agent-turn"}`. An agent-turn action starts one agent turn, in the process that supervises the trigger, with this message:

```text
A GoodVibes trigger fired.

Trigger: <label>
Purpose: <description>            (only when a description is set)
Why it fired: <reason>

Act on what this actually indicates. Verify before assuming anything the trigger did not directly observe.
```

`{"kind":"agent-turn","prompt":"<text>"}` puts `<text>`, a blank line, then that message. `{"kind":"agent-turn","model":"<provider:model>"}` runs the turn on that model; without it the supervising process's default model is used. A `sessionId` in an agent-turn action is refused on a new trigger. When the turn ends its answer is delivered: to the channel `deliverTo` names (`{"kind":"agent-turn","deliverTo":"telegram"}`, or `"slack:C123"`; written as in settings), else to the owner inbox as a report titled `Trigger <label>`. A send that fails puts the answer in the owner inbox with the reason. A `deliverTo` that names no delivery surface is refused when the trigger is created. The firing is also recorded in the trigger's runs (`/triggers history <trigger>`, with the action's result, `agent:<id>`) and the turn appears with the supervising process's agents (the web UI Work view for the daemon). The turn gets the same tools as a scheduled run, the `google` mail and calendar tool included once mail or a calendar is connected. `{"kind":"action-grant","grantId":"<id>","digest":"<digest>"}` runs a command the owner let triggers run with `/triggers allow-command`; `/triggers commands` shows each one's digest.

Spec fields:

| Kind | Fields |
| --- | --- |
| `on-exit` | `command`, `args`, `cwd`, `env`, `maxDurationMs` (default `watchers.triggers.onExitMaxDurationMs`, six hours), `stdin` (`none` or `empty`), `outputTailBytes` |
| `stream` | `command`, `args`, `cwd`, `match` (a regex extract, required), `exclude`, `batchLines`, `batchIntervalMs`, `queueLimit`, `dedupTtlMs`, `restart` (default `true`) |
| `condition` | `probe`, `extract`, `rule`, `intervalMs` (up to 24 hours; default `watchers.triggers.defaultCheckIntervalMs`) |

Probes (`condition`):

| Probe | Fields |
| --- | --- |
| `{"kind":"http"}` | `url`, `method` (`GET`, `HEAD`, `POST`), `headers`, `body`, `timeoutMs`, `capture` (`body`, `status`, `envelope`) |
| `{"kind":"file"}` | `path`, `capture` (`content`, `stat`), `maxBytes` |
| `{"kind":"command"}` | `command`, `args`, `cwd`, `timeoutMs`, `capture` (`stdout`, `stderr`, `exit-code`, `envelope`) |
| `{"kind":"platform-tool"}` | `tool`, `input`, `timeoutMs` |

Extracts: `{"kind":"jsonpath","path":"$.status"}`, `{"kind":"regex","pattern":"...","flags":"i","group":1}`, `{"kind":"jq-subset","expression":".status"}`, `{"kind":"raw"}`. A pattern may be at most 512 characters.

Rules:

| Rule | Fires when |
| --- | --- |
| `{"kind":"change","fireOnFirst":false}` | The value differs from the previous check. |
| `{"kind":"value","operator":"eq","operand":"down","level":false}` | The value satisfies the comparison (on the entering edge, or every check with `level`). Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `not-contains`, `matches`. |
| `{"kind":"transition","from":"running","to":"done"}` | One specific previous-to-current change. |
| `{"kind":"threshold","direction":"above","enter":90,"exit":80}` | Crossing `enter`; re-arms after crossing back past `exit`. |
| `{"kind":"debounce-n","count":3,"inner":{...}}` | The inner rule matched that many checks in a row. |
| `{"kind":"dedup-ttl","ttlMs":600000,"inner":{...}}` | The inner rule, at most once per fingerprint in the window. |
| `{"kind":"rate-of-change","windowMs":60000,"operator":"gt","operand":5,"per":"second"}` | The change rate in the window satisfies the comparison. |
| `{"kind":"windowed-aggregate","windowMs":300000,"aggregate":"mean","operator":"gt","operand":2,"minSamples":3}` | An aggregate (`min`, `max`, `mean`, `sum`, `count`, `stddev`) satisfies the comparison. |
| `{"kind":"correlation","triggerIds":["a","b"],"withinMs":60000,"require":"all"}` | The named triggers fired inside the window (`all`, `any` or `sequence`). |

Example: fire when a health endpoint stops answering `ok` three checks in a row.

```text
/triggers watch "API health" --definition '{"spec":{"kind":"condition","probe":{"kind":"http","url":"https://api.example.com/health","capture":"body"},"extract":{"kind":"raw"},"rule":{"kind":"debounce-n","count":3,"inner":{"kind":"value","operator":"ne","operand":"ok"}},"intervalMs":60000}}'
```

### Trigger states and failures

- Only an `on-exit` trigger finishes when it fires (state `fired`, final). A `condition` or `stream` trigger records each firing (`firedCount`, a `fired` entry in its runs) and keeps watching. A cancelled trigger is finished. Cancelling a running `on-exit` trigger stops its process and records the run's termination as `cancel-requested` (not observed) until the supervisor sees the process end, then as what it saw (`signalled` or `exited`, reason `cancelled`); a process started before a daemon restart is not ours to stop, so its cancel records no termination and says the process was not stopped. "Start a trigger that gave up" (`/triggers restart`) applies only to `idle`, `backoff`, `circuit-open` and `failed` triggers; another is refused with what to do instead.
- A failing check backs off along `watchers.triggers.backoffLadderMs`; after `watchers.triggers.breakerStrikes` failures in a row the breaker opens (`circuit-open`) until reset.
- An action that fails to deliver is kept owed and delivered again when due, once at a time: an action slower than the supervision tick is not started a second time, and a batch leaves the owed list only when the attempt that delivered it ends. A stream keeps at most eight undelivered batches; a dropped one is recorded in the trigger's runs.
- A save that fails sets `lastError` to `not saved: <cause> (<path>)` and is retried on the next tick; the trigger keeps running.
- `/triggers` answers `<what> was not done: <reason>` when the daemon refuses (for example `Stopping it was not done: ...`).

## Watchers

A watcher is a daemon-managed poller over an external source: a URL requested every interval, a file whose size and modification time are checked, or a manual watcher that runs only when started by hand. Each run records a checkpoint (what it observed) and emits runtime events on the `watchers` domain: `WATCHER_STARTED`, `WATCHER_HEARTBEAT`, `WATCHER_CHECKPOINT_ADVANCED` (the observation changed), `WATCHER_FAILED` and `WATCHER_STOPPED`. A watcher does not start an agent or send a message by itself; an operator client or the event stream reads its events. To have the assistant act when something changes, use a supervised trigger (above).

Where watchers are managed:

| Surface | Create | List | Start, stop, run now | Change | Remove |
| --- | --- | --- | --- | --- | --- |
| Operator API | `watchers.create` (`POST /api/watchers`) | `watchers.list` (`GET /api/watchers`) | `watchers.start`, `watchers.stop`, `watchers.run` (`POST /api/watchers/<id>/start`, `/stop`, `/run`) | `watchers.update` (`PATCH /api/watchers/<id>`) | `watchers.delete` (`DELETE /api/watchers/<id>`) |
| The Agent (model) | the `agent_operator_method` tool with `methodId:"watchers.create"`, after the owner confirms | same tool, `watchers.list` | same tool | same tool | same tool |
| Web UI | no | Work, Processes (a watcher is one row of the fleet) | Stop only | no | no |
| Terminal app | no | no | no | no | no |

Creating needs the `write:watchers` scope (an admin operator token); listing needs any signed-in client. Each operator method can also be called as `POST /api/control-plane/methods/<method-id>/invoke` with the input as `{"body": { ... }}`. Tokens and their scopes are described under "Credentials and pairing" in "The daemon, the web UI and networking".

`watchers.create` input:

| Field | Meaning |
| --- | --- |
| `label` | Required. A name. |
| `id` | Optional id; generated when absent. |
| `kind` | `polling` (default), `webhook`, `filesystem` or `manual`. `socket` and `integration` are refused with `WATCHER_NOTHING_TO_RUN`: those are registered by the component that owns them. |
| `url` | Required for `polling` and `webhook`: the URL requested each run. Its response is what the watcher observes; a non-2xx answer fails the run. A URL on your own network is refused with `WATCHER_TARGET_NOT_ALLOWED` unless its host is approved in `network.privateDeliveryHosts`. |
| `endpoint` | `polling` only: an alternative to `url`. |
| `method` | HTTP method, default `GET`. |
| `headers` | Request headers. A header that carries a credential must be a `goodvibes://secrets/<KEY>` reference; the daemon reads the secret at request time and, when it cannot, fails the run without sending the request. |
| `path` | Required for `filesystem`. |
| `intervalMs` | How often it runs; default `watchers.pollIntervalMs`. |
| `sourceId`, `sourceKind`, `metadata` | Optional labels. |

Example:

```sh
curl -s -X POST http://127.0.0.1:3421/api/control-plane/methods/watchers.create/invoke \
  -H "Authorization: Bearer <operator-token>" -H "Content-Type: application/json" \
  -d '{"body":{"label":"status page","kind":"polling","url":"https://status.example.com/api.json","intervalMs":300000,"headers":{"Authorization":"goodvibes://secrets/goodvibes/STATUS_PAGE_TOKEN"}}}'
```

The answer is the watcher record: `id`, `label`, `kind`, `state`, `source`, `lastCheckpoint`, `lastError`. Remove it with `watchers.delete` and `{"body":{"watcherId":"<id>"}}`.

- After a restart, a watcher owned by a component reads `awaiting its owner since <time>` until that component registers it again; start or run is refused with `WATCHER_AWAITING_OWNER`.
- Updating, stopping or deleting a watcher while it runs stops that run (its request is aborted) and its outcome is not written: the record shows the new definition's runs only.
- The daemon itself runs one watcher, `daemon-heartbeat`, while `watchers.enabled` is on.
- When the watcher store cannot be saved, a change still applies and its answer carries `persisted: false`.
- Settings: `watchers.enabled`, `watchers.pollIntervalMs`, `watchers.heartbeatIntervalMs`, `watchers.recoveryWindowMinutes`, and `watchers.ciPollIntervalMs` for CI watches (never below 15 seconds).

## Proactive check-ins

On a cadence, the daemon assembles a briefing and the decision model judges whether anything needs the owner now; only then is a message delivered. The briefing holds: approvals and questions waiting in the owner inbox (and for how long), contracts waiting for the owner's decision (with their question), automation runs that failed since the last check-in, and messages a session has not picked up yet. It does not read mail, calendar or channels. With no decision model in use (none set, `No Decision Model`, or `Hybrid` after the set model failed), the check-in takes its fallback without a model request for the decision: when something waits for the owner (an approval, question or report in the owner inbox, a contract waiting for his decision, a failed run) it contacts him with the note the conversation model writes, sent as written and marked `(Not independently checked: no decision model is in use.)`, and its receipt's reason reads `Decided from the current state (no decision model is in use): <n> items are waiting for you; the note was not independently checked`; when nothing waits it records `quiet` (`Nothing needs the owner: ...`) and sends nothing. With none set or `No Decision Model` chosen this is silent; under `Hybrid` with a set model failing, the same fallback runs and the model's failure is reported as everywhere else. The outcome `skipped-decision-models-disabled` ("Decision models are unavailable; automatic check-in contact and note verification were not completed.") is recorded only when a decision the check-in needs has no fallback and fails with decision models off. Inside quiet hours it is recorded as `skipped-quiet-hours`. A note too long for one message on its channel goes out as several; when only some of them arrive, the receipt is `partial` with `partsSent` and `partsTotal` and says how many did not arrive (the run reports `partly delivered`; it is not sent again, since the owner already has the start). Each receipt's summary states how many items wait for the owner (the same count the decision reads), then only the counts that are not zero: sessions running, sessions with messages not yet picked up, channel messages not yet picked up, runs finished recently (`11 items waiting for you.`).

```text
/settings set checkin.enabled true
/settings set checkin.cadence "0 */4 * * *"
/settings set checkin.deliveryChannel telegram
/settings set checkin.quietHours 22:00-07:00
/checkin            view the settings and recent receipts
/checkin run        run one now
```

`checkin.deliveryChannel` is `surfaceKind` or `surfaceKind:address` (for example `slack:C0123456`); empty uses the owner profile's `contactMe.channel`. `checkin.quietHours` is `HH:MM-HH:MM` local time; empty uses the owner profile's `contactMe.quietHours`.

## Notifications

Agent and workstream outcomes, approvals waiting and budget alerts are announced to the notification transports: Slack, Discord and webhook URLs.

```text
/notify add https://ntfy.sh/<your-topic>
/notify list            each address shown by its site; --show reveals them (asks first, the owner's only)
/notify remove 1
/notify clear           asks first
/notify test            asks first
/notify send <message>  asks first
/notify failed          notifications this app could not deliver
/notify resend <id|all> [--to-current]
/notifications          open the notification history view
```

`/notify` and `/notifications` are one command each in both apps; `/notify` alone lists its actions, and a model or script running it bare gets the list. The address after `/notify add` is asked for on a hidden line in the guided path; `/notify remove` takes the number `/notify list` shows.

- `/notify add` keeps each URL in the secret store (key `GOODVIBES_NOTIFY_WEBHOOK_<id>`, daemon tier) and adds its `goodvibes://secrets/` reference to `notifications.webhookUrls`; the URL is read only when a notification is sent. Each URL carries its own key, so a literal URL written into the list is refused, screens show the host only, and the address typed after `/notify add` is kept as `<redacted>` in the input history. `/notify remove` and `/notify clear` delete the stored URLs too. The setting applies at the next start.
- Slack and Discord carry notifications only when they have somewhere to post: an incoming-webhook URL (`SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`) or a bot token with `surfaces.slack.defaultChannel` / `surfaces.discord.defaultChannelId`.
- A notification that fails is retried, then kept in a failed list. The daemon keeps its own list on disk (operator methods `notifications.deadLetters.list` and `notifications.deadLetters.replay`). A resent entry stays in the list (and on disk) until its delivery settled, so a daemon that stops during a resend still lists it; a list that cannot be written is reported as a failure, and a terminal takes over another terminal's list file only after its own file was written.
- A notification is sent only to the destination it was queued for: a retry waiting while the Slack or Discord webhook or default channel changed ends in the failed list with the reason instead of going to the new place. `/notify resend` (and `notifications.deadLetters.replay`) refuses one whose channel now posts somewhere else, naming the old and new destination (`destination-changed`), and leaves it in the list; `--to-current` (`toCurrent: true`) sends it to where the channel posts now.
- `notifications.pushApproval`, `notifications.pushNeedsInput` and `notifications.pushCompletion` decide which events go to paired devices as push notifications. `notifications.adaptiveSuppression` and `notifications.burstThreshold` quiet bursts. `notifications.blockedEscalation*` decide when a blocked approval is raised again.

## Mail

Mail is read and sent by the daemon over IMAP and SMTP (or Gmail through Google, see "Google (Gmail and Google Calendar)"). One mailbox is the daemon's own; more can be added for inbound reading.

### Prerequisites

- An IMAP and SMTP account, or a Gmail account (see "Google (Gmail and Google Calendar)" for the fastest Gmail route).
- The account password, or an app password where the provider requires one.

### Setup from nothing (terminal app)

1. Set the mail server and user:

   ```text
   /settings set surfaces.email.host imap.example.com
   /settings set surfaces.email.user you@example.com
   /settings set surfaces.email.from you@example.com
   ```

   `surfaces.email.host` is the IMAP host. Optional: `surfaces.email.imap.host`, `.port` (default `993`), `.secure` (default `true`), `.mailbox` (default `INBOX`), `.draftsMailbox`, `.user`, `.password`; `surfaces.email.smtp.host`, `.port` (default `465`), `.secure` (default `true`), `.password`. Separate IMAP and SMTP values override the shared ones.
2. Store the password where the daemon reads it:

   ```text
   /secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD <your-password>
   ```

   The terminal app files this daemon-owned credential in the daemon's store.
3. Check the connection: `/mail status`. It prints `Mail: ready` with what is true, or `Mail: needs-setup` with the next steps.
4. First use: `/mail list`.

### `/mail` (both apps)

`/mail` is one command in both apps; `/mail` alone lists its actions ("See whether mail is connected" first), and a model or script running it bare gets the status. A message is three blanks: To, Subject, Message.

```text
/mail status                                   whether mail is connected, and the next step if not
/mail list [n]                                 the n newest messages (default 15)
/mail read <message>                           open one message (its uid; /mail read alone lists the inbox to choose from)
/mail draft you@example.com --subject "Status update" The build is green.
/mail send you@example.com --subject "Status update" The build is green.
/mail send you@example.com --subject "Status update" --again The build is green.
```

- The message is the words after the options; `--subject` takes one quoted value.
- `send` shows the recipient, subject and message and asks once, because a sent message cannot be recalled. `--yes` typed by the owner right after `send` answers in advance; the same word inside the message is text and still asks (the word itself is dropped from the message). The same holds for `/channels send` and `/notify send`.
- The same exact message is not sent twice from one session. `--again` ("Send it again") sends it anyway (for a retry after a timeout); check the Sent folder first.
- The terminal app reads and sends through the daemon; the Agent uses its own mail service on the same `surfaces.email.*` settings and records each message it reads as untrusted content.
- In the terminal app message bodies are printed as transcript output only; they never enter the model's history from `/mail read`.

Status failures and fixes:

| Daemon code | Meaning | Fix |
| --- | --- | --- |
| `EMAIL_NOT_CONFIGURED` | Host or user missing. | Steps 1 and 2 above. |
| `EMAIL_CREDENTIALS_MISSING` | Password secret missing. | `/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD <password>` |
| unreachable | The daemon cannot be reached. | Check the daemon with `/health` and `goodvibes status`. |

### Mailbox settings in the Agent: `/mail settings`, `/mail set`, `/mail password`

```text
/mail settings                     every mailbox setting, the password shown only as stored or not
/mail set <setting> <value>        change one
/mail password                     store the password (asked for with masked input)
```

- `/mail status` in the Agent shows the IMAP and SMTP host and port, the user, whether the password is stored (`[stored]` or `[missing]`), the from address, `ready: yes|no`, and the problems found. These are the same `surfaces.email.*` settings the daemon uses.
- `/mail list [n]` in the Agent lists up to `n` unread messages (at most 100) and a two-line preview of the newest. Mail is opened read-only (IMAP EXAMINE); nothing is marked read.
- The terminal app changes these settings in `/settings` and refuses these three actions saying so.

`/mail set` settings:

| Setting | Key | Value |
| --- | --- | --- |
| `host` | `surfaces.email.host` | Mail server host used for IMAP and SMTP unless they are set separately. |
| `imap.host` | `surfaces.email.imap.host` | IMAP host. |
| `imap.port` | `surfaces.email.imap.port` | Whole number 1 to 65535. |
| `imap.secure` | `surfaces.email.imap.secure` | `true`, `yes` or `tls` (TLS, port 993); `false` or `no` (plain, local servers only). |
| `imap.mailbox` | `surfaces.email.imap.mailbox` | Folder to read, default `INBOX`. |
| `smtp.host` | `surfaces.email.smtp.host` | SMTP host. |
| `smtp.port` | `surfaces.email.smtp.port` | Whole number 1 to 65535. |
| `smtp.secure` | `surfaces.email.smtp.secure` | `true`, `yes` or `tls` (implicit TLS, port 465); `false`, `no` or `starttls` (STARTTLS, port 587). |
| `user` | `surfaces.email.user` | Login name. |
| `from` | `surfaces.email.from` | From address. |

The settings that decide where and as whom the password is presented (the hosts, ports, TLS switches and user) loosen a protection when changed: `/mail set` asks first for them, and only the owner's own typing counts. `/mail password` is the owner's only.

Worked example (Fastmail):

```text
/mail set imap.host imap.fastmail.com
/mail set imap.port 993
/mail set smtp.host smtp.fastmail.com
/mail set smtp.port 465
/mail set smtp.secure true
/mail set user you@fastmail.com
/mail set from you@fastmail.com
/mail password
/mail status
```

`/mail password` asks for the password with masked input and answers `The mailbox password is stored as a secret (reference goodvibes://secrets/...); settings hold only the reference.` A setting not in the table is refused with the list; a bad port answers `Invalid port number: <value>. Must be an integer between 1 and 65535.` The settings are daemon-owned, so a write fails when no daemon answers.

### Inbound mail and notices

The daemon can watch mailboxes and tell the owner when mail arrives. Arrival is untrusted input: it never starts an agent or a session by itself, and a change asked for in an email is refused (email cannot direct changes).

```text
/settings set surfaces.email.inbound.enabled true
/settings set surfaces.email.inbound.accounts "[\"main\",\"signups\"]"
/settings set surfaces.email.inbound.mailboxes "{\"signups\":{\"host\":\"imap.example.com\",\"user\":\"signups@example.com\"}}"
/secrets set GOODVIBES_EMAIL_INBOUND_SIGNUPS_PASSWORD <password>
```

`surfaces.email.inbound.accounts` and `surfaces.email.inbound.mailboxes` are text settings that hold JSON, so the JSON is written as one quoted string (as above); a bare array or object is not a string and is refused.

- The first entry of `surfaces.email.inbound.accounts` is the daemon's own mailbox (`surfaces.email.*`, or Gmail when Google is connected). Each further account is read over IMAP with the connection in `surfaces.email.inbound.mailboxes`: `host` and `user` required; optional `port` (993, or 143 when `secure` is false), `secure` (default `true`; `false` only for a loopback host), `mailbox` (default `INBOX`) and `passwordRef` (a `goodvibes://secrets/goodvibes/<KEY>` reference whose key contains `EMAIL`, `MAIL` or `IMAP` as a word). Without `passwordRef`, the password is the secret `GOODVIBES_EMAIL_INBOUND_<ACCOUNT>_PASSWORD` (the account name upper-cased, other characters as `_`). An account with no entry in `mailboxes` is reported in the inbound status rather than watched.
- `surfaces.email.inbound.source`: `auto`, `gmail` or `imap`. `surfaces.email.inbound.mode`: `idle`, `poll` or `auto`. `pollIntervalSeconds` (default 120), `idleReissueMinutes` (27), `gmailPollSecondsIdle` (60) and `gmailPollSecondsExpecting` (5) set the pace.
- `surfaces.email.inbound.notice.mode`: `all`, `expected-only` or `none`; `notice.route` picks where notices go: `default` is your most recently used one-to-one conversation with the daemon (never a group or shared channel); a route binding id, shared or not, sends them there. A one-to-one conversation counts once you have messaged the daemon directly from your own account on any chat channel (Telegram, Slack, Discord, Mattermost, Signal, WhatsApp, Matrix through a bridge that marks direct rooms, Google Chat, Microsoft Teams, BlueBubbles, iMessage, Home Assistant chat, SMS, or your ntfy topic). When there is no such conversation, or it refuses the notice, the notice is put in your owner inbox (`inbox.list`, the terminal apps and the web UI) and `email.inbound.status` says why it was not sent to a chat.
- On first run the newest 50 messages already there are kept as history: shown in the inbox, never announced.
- A message that cannot be read is tried on three drains, then stepped over and shown as unreadable.
- Records are kept `retentionDays` (30) and at most `maxRecords` (5000).
- Changing the IMAP host, port or TLS, `inbound.enabled`, `inbound.source`, a corrected credential, or the accounts takes effect without a restart. Changing the first mailbox's user, its folder or the first account name needs a daemon restart; the status says so.
- `surfaces.email.imap.authservIds` names the authserv-ids your receiving server writes in `Authentication-Results`, for a provider that is not built in (Gmail, Fastmail, Zoho, Yahoo and AOL are). Without it, senders on such a mailbox read as unverified.
- `surfaces.email.inboxTagging` (default off) lets the inbox write its spam, priority and normal labels back to the mailbox as IMAP keywords.
- Operator methods: `email.inbound.status`, `email.inbox.list`, `email.inbox.read`, `email.inbox.update`, `email.send`, `email.draft.create`, `email.draft.update`, `email.drafts.list`, `email.attachment.get`, `email.expectation.open`, `email.expectation.wait`, `email.expectation.list`, `email.expectation.cancel`.
- A message UID names a message only within its mailbox generation: `email.inbox.list` and `email.inbox.read` return `uidValidity`, and `email.inbox.update` requires it, so a mailbox the server reset refuses the change instead of changing whichever message now holds the number. In the same way `email.drafts.list` and `email.draft.create` return the Drafts folder's `uidValidity`, and `email.draft.update` replaces a saved draft (by `uid` and `uidValidity`) so the folder keeps one copy instead of two.
- A draft is saved with a `Message-ID` of its own. A change to the mailbox (a saved or replaced draft, a message marked, archived or moved) is reported done once the server confirmed it, even when signing out afterwards fails. A save whose answer the server never gave is reported as one that may have been saved; creating the same draft again in the same daemon run looks for it under that `Message-ID` first and returns it instead of saving a second copy.

## Calendar

### Terminal app: CalDAV over the daemon

Prerequisites: a CalDAV server URL, user and password (or an app password).

1. Configure:

   ```text
   /settings set surfaces.calendar.caldavUrl https://caldav.example.com/dav/
   /settings set surfaces.calendar.caldavUser you@example.com
   /secrets set GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD <your-password>
   ```

   Optional: `surfaces.calendar.defaultCalendarId` and `surfaces.calendar.calendars`.
2. Check: `/calendar status`.
3. First use: `/calendar upcoming`.

`/calendar` is one command in both apps; `/calendar` alone lists its actions ("See what is coming up" first), and a model or script running it bare gets the days ahead. In the terminal app it works on the daemon's calendar:

```text
/calendar upcoming [--days 7]
/calendar get <event>
/calendar add --title "Design review" --start 2026-12-01T14:00:00Z --end 2026-12-01T15:00:00Z [--location "Room 4"] [--notes "..."] [--again]
/calendar change <event> [--title ...] [--start ...] [--end ...]
/calendar delete <event>
/calendar status
```

A blank left out keeps its value in `change`. `change` and `delete` reach the guests and ask once; the daemon's calendar needs an end time for `add`, and an identical `add` from the same session is refused unless `--again` ("Add it again"). A time without a zone is read in this machine's zone. A daemon answer of `CALENDAR_NOT_CONFIGURED` means the URL or user is missing. The Agent's own actions (`all`, `import`, `export`, `accounts`, `connect`, `disconnect`, `subscriptions`, `subscribe`, `refresh`, `unsubscribe`) are refused here saying so.

Google Calendar cannot be reached over CalDAV with a password: Google refuses Basic authentication on its CalDAV endpoint. Use the Google route below.

### The Agent: `/calendar`

The Agent keeps local events, subscribes to ICS feeds, and connects Google or Microsoft calendars over OAuth.

```text
/calendar upcoming --days 7
/calendar all
/calendar get <event>
/calendar add --title "Dentist" --start 2026-12-03T15:00:00 --end 2026-12-03T16:00:00 --location "Main St"
/calendar delete <event>                          asks first
/calendar import <path.ics>
/calendar export [<path.ics>]
/calendar subscribe <ics-url> --name work --every 30 [--allow-private-host]
/calendar subscriptions
/calendar refresh [<feed>]
/calendar unsubscribe <feed>                      asks first
/calendar connect google
/calendar connect outlook --with device
/calendar connect google --with code              asks for the address the browser landed on, masked
/calendar accounts
/calendar disconnect <google|outlook>             asks first
```

`/calendar change` and `/calendar status` are the terminal app's (the daemon's calendar) and are refused here saying so.

Connecting a calendar account over OAuth needs your own OAuth client id: no client id ships with the product. Steps:

1. Register a free OAuth app (Google Cloud Console for Google, the Azure portal for Microsoft) and copy its client id. A desktop or public-client app needs no secret.
2. Keep the client id with `/calendar use-app google <client-id>` (or `outlook`); add `--secret` to be asked for a client secret, masked. The id goes in `calendar.google.clientId` or `calendar.microsoft.clientId`; a client secret goes in the secret store and is referenced by `calendar.google.clientSecretRef` / `calendar.microsoft.clientSecretRef`. The rows "Use your own Google Calendar app" and "Use your own Outlook calendar app" under `/agent personal-ops` open the same action.
3. Run `/calendar connect google` (or `outlook`). A browser opens; approve. On a machine with no browser, add `--with device`: Outlook shows a device code to enter on another device; Google prints a link to open anywhere, and after approving you run `/calendar connect google --with code` within ten minutes and give the 127.0.0.1 address the browser landed on (asked for masked).
4. The answer lists the account, the transport and the scopes. `/calendar upcoming` then merges that account's events.

`disconnect` revokes the access at the provider when it offers revocation, and clears local tokens.

Daemon operator methods for calendars: `calendar.calendars.list`, `calendar.events.list`, `calendar.events.get`, `calendar.events.create`, `calendar.events.update`, `calendar.events.delete`, `calendar.ics.import`, `calendar.ics.export`.

On a CalDAV calendar each occurrence of a recurring event has its own id (the resource href, `#`, and the instant it recurs at), and `calendar.events.get` with that id answers that occurrence. A create whose request got no answer fails with `CALENDAR_OUTCOME_UNKNOWN` and names the new event's UID: read it with `calendar.events.get` before creating it again. `calendar.events.get` returns the event's `revision` (Google's etag, the CalDAV ETag); send it as `expectedRevision` on `calendar.events.update`, and an event changed elsewhere after it was shown is refused with `409` `CALENDAR_EVENT_CHANGED` and nothing is written. The web UI's edit form does this: saving over a newer version says so and shows the event as it is now. A feed event without a UID gets an id made from its feed, start and title, so it keeps the same id on every read.

## Google (Gmail and Google Calendar)

The Agent's `/google` connects one Google account for both mail and calendar. Saying "connect my Google account" to the Agent runs the same flow.

```text
/google connect                 work out the shortest route and connect
/google status                  what is connected, proven by reading mail and calendar
/google reauthorize             fresh consent covering mail and calendar
/google forget                  remove stored Google credentials: shows what would go and asks; the yes removes only the values the question named, and keeps one stored or replaced since
/google adopt [--replace]       take up Google credentials from files on this machine (~/.gmail-mcp); --replace replaces stored ones
/google client-file <path>      store an OAuth client JSON you already have, then ask for consent
/google client <client-id> <client-secret>
/google account <address>       the Gmail address to connect as
/google calendar-address <url>  store the private iCal address (read-only calendar)
/google setup [--path app-password|oauth|existing-client]
/google runbook                 print the step-by-step instructions
/google waiting                 the sends the content check refused, exactly as they would go out
/google approve [<n>]           shows the send and asks, then sends it exactly as shown (without a number: the one the last /google waiting showed alone, refused if the waiting sends changed since; with none shown, the one waiting send)
/google drop <n>                drop a refused send
```

The Agent workspace's Personal Ops rows open these same `/google` actions. The terminal app has no `/google`; it uses the mail and calendar the daemon already has.

### Choosing a path

| | App password | OAuth |
| --- | --- | --- |
| Read Gmail | yes | yes |
| Send Gmail | yes | yes |
| Read calendar | yes (read-only, private iCal address) | yes |
| Write calendar | no | yes |
| Google Cloud project needed | no | yes |
| Credential expires | no | only if the app stays in Testing |
| Time | about 3 minutes | about 15 minutes |

Start with the app password path. The two coexist.

### Path A: app password

Prerequisites: 2-Step Verification on the Google account.

1. `/google setup --path app-password` (or `/google connect`). A browser window opens at `https://myaccount.google.com/apppasswords`. Google blocks automated browsers at sign-in, so sign in once by hand in that window; the profile is kept for later runs.
2. If 2-Step Verification is off, turn it on at `https://myaccount.google.com/signinoptions/twosv`.
3. The flow creates an app password named `goodvibes-agent` (by hand: type that name, click Create, copy the 16-character password, paste it when asked). It is stored as the secret `GOODVIBES_SURFACES_EMAIL_PASSWORD`.
4. The flow writes the Gmail endpoints: IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:587` with STARTTLS. Give the address with `/google account you@gmail.com` when asked.
5. The flow opens a real IMAP and SMTP session to prove the password; nothing is sent.
6. For calendar, the flow captures the "Secret address in iCal format" from Google Calendar settings (Settings for my calendars, Integrate calendar). By hand: `/google calendar-address <url>`. It is stored as the secret `GOODVIBES_CALENDAR_GOOGLE_ICS_URL` and subscribed read-only. Treat that URL as a password.
7. The flow reads calendar events to prove it works.

### Path B: OAuth

Prerequisites: a Google Cloud account; the `gcloud` CLI (the flow checks `gcloud --version` and tells you how to install it into your home directory).

1. `gcloud auth login` (you choose the account and click Allow).
2. The flow selects or creates a Cloud project and enables `gmail.googleapis.com` and `calendar-json.googleapis.com`.
3. Fill in the OAuth consent screen at `https://console.cloud.google.com/auth/branding`: app name `goodvibes agent`, your support email, Audience External, your contact email, agree, Create.
4. At `https://console.cloud.google.com/auth/audience`, set Publishing status to **In production** (PUBLISH APP, Confirm). An app left in Testing gets refresh tokens that expire after seven days, and the integration then stops silently.
5. At `https://console.cloud.google.com/auth/clients`, Create client, type Desktop app, name `goodvibes agent`, Create. Copy the client id and secret (the secret is shown in full only once) and run `/google client <client-id> <client-secret>`.
6. Open the consent link the flow prints. Check the account shown at the top. Expect "Google hasn't verified this app": click Advanced, then "Go to goodvibes agent (unsafe)". Leave every permission ticked; Continue. The browser lands on a local page confirming the connection.
7. The flow reads your mailbox and calendar with the new credential and reports the account, both answers and the publishing status.

Scopes requested: `gmail.readonly`, `gmail.send`, `calendar.events`. Stored: the client secret as `GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF`, the refresh token as `GOODVIBES_GOOGLE_OAUTH_REFRESH_TOKEN`; settings `calendar.google.clientId`, `calendar.google.clientSecretRef`, `google.oauth.projectId`, `google.oauth.publishingStatus`. No secret is written to settings files, logs, transcripts or status output.

### Google failures

| Symptom | Fix |
| --- | --- |
| "This browser or app may not be secure" | Sign in by hand in the window that opened, then re-run. |
| IMAP `AUTHENTICATIONFAILED` | The app password is wrong or revoked. Delete the `goodvibes-agent` entry at the app passwords page and re-run. |
| Worked, then broke about a week later | The OAuth app is in Testing. Publish it, then `/google reauthorize`. |
| A missing scope or dead credential is reported | `/google reauthorize`. |
| A send was refused | `/google waiting` lists refused sends; `/google approve <n>` shows one, asks and sends it exactly as shown, typed by the owner. |

Re-running any step is safe: each step checks what already exists and skips it.

The model's `google` tool reads and sends mail and reads and writes calendar events through the connected account; sends to new recipients are the owner's to allow.

## Chat channels

A channel is a chat surface the daemon sits behind: Slack, Discord, Telegram, ntfy, the generic webhook, Home Assistant, Google Chat, Signal, WhatsApp, telephony (SMS and voice), iMessage, Microsoft Teams, BlueBubbles, Mattermost and Matrix. A channel can carry conversations with the assistant, approvals for the owner, and notifications and deliveries.

### General setup procedure

1. Get the credentials from the provider (each surface below says which).
2. In the terminal app, run `/devices pair channel <surface>`. It lists the surface's declared fields, asks for every missing required value (and offers the optional ones), stores secret values in the daemon's secret store with a reference in the setting, and switches the surface on once every required field is set. `/channel pair` alone lists every surface and how many required values are set. A surface whose schema marks no field required (Slack, ntfy, the generic webhook, Google Chat) is switched on even when you skip every value, so enter its tokens before you finish, or set them with `/settings set` as below.
   - Alternatively set each key with `/settings set surfaces.<surface>.<field> <value>` and switch it on with `/settings set surfaces.<surface>.enabled true` or `goodvibes surfaces enable <surface>`.
   - In the Agent: `/channels setup <id>`, `/channels doctor <id>`, `/channels guide <id>`.
3. Prove it end to end: `/channels test <surface>` sends a real test message through the daemon and reports the delivered or error outcome.
4. Send a first message from your own account. On a surface whose allowlists are empty it is not answered: it raises an owner claim (see "Who may talk to the assistant"). Accept it with `/questions`, then `/questions answer <id> accept` (or in the web UI inbox). You are then the surface's owner; send your message again and it is answered.
5. Check: `goodvibes surfaces check <surface>`, `/channels status`, `/channels rules <surface>`.

A surface switched on, or given a credential, while the daemon runs is picked up without a restart. A surface switched off answers inbound requests with HTTP 503 `SURFACE_DISABLED`.

An answer to a channel message is recorded as owed (on the session's input) before it is sent and marked sent once it was handed to the channel. A daemon that stops while an answer is being sent sends it again when it starts: on the generic webhook (whose request carries the answer's identity as `Idempotency-Key`) and on Discord (the bot's post carries it as a nonce) the receiver drops the repeat; on every other surface the answer ends with the line `(Sent again after a restart; you may see it twice.)`. Each part of a long answer keeps one identity for every attempt at it.

A Slack or Discord slash command is acknowledged only once its message is saved (a save takes milliseconds). When the save takes longer than 2.5 seconds, the acknowledgement says `Received, still saving: ...` and asks to send it again if no answer comes; sending it again is safe, because the command's id (Slack `trigger_id`, Discord interaction id) makes the second a no-op once the first is saved.

### Inbound addresses

Surfaces that receive provider webhooks are served by the daemon's control-plane server on the path `/webhook/<surface>`:

<!-- generated: webhook-paths -->

GitHub automation webhooks arrive at `POST /webhook/github`. When the daemon posts the agent's answer itself, the owed answer is recorded in the daemon's operation log (`control-plane/operations.jsonl` in the daemon's control-plane directory) before GitHub is answered, and the posted comment ends with a hidden marker `<!-- goodvibes:op=<id> -->`. After a restart an answer that was recorded and not confirmed posted is posted once (the issue's comments are read first for its marker); an owed answer whose agent stopped with the daemon is logged as not posted.

The control plane listens on `127.0.0.1:3421` by default. A provider on the internet can reach these paths only when the daemon is published at a public HTTPS address (remote access, a tunnel or a reverse proxy, described under "Network exposure" and "Remote access" in "The daemon, the web UI and networking"), and `web.publicBaseUrl` is set to that address where a surface registers its own webhook (Telegram webhook mode). Four surfaces can work with no public address: Slack with an app token (Socket Mode), Discord (gateway connection; interactions and slash commands still arrive at `/webhook/discord`), Telegram in `polling` mode, and ntfy (the daemon subscribes to its topics).

### Who may talk to the assistant

Each surface has an ingress policy.

- Every list that is set must admit a message; an empty list restricts nobody. A group, channel or thread is admitted when it is on the group list (if set), on the channel list (if set), and its sender is on the user list (if set).
- A surface with every list empty has no owner yet. The first message from an unknown sender is not answered: it raises an owner claim in the owner inbox, titled `Make <sender-id> (<name>) the owner of <surface>?`, with the choices `accept` and `decline`. Accepting puts that sender on the user list and makes him the surface's owner; from then on the surface answers only him. Declining is remembered and that sender is not asked about again. At most three claims per surface are open at once.
- Once a surface has an owner, a message from a sender not on the user list is not answered either: it raises `Let <sender-id> (<name>) reach you on <surface>?`. Accepting adds that sender to the user list (he is not made owner); declining is remembered.
- The `<sender-id>` in a claim is the provider's user id (on Telegram the numeric user id, on Slack the `U...` id). Use it with `--allow-users`.
- An admitted message gets a conversational reply. A message from the owner that reads as a request for work is proposed back ("reply yes or go ahead to start it") and starts only when he answers yes in the same conversation (`conversationGate.mode` `propose`, the default, on every surface in `conversationGate.gatedSurfaces`). `confirm-all` confirms every message; `off` starts work at once. Reading a message as work needs a decision model; only a confident "work" reading is proposed, and an unsure one gets a conversational reply. With no decision model in use, no proposal is ever made: every admitted message is answered at once by a conversational agent turn.
- Work a guest (any admitted sender who is not the owner) asks for is proposed to the owner, never to the guest: the proposal (`<guest-id> on <surface> (not you) asks for work: <summary>`) goes to the owner's own direct conversation on that surface (or, when he has none there, his most recently used direct conversation on another surface) and is answered only there, by the owner. The guest is told `I asked the owner to agree to this: <summary>. You will hear here whether it starts.` and hears the outcome; a guest's own "yes" is ordinary chat. When none of the owner's conversations takes the proposal, the guest is told `Not started: the owner could not be asked about this: <summary>`.
- The owner and other admitted senders. This is the whole rule:

  | | The surface's owner | Any other admitted sender |
  | --- | --- | --- |
  | Talk to the assistant and get replies | Yes | Yes |
  | Start a turn that reads and answers | Yes | Yes (with no decision model in use, every message starts one) |
  | Agree to work | Yes (`yes` to his own work proposal, and to a guest's, in his own conversation) | No. His work request is put to the owner; his own `yes` is ordinary chat. |
  | Change anything (write, edit, run a command, send, fetch, read app state or files outside the allowed directories) | Decided by the gate as on the surface (see below) | Never on his own word: every such call is put to the owner as an approval (`channel-request`), in every permission mode (`yolo` included) and with or without a decision model; in `just-vibes` it is held for the owner. A plain read of files inside the allowed directories runs. |
  | Answer a permission ask | Yes (see "Answering an approval from a channel") | No. A guest's text reply is ordinary chat. On Slack and Discord, an approval button pressed by a guest is refused with HTTP 403 `APPROVAL_ANSWER_REFUSED`; the ask stays pending. |
  | Approve or veto a purchase, type a card code | Yes | No |
  | `status`, `cancel`, `retry` on a run, agent or session | Yes, for work started from the same conversation | No: `Not done: <action> <id> was refused. Status, cancel and retry act on any run or agent, so only the owner of this channel may send them. Ask the owner, or have them change the channel's owner.` |

  Where the asks of a guest's turn go: never to the guest's chat. The approval prompt goes to the owner's own direct conversation on that surface (newest first), or when none takes it, to his direct conversations on other surfaces; it is also listed in the owner inbox (`/questions` in either terminal app, the web UI). The owner answers it by replying in any of his own direct conversations, or in the inbox. When none of his conversations takes the prompt, he is alerted ("Approval required for <tool>: ... It was asked for by someone on <surface> who is not you, and none of your own conversations took it. Answer it in the terminal app or the web UI") and the alert is kept as a receipt for the next terminal or web UI.

  Authority belongs to the person, not the surface. The owner's own messages keep the surface's authority: on Telegram (a command-authority surface) his turn runs as if typed in the terminal app, in his permission mode; on every other chat surface a change his turn asks for becomes an approval for him each time (`channel-request`); on email, webhook and ntfy it is refused. A guest's turn runs under the guest form of the surface (`guest:<surface>`), which carries no authority on any surface, Telegram included. A guest's message is also never handed to an agent already running in that conversation; it starts a guest's turn of its own. A surface with no owner (`open`, below) has only guests.

```text
/channels rules                             every surface's rules
/channels rules slack
/channels set-rules slack --require-mention on --allow-dms on --allow-users U0123,U0456
/channels set-rules discord --allowed-commands status,help --commands-without-mention on
/channels set-rules matrix --allow-users none
```

`/channels set-rules` asks first and counts only when the owner types it (it decides who may reach the assistant). Options: `--enabled`, `--require-mention`, `--allow-dms`, `--allow-groups`, `--allow-threads`, `--commands-without-mention`, `--open` take `on` or `off`; `--dm-policy` and `--group-policy` take `allow`, `deny` or `inherit`; `--allow-users`, `--allow-channels`, `--allow-group-ids`, `--allowed-commands` take a comma list or `none`. A list replaces the whole stored list on every surface, so to remove one admitted sender set the list again without him (for example `/channels set-rules telegram --allow-users <your-id>`); include yourself, or you lock yourself out. `--open on` makes a shared channel: while every list is empty, every sender is admitted and no owner claim is raised (off by default); everyone on it talks as a guest. The operator method `channels.policies.update` takes the same field as `open`, and `channels.policies.list` reports it.

A message names a command only when its first word is written as one (`/status`, `!status`, `/status@yourbot`); `allowedCommands` limits those.

#### Answering an approval from a channel

An approval prompt for a turn the owner started from a channel is shown in that conversation, and he answers it by replying in the same conversation (same chat, channel and thread); a reply anywhere else does not count. An approval a guest's turn raised is shown in the owner's own direct conversation instead, and he answers it by replying in any of his own direct conversations. With a decision model in use, any wording is read (approve, deny, or approve with changes, which declines the original call and passes the change back); a reply the model reads as unclear leaves the ask waiting and the message goes on as conversation. With several asks waiting in one conversation, the reply must make clear which one it answers. With no decision model in use, only the exact `/approve <id>` or `/deny <id>` is recognised (the id from the prompt), with nothing else on the line. Slack and Discord prompts also carry Approve and Deny buttons; only the owner's press counts. A guest's reply never answers an ask.

#### Run control

Every chat surface lets the owner ask about, cancel or retry a run, agent or session the daemon knows, by its id, for work started from the same conversation (anything else is refused: `This conversation did not start <id>, so it cannot act on it. Send the command from the conversation that did.`). With a decision model in use, any message that names a known id and asks for one of the three is read as the command (`cancel run-123`, "stop run-123"). With no decision model in use, only the exact form is recognised: `/status <id>`, `/cancel <id>` or `/retry <id>`, with the leading slash and nothing else on the line; any other wording is an ordinary message.

Only the channel's owner controls runs: a guest (anyone else the channel admits) who sends one of these, or presses a run's Cancel or Retry button on Slack or Discord, is refused (`Not done: cancel <id> was refused. Status, cancel and retry act on the owner's runs and agents, so only the owner of this channel may send them.`). The typed command and the button are the same control: a button cancels a run or an agent, as `/cancel` does.

### Other `/channels` actions (both apps)

```text
/channels                 the list of actions; a model or script gets "See your channels"
/channels status          each channel, on or off, ready or not
/channels setup <channel> what a channel needs (no value shown)
/channels doctor <channel>  the daemon's checks and the repairs it offers
/channels test <channel>  a real test message through the daemon (asks first)
/channels accounts        the channel accounts, configured, linked and signed in
/channels profiles        the model, provider and permission mode each channel's sessions get
/channels profile <channel> [<conversation>]
/channels set-profile <channel> [<conversation>] [--model ...] [--provider ...] [--permission-mode ...]
/channels remove-profile <channel> [<conversation>]
/channels telegram-cursor recover the Telegram update cursor
```

The terminal app adds `overview`, `routes` (where replies go), `delivery` (delivery strategies) and `open` (the routes view); the Agent adds `readiness [--show all|ready|attention]`, `configured <channel>`, `guide [<channel>]`, `triage`, `send` and `deliveries`. Each app refuses the other's, saying where it is done. Pairing a channel is "Pair something" under `/devices`: `/devices pair channel <channel>`.

### Slack

Prerequisites: a Slack app (api.slack.com/apps) installed in your workspace.

Bot token scopes, required by what the code calls:

| Scope | Required by |
| --- | --- |
| `chat:write` | Sending replies and notifications (`chat.postMessage`). |
| `app_mentions:read` | Receiving `app_mention` events (a mention of the bot). |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Receiving `message` events in public channels, private channels, direct messages and group DMs; `im:history` also for the inbox reading direct messages (`conversations.history`). Add the ones for the places the bot should hear. |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | Listing conversations for the directory and target lookup (`conversations.list` over public, private, IM and group-IM conversations). |
| `users:read` | Looking up users for the directory and allowlist edits (`users.list`). |
| `commands` | Slash commands. |
| `reactions:write` | Only with `surfaces.slack.inboxTagging` on: writing triage labels as reactions (`reactions.add`, `reactions.remove`). |

The app-level token (`xapp-...`) needs `connections:write` for Socket Mode (`apps.connections.open`). In the app settings, subscribe to the bot events `app_mention` and `message.channels`, `message.groups`, `message.im`, `message.mpim` as needed, and turn on Interactivity for buttons (approval answers arrive as `block_actions`). With Socket Mode on, no request URL is needed; without it, set the Events, Interactivity and Slash Command request URLs to `https://<public-host>/webhook/slack` and store the signing secret. The install URL the surface's `oauth-url` provider action builds (it needs `SLACK_CLIENT_ID` or a `clientId` input) asks for `commands`, `chat:write`, `channels:read`, `groups:read`, `im:read`, `mpim:read` and `users:read`; add `app_mentions:read` and the `*:history` scopes in the app's OAuth settings. `surfaces.slack.inboxUserId` names the Slack user whose direct messages the protected inbox reads.

| Setting | Required | Notes |
| --- | --- | --- |
| `surfaces.slack.botToken` | for chat and directory | Secret. Env `SLACK_BOT_TOKEN`. |
| `surfaces.slack.appToken` | for Socket Mode | Secret. Env `SLACK_APP_TOKEN`. With it, no public URL is needed. |
| `surfaces.slack.signingSecret` | for webhook ingress | Secret. Env `SLACK_SIGNING_SECRET`. Verifies `/webhook/slack` requests. |
| `surfaces.slack.defaultChannel` | for notifications | For example `#ops`. |
| `surfaces.slack.workspaceId` | optional | |
| `SLACK_WEBHOOK_URL` (env) | optional | Posts notifications into one channel without a bot token. |

From nothing to the first answered message (Socket Mode, no public address needed):

1. At api.slack.com/apps: Create New App, From scratch; name it and pick the workspace.
2. Socket Mode: turn it on and create an app-level token with the scope `connections:write`. Copy the `xapp-...` token.
3. OAuth & Permissions, Bot Token Scopes: add `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `users:read`, `commands`, plus `channels:history`, `channels:read` (public channels), `groups:history`, `groups:read` (private channels) and `mpim:history`, `mpim:read` (group DMs) for the places the bot should hear.
4. Event Subscriptions: turn on and subscribe to the bot events `app_mention` and `message.im`, plus `message.channels`, `message.groups`, `message.mpim` as in step 3.
5. Interactivity & Shortcuts: turn on (approval and purchase buttons). App Home: allow users to send messages from the Messages tab (Slack's own requirement for direct messages to a bot).
6. Optional, Slash Commands: create one, for example `/goodvibes`.
7. Install to Workspace. Copy the Bot User OAuth Token (`xoxb-...`).
8. In the terminal app (set both tokens before switching the surface on; `/devices pair channel slack` would switch it on with nothing entered):

   ```text
   /settings set surfaces.slack.botToken <your-bot-token>
   /settings set surfaces.slack.appToken <your-app-token>
   /settings set surfaces.slack.enabled true
   goodvibes surfaces check slack
   ```

9. In Slack, open a direct message with the bot and send anything. It is not answered; an owner claim appears. In the terminal app: `/questions`, then `/questions answer <id> accept`.
10. Send the message again: it is answered. A request for work is proposed back; reply `yes` to start it.
11. To use it in a channel: `/invite @<bot name>` in that channel, and turn on mentions so the bot answers only when addressed: `/channels set-rules slack --require-mention on`. With mentions off (the default), every message in a channel the bot is in is handled.
12. To allow a second person, accept their claim, or `/channels set-rules slack --allow-users <your-U-id>,<their-U-id>` (listing replaces the list, so include yourself).

Slack delivers every message as a channel or thread conversation, direct messages included, so `--allow-dms` and `--dm-policy` do not separate Slack direct messages from channels; use the user list. A Slack start is reported running only once its socket opens; a socket that does not open within 30 seconds is a failed start. Without Socket Mode, set the request URLs and `surfaces.slack.signingSecret` as above. A change the assistant is asked for from Slack is approved by the owner each time (`channel-request`), even in `yolo`.

### Discord

| Setting | Required | Notes |
| --- | --- | --- |
| `surfaces.discord.botToken` | yes | Secret. Env `DISCORD_BOT_TOKEN`. |
| `surfaces.discord.publicKey` | for interactions | Secret. Env `DISCORD_PUBLIC_KEY`. Verifies interaction signatures. |
| `surfaces.discord.applicationId`, `surfaces.discord.guildId` | for slash commands | |
| `surfaces.discord.defaultChannelId` | for notifications | |
| `DISCORD_WEBHOOK_URL` (env) | optional | Notifications into one channel without a bot token. |

Steps: create a Discord application and bot, install it into your server, `/devices pair channel discord`, optionally register slash commands through the surface's provider actions, verify, then mention the bot. A reply after Discord's fifteen-minute interaction window is posted to the command's channel.

### Telegram

Telegram is a command-authority surface for its owner: an agent turn the owner starts from Telegram is decided as if typed in the terminal app. A turn anyone else the surface admits starts is a guest's turn: it may read and answer, and every change is put to the owner (see "Who may talk to the assistant").

From nothing to the first answered message:

1. In Telegram, talk to `@BotFather`, send `/newbot`, give a display name and a username ending in `bot`. Copy the token it gives.
2. Choose the mode and store the token. Use `polling` unless the daemon is published at a public HTTPS address: the setting's default is `webhook`, which cannot start without one.

   ```text
   /settings set surfaces.telegram.mode polling
   /settings set surfaces.telegram.botToken <your-bot-token>
   /settings set surfaces.telegram.botUsername @<your_bot>
   /settings set surfaces.telegram.enabled true
   goodvibes surfaces check telegram
   ```

   For webhook mode instead: set `web.publicBaseUrl` to the daemon's public HTTPS address; the daemon registers `{publicBaseUrl}/webhook/telegram` with Telegram itself and manages the webhook credential.
3. The daemon log (see "Logs and diagnostics" in "The daemon, the web UI and networking") says `Telegram ingress active` with `mode` `polling` or `webhook` and the reason, or, when it cannot receive, `Telegram is enabled but is NOT receiving messages` (error level, with an `action` field saying what to fix) or `Telegram ingress is inactive` (warning, or info when the surface is switched off).
4. In Telegram, open a chat with your bot and send any message (tapping Start sends `/start`). It is not answered and binds nothing: it raises an owner claim, `Make <your-numeric-id> (<your-username>) the owner of telegram?`.
5. In the terminal app: `/questions`, then `/questions answer <id> accept`. You are the owner, and only you are on the user list: the bot answers nobody else until you admit them.
6. Send `/start` again: the bot replies with how to use it. Then send a request. A conversation gets a reply; a request for work is proposed back, and `yes` (or `go ahead`) starts it.
7. Optional, for deliveries (routines, notices) with no conversation to answer: `/settings set surfaces.telegram.defaultChatId <chat-id>`. A private chat's id is your numeric user id from the claim. `/devices pair channel telegram verify` sends its test message to this chat; without it the test reports `delivered:false`.

The bot's own commands (answered by the adapter, never sent to an agent): `/start` and `/help` reply with usage; `/stop` explains that it does not cancel work (its reply says to send `cancel <id>`; with no decision model in use send `/cancel <id>`) and that the surface is switched off with `surfaces.telegram.enabled false`. In a group, the bot acts only on `/goodvibes <message>` or `@<your_bot> <message>` and ignores other text; the group's other members are answered only if they are admitted (each raises a "reach you" claim). While work runs, the owner can send `status <id>`, `cancel <id>`, `retry <id>` (`/status <id>` and so on without a decision model; see "Run control"). A message with only a photo, voice note or file is answered "I cannot read <kind>s yet. Send the request as text." Edits of a message already sent are not read.

A webhook registered for the bot blocks polling (Telegram answers `409 Conflict`); polling mode deletes it before its first poll. One bot token supports one ingress at a time: a second daemon or an old deployment polling the same token makes polling report a conflict.

### ntfy

| Setting | Notes |
| --- | --- |
| `surfaces.ntfy.baseUrl` | Default `https://ntfy.sh`. |
| `surfaces.ntfy.chatTopic` | Messages here go to the active shared terminal session (secret). |
| `surfaces.ntfy.agentTopic` | Messages here start agent work (secret). |
| `surfaces.ntfy.remoteTopic` | Messages here use daemon-owned remote chat (secret). |
| `surfaces.ntfy.topic` | Default delivery topic for notifications (secret). |
| `surfaces.ntfy.token` | Optional access token (secret). Env `NTFY_ACCESS_TOKEN`. |
| `surfaces.ntfy.defaultPriority` | Default `3`. |

On the public server a topic name is the only thing keeping strangers out, so each topic is a credential: its name is kept in the secret store (daemon tier, key `GOODVIBES_SURFACES_NTFY_CHAT_TOPIC` and so on) and the setting holds a `goodvibes://secrets/` reference; a literal name written into a setting is refused, and the settings screens, channel accounts, status and the model's tools show the reference or `(secret)`, never a name. Setting a topic in a settings screen, the setup wizard or channel setup stores it that way. Topics ship unset: `goodvibes surfaces enable ntfy` gives each unset topic an unguessable name, stores it and says which names to subscribe to, and the daemon does the same when ntfy starts with a topic unset. ntfy carries no sender identity, so a change asked for over ntfy is refused. `goodvibes surfaces` (the owner's own command) lists the topic names to subscribe to. The ntfy subscribe-URL action builds URLs only for a topic it is given.

### Generic webhook

`surfaces.webhook.defaultTarget` (where outbound JSON goes), `surfaces.webhook.secret` (shared secret for signing and verifying), `surfaces.webhook.timeoutMs` (default 10000). Inbound JSON is posted to `/webhook/generic`. A `correlationId` (in the body, or the `x-goodvibes-correlation-id` header) is the message's identity: posting the same message again with the same `correlationId` (after a timeout or a lost answer, also across a daemon restart) answers as a duplicate and starts nothing. Outbound posts carry `Idempotency-Key`, the same for every attempt at one message. A webhook caller receives refusals as HTTP 403 with `ok: false`, `outcome: "refused"`, the reason and the next step. A change asked for over the webhook is refused.

### Home Assistant

What ships: the daemon side only. No Home Assistant custom integration (no `custom_components` package, no HACS entry) is shipped with GoodVibes; the platform describes one as a separate project and none is published from this repository. A Python operator client generated from the contract (`homeassistant_operator_client.py`) is in the source tree's contract artifacts, for whoever writes that integration. Without one, Home Assistant talks to the daemon with its own built-in tools: a `rest_command` (or an automation's REST call) to send prompts, and an automation triggered on the GoodVibes event to read replies.

Settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `surfaces.homeassistant.enabled` | `false` | Switches the surface on. |
| `surfaces.homeassistant.webhookSecret` | | Required. Secret; env `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET` or `HA_GOODVIBES_WEBHOOK_SECRET`. Checked on `/webhook/homeassistant`. |
| `surfaces.homeassistant.instanceUrl` | | Home Assistant's base URL, for example `http://homeassistant.local:8123`; env `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL` or `HA_URL`. Needed for replies and the Home Assistant tools. |
| `surfaces.homeassistant.accessToken` | | A Home Assistant long-lived access token (Profile, Security, Long-lived access tokens). Secret; env `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN` or `HA_ACCESS_TOKEN`. Needed for replies and the tools. |
| `surfaces.homeassistant.eventType` | `goodvibes_message` | The Home Assistant event type replies are fired as. |
| `surfaces.homeassistant.defaultConversationId` | `goodvibes` | Conversation id when a request names none. |
| `surfaces.homeassistant.deviceId`, `deviceName` | `goodvibes-daemon`, `GoodVibes Daemon` | How the daemon presents itself. |
| `surfaces.homeassistant.remoteSessionTtlMs` | `1200000` (20 minutes) | Idle time after which a Home Assistant conversation's session ends. |

Setup from nothing:

1. In Home Assistant, create a long-lived access token.
2. In a terminal app: `/devices pair channel homeassistant` and enter the instance URL, the access token and a webhook secret you choose (or use `/settings set` for each key), then switch the surface on.
3. Make the daemon reachable from Home Assistant: Home Assistant calls the daemon's control plane, which listens on `127.0.0.1:3421` by default, so a Home Assistant on another machine needs the daemon exposed on the network (see "Network exposure" in "The daemon, the web UI and networking").
4. Send a prompt. Two routes:
   - Webhook, authenticated by the webhook secret: `POST http://<daemon>:3421/webhook/homeassistant` with header `x-goodvibes-homeassistant-secret: <secret>` (or `x-goodvibes-webhook-secret: <secret>`, or `Authorization: Bearer <secret>`) and a JSON body such as `{"type":"prompt","message":"turn on the kitchen lights","conversationId":"home","messageId":"ha-msg-1"}`. The prompt text may be in `message`, `prompt`, `text` or `task`; optional `areaId`, `entityId`, `userId`, `displayName`, `providerId`, `modelId`. The request is held until the turn ends (at most 120 seconds) and answers with `delivered`, `sessionId` and `assistantMessageId`; the reply text arrives as the event below. A body with a `tools` list is refused with 400. A body whose text is a run-control command (see "Run control" under "Who may talk to the assistant") controls a run started from the same conversation.
   - Conversation API, authenticated by an operator token with the `write:sessions` scope (`Authorization: Bearer <operator-token>`; tokens are described under "Credentials and pairing" in "The daemon, the web UI and networking"): `POST /api/homeassistant/conversation` with `{"text":"what is on my calendar today","conversationId":"home"}`. The answer carries `status`, `sessionId` and `assistant` with `text` and `speechText`. It waits up to 120 seconds by default (`timeoutMs` 1000 to 600000; `wait: false` returns at once). `POST /api/homeassistant/conversation/stream` returns the same as one server-sent `final` or `error` event. A `messageId` the caller chooses makes a repeat of either safe: the utterance is posted once and the repeat answers with that turn's outcome; `POST /api/homeassistant/conversation/cancel` with `sessionId` (or a known `messageId`) stops a turn. `GET /api/homeassistant/health` reports the surface's state and endpoints.
5. Receive replies: the daemon fires the event `goodvibes_message` on Home Assistant (`POST <instanceUrl>/api/events/goodvibes_message` with the access token). Its data includes `body`, `speechText`, `status`, `sessionId`, `conversationId`, `messageId` and `replyToMessageId`. In Home Assistant, an automation with an event trigger of that type can notify, speak or update a helper from it.

Prompts from Home Assistant run in isolated remote-chat sessions, never in a terminal session. A turn longer than two minutes is answered "Still working on that." (status `running`) and the final reply follows as a second event. The Home Graph routes under `/api/homeassistant/home-graph/*` build a separate knowledge space about the house; they are used by an integration and are not configured from the terminal apps.

### Google Chat

`surfaces.googleChat.webhookUrl` (secret; env `GOOGLE_CHAT_WEBHOOK_URL`) for outbound delivery; `surfaces.googleChat.verificationToken` (secret; env `GOOGLE_CHAT_VERIFICATION_TOKEN`) to verify inbound events at `/webhook/google-chat`; `surfaces.googleChat.appId`, `surfaces.googleChat.spaceId`. Create a Google Chat app or webhook in the target space and store the values. A surface that can only be checked by sending says so on retest and sends nothing.

### Signal

Requires a trusted Signal bridge paired with the account GoodVibes uses. Required: `surfaces.signal.bridgeUrl`, `surfaces.signal.account`. Optional: `surfaces.signal.token` (secret; env `SIGNAL_BRIDGE_TOKEN`), `surfaces.signal.defaultRecipient`. The bridge posts inbound messages to `/webhook/signal`. Signal payloads carry no mention data; with `--require-mention on`, a message is refused unless the bridge sets `mentioned: true`.

### WhatsApp

`surfaces.whatsapp.provider`: `meta-cloud` (default) or `bridge`. Required: `surfaces.whatsapp.accessToken` (secret; env `WHATSAPP_ACCESS_TOKEN`). Optional: `verifyToken`, `signingSecret` (env `WHATSAPP_SIGNING_SECRET` or `WHATSAPP_BRIDGE_TOKEN`), `phoneNumberId`, `businessAccountId`, `defaultRecipient`, and `bridgeUrl` (required in bridge mode; the doctor fails the surface while it is unset). Inbound goes to `/webhook/whatsapp`.

### Telephony (SMS and voice)

`surfaces.telephony.provider`: `twilio` (default) or `bridge`. `surfaces.telephony.mode`: `sms` (default), `voice` or `bridge`.

- Direct Twilio: `accountSid`, `authToken` (secret; env `TWILIO_AUTH_TOKEN`), `fromNumber` (for example `+15551234567`).
- Bridge: `bridgeUrl`, `token` (secret; env `TELEPHONY_BRIDGE_TOKEN`).
- Both: `webhookSecret` (secret; env `TELEPHONY_WEBHOOK_SECRET` or `TWILIO_WEBHOOK_SECRET`) before accepting inbound callbacks at `/webhook/telephony`; `defaultRecipient`; `voiceLanguage` (default `en-US`).

### iMessage

Requires a trusted iMessage bridge or local companion. Required: `surfaces.imessage.bridgeUrl`, `surfaces.imessage.account`. Optional: `token` (secret; env `IMESSAGE_BRIDGE_TOKEN`), `defaultChatId`. Inbound: `/webhook/imessage`.

### Microsoft Teams

Required: `surfaces.msteams.appId`, `surfaces.msteams.appPassword` (secret; env `MSTEAMS_APP_PASSWORD`). Optional: `tenantId`, `botId`, `serviceUrl`, `defaultConversationId`, `defaultChannelId`, `webhookSecret` (a relay secret, only when a relay in front of the webhook cannot forward the Bot Framework token; env `MSTEAMS_WEBHOOK_SECRET`).

Steps: register a Bot Framework app and capture its id and password; in Azure Bot Service set the messaging endpoint to the daemon's `/webhook/msteams`; send one message from each target conversation (or set a default conversation id and service URL) so proactive replies have a route.

### BlueBubbles

Required: `surfaces.bluebubbles.serverUrl`, `surfaces.bluebubbles.password` (secret; env `BLUEBUBBLES_PASSWORD`). Optional: `account`, `defaultChatGuid` (for example `iMessage;-;+15551234567`). Point the BlueBubbles Server webhook at `/webhook/bluebubbles`.

### Mattermost

Required: `surfaces.mattermost.baseUrl`, `surfaces.mattermost.botToken` (secret; env `MATTERMOST_BOT_TOKEN`). Optional: `teamId`, `defaultChannelId`, `webhookSecret`. Optionally point a slash command or trusted relay at `/webhook/mattermost`.

### Matrix

Required: `surfaces.matrix.homeserverUrl`, `surfaces.matrix.accessToken` (secret; env `MATRIX_ACCESS_TOKEN`). Optional: `userId` (for example `@goodvibes:example.org`), `defaultRoomId` (for example `!roomid:example.org`), `webhookSecret`. Matrix events must be forwarded to `/webhook/matrix`; there is no built-in sync worker in this release.

### Channel health and failures

- `goodvibes surfaces` lists each surface with `enabled` and `ready`; `goodvibes surfaces check [<surface>]` runs the doctor; `goodvibes surfaces show <surface>`; `goodvibes surfaces enable|disable <surface>`.
- A surface that stops working is reported once over another working surface (or a receipt the next attached terminal shows), and again every six hours while it stays failing.
- A delivery longer than one message is sent as up to ten messages in order; past that, the result says `truncated` with the number of characters that did not arrive.
- Inbound refusals: a provider that redelivers (Slack events, Telegram, WhatsApp, Twilio) gets an acknowledgement with `outcome: "ignored"` and the policy reason; a caller that reads the status (webhook, Home Assistant, ntfy, the bridges, Teams) gets HTTP 403 with the reason.
- Inbox triage: for an inbox account that has a privacy-screening model route, each new batch of messages is labelled `spam`, `priority` or `normal` by one model request on that same route. A message read as both spam and urgent is labelled spam. Triage is off while no decision model is in use, and off for an account with no screening route or a revoked one (its status says which and what to do). Labels show in `channels.inbox.list` as `triageLabel`, `triageScore` and `triageTags`; reading the inbox never asks a model. `surfaces.slack.inboxTagging`, `surfaces.discord.inboxTagging` and `surfaces.email.inboxTagging` (default off) let `channels.inbox.applyLabels` write the labels back: as reactions on Slack, as reactions (or forum tags on a Discord forum thread) on Discord, or as the IMAP keywords `GoodVibes/Spam`, `GoodVibes/Priority` and `GoodVibes/Normal`. Writing one label removes the other two.
- A chat delivery is not repeated for a provider redelivery: a second delivery with the same provider message id within ten minutes is acknowledged as `duplicate-delivery` and starts nothing.
- A Discord reply that comes after the fifteen-minute interaction window is posted to the command's channel instead.

## Voice

### Spoken output and speech input

| Provider | Speech out | Streaming out | Speech in | Key |
| --- | --- | --- | --- | --- |
| `elevenlabs` (default for `tts.provider`) | yes | yes | yes | `ELEVENLABS_API_KEY` or `XI_API_KEY` |
| `openai` | yes | no | yes | `OPENAI_API_KEY` or `OPENAI_KEY` |
| `microsoft` | yes | no | no | none; sends text to an unofficial Microsoft endpoint, so it is used only when named |
| `google` | no | no | yes | `GEMINI_API_KEY`, `GOOGLE_API_KEY` or `GOOGLE_GEMINI_API_KEY` |
| `deepgram` | no | no | yes | `DEEPGRAM_API_KEY` |
| `vydra` | yes | no | no | `VYDRA_API_KEY` (optional `VYDRA_BASE_URL`) |
| `local` | yes | yes | yes | none; offline engines |

When a request names no provider, a configured `local` provider is used first, then the first other configured provider.

```text
/settings set tts.provider openai
/settings set tts.voice <voice-id>
/settings set tts.speed 1.1
/tts <prompt>          speak the answer to a prompt
/tts stop
/tts on                speak every answer (always-speak)
/tts off
```

### `/voice`

```text
/voice                 review (same as /voice review)
/voice status
/voice setup
/voice enable          speak every answer
/voice disable
/voice wake status
/voice wake setup [yes]
/voice bundle export <path>
/voice bundle inspect <path>
/voice bundle import <path>
```

`ui.voiceEnabled` turns the voice control surface on. The `voice-input` key action (Alt+V by default) starts and stops recording in the terminal app.

### Local offline voice

`voice.local.sttEngine` (`whisper-cpp` or `faster-whisper`), `voice.local.sttBinary`, `voice.local.sttModelPath`, `voice.local.ttsEngine` (`piper` or `kokoro`), `voice.local.ttsBinary`, `voice.local.ttsModelPath`. The `local` provider reports `unconfigured` until an engine is set up.

Managed install: `/voice setup` asks the daemon to download and set up piper (text to speech) with the `en_US-lessac-medium` voice, and whisper.cpp 1.8.2 with the `base.en` model (speech to text, about 148 MB). Every download is checksum-verified and resumable; re-run `/voice setup` to retry a failed part. `/voice status` shows what is installed. The managed install has pinned builds for Linux x86_64 only; on any other platform it reports the engine unsupported, and you install the engine yourself and set the `voice.local.*` keys:

```text
/settings set voice.local.ttsEngine piper
/settings set voice.local.ttsBinary ~/.local/opt/piper/piper
/settings set voice.local.ttsModelPath ~/.local/opt/piper-voices/en_US-lessac-low.onnx
/settings set voice.local.sttEngine whisper-cpp
/settings set voice.local.sttBinary ~/.local/opt/whisper.cpp/build/bin/whisper-cli
/settings set voice.local.sttModelPath ~/.local/opt/whisper.cpp/ggml-tiny.en.bin
/settings set tts.provider local
```

A leading `~/` is expanded. The provider runs `whisper-cpp` as `<binary> -m <model> -f <wav> --no-timestamps --no-prints`, `faster-whisper` as `<binary> <model> <wav>`, and `piper` and `kokoro` as `<binary> --model <onnx> --output_file <wav>` with the text on standard input.

### Wake word

Wake-word detection listens continuously on the microphone for the phrase "hey goodvibes". A confirmed wake plays a sound, shows a listening marker, records what you say next until you stop talking, sends it to speech to text, and puts the transcript in the input box (or sends it as a turn when `voice.wake.autoSubmit` is on).

What it needs:

- The wake models: a classifier for "hey goodvibes" and a speech-embedding front end (about 6 MB in all), checksum-pinned and downloaded into `~/.goodvibes/voice/wake`. Installing GoodVibes downloads them, and a daemon retries at start if the install had no network. If they are still missing, turning `voice.wake.enabled` on in the terminal app or the Agent runs the wake setup plan, which downloads them (see below); `/voice wake setup` and `goodvibes-daemon provision-wake-model` also fetch them.
- A recorder program on the host for the terminal apps: `pw-record`, `parecord`, `arecord`, `ffmpeg` or `sox` (`voice.wake.captureCommand` `auto` uses the first one found in that order).
- Speech to text: a configured speech-to-text provider (the managed local whisper, or a cloud provider from the table above). Without it a wake has nothing to transcribe.

Turning it on from nothing (terminal app):

```text
/voice wake status          what is installed and what blocks wake
/voice wake setup           fetch missing wake models, turn on the wake rows for this terminal, and propose speech to text
/voice wake setup yes       the same, and install the proposed local speech to text through the daemon
/settings set voice.wake.enabled true
```

In both the terminal app and the Agent, turning on `voice.wake.enabled` from anywhere (the settings workspace, `/settings set`, a model's settings call) runs the same setup plan as `/voice wake setup`: it fetches missing wake models and prints the plan. In the Agent the same write also turns on `voice.wake.surfaces.agent` (off by default) and says so, because the switch alone would open no microphone there; the terminal app's row `voice.wake.surfaces.tui` is on by default. The Agent's follow-up line is `(yes: /voice wake setup --yes yes installs it now)`. While wake runs, the terminal footer shows the listening marker (`voice.wake.indicator`). `ui.voiceEnabled` (always-speak) is not needed for wake. The `voice.wake.*` settings belong to each app, not the daemon: the Agent keeps its own `voice.wake.enabled`, set with `/settings set voice.wake.enabled true` there.

The `voice.wake.*` settings, by group:

| Group | Settings | Use |
| --- | --- | --- |
| On/off and where | `enabled`; `surfaces.tui` (default on), `surfaces.agent`, `surfaces.webui`, `surfaces.app` | Turn detection on, and choose which apps listen. Turn `surfaces.tui` off when you talk to the Agent instead, so two apps do not both act on one phrase. The web UI and desktop app ask the browser for microphone permission only when their row is on; a plain-http origin cannot capture. |
| What it listens for | `models` (default `hey_goodvibes`), `customModelDir` | Comma-separated model ids; extra ids are loaded from `customModelDir` without checksum pinning. An empty list stops detection without stopping the service. |
| How sure it must be | `threshold` (0.9), `patienceFrames` (2), `cooldownMs` (2000), `vadThreshold` (0, off; 0.3 recommended) | Lower `threshold` toward 0.5 if it misses you; raise it if it fires when you did not speak to it. `vadThreshold` above 0 screens out non-speech frames first. |
| Audio input | `inputDevice` (empty: system default), `captureCommand`, `noiseSuppression` (`none` or `speex`) | List devices with `pactl list short sources` or `arecord -L`. `pw-record` takes a PipeWire node name or serial; `sox` cannot pick a device. Use `speex` in a noisy room. These rows also apply to push-to-talk (Alt+V). |
| Feedback | `activationSound` (`chime`, `none`, `custom`), `activationSoundPath`, `indicator` (`statusline`, `banner`, `off`) | |
| Recording after the wake | `preRollMs` (500), `captureMaxSeconds` (10; 0 removes the ceiling), `silenceStopMs` (1200), `silenceFloorRms` (0: measured per utterance), `speechRetriggerMs` (150) | Raise `silenceStopMs` if it cuts you off mid-sentence; set `silenceFloorRms` if capture keeps running after you stop. |
| What happens to the transcript | `autoSubmit` (off) | On sends the transcript as a turn without review. Read when the transcript is ready, so a change made while one is being transcribed applies to it. |
| Audio retention | `retainAudio` (`none`, or `session-temp` for debugging, deleted when the session ends) | |
| Crash handling | `maxRestarts` (3), `restartBackoffMs` (2000), `crashWindowSeconds` (60) | A detector that crashes more than `maxRestarts` times in the window is stopped and reported. |
| Browser engine | `browserBackend` (`wasm` or `webgpu`) | Web UI and desktop app only. |

Failures:

| Symptom | Fix |
| --- | --- |
| Wake models reported missing or failing verification | `/voice wake setup` (re-run to resume). |
| No recorder found, or a named `captureCommand` is not installed | Install one of `pw-record`, `parecord`, `arecord`, `ffmpeg`, `sox`, or set `captureCommand` to `auto`. |
| A surface refuses to start with `vadThreshold` above 0 | The speech gate artifact is not installed there: run `/voice wake setup`, or set `vadThreshold` to 0. |
| Wakes but nothing is transcribed | No speech-to-text provider: `/voice wake setup yes`, or configure a cloud speech-to-text key. |
| Detector stops after repeated crashes | It latched off after `maxRestarts`; fix the device or recorder, then restart the app. |
| Fires on ordinary speech | Raise `threshold`, set `vadThreshold` 0.3, or raise `patienceFrames`. |

Daemon routes: `POST /api/voice/tts` (a complete audio file) and `POST /api/voice/tts/stream` (raw audio bytes as a stream). A cloud provider call ends after 60 seconds. An empty transcript is an error.

## The browser

The model drives a real Chromium browser with the `browser` tool (navigate, click, type, read text, screenshot, tabs). The Agent exposes the same driver from the shell:

```sh
goodvibes-agent browser status
goodvibes-agent browser provision [--repair]
goodvibes-agent browser open https://example.com [--visible]
goodvibes-agent browser read https://example.com [--visible]
```

`status` reports whether the driver and a browser are present and what is missing:

```text
GoodVibes Agent browser
  browser available  yes
  driver version     1.62.0
  browser executable /usr/bin/chromium
  browser source     system-browser
  browser cache      /home/me/.cache/ms-playwright
  display            none (headless only)
```

A system Chromium is used when present; otherwise `provision` installs Playwright's Chromium into `~/.cache/ms-playwright` with every step shown. `open` and `read` prove the whole path on a real page without a model, a provider or an API key. `--visible` shows the window when a display exists. The daemon serves the same capability through the `browser.*` operator methods (sessions, tabs, navigate, click, type, snapshot, screenshot, provision, status).

What the browser reads from a page is untrusted text: a change asked for in it is never taken as the owner's instruction, and a purchase cannot be started by page content.

## Purchases and payments

The daemon can buy things for the owner with a stored card, inside budgets the owner sets. Payment rules apply in every permission mode, `yolo` included.

### Before the first purchase

Purchases are off, and every budget is `0`. With the defaults, a checkout that adds any tax, fee or paid delivery is refused outright (the daily overage budget of 0 cannot cover it), and one that adds nothing asks you first (the daily item budget and the per-purchase ceiling of 0 send every purchase to you). Set the amounts below before the first purchase.

1. Turn purchases on: `/settings set payments.enabled true`.
2. Add a card (each field hidden, sent to the daemon after the last field): `/payments add-card`. Fields: label, kind (`virtual` or `real`), number, expiry, security code (3 or 4 digits), cardholder name. The answer is `[payments] Card stored on the selected daemon: <label> ...`. A virtual card with an issuer cap is recommended: the issuer enforces its cap even when this software is wrong. The terminal apps cannot record the cap; the web UI's card form (Settings, payments) has an optional "Issuer cap" field, and the operator method `payments.cards.create` takes `issuerCapMinorUnits`. A recorded cap is your declaration; a purchase whose full total is over it is refused (`card-limit-exceeded`) before any window. A card cannot be edited: to change its cap, remove it (`/payments remove-card <card>`) and add it again. A card number (and a security code asked for with `payments.cvvHandling` `prompt`) is taken only from a connection that reaches the daemon from its own machine, over https (`controlPlane.tls`, or a trusted proxy that ended TLS), or over a Tailscale address; over plain http on the local network (a LAN address or a `.local` name) the daemon refuses it with `403` `CARD_ENTRY_TRANSPORT` before reading it, and the web UI shows that reason instead of the card form or the code field.
3. Set the addresses: `/payments address` in either program (it asks which, then the fields: `name`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`), or the settings workspace (`/settings payments.shippingAddress`).
4. Set the currency and budgets:

   ```text
   /settings set payments.currency USD
   /settings set payments.budget.dailyItem 100
   /settings set payments.budget.dailyOverage 25
   /settings set payments.budget.perPurchaseCeiling 150
   /settings set daemon.timezone America/Chicago
   ```

   Amounts are written as you would say them (`19.99`). The day resets at midnight in `daemon.timezone` (UTC when empty). Every hold and spend records its currency: changing `payments.currency` starts new daily pools in the new currency for the rest of the day, and `payments.budget.status` lists what was spent earlier that day in the old currency (`earlierSpend`), in that currency, never converted.
5. Say where approval and veto prompts also go: `/settings set payments.notifyChannels telegram`. The only accepted value today is `telegram` (or empty); any other name is refused with `expected string (a comma-separated list; only 'telegram' can deliver a notice today)`. Every notice, window and confirmation always goes to the owner inbox (`/questions`, the web UI) whatever this says.
6. Check: `/payments cards`.

### `/payments`

`/payments` alone opens its list of actions (in a script or for a model it prints the cards, as "See your cards" does). Each action is also a typed line; a line with something missing opens the step that asks for it.

| Action | Line | Risk |
| --- | --- | --- |
| See your cards | `/payments cards` (the cards on the daemon and the addresses purchases use) | |
| See what is waiting for your answer | `/payments pending` (answer a purchase window, stop a checkout, type a security code) | |
| Approve one purchase ahead of time | `/payments approve <shop> --most <amount> <item...>` | spends money |
| Allow a repeat purchase | `/payments repeat --shop <shop> [--shop <shop>]... --item <item> --each <amount> --per-period <amount> [--days 7\|30\|90\|365] [--until YYYY-MM-DD]` | spends money |
| See repeat purchases you have allowed | `/payments repeats` | |
| Stop a repeat purchase | `/payments stop-repeat <repeat purchase>` (picked from the ones you allowed) | |
| Add a card | `/payments add-card` (asks each field, hidden) | |
| Remove a card | `/payments remove-card <card>` (picked from the daemon's cards) | cannot be undone |
| Set your billing or shipping address | `/payments address <billing\|shipping> [--name ...] [--line1 ...] [--line2 ...] [--city ...] [--region ...] [--postal-code ...] [--country ...]` (blank keeps what is set) | |

Every action is the owner's own: a line a model runs is refused, naming the action. Each needs a paired owner credential with the `read:payments` and `write:payments` scopes. An action marked "spends money" or "cannot be undone" asks first, with the sentence that says what it does. `/payments address` in the terminal app writes this machine's settings; in the Agent it writes the connected host's settings.

`/payments approve <shop> --most <amount> <item...>`: the shop's domain, the most it may cost (in `payments.currency`), and the item in your words. The approval is used once, for a purchase matching all three that begins within five minutes; such a purchase needs no further answer up to that amount. Approving the same shop, item and amount again while the first approval is unused returns that approval rather than making a second. When recording an approval cannot be confirmed, the answer is `OUTCOME_UNKNOWN` ("The approval may have been recorded ..."), and the web UI says it may have been approved instead of "Nothing was approved". The approval is for that amount in the currency `payments.currency` named when it was given (the reply names it): a begin after `payments.currency` changed is a different purchase, does not spend it, and with `payments.confirmEveryPurchase` on is refused saying the merchant, item, amount or currency differs.

```text
/payments approve shop.example --most 25.00 USB-C cable
Approved ahead of time: "USB-C cable" from shop.example, at most 25.00.
It ends 11/18/2026, 10:20:00 AM; the amount is in USD.
```

"Allow a repeat purchase" lets a scheduled routine or trigger buy one thing without asking, within limits. Its blanks:

| Blank | Option | Rule |
| --- | --- | --- |
| Shop | `--shop` (again for each further shop) | 1 to 8 shop domains, each with a dot; picked from the shops you have bought from, or typed. |
| What may be bought | `--item` | Your words, 1 to 200 characters. |
| Most per purchase | `--each` | Above zero. |
| Most in any period | `--per-period` | At least the per-purchase amount. |
| Period | `--days` | 7, 30 (the usual), 90 or 365 days; typed, any whole number 1 to 366. |
| Last day | `--until` | Optional, `YYYY-MM-DD`. Without it the authorisation lasts until you stop it. |

At most 32 repeat purchases are kept.

```text
/payments repeat --shop shop.example --shop pets.example --item "dog food" --each 60.00 --per-period 120.00 --days 30 --until 2027-06-30
Allowed: "dog food" from shop.example, pets.example. Stop it any time: Stop a repeat purchase.
/payments repeats
/payments stop-repeat standing-1a2b3c4d
```

In the web UI the Repeat purchases screen lists the same allowances, each with Stop, under `Allow a repeat purchase…`, a sheet with the same six blanks and sentence; both are sent as the owner's own request.

The example lets a scheduled run buy "dog food" from either shop, at most 60.00 a purchase and 120.00 every 30 days, until 30 June 2027. A routine's purchase names the authorisation as `standingId` when it calls `payments.checkout.begin`. Every budget, ceiling and purchase window still applies to each purchase under it. A refusal names the field and ends with `Nothing was added.`, for example `maxPerPeriod must be one amount in USD, at least the per-purchase maximum.`

How a purchase is started: there is no owner command that buys. You ask the Agent in conversation ("buy one USB-C cable from shop.example, at most 25 dollars"). The Agent's model opens the shop's checkout page with its `browser` tool, then calls its `agent_operator_method` tool with `methodId` `payments.checkout.begin` and the open page (`sessionId`, `pageId`), `requestId`, `merchantDomain`, `checkoutUrl`, `item`, the requested and quoted lines, the shipping options, the stated total, the currency and optionally `cardId` (else `payments.defaultCardId`) and `requestedMax`. The daemon then reads the page itself, applies the decision below and runs the window. "Accepted" in the answer does not mean bought: `payments.purchase.status` with the `requestId`, `/payments pending` and the web UI Purchases panel show where it stands. The terminal app's model has neither tool, so purchases are started from the Agent (or from a daemon-hosted Agent session, or by an operator client calling `POST /api/payments/checkout/begin` with the `write:payments` scope). A routine or trigger purchase must name a standing authorisation as `standingId`.

How that call is checked, in order:

1. The permission gate decides the `agent_operator_method` call like any other tool call. `payments.checkout.begin` and `payments.purchase.cancel` are not owner-only methods, so the call is a judgment call: with a working decision model Jev decides it in `jev-decides` and `just-vibes` (held instead of refused in `just-vibes`), `ask-me` runs it unless the reading is critical, irreversible or security-weakening; without a decision model it is asked (held in `just-vibes`); `yolo` runs it; `plan` refuses it. The owner-only methods (answering a window, typing a card code, approving in advance, adding a standing authorisation) are refused to the model in every mode.
2. The tool screens the request: it is held if it would carry text the model may not send on (the judgment-input boundary) or card material. It does not run the outward-content check other operator calls get: a purchase's taint is judged by the daemon against the purchase itself.
3. A begin without `standingId` is sent as the owner's own request (the explicit-user-request context); a begin naming `standingId` claims no owner request and is bound to that entry's shops, item and maximums.
4. The daemon then applies every payment gate below (purchases enabled, the owner asked directly, taint of item, maximum, merchant and link, this daemon runs payments for its group, a card, a shipping address), then the budget decision and the window. These apply in every permission mode, `yolo` included.

The model may start a purchase (`payments.checkout.begin`) and cancel one, and read status and the purchase list. Everything else (answering a window, typing a security code, approving in advance, adding a standing authorisation) is the owner's act and is refused to the model.

### How a purchase is decided

1. Gates, each a refusal with no approval path: purchases enabled; the purchase was asked for by the owner directly, not by content he read; this daemon runs payments (alone it always does; in a cluster exactly one machine holds the group's payments role, chosen by the election, and every other machine refers the owner to it: `Refused: in this group of machines purchases run on one machine at a time, and that is <name>. Ask there (its terminal app, web UI or channels); it buys with its own card, address and daily budget.`); a usable card; a shipping address; item and maximum not taken from untrusted content; a checkout link that passes full link validation.
2. The merchant is graded on the domain that takes the card. Established recourse makes the later window a veto window; anything else makes it an approval window. Grading needs a decision model: with none in use (or under `Hybrid` after the set model failed) the merchant is "not judged, because no decision model is in use", which is not established recourse, so every purchase opens an approval window (60 minutes, silence denies), even within every budget. An eBay auction or Best Offer listing is refused. `payments.majorRetailersAdditional` and `payments.majorRetailersExcluded` adjust the grade; `payments.ebayMinSellerFeedbackCount` (100) and `payments.ebayMinSellerPositivePercent` (98) set the eBay seller bar.
3. The page's prices are parsed into numbers, the cart must hold only what was asked for, and a subscription or recurring charge is refused. Without a decision model, a cart line whose label is not exactly a requested item is never passed over because the requested quantities are met: it is listed in the approval window for the owner to see.
4. Budget: the item price against what is left of `budget.dailyItem` (over it, the purchase needs approval: "This item costs USD 40.00 and only USD 25.00 is left in today's item budget, USD 15.00 short."; it is not refused for that); tax, mandatory fees and delivery against `budget.dailyOverage`, stepping delivery down from `payments.shipping.preferredTier` (`normal`, `fast`, `fastest`) one tier at a time until it fits; then the overage tolerance pool if `budget.overageToleranceEnabled`; otherwise refused. The full total is checked against the card's declared issuer cap (over it is refused), the per-purchase ceiling (over it needs approval) and the maximum the owner asked for (over it needs approval). A checkout in another currency is refused.
5. The pools are reserved before the owner is asked.
6. One notification goes out with what was chosen and what it will cost:
   - Veto window (within budget, recourse established): silence for `payments.windows.vetoMinutes` (10) proceeds; an objection cancels. An answer that could not be read (an unreadable owner inbox) is not silence: nothing is bought, and the purchase is refused `answer-unreadable`. An objection or denial given through `payments.purchase.deny` or `payments.purchase.cancel` (the web UI's buttons) is written to the purchase's record before it is reported accepted, so a daemon that stops right after never resumes that window and never buys on its silence.
   - Approval window (over budget, over the requested maximum, or no recourse): silence for `payments.windows.approvalMinutes` (60) denies; only an explicit approve proceeds. When the notice cannot be delivered, a within-budget purchase proceeds and an over-budget one is refused.
   - `payments.confirmEveryPurchase` `true` makes every purchase need the owner's approval.
7. The card is filled and the order submitted. Without a decision model, code checks the live page first: the approved total must be the amount on the order summary's total line (a "Total", "Order total" or "Grand total" line, never a subtotal), and when the page offers delivery choices the quoted one must be the one shown as selected; otherwise nothing is submitted and the purchase stops for the owner to start again. A card security code, 3-D Secure or CAPTCHA pauses for the owner (`/payments pending`). With `payments.cvvHandling` `prompt`, the security code is not stored and is asked every time.
8. The purchase is recorded as `purchased` only when the page the submit landed on, on the merchant's own domain, shows an order number, or shows a confirmation together with this submit's own total. Confirmation wording alone ("Thank you for your order") records `submitted-unverified`: the money is counted as spent, and the owner confirms or denies the order (`payments.purchase.reconcile`, the Purchases panel) or the shop's confirmation mail settles it.
9. The owner's report of a recorded purchase is saved with the purchase record and marked sent once a channel took it; a report the daemon did not get out before it stopped is sent at its next start.

While the daily item budget or the per-purchase ceiling is `0`, every purchase that gets past the overage check asks; the first time, the owner inbox offers once to set that limit. The overage check comes first: with `payments.budget.dailyOverage` at `0`, a checkout with tax, fees or a paid delivery is refused before any question: `Refused: tax, fees and even the lowest delivery option I could choose come to <amount> and only USD 0.00 is left in today's overage budget, <amount> short. ... The daily overage budget is not set (0). Set payments.budget.dailyOverage ...`.

### Two purchases worked through

Settings: `payments.budget.dailyItem 50`, `payments.budget.perPurchaseCeiling 30` (ceiling on, the default), `payments.budget.dailyOverage 10`, overage tolerance off, `payments.shipping.preferredTier normal`, a card with no declared cap, currency USD. "Price" below is the item price on the checkout page; tax, fees and delivery come on top.

Purchase A, item price 25.00, tax 2.00, standard delivery 8.00 (nothing faster offered):

1. Item 25.00 against today's item pool 50.00: fits.
2. Tax plus delivery 10.00 against today's overage pool 10.00: fits (a draw equal to what is left fits).
3. Full total 35.00 against the ceiling 30.00: over by 5.00, so it needs approval: "This purchase comes to USD 35.00 and is over the per-purchase ceiling of USD 30.00 by USD 5.00."
4. The pools are reserved (item 25.00, overage 10.00) and an approval window opens: silence for 60 minutes denies; `approve` buys.

If delivery were 9.00 instead (tax plus delivery 11.00 over the 10.00 pool, and no cheaper tier offered), purchase A is refused at step 2 with `overage-pool-exhausted`, before the ceiling is looked at.

Purchase B, the same day after A was bought, item price 40.00, tax 3.00, delivery 5.00:

1. Item 40.00 against what is left of the item pool, 25.00: over by 15.00. On its own this would only need approval ("only USD 25.00 is left in today's item budget, USD 15.00 short").
2. Tax plus delivery 8.00 against what is left of the overage pool, 0.00: does not fit at any tier, and tolerance is off, so it is refused (`overage-pool-exhausted`).

Purchase B on a fresh day: item 40.00 fits the pool of 50.00; tax plus delivery 8.00 fits 10.00; total 48.00 is over the ceiling 30.00 by 18.00: an approval window ("over the per-purchase ceiling of USD 30.00 by USD 18.00").

A purchase within every limit (for example item 15.00, tax 1.00, delivery 4.00, total 20.00) at a merchant with established recourse opens a veto window: silence for 10 minutes buys it. At a merchant without established recourse, or with no decision model in use, it opens an approval window even within budget.

### Where payment data lives

| Data | Location |
| --- | --- |
| Settings | `~/.goodvibes/daemon/settings.json` |
| Card numbers, expiry, security code, name | Daemon secret store `~/.goodvibes/daemon/secrets.enc`, keys `GOODVIBES_PAYMENTS_CARD_<ID>_<FIELD>`; never returned by any method |
| Card list (id, label, brand, last 4, kind, expiry, issuer cap) | `~/.goodvibes/tui/control-plane/payments-cards.json` |
| Purchase ledger, budget pools, approvals, checkout journal | `~/.goodvibes/tui/control-plane/payments-*.json` |

Not supported: a checkout quoted in another currency, a subscription or recurring charge, and crediting a pool for money that comes back (a refund does not restore the budget).

## CI watch

CI watch reports a GitHub repository's CI status job by job and can watch a branch or pull request until its verdict is in.

Prerequisites: the `gh` CLI installed and signed in (`gh auth login`) on the daemon's machine.

```text
/ci status my-org/my-repo
/ci status my-org/my-repo#42            a pull request
/ci status my-org/my-repo@main          a branch, tag or commit
/ci watch my-org/my-repo#42 telegram
/ci watch my-org/my-repo@main slack:C0123456 --fix-session
/ci watches
/ci run <watch>
/ci unwatch <watch>                    asks first
```

```sh
goodvibes-agent ci status my-org/my-repo --ref main
goodvibes-agent ci status my-org/my-repo --pr 42
goodvibes-agent ci watches list
goodvibes-agent ci watches create my-org/my-repo --ref main --delivery-channel slack:C0123456 --trigger-fix-session --yes
goodvibes-agent ci watches run <watchId>
goodvibes-agent ci watches delete <watchId> --yes
```

- Every job and its conclusion is listed; the overall verdict comes from the jobs, never a rollup. A job configured `continue-on-error` cannot be detected through `gh` and is not flagged.
- The delivery channel is `surfaceKind` or `surfaceKind:address`.
- `--fix-session` (`--trigger-fix-session` in the Agent) starts a fix session on a red verdict, seeded with the tails of up to five failing jobs' logs.
- A standing watch is polled every `watchers.ciPollIntervalMs` (never faster than 15 seconds), sends its verdict once, then retires. A watch whose branch is gone, or that gets no verdict in time, ends with a "no verdict" notice.
- A `git push` or `gh pr create` run through the `exec` tool creates a watch for the pushed branch by itself, delivered to the web UI.

## Occasions and plans

The daemon keeps dated facts about the owner's life and raises them ahead of time.

- An occasion (a birthday, an anniversary) is dated, usually annual, and needs an action. It is raised `occasions.leadDays` (10) days ahead, and the owner's answer is remembered until the next occurrence.
- A plan (a trip with dates and a place) is ambient: nothing is asked, but nudges are moved out of the time the owner is away (`occasions.awayAdjust`).

Both are written in the owner profile, `~/.goodvibes/daemon/owner-profile.md` (another location with `profile.path`), under `## Important dates` and `## Plans`, one line each:

```markdown
## Important dates
- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21
- Dad · 11-02 · annual · remember-only
- Our anniversary · 2015-09-12 · annual · gift-giving · for Jane

## Plans
- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon
```

Segments after the title may be in any order; `|` may be used instead of `·`. A date `MM-DD` is annual and `YYYY-MM-DD` is a one-off unless `annual` or `once` says otherwise; `once` needs a year, so a `MM-DD` line marked `once` is reported as unreadable. The kind is `gift-giving` (offers a gift conversation), `remember-only` (no gift) or `neither`, and is always the owner's choice; nothing infers it. `for <name>` says who it is about; `for me` marks the owner's own date (a `remember-only` date of his own is listed but never pushed at him). `lead <n>` overrides the lead time for one occasion. A line that cannot be read is reported with a reason and never rewritten; you may also edit the file by hand.

### Where occasions are managed

- The Agent: the model's `occasions` tool, used in ordinary conversation ("remember that Sarah's birthday is 14 March"). The terminal app has no occasions command or tool and never receives nudges.
- The web UI: Personal, Occasions tab: open items, upcoming occasions and plans; "Add occasion" and "Add plan" (preview, then confirm), Edit, answering, resolving a conflict, continuing a gift interview, gift history, and the sweep.
- The operator methods `occasions.*` (scope `read:occasions` or `write:occasions`).

### The `occasions` tool (Agent)

Each call names an `action`:

| Action | What it does | Main inputs |
| --- | --- | --- |
| `list` | Every occasion with its next occurrence, days away, window and recorded answer; unreadable lines with reasons; conflicts. The only read that returns real dates. | |
| `pending` | Everything outstanding: nudges (naming the occasion with a word such as approaching, soon or imminent, never the date), open interviews, conflicts. | |
| `state` | What the machine-owned store holds: counts and reasons. | |
| `gifts` | What the owner landed on in earlier years. | `occasionId` |
| `plans` | Plans, and whether one has the owner away today. | |
| `propose` | Draft an occasion and return the one-line confirmation to read back plus a `proposal` token. Writes nothing. | `title`, `date`, `kind`, `person`, `recurrence`, `leadDays`, `self` |
| `confirm` | Write exactly the proposed line to the profile. Refused without a kind. | `proposal`, `kind` |
| `plan_propose` / `plan_confirm` | The same two steps for a plan. | `title`, `from`, `to`, `away`, `destination`, `details` (list); then `proposal` |
| `answer` | The owner's answer to a nudge: `yes`, `no`, `later` or `acknowledged`. | `occasionId`, `answer`, `occurrence` |
| `interview` | Resume a gift interview at its unanswered question. | `interviewId` |
| `interview_answer` | Record one answer and return the next question. | `interviewId`, `stepId`, `text` |
| `interview_record` | Close the interview with what the owner settled on; written to gift history. | `interviewId`, `landedOn` |
| `remove` | Remove an occasion's line (named in the answer as `removedLine`) and every record against it, after asking the owner once. When other lines still declare the same occasion, only the first line goes and its records stay. | `occasionId`, `confirmed: true` |
| `resolve_conflict` | Two lines for one thing: with `keep`, keep the first line with that date and remove the others; without it, return the recorded dates to ask about (lines that agree on the date need no `keep`). | `occasionId`, `keep` |
| `sweep` | Run one pass now. | |

A date heard in conversation is confirmed with the owner once, at the time ("Noted your anniversary as 12 September, right?"), then written.

### Answers and the gift interview

- `yes` on a gift-giving occasion opens a short gift interview: up to `occasions.interviewQuestions` (3, range 1 to 8) questions that open from what the profile already knows about the person and from what the owner chose last time ("Last time you went with <gift>. Something in the same vein, or somewhere different this year?"). The agent does not recommend a gift. Each answer is recorded with `interview_answer`; the interview ends with `interview_record` and what the owner landed on, which is kept in gift history for `occasions.giftHistoryYears` years. An interview the owner walks away from is not finished: it resumes at the unanswered question, the next day.
- `no` ends the question for this occurrence; next year asks again with no memory of the refusal. For a one-off, it is final.
- `later` is not a no: it comes back roughly halfway to the date.
- `acknowledged` means "I have it in hand": the item stays open and listed, and stops being pushed. It never replaces a yes or no already given.

### When nudges are sent

- An occasion is pushed at most twice: once when it enters its lead window (`occasions.leadDays`, default 10 days before), and once on the day. Between those it stays open and quiet, and `pending` always lists it.
- Pushes go to `occasions.nudgeChannel` (default `telegram`; a comma list of `surface` or `surface:address`, for example `telegram:12345,agent`; empty makes it pull-only). `agent` means the Agent reads outstanding items at the end of each turn and when the daemon says one is waiting.
- Nothing is pushed outside `occasions.activeHours` (default `08:00-22:00`, in `daemon.timezone`); it waits.
- A plan with `away` moves a nudge due during the trip to the day before departure (`occasions.awayAdjust`).
- Two lines for one thing (different dates, or the same date written twice) are raised at once and again every `occasions.cadenceDays` (3) days until resolved.
- `occasions.calendarMirror` copies occasions into the calendar; `occasions.suppressMirroredNudges` then avoids a second reminder.
- The daemon checks every `occasions.sweepIntervalMinutes` (60); a sweep runs soon after start when the last one is older than that.

| Setting | Default | Meaning |
| --- | --- | --- |
| `occasions.enabled` | `true` | Master switch. |
| `occasions.leadDays` | `10` | Days ahead an occasion is first raised. |
| `occasions.nudgeChannel` | `telegram` | Where nudges go. Never the terminal app. |
| `occasions.activeHours` | `08:00-22:00` | When nudges may be sent. |
| `occasions.cadenceDays` | `3` | How often an unresolved date conflict is raised again (1 to 60). It does not repeat birthday reminders. |
| `occasions.awayAdjust` | `true` | Move nudges out of away plans. |
| `occasions.calendarMirror` | `false` | Mirror occasions into the calendar. |
| `occasions.suppressMirroredNudges` | `true` | No push for a mirrored occasion. |
| `occasions.interviewQuestions` | `3` | Questions in a gift interview (1 to 8). |
| `occasions.giftHistoryYears` | `10` | How long gift history is kept. |
| `occasions.sweepIntervalMinutes` | `60` | How often the daemon checks. |

Answers, interviews, gift history and calendar-mirror records are kept apart from the profile, in the daemon's `occasions-state.json`.

Operator methods: `occasions.list`, `occasions.pending`, `occasions.state`, `occasions.sweep`, `occasions.propose`, `occasions.confirm`, `occasions.update`, `occasions.remove`, `occasions.answer`, `occasions.acknowledge`, `occasions.interview.get`, `occasions.interview.answer`, `occasions.interview.record`, `occasions.gifts`, `occasions.conflict.resolve`, `occasions.plans.list`, `occasions.plans.propose`, `occasions.plans.confirm`, `occasions.plans.update`, `occasions.plans.remove`. The methods that write the profile (`confirm`, `update`, `remove` and the plan equivalents) take a required `authority`; `update` without `confirmed` returns the line to put to the owner and writes nothing.

## List-valued settings

Some settings hold a whole list. Each is read and written as one JSON value; a malformed list is refused whole.

| Setting | What it is for | Example |
| --- | --- | --- |
| `notifications.webhookUrls` | Webhook URLs that receive this machine's notifications (turn ends, approvals waiting, budget alerts). Each member is a `goodvibes://secrets/` reference to a URL kept in the secret store; a literal URL is refused. Applies at the next start. Managed by `/notify add`. | `["goodvibes://secrets/goodvibes/GOODVIBES_NOTIFY_WEBHOOK_1A2B3C4D5E6F"]` |
| `sandbox.egressAllowlist` | Command names the exec sandbox lets reach the network. From the next command. | `["git","npm"]` |
| `sandbox.workspaceWritable` | Extra absolute paths sandboxed commands may write. From the next command. | `["/home/me/.cache/build"]` |
| `surfaces.email.imap.authservIds` | Authserv-ids your mailbox's receiving server writes in `Authentication-Results`, for a provider that is not built in. An entry starting with `.` matches the hosts under that domain. | `["mx.example.com"]` |
| `provider.fallbackModels` | Your fallback order: the provider-qualified models a turn moves to, in every program (terminal app, `run`, the Agent, hosted sessions, the daemon's agents), when the selected model fails on every sign-in of its provider and its retries. The provider half is matched by id or display name without regard to case. Empty: the turn stops and says so. | `["anthropic:claude-sonnet-5"]` |
| `cluster.peers` | Cluster peers (`host` or `host:port`) contacted directly as well as over multicast, for a network that drops multicast. | `["10.0.0.2","10.0.0.3:4000"]` |
| `conversationGate.gatedSurfaces` | Channel surfaces whose inbound messages pass the conversation gate before a session sees them. | `["slack","telegram"]` |
| `contract.gates` | Quality gates a contract runs before it reports work done: objects `{ "name", "command", "enabled" }` with optional `required` and `verification`; a gate passes or fails on its command's exit code. A gate that cannot run is refused when saved. | `[{"name":"tests","command":"bun run test","enabled":true}]` |
| `worktree.setup.commands` | Commands run in a new worktree before an isolated agent starts in it. `[]` (auto, the default) runs the install command each lockfile names; `{"mode":"none"}` runs nothing. | `["bun install"]` |
| `worktree.setup.carryOverGlobs` | Untracked files copied from the main checkout into a new worktree. `[]` (auto) copies `.env` and `.env.*`; `{"mode":"none"}` copies nothing. | `[".env","config/*.local.json"]` |

These are settings only; "lists" in this section means these list-valued settings. GoodVibes has no shopping-list feature. Both apps have the same to-do list, the project's work plan, kept with `/todo` (`list`, `markdown`, `export`, `add <title>`, `edit <item> <title>`, `mark <item> <state>`, `next <item>`, `remove <item>`, `clear-done`; `/todo` alone opens these as a list to choose from). The Agent's model reads and changes it with the `agent_work_plan` tool, the terminal app's with the `work_plan` tool. Both are described in full in "The terminal app (`goodvibes`)" and "The Agent (`goodvibes-agent`)".

How to edit one, from each surface:

| Surface | How |
| --- | --- |
| Terminal app | `/settings set <key> <JSON list>`, for example `/settings set sandbox.egressAllowlist ["git","npm"]`; `[]` empties it. `/settings <key>` opens the settings workspace at the key. `-c <key>=<JSON list>` sets it for one launch. |
| Agent | `/settings <key>` opens the settings workspace at the key, where the list is edited. `/settings set` does not take a list. `-c <key>=<JSON list>` sets it for one launch. |
| Daemon command line | `goodvibes-daemon config get <key>`, `goodvibes-daemon config set <key> '<JSON list>'`, `goodvibes-daemon config unset <key>`, `goodvibes-daemon config list`. Quote the JSON for the shell. |
| Web UI | Settings: the key's field is a JSON editor that checks the list before it saves. |
| Operator API | `config.set` and the other `config.*` methods (described in "The daemon, the web UI and networking"). |

`notifications.webhookUrls` is set through `/notify add|remove|list|clear`, which keep each URL in the secret store. A value that fails the key's check is refused whole with the key's hint, for example `list of absolute paths`.

## Settings reference for this part

<!-- generated: settings:automation -->

<!-- generated: settings:watchers -->

<!-- generated: settings:checkin -->

<!-- generated: settings:notifications -->

<!-- generated: settings:surfaces -->

<!-- generated: settings:calendar -->

<!-- generated: settings:google -->

<!-- generated: settings:tts -->

<!-- generated: settings:voice -->

<!-- generated: settings:ui.voiceEnabled -->

<!-- generated: settings:payments -->

<!-- generated: settings:daemon.timezone -->

<!-- generated: settings:occasions -->
