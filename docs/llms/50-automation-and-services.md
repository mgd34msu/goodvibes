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

  The secret key name is `GOODVIBES_` followed by the setting key in upper case with dots and camel-case boundaries turned into `_`. The same value can be stored directly as the secret `GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN` ("Store a secret" in Permissions and safety, Secrets, or `goodvibes secrets set GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN --user`).
- Everything a service sends as the owner passes the permission gate described in "Permissions, decisions and safety": a new recipient is the owner's to allow, and a change asked for on a channel is the owner's to approve.

## Scheduled routines

A routine is a prompt that runs on a schedule. Each time it fires it produces a run. The daemon keeps routines as automation jobs, so a routine runs once whether or not a terminal is open, and the list is the same in the web UI, channels and agents.

### Schedule kinds

| Kind | Value | Example |
| --- | --- | --- |
| `cron` | A five-field cron expression, with an optional time zone (an IANA zone) and a spread of the start. New schedule sends the daemon's machine's zone when the time zone is left blank; a schedule created through the daemon with no zone at all (an agent's reminder, a script calling `automation.schedules.create`) is kept in `daemon.timezone`, or the daemon host's zone when that is unset, and `automation.schedules.list` reports that zone as `defaultTimezone`. A cron kept in a zone other than yours is listed with the zone's name | `"*/30 * * * *"` |
| `every` | An interval such as `15m`, `2h`, `1d` | `15m` |
| `at` | One date and time, ISO form; read in this machine's zone when it has no zone | `2026-12-01T09:00` |
| `when` | Natural language, read by the decision model into one of the three above | `"every weekday at 9am"` |

### Automation, in every program

Automation is one place, reached from the menu (the leader key, then `m`, in the terminal app and the Agent; the Automation screen in the web UI's command palette). Its tabs are Schedules, Runs, Triggers, Commands (the commands triggers may run), CI watches and Check-ins. Every list is read from the daemon when the place opens and again whenever the daemon says it changed (a schedule paused from the web UI, a trigger stopped by a script, a run that ended), with no key pressed. The keys on the hint row are the actions that apply to the selected item in its state; each is rebindable in Keys. The daemon keeps and runs every schedule, so it runs once whether or not a program is open; the terminal app keeps none of its own, and the Agent's schedules are its connected host's.

The same actions are capabilities (`schedule.*`, the daemon's own `automation.*` methods): a model finds and runs them with `capability_find` and `capability_run`, an outside agent with `capabilities.find` and `capabilities.run`, and a script with `goodvibes do <id> --input name=value` (also `goodvibes-agent do` and `goodvibes-daemon do`).

| Action | Capability | Control in Automation | Risk |
| --- | --- | --- | --- |
| See your schedules | `schedule.list` | the Schedules tab | |
| Schedule something to run | `schedule.add` | `n` new schedule (Schedules tab) | |
| Run a schedule now | `schedule.run` | `g` run now, on a schedule | |
| Pause a schedule | `schedule.pause` | `p` pause, on a schedule that runs | |
| Resume a schedule | `schedule.resume` | `p` resume, on a paused schedule | |
| Change a schedule | `schedule.change` | `c` change, on a schedule | |
| Remove a schedule | `schedule.remove` | `x` remove, on a schedule (asks first) | cannot be undone |
| Stop a run that is going | `schedule.stop-run` | `s` stop, on a run waiting or running (asks first) | cannot be undone |
| Run a failed run again | `schedule.retry-run` | `t` run again, on a failed run | |

```text
goodvibes do schedule.add --input prompt="post the standup summary" --input when="every weekday at 9am"
goodvibes do schedule.add --input prompt="summarize open pull requests" --input how=cron --input cron="0 9 * * 1-5" --input tz=America/Chicago
goodvibes do schedule.add --input prompt="check the build status" --input how=every --input every=15m
goodvibes do schedule.pause --input schedule=<schedule id>
```

The Schedules tab shows each schedule by name; its detail gives its timing in words with the pattern it is kept as beside it (`every weekday at 09:00 (0 9 * * 1-5) [UTC]`, `on the 1st of each month at 07:30 (30 7 1 * *)`, `every hour at :15`, `every 30 minutes`), the next and last run, how many runs so far, why it is paused, and what it does. A schedule whose last run failed or was missed is marked, and the menu row of Automation counts them.

New schedule's form asks what it does, then when (described in words, once at a date and time, every so often, or a cron pattern; a time zone and a spread of the start), then "Anything else?" (each blank keeps the usual setting):

| Input | Meaning |
| --- | --- |
| Name | Its name; default is the first 40 characters of what it does. |
| Model, Provider | The model to run it with. |
| Fallback models | Fallback models, separated by commas. |
| How hard it thinks, Thinking | Reasoning effort and thinking mode. |
| Where it runs | A fresh conversation each time (the usual), the main conversation, a background session, or the pinned one. |
| When it wakes | Run at once when due, or with the next heartbeat. |
| Template | A prompt template. |
| Tools it may use | Only these tools, one per line. A run limited this way does not get the mail and calendar tool unless `google` is listed. |
| Answer goes to | Where each run's answer goes: a channel written as in settings, `telegram`, `slack:C123` and so on (`telegram` alone uses `surfaces.telegram.defaultChatId`). Blank: the owner inbox. |
| Outside source | Marks where outside content comes from. |
| May act on content from outside sources | "Yes" loosens a protection: a model's call of it is put to you, opening on No; set it back to "No" to undo it. |
| Start paused | Kept, but runs only once resumed. |
| Light context | Run with a small context. |

A time described in words is read by the daemon (`automation.schedules.preview`, in the daemon's time zone when the time zone is blank; the web UI's sheet shows the reading as `Read as: ...` with the next run before its button keeps it). Nothing is kept by the reading.

What New schedule says when it kept one (the id is generated):

```text
Scheduled. "check the build status": every 15 minutes; next 2026-11-18 10:15 America/Chicago. The answer goes to your owner inbox.
```

Run now says what ran and how it stands: `Started "Morning brief". Its run is running.` The Runs tab shows how it ends.

Schedules an earlier terminal app kept in its own file (`~/.goodvibes/tui/control-plane/automation-jobs.json`, when that was not the daemon's own store) are taken by the daemon itself when it starts, as its upgrade step: each one the daemon does not hold is added once, in the folder the 3.5.0 daemon ran in, and nothing is asked. The file is read only and left as it was, so a rollback finds it; a later start finds each schedule held and takes nothing again. The terminal app no longer moves schedules at its start.

Failures:

| Message | Fix |
| --- | --- |
| `Not done: the daemon did not answer (it may be stopped or still starting)` | Start the daemon; check `goodvibes status`. The place reads its lists again by itself when the daemon is back. |
| `Not kept: "<value>" is not a date and time. Use one such as 2026-12-01T09:00 (read in <zone> when it has no zone).` | Write it as `YYYY-MM-DDTHH:MM`, read in the time zone given (or the daemon's or the browser's zone), or add `Z` or an offset for an exact instant. |
| `Not kept: <time> has already passed.` | Pick a future time. |
| `Not kept: the timing is <reason>; give it as a date and time, an interval or a calendar pattern instead.` | The decision model could not read the words, or none is set. Choose "Once, at a date and time", "Every so often" or "On a calendar pattern". |

### Routines on a schedule, and a schedule's runs

A routine becomes a schedule of the daemon with "Run a routine on a schedule" (`routines.promote`; `p` on a routine on the Routines tab of Automation or of Memory and knowledge), in every program, the web UI, a model's `capability_run` and `goodvibes do routines.promote`: when (a calendar pattern, an interval or a time, with a time zone for a pattern), where the answer goes (channels, routes, web addresses, linked surfaces, one per line), a name, a provider and model, and whether it starts paused. Only a routine switched on, reviewed and with nothing missing is put on one, and a repeat after a lost answer finds the schedule already made. "See routines put on a schedule" (`routines.receipts`), "See one schedule receipt" (`routines.receipt`) and "Check scheduled routines against their schedules" (`routines.reconcile`) read what was recorded. From the shell: `goodvibes do routines.promote --input routine=<routine> --input how=cron --input when="0 9 * * *" --input tz=America/Chicago`.

A schedule's runs are on Automation's Runs tab in every program: `s` stops one that is waiting or running (`schedule.stop-run`), `t` runs a failed one again (`schedule.retry-run`).

### The model's `schedule` tool

The model can list and create schedules with the `schedule` tool (its inputs are in the tool reference). A routine the model creates passes the permission gate like any change.

### How runs behave

- A run uses the permission mode and sandbox of the owner who created its job; a job has no permission setting of its own. A run in a mode that would ask gets its asks through the owner inbox and the attached surfaces.
- A run ends at the job's own timeout, or `automation.defaultTimeoutMs` (two hours; `0` means no limit). Past it the run fails with `Timed out after <duration>`.
- A run in flight when the daemon stopped is failed when it starts again (`Interrupted by a restart before it finished. It may already have done part of its work, so it was not retried; run it again by hand if it still needs to run.`). It may already have sent mail, posted or written files, so it is never retried on its own; its failure notice says so and Run again on Automation's Runs tab (`schedule.retry-run`) runs it again. A run whose agent stopped without reporting its end is failed the same way. A check-in whose note was handed to its channel when it failed is not retried either: the note may already have arrived.
- An occurrence that comes due while an earlier run of the same job is still running is skipped.
- A one-time job whose time passed while the daemon was down for longer than `automation.catchUpWindowMinutes` is recorded as missed and disabled.
- After a failure, the job waits `automation.failureCooldownMs` before it may run again.
- A cancelled run stays cancelled and is not retried. Cancelling a check-in that is still deciding stops it before its judgment and its delivery.
- A run still starting when the daemon stops starts no agent and saves no record afterwards; the next start reconciles what was recorded.
- At most `automation.maxConcurrentRuns` runs execute at once; `automation.runHistoryLimit` runs per job are kept. An occurrence or a retry that comes due while every slot is in use waits for one and starts as soon as a run ends, oldest first; its stored next run time stays the time it came due, so a restart finds it due.
- A one-time schedule already in the past cannot be enabled: creating, enabling or editing such a job leaves it disabled with the reason `schedule-expired`. A job whose status is `archived` cannot be enabled again. A job paused for its failures that is enabled again starts its failure count afresh.
- `automation.enabled` `false` stops the whole subsystem.
- In a group of machines (`cluster`), a routine made on any machine is listed on every machine and runs once in the group, on the machine holding the `automation` role; disabling or removing it on any machine applies on all of them, and when the role moves the new holder carries on from the last occurrence started. A run still starting on the machine that lost the role starts no agent and saves nothing more. See "What a cluster does and does not do" under "Clusters" in "The daemon, the web UI and networking". The scheduled check-in is the exception: it follows the `checkin` role.

### Where a routine's result goes, and what a routine can use

- Each run's answer goes to the surface named on the routine. New schedule takes it as "Answer goes to" (`deliver`) in every program; "Run a routine on a schedule" takes the same targets, one per line; the Agent model's schedule tools take `--delivery-channel <surface>` (for example `telegram`), `--delivery-channel <surface>:<route id>`, `--delivery-route <route id>`, `--delivery-webhook <url>` or `--delivery-link <name>`. In the Agent's flags the part after `:` is a route binding id, not a chat id. A Telegram delivery with no route or address goes to `surfaces.telegram.defaultChatId`; with neither, that send fails with `Missing Telegram chat id`.
- A routine that names no surface, or whose every named surface failed, leaves its answer in the owner inbox as a report titled `Scheduled run: <name>` (the answer, cut at about 3,800 characters; when a send failed, the reason first). It stays open until you answer it `read` (Waiting for you, the web UI's Work view, or a channel). A failed or missed run leaves `Scheduled run failed: <name>` (or `missed`) there too when its notice reached no one: the routine names no surface, delivery is off, or every surface it names failed. An answer that reached neither a surface nor the owner inbox stays owed on the run and is delivered again when the daemon next starts; so does a failed or missed run's notice that was not yet sent or reached no one when the daemon stopped. Every run is also kept in the run history (the web UI and the `automation.runs.*` methods). The routine itself keeps how its last run ended for the person as `lastOutcome`: `delivered` (a named surface took it), `partly-delivered` (some named surfaces took it and some did not; the owner inbox gets the answer with the surfaces it missed named), `not-delivered` (every named surface failed and it went to the inbox instead, or it names no surface and the owner inbox could not take it), `inbox` (it names no surface) or `failed` (the run failed); It is on the routine's record (`automation.jobs.list`) and on its fleet node (`schedule.lastOutcome`).
- A routine the terminal app keeps itself (with `daemon.enabled` off) has no owner inbox to fall back to: an answer with no surface is kept only in its run history.
- A run's answer is owed from the moment the run ends (saved with the run's end) until its delivery is recorded. A daemon that stops in between delivers it at its next start, under the same identity, so a surface that drops repeats drops a second copy. A one-shot routine is removed only once its run's answer was delivered.
- The model's `schedule` tool with `action:"remind"` does not send its text as is: at each run a model turn is started with the text framed as a reminder ("GoodVibes Agent scheduled reminder. Reminder: <text> ... Keep the reminder concise and state any next action"), and its answer is delivered. New schedule (`schedule.add`) sends what it does as written.
- A scheduled run is an agent the daemon starts with the platform's tool set (files, shell, fetch, web search, MCP, channel tools, and the like). Once you have connected mail or a calendar (a Google account with "connect" on the Google tab of Mail, calendar and channels, or a CalDAV server in `surfaces.calendar.caldavUrl` and `surfaces.calendar.caldavUser`), it also gets the `google` tool: `mail.list` and `mail.read` on the connected Gmail, and `calendar.list` on the daemon's calendar (the CalDAV server when one is set, otherwise the Google calendar). Its calls pass the same permission gate as any turn. A send or a calendar event it makes may not carry what it read from mail or a calendar, and `calendar.create` is refused in a scheduled run (nobody asked for that event at that moment). A routine limited with `--tool` gets the tool only when `google` is listed.

### A daily 8 am summary of mail and calendar delivered to Telegram

1. Connect the mail and calendar to the daemon: "connect" on the Google tab of Mail, calendar and channels (Gmail and Google Calendar over OAuth, Path B in "Google" below: the model's `google` tool reads mail only through it, in a conversation as in a scheduled run), or set a CalDAV server for the calendar. The Google tab shows the connection; "check it" proves it by use.
2. Set up Telegram as in "Telegram" (owner claim accepted) and give it a delivery chat: `/settings set surfaces.telegram.defaultChatId <your-numeric-id>`.
3. Create the schedule (any program): open Automation, press `n` (New schedule), write what it does ("Summarize my unread mail from the last 24 hours and today's calendar events. Group the mail by sender and give the events in time order."), choose "On a calendar pattern" with `0 8 * * *` and the time zone `America/Chicago`, and under "Anything else?" put `telegram` in "Answer goes to". From a script:

   ```text
   goodvibes do schedule.add --input prompt="Summarize my unread mail from the last 24 hours and today's calendar events. Group the mail by sender and give the events in time order." --input how=cron --input cron="0 8 * * *" --input tz=America/Chicago --input deliver=telegram
   ```

   ```text
   Scheduled. "Summarize my unread mail from the last": every day at 08:00 (0 8 * * *) [America/Chicago]; next 2026-11-20 08:00 America/Chicago. The answer goes to telegram.
   ```

4. Try it at once: select it on the Schedules tab and press `g` (run now). The run reads the mail and the calendar with the `google` tool and its answer arrives in your Telegram chat. If the send fails (the bot cannot reach the chat), the answer is in the owner inbox instead, with the reason.

In the Agent the schedule is kept on the connected host the same way; its run has the same tools.

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

Stored triggers start being supervised at once. Triggers are saved in `triggers.db` inside the project tree of the process that supervises them: `<working directory>/.goodvibes/<surface>/triggers.db` (for the daemon, its own working directory and `tui`). Automation's Triggers tab reads and changes the triggers of the daemon the program is connected to. A trigger's agent turn is started by that process's agent manager, so it runs in the daemon under the daemon's own settings. One process supervises a store at a time; another window can list them and reports `another process supervises them`; a change from that window is refused and names the process to use.

### Triggers in Automation

The Triggers tab lists each trigger with its state in words (watching, waiting after a failure, gave up after failing again and again, stopped); its detail says what it watches, how often it acted and when last, when it looks again, and its last problem. The Commands tab lists the commands you let triggers run, with what each runs, who approved it and its digest. Both read again by themselves when a trigger is made, changes state, acts or is stopped anywhere (LIST_CHANGED `triggers`).

| Action | Capability | Control in Automation | Risk |
| --- | --- | --- | --- |
| See your triggers | `triggers.list` | the Triggers tab | |
| Watch for something | `triggers.watch` | `n` watch for something (Triggers tab) | |
| See what a trigger did | `triggers.history` | `h` what it did, on a trigger | |
| Stop a trigger | `triggers.stop` | `x` stop, on a trigger that watches (asks first) | cannot be undone |
| Start a trigger that gave up | `triggers.restart` | `s` start again, on one that gave up | |
| See commands triggers may run | `triggers.commands` | the Commands tab | |
| Let triggers run a command | `triggers.allow-command` | `n` let triggers run a command (Commands tab; asks first) | loosens a protection |

"Watch for something" asks what to watch: a command finishing (the program and its arguments, one per line; an `on-exit` trigger), a line a command prints (a pattern; a `stream` trigger), a web address changing (looked at every so often, default 5m; a `condition` with an `http` probe and a `change` rule), a file changing (likewise with a `file` probe), or something else written out (the `{ "spec": ..., "action": ... }` JSON below, for any probe, rule or action). Its id is made from the name. Then it asks what happens: the agent looks at it ("Tell the agent" adds your instructions; "Answer goes to" names the channel its answer goes to, else the owner inbox), or a command you let triggers run. The daemon reads the blanks into the definition (`watchers.triggers.preview`) before it is made.

The model creates, lists, cancels and resets triggers with the `trigger` tool, or through `capability_run`. Letting triggers run a command loosens a protection: a model's `capability_run` of `triggers.allow-command` is an item of your list: asked in Ask me and Jev decides (opening on No), held in Just vibes, run in YOLO. Your own call of it, from any of your credentials, runs at once.

The web UI's Automation screen has the same actions, each as a sheet with the same blanks.

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

`{"kind":"agent-turn","prompt":"<text>"}` puts `<text>`, a blank line, then that message. `{"kind":"agent-turn","model":"<provider:model>"}` runs the turn on that model; without it the supervising process's default model is used. A `sessionId` in an agent-turn action is refused on a new trigger. When the turn ends its answer is delivered: to the channel `deliverTo` names (`{"kind":"agent-turn","deliverTo":"telegram"}`, or `"slack:C123"`; written as in settings), else to the owner inbox as a report titled `Trigger <label>`. A send that fails puts the answer in the owner inbox with the reason. A `deliverTo` that names no delivery surface is refused when the trigger is created. The firing is also recorded in the trigger's runs (What it did, `h` on the trigger in Automation, with the action's result, `agent:<id>`) and the turn appears with the supervising process's agents (the web UI Work view for the daemon). The turn gets the same tools as a scheduled run, the `google` mail and calendar tool included once mail or a calendar is connected. `{"kind":"action-grant","grantId":"<id>","digest":"<digest>"}` runs a command the owner let triggers run ("Let triggers run a command" in Automation); the Commands tab shows each one's digest.

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

`timeoutMs` is a positive number of milliseconds; leave it out for the default budget (`watchers.triggers.probeTimeoutMs`). An `http` probe is held to the fetch tool's host settings: a URL the fetch tool would refuse (a blocked host, a cloud metadata or private address not in `fetch.allowedPrivateHosts`, a localhost address while `fetch.allowLocalhost` is off) is refused at create with the fetch tool's reason, and every check resolves the host again, checks each address and follows a redirect only to a host that passes the same check. The probe's URL, file path and working directory are the trigger tool call's hosts and paths, so your path and host rules apply to them.

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

Watch for something, "Something else, written out", named `API health`, with this definition (from a script: `goodvibes do triggers.watch --input name="API health" --input kind=written --input definition='...'`):

```text
{"spec":{"kind":"condition","probe":{"kind":"http","url":"https://api.example.com/health","capture":"body"},"extract":{"kind":"raw"},"rule":{"kind":"debounce-n","count":3,"inner":{"kind":"value","operator":"ne","operand":"ok"}},"intervalMs":60000}}
```

### Trigger states and failures

- Only an `on-exit` trigger finishes when it fires (state `fired`, final). A `condition` or `stream` trigger records each firing (`firedCount`, a `fired` entry in its runs) and keeps watching. A cancelled trigger is finished. Cancelling a running `on-exit` trigger stops its process and records the run's termination as `cancel-requested` (not observed) until the supervisor sees the process end, then as what it saw (`signalled` or `exited`, reason `cancelled`); a process started before a daemon restart is not ours to stop, so its cancel records no termination and says the process was not stopped. "Start a trigger that gave up" (`triggers.restart`; `s` on the trigger) applies only to `idle`, `backoff`, `circuit-open` and `failed` triggers; another is refused with what to do instead.
- A failing check backs off along `watchers.triggers.backoffLadderMs`; after `watchers.triggers.breakerStrikes` failures in a row the breaker opens (`circuit-open`) until reset.
- An action that fails to deliver is kept owed and delivered again when due, once at a time: an action slower than the supervision tick is not started a second time, and a batch leaves the owed list only when the attempt that delivered it ends. A stream keeps at most eight undelivered batches; a dropped one is recorded in the trigger's runs.
- A save that fails sets `lastError` to `not saved: <cause> (<path>)` and is retried on the next tick; the trigger keeps running.
- When the daemon refuses, Automation's outcome line says `Not done: <the daemon's reason>`; `capabilities.run` answers with the same reason.

## Watchers

A watcher is a daemon-managed poller over an external source: a URL requested every interval, a file whose size and modification time are checked, or a manual watcher that runs only when started by hand. Each run records a checkpoint (what it observed) and emits runtime events on the `watchers` domain: `WATCHER_STARTED`, `WATCHER_HEARTBEAT`, `WATCHER_CHECKPOINT_ADVANCED` (the observation changed), `WATCHER_FAILED` and `WATCHER_STOPPED`. A watcher does not start an agent or send a message by itself; an operator client or the event stream reads its events. To have the assistant act when something changes, use a supervised trigger (above). A run that fails on a running watcher leaves it `degraded` with the error in `lastError`: its interval keeps running it, also after a daemon restart, and its next successful run returns it to `running`. A watcher is `failed` only when nothing drives it (a run started by hand on a stopped watcher failed); start it to run it on its interval again.

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

On a cadence, the daemon assembles a briefing and the decision model judges whether anything needs the owner now; only then is a message delivered. The briefing holds: approvals and questions waiting in the owner inbox (and for how long), contracts waiting for the owner's decision (with their question), automation runs that failed since the last check-in, and messages a session has not picked up yet. It does not read mail, calendar or channels. With no decision model in use (none set, or the set model failing), the check-in takes its fallback without a model request for the decision: when something waits for the owner (an approval, question or report in the owner inbox, a contract waiting for the owner's decision, a failed run) it contacts the owner with the note the conversation model writes, sent as written and marked `(Not independently checked: no decision model is in use.)`, and its receipt's reason reads `Decided from the current state (no decision model is in use): <n> items are waiting for you; the note was not independently checked`; when nothing waits it records `quiet` (`Nothing needs the owner: ...`) and sends nothing. With none set this is silent; with a set model failing, the same fallback runs and the model's failure is reported as everywhere else. The outcome `skipped-decision-models-disabled` ("Decision models are unavailable; automatic check-in contact and note verification were not completed.") is recorded only when a decision the check-in needs has no fallback and fails with decision models off. Inside quiet hours it is recorded as `skipped-quiet-hours`. A note too long for one message on its channel goes out as several; when only some of them arrive, the receipt is `partial` with `partsSent` and `partsTotal` and says how many did not arrive (the run reports `partly delivered`; it is not sent again, since the owner already has the start). Each receipt's summary states how many items wait for the owner (the same count the decision reads), then only the counts that are not zero: sessions running, sessions with messages not yet picked up, channel messages not yet picked up, runs finished recently (`11 items waiting for you.`).

```text
/settings set checkin.enabled true
/settings set checkin.cadence "0 */4 * * *"
/settings set checkin.deliveryChannel telegram
/settings set checkin.quietHours 22:00-07:00
```

Automation's Check-ins tab lists what each check-in did (told you, stayed quiet, skipped and why, failed), newest first, with what it read and what it said; it reads again by itself after each one (LIST_CHANGED `check-ins`). `g` there checks in now (`checkin.run`; it may send a message to the check-in channel, which cannot be called back). `checkin.status` gives the same list to a model or a script.

`checkin.deliveryChannel` is `surfaceKind` or `surfaceKind:address` (for example `slack:C0123456`); empty uses the owner profile's `contactMe.channel`. `checkin.quietHours` is `HH:MM-HH:MM` local time; empty uses the owner profile's `contactMe.quietHours`.

The check-in settings own the scheduled job named `Proactive check-in`, which Automation's Schedules tab lists with the other jobs. Removing, enabling, disabling or rescheduling it there is refused (`The check-in job is kept by the check-in settings, so it cannot be <removed> here. Use checkin.config.set: enabled false stops check-ins, enabled true starts them, and cadence changes when they run. Nothing was changed.`); renaming it is allowed. `checkin.config.get` reads its schedule state from that job as it stands: `scheduled` only while the job exists, is enabled and runs on `checkin.cadence`.

## Notifications

Agent and workstream outcomes, approvals waiting and budget alerts are announced to the notification transports: Slack, Discord and webhook URLs.

The webhook addresses are one list, the daemon's, for every program on this machine. In either terminal program they are the Notifications tab of Mail, calendar and channels (`Ctrl+G` then `m`): `n` adds an address (asked for on a hidden line), `x` stops sending to the selected one, `Shift+D` removes every address (asked first: it cannot be undone), `t` sends a test to each, `s` sends a notification you write, `v` shows the full addresses (asked first: each carries its key). The Failed notifications tab lists what could not be delivered (Slack, Discord, webhooks): `Enter` sends the selected one again, `a` sends them all again, `c` sends it where its Slack or Discord channel posts now, `l` lists them in words. A model, an outside agent or a script reaches the same as the capabilities `notify.list`, `notify.add`, `notify.remove`, `notify.clear`, `notify.test`, `notify.send`, `notify.failed` and `notify.resend` (`capability_run`, `capabilities.run`, `goodvibes do`). The notice history is the Notices tab of the System place (`Ctrl+N`).

- Adding keeps each URL in the secret store (key `GOODVIBES_NOTIFY_WEBHOOK_<id>`, daemon tier) and adds its `goodvibes://secrets/` reference to the daemon's `notifications.webhookUrls`; the URL is read only when a notification is sent. Each URL carries its own key, so a literal URL written into the list is refused and screens show the host only. Removing an address, or every address, deletes the stored URLs too. A program that sends a notice on its own events reads the daemon's list when it starts.
- Until 3.5.0 the terminal app, the Agent and the daemon each kept a list. The first start of this version carries every address of each into the daemon's list (the same address once); the programs' own settings keep their old value, so a 3.5.0 program after a rollback still sends where it did.
- An address on your own network (a self-hosted ntfy or a webhook receiver on the LAN, written as `http://192.168.1.20/...`, `http://ntfy.home.lan/...` or `http://localhost:8080/...`) is delivered to only when its host is listed in `network.privateDeliveryHosts`, shown in `/settings` as "Machines on your network deliveries may reach" (for example `192.168.1.20, ntfy.home.lan` or `*.home.lan`). A listed host may be a private, loopback, link-local, unique-local or shared (CGNAT, Tailscale) address, and the request goes to the address that was checked; a cloud metadata address is never reached. A host that is not listed is refused when it is added (a private or loopback address written in the URL) or when the notification is sent (a name that resolves to one), and the refusal names the setting and the host to add, for example `Webhook URL host 192.168.1.20 is on your own network and is not approved. To deliver to a host on your own network, add "192.168.1.20" to the setting "Machines on your network deliveries may reach" (network.privateDeliveryHosts).` The same list admits a watcher's target and the default webhook target; it never admits an address someone else supplied, such as the callback URL a webhook sender bound.
- Slack and Discord carry notifications only when they have somewhere to post: an incoming-webhook URL (`SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`) or a bot token with `surfaces.slack.defaultChannel` / `surfaces.discord.defaultChannelId`.
- A notification that fails is retried, then kept in a failed list. The daemon keeps its own list on disk (operator methods `notifications.deadLetters.list` and `notifications.deadLetters.replay`). A resent entry keeps its id and stays in the list (and on disk) until its resend is delivered, retries included; a resend that fails for good replaces it in place, and a second resend of an entry still being resent starts nothing. A notification still waiting to retry when the program stops is kept in the failed list (`The program stopped while this notification waited to retry; it was not sent. Resend it from the failed list.`), so it can be resent after the restart. A list that cannot be written is reported as a failure, and a terminal takes over another terminal's list file only after its own file was written.
- Every attempt at one notification, retries and resends included, carries the same identity: a Discord bot post sends it as the message nonce (Discord drops the repeat) and a `notifications.webhookUrls` webhook receives it as the `Idempotency-Key` header.
- A notification is sent only to the destination it was queued for: a retry waiting while the Slack or Discord webhook or default channel changed ends in the failed list with the reason instead of going to the new place. Sending it again (and `notifications.deadLetters.replay`) refuses one whose channel now posts somewhere else, naming the old and new destination (`destination-changed`), and leaves it in the list; "send it where the channel posts now" (`toCurrent: true`) sends it there.
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
   goodvibes secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD --user
   ```

   The terminal app files this daemon-owned credential in the daemon's store.
3. Check the connection: open the menu (`Ctrl+G` then `m`) and choose Mail, calendar and channels. Its Inbox lists the newest messages by itself, or says why it could not read them (the mailbox is not set up, the password is missing, the server refused it).

### Mail (both apps, and the web UI)

Mail is the daemon's: one mailbox, the same for the terminal app, the Agent, the web UI and every scheduled run. There is no slash command for it. A person reads and sends it in **Mail, calendar and channels** (the menu's row of that name), on its **Inbox** tab:

| On the Inbox | What it does | Capability |
| --- | --- | --- |
| `Enter` on a message | Opens it: sender (as the message claims it), subject, date, files and text. Nothing is marked read. | `mail.read` |
| `n` | New message: To, Subject, Message; sent at once when the form is submitted (a sent message cannot be recalled). | `mail.send` |
| `d` | Save a draft in the account's Drafts folder; nothing is sent. | `mail.draft` |
| `m` | The mailbox settings; the password only as stored or not. | `mail.settings` |
| `e` | Change one mailbox setting (the table below). | `mail.set` |
| `p` | Store the mailbox password (typed on a hidden line). | `mail.password` |

The keys are the place's defaults; each can be rebound in the Keys place. The model and outside agents reach the same capabilities with `capability_find` / `capability_run` (and `capabilities.find` / `capabilities.run` over HTTP and `goodvibes-daemon mcp serve`), and scripts with `goodvibes do <id> --input name=value` (also `goodvibes-agent do` and `goodvibes-daemon do`); `mail.status` and `mail.list` complete the set:

```text
goodvibes do mail.status
goodvibes do mail.list --input count=30
goodvibes do mail.read --input message=4211
goodvibes do mail.draft --input to=you@example.com --input subject="Status update" --input body="The build is green."
goodvibes do mail.send --input to=you@example.com --input subject="Status update" --input body="The build is green."
```

- A send a person submits is the request and goes at once; a model's send is put to the owner first, because it sends something outside this machine.
- Each message is sent under one send id made from its recipients, subject and text, so the same message sent again within ten minutes is answered with the first send instead of being mailed twice. "Send it again" (`again=yes`) sends a new copy. A send whose outcome is unknown says `The send was not confirmed; it may have gone`; look in the Sent folder first.
- The daemon reads every message read-only (IMAP EXAMINE) and records it as untrusted content.
- On upgrade nothing is carried: the mailbox settings (`surfaces.email.*`) were already the daemon's, and the Agent's own mail service, which read the same settings, is gone. A 3.5.0 program run again after a rollback reads the same settings.

Status failures and fixes:

| Daemon code | Meaning | Fix |
| --- | --- | --- |
| `EMAIL_NOT_CONFIGURED` | Host or user missing. | Steps 1 and 2 above. |
| `EMAIL_CREDENTIALS_MISSING` | Password secret missing. | "Store a secret" `GOODVIBES_SURFACES_EMAIL_PASSWORD` (Permissions and safety, Secrets) |
| `EMAIL_CREDENTIALS_UNREADABLE` (HTTP 412) | The secret store on the daemon's computer could not be read, so the mailbox password, which may well be stored, could not be read; the answer gives the cause. The Inbox says it could not read your inbox because the secret store could not be read, and the web mail view "The secret store could not be read"; neither asks for the password. | Make the store readable on that computer (its key file, `~/.goodvibes/secrets.key`, must be the one the store was written with); nothing needs to be given again. |
| `EMAIL_NOT_ENABLED` | The mailbox is not set up: an IMAP host, SMTP host or account is missing. | Steps 1 and 2 above. |
| `EMAIL_CREDENTIALS_REJECTED` (HTTP 424) | The IMAP or SMTP server refused the stored password (an app password revoked or changed). Not a sign-in failure: the daemon answers 424, never 401. | Store a current password with "Store a secret" `GOODVIBES_SURFACES_EMAIL_PASSWORD` (Permissions and safety, Secrets). |
| unreachable | The daemon cannot be reached. | Check the daemon on the Health tab of the System place and with `goodvibes status`. |

### Mailbox settings: `mail.settings`, `mail.set`, `mail.password`

The Inbox's `m`, `e` and `p` (above), in both programs; the daemon writes its own settings and its own secret store.

- `mail.settings` (and `mail.status`, which adds whether new mail is watched) shows the IMAP and SMTP host, port and security, the mailbox read, the user, the from address, whether the password is stored, and what is still needed.
- `mail.set` changes one setting:

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

The settings that decide where and as whom the password is presented (the hosts, ports, TLS switches and user) loosen a protection when changed: the Inbox asks once before it changes one, a script's `goodvibes do` is the person's own request, and a model's change is put to the owner, opening on No. Storing the password writes a credential: a model's call is put to the owner the same way, and a password the model leaves out is typed by the person on the hidden line.

Worked example (Fastmail), as a script:

```text
goodvibes do mail.set --input setting=imap.host --input value=imap.fastmail.com
goodvibes do mail.set --input setting=smtp.host --input value=smtp.fastmail.com
goodvibes do mail.set --input setting=smtp.port --input value=465
goodvibes do mail.set --input setting=user --input value=you@fastmail.com
goodvibes do mail.set --input setting=from --input value=you@fastmail.com
goodvibes do mail.status
```

The password is stored from the Inbox's `p` (a hidden line). `mail.password` answers `The mailbox password is stored in the daemon's secret store; the settings hold only its reference.` A bad port answers `<value> is not a port: give a whole number from 1 to 65535.` Every mail capability runs in the daemon, so it fails, saying so, when no daemon answers.

### Inbound mail and notices

The daemon can watch mailboxes and tell the owner when mail arrives. Arrival is untrusted input: it never starts an agent or a session by itself, and a change asked for in an email is refused (email cannot direct changes).

```text
/settings set surfaces.email.inbound.enabled true
/settings set surfaces.email.inbound.accounts "[\"main\",\"signups\"]"
/settings set surfaces.email.inbound.mailboxes "{\"signups\":{\"host\":\"imap.example.com\",\"user\":\"signups@example.com\"}}"
goodvibes secrets set GOODVIBES_EMAIL_INBOUND_SIGNUPS_PASSWORD --user
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
- One verification expectation is open per address: `email.expectation.open` for an address that already has one replaces it, and `email.expectation.wait` on the earlier id answers at once with state `replaced` and `replacedBy`, the id to wait on instead. When the open cannot be saved, it fails and the earlier expectation stays open. The other states are `waiting`, `arrived`, `expired`, `capability-lost`, `cancelled` and `unknown` (no expectation with that id is open or remembered).
- `email.inbox.read` returns the headers even when a body section of the message cannot be fetched; it then carries `bodyUnavailable` (each section and why), the body fields are empty for those sections because they were not read, and `mail.read` (the Inbox's `Enter`) says the text could not be fetched instead of "(no plain-text body)". The web UI does not quote a body it did not fetch in a reply.
- A message UID names a message only within its mailbox generation: `email.inbox.list` and `email.inbox.read` return `uidValidity`, and `email.inbox.update` and `email.attachment.get` require it, so a mailbox the server reset refuses the change (or the download, with "The mailbox was reset since this message was listed, so nothing was downloaded. Refresh the list and try again.") instead of acting on whichever message now holds the number. In the same way `email.drafts.list` and `email.draft.create` return the Drafts folder's `uidValidity`, and `email.draft.update` replaces a saved draft (by `uid` and `uidValidity`) so the folder keeps one copy instead of two. A draft save the mail server refuses is reported as not saved, with the cause read from its response code (the mailbox is full, the Drafts folder does not exist, the draft is too large, or the mail server refused it); a save whose answer was lost may have been saved, and creating or replacing the same draft again in the same daemon run looks for it in the Drafts folder first instead of saving it twice. `email.draft.create` takes an `Idempotency-Key`: a create sent again under the same key (the web UI sends one per composer) returns the first draft instead of appending a second. `email.drafts.list` reads the newest drafts; `before` (a UID) reads the page older than it, so every draft in the folder can be listed (the web UI's "Load older drafts").
- A draft is saved with a `Message-ID` of its own. A change to the mailbox (a saved or replaced draft, a message marked, archived or moved) is reported done once the server confirmed it, even when signing out afterwards fails. A save whose answer the server never gave is reported as one that may have been saved; creating the same draft again in the same daemon run looks for it under that `Message-ID` first and returns it instead of saving a second copy.

## Calendar

### Terminal app: CalDAV over the daemon

Prerequisites: a CalDAV server URL, user and password (or an app password).

1. Configure:

   ```text
   /settings set surfaces.calendar.caldavUrl https://caldav.example.com/dav/
   /settings set surfaces.calendar.caldavUser you@example.com
   goodvibes secrets set GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD --user
   ```

   Optional: `surfaces.calendar.defaultCalendarId` and `surfaces.calendar.calendars`.
2. Check: "what it reads" (`s`) on the Calendar tab of Mail, calendar and channels (the menu, `Ctrl+G` then `m`).
3. First use: the Calendar tab lists the days ahead by itself (`w` the days ahead in words).

There is no `/calendar`: the calendar is the daemon's, the same in both programs, on the Calendar, Calendar accounts and Calendar feeds tabs of Mail, calendar and channels, and each action is a capability (`calendar.*`) a model or a script runs too. On the Calendar tab: Enter opens an event, `n` new event, `c` change one, `x` remove one, `w` the days ahead, `s` what it reads, `a` every event, `i` import a file, `e` export to a file. On Calendar accounts: Enter signs Google or Outlook in, `o` signs one out, `u` use your own app, `l` lists them in words. On Calendar feeds: `n` subscribe to a feed, `g` read one again now, `a` read every feed now, `x` stop subscribing, `l` lists them in words.

A blank left out keeps its value in a change. A change and a removal reach the guests and ask once; the daemon's calendar needs an end time for a new event, and an identical new event from the same session is refused unless "Add it again" is chosen. A time without a zone is read in this machine's zone. A daemon answer of `CALENDAR_NOT_CONFIGURED` means the URL or user is missing, and `CALENDAR_CREDENTIALS_MISSING` that no CalDAV password is stored. `CALENDAR_CREDENTIALS_UNREADABLE` (HTTP 412) means a password may well be stored but the secret store on the daemon's computer could not be read; the answer gives the cause, and no screen asks for the password again: make the store readable on that computer (its key file, `~/.goodvibes/secrets.key`, must be the one the store was written with) and the calendar reads again.

Google Calendar cannot be reached over CalDAV with a password: Google refuses Basic authentication on its CalDAV endpoint. Use the Google route below.

A subscribed feed is read whenever the calendar is read (the Calendar tab, "every event", and the same reads by the assistant) and the feed is older than its interval (conditional requests; a feed that cannot be read keeps its last events, its status says why). "Read every feed now" reads them all, whatever their age. There is no timer: a feed nobody reads is not fetched.

Connecting a calendar account over OAuth needs your own OAuth client id: no client id ships with the product. Steps:

1. Register a free OAuth app (Google Cloud Console for Google, the Azure portal for Microsoft) and copy its client id. A desktop or public-client app needs no secret.
2. Keep the client id with "use your own app" (`u`) on the account's row of Calendar accounts; its form asks for a client secret too, masked, when you give one. The id goes in `calendar.google.clientId` or `calendar.microsoft.clientId`; a client secret goes in the secret store and is referenced by `calendar.google.clientSecretRef` / `calendar.microsoft.clientSecretRef`.
3. Sign in: Enter on the account's row. A browser opens; approve. On a machine with no browser, choose the device route in its form: Outlook shows a device code to enter on another device; Google prints a link to open anywhere, and after approving you sign in again with the code route within ten minutes and give the 127.0.0.1 address the browser landed on (asked for masked).
4. The answer lists the account, the transport and the scopes. The Calendar tab then merges that account's events.

A Google account has one connection on a machine. Signing Google in on Calendar accounts, "connect" on the Google tab and the model's `google` tool all store the same one (the refresh token `GOODVIBES_GOOGLE_OAUTH_REFRESH_TOKEN`, and beside it `GOODVIBES_GOOGLE_OAUTH_ACCOUNT`: the account's label, the scopes granted at connect and a digest of the token, never the token), and the daemon's calendar (the web Calendar), its Gmail access and both terminal programs' calendar tabs all read it. Every Google sign-in asks for the same scopes: `gmail.readonly`, `gmail.send`, `calendar.readonly`, `calendar.events`. A connection made earlier with fewer (an Agent calendar connection from 3.4.4 or before has no Gmail scope; one from the Agent's Google connection before 3.4.5 has no `calendar.readonly`, which listing calendars needs) works for what it was granted and names the missing scope when a feature needs it; connecting once more grants them all. A Microsoft account signed in on Calendar accounts is one connection too (`GOODVIBES_CALENDAR_MICROSOFT_TOKENS`, with the client id in `calendar.microsoft.clientId`): the daemon's calendar (both terminal programs and the web Calendar) reads it. The daemon serves it beside the CalDAV server or the Google connection: a read of the default calendars returns the events of both, Outlook's events and calendars carry ids that start with `outlook:` (its calendars are listed as "<name> (Outlook)"), and a read, change or removal of an `outlook:` event goes to Outlook. With Outlook the only account, it is the daemon's calendar and a new event goes there. An `.ics` import into an Outlook calendar is refused (`CALENDAR_NOT_SUPPORTED`): import it in Outlook. With no usable account at all, the answer (`CALENDAR_NOT_CONFIGURED`) names the accounts that exist and why none can be read; when the reason is a secret store this computer cannot read, the answer is `CALENDAR_CREDENTIALS_UNREADABLE` ("No calendar this daemon can read: …" with the cause), and the Calendar accounts tab says the store could not be read instead of "not connected".

Up to 3.4.4, the Agent's calendar kept a second Google connection (`GOODVIBES_CALENDAR_GOOGLE_TOKENS`) that the daemon never read. The daemon's first start of 3.4.5 moves it into the one connection, once, and says "Carried forward from the earlier version: 1 Google connection." When a different Google connection was already there, that one stays (the daemon's mail and calendar were using it), the earlier one is kept unused, and the notice names both accounts and how to choose the other: disconnect Google on the Google tab, then "connect" there and sign in as it. Going back to 3.4.4 after the move: the daemon, the web Calendar and mail keep the connection, and the 3.4.4 Agent lists no Google account until Google is connected there again.

Signing out revokes the access at the provider when it offers revocation, and clears local tokens. Signing Google out ends the one Google connection, so the daemon's calendar and its Gmail access stop too.

Daemon operator methods for calendars: `calendar.calendars.list`, `calendar.events.list`, `calendar.events.get`, `calendar.events.create`, `calendar.events.update`, `calendar.events.delete`, `calendar.ics.import`, `calendar.ics.export`.

On a CalDAV calendar each occurrence of a recurring event has its own id (the resource href, `#`, and the instant it recurs at), and `calendar.events.get` with that id answers that occurrence. A create whose request got no answer fails with `CALENDAR_OUTCOME_UNKNOWN` and names the new event's UID: read it with `calendar.events.get` before creating it again. On Google Calendar the same answer names the event id to read; a create that carries a `uid` is made under an event id derived from it (the UID's SHA-256 in hex), so sending it again after a lost answer returns the event already made instead of adding a second one, and the result's `uid` is the one sent. Google keeps a deleted event's id taken, so a create under the UID of an event that was deleted puts that event back on the calendar with the fields sent; when Google refuses the id but returns no event under it, the create fails with `409` `CALENDAR_REQUEST_FAILED` and nothing is made. `calendar.events.get` on Google answers a deleted event by its id with `cancelled: true`: it is not on the calendar. `calendar.events.get` returns the event's `revision` (Google's etag, the CalDAV ETag); send it as `expectedRevision` on `calendar.events.update`, and an event changed elsewhere after it was shown is refused with `409` `CALENDAR_EVENT_CHANGED` and nothing is written. The web UI's edit form does this: saving over a newer version says so and shows the event as it is now. A feed event without a UID gets an id made from its feed, start and title, so it keeps the same id on every read.

## Google (Gmail and Google Calendar)

One Google account serves both mail and calendar, and its connection is the daemon's: every Google setting is the daemon's and every Google credential is in the daemon's secret store. Connecting, checking, asking for consent again, adopting and disconnecting run in the daemon, so they work the same from the terminal app, the Agent, the web UI, a script (`goodvibes do google.connect`) or a model's call (`capability_run`, put to you first because it stores a credential). Saying "connect my Google account" in a conversation runs the same.

The controls are on the **Google** tab of **Mail, calendar and channels** (`Ctrl+G` then `m`). The tab shows the connection (connected, needs your consent, mail by app password, not connected, or "could not be read" when the secret store cannot be read: never "not connected" then) and, under it, the steps of the connection under way or the last one, each as it starts and ends, read again on the daemon's `google` notice with no key pressed. Keys on the connection (each rebindable in the Keys place):

| Key | Control | Capability |
| --- | --- | --- |
| `c` | connect: works out the shortest route and connects; installs what it needs as it goes (the Google Cloud SDK, about 500 MB, into your home folder: pressing it is the request, nothing is asked first); its consent link opens in a pane of its own, with the copy key | `google.connect` |
| `c` while the link waits | show the consent link again | `google.connect` |
| `s` while one runs | stop connecting: the step under way ends (a waiting consent link stops working), nothing more is set up, and it says what was set up and kept and what was not | `google.stop` |
| `k` | check it: reads the mailbox and the calendar once and says, for what failed, what to do; a part refused for a missing scope is named at once, and "ask for consent again" is what renews it (nothing waits on a consent) | `google.status` |
| `a` | ask for consent again: a fresh consent for mail and calendar together; the current connection stays in use until Google returns a new token | `google.reauthorize` |
| `x` | disconnect: removes the stored refresh token, OAuth client secret, app password and private calendar address (asks first: it cannot be undone) | `google.forget` |
| `o` | connect by one route: app password, a new OAuth client, or an OAuth client you have | `google.setup` |
| `i` | use your client id and secret (the secret typed hidden) | `google.client` |
| `f` | use your client file (a client JSON on the daemon's machine) | `google.client-file` |
| `u` | take up credentials on this machine (`~/.gmail-mcp` on the daemon's machine; the files are read and left as they are) | `google.adopt` |
| `m` | the Gmail address mail is signed in and sent as | `google.account` |
| `l` | calendar by private address (read once, then kept in the secret store; typed hidden) | `google.calendar-address` |
| `w` | the written steps for connecting by hand | `google.runbook` |

One connection runs at a time: a second press while one is under way says so and starts nothing, and "stop connecting" ends it. The line under the list says what the press answered until the connection moves on (approved, stopped, or changed elsewhere); the list then says where it stands. A connection started from a program nobody is sitting at (a model's call, a script of yours with no screen) puts its consent link in Waiting for you instead. A send the content check refused waits in **Waiting for you**, under Sends, where it is sent exactly as shown or dropped (`google.approve`, `google.drop`; `google.waiting` lists them).

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

1. "connect by one route", An app password (or "connect"). A browser window opens on the daemon's machine at `https://myaccount.google.com/apppasswords`. Google blocks automated browsers at sign-in, so sign in once by hand in that window; the profile is kept for later runs. Someone who signed in this way through the 3.5.0 Agent does not sign in again: the Agent's browser profile for Google is carried into the daemon's the first time the daemon opens one (the Agent's own copy is left as it was), unless the Agent's browser has it open at that moment, which the run says.
2. If 2-Step Verification is off, turn it on at `https://myaccount.google.com/signinoptions/twosv`.
3. The flow creates an app password named `goodvibes-agent` (by hand: type that name, click Create, copy the 16-character password, paste it when asked). It is stored as the secret `GOODVIBES_SURFACES_EMAIL_PASSWORD`.
4. The flow writes the Gmail endpoints: IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:587` with STARTTLS. Give the address with "the Gmail address" on the Google tab when asked.
5. The flow opens a real IMAP and SMTP session to prove the password; nothing is sent.
6. For calendar, the flow captures the "Secret address in iCal format" from Google Calendar settings (Settings for my calendars, Integrate calendar). By hand: "calendar by private address" on the Google tab. It is read once, then stored as the secret `GOODVIBES_CALENDAR_GOOGLE_ICS_URL`. Treat that URL as a password.
7. The flow reads calendar events to prove it works.

### Path B: OAuth

Prerequisites: a Google Cloud account. The `gcloud` CLI is installed by the daemon when it is not on its machine (pressing "connect" is the request: nothing is asked first): the Google Cloud SDK archive (about 500 MB) is downloaded into your home folder, unpacked and its installer run, and each step is said on the Google tab as it happens: `Installing Google Cloud SDK, 511 MB, into ~/google-cloud-sdk: downloading`, `...: 25% downloaded` at each quarter, `...: unpacking`, `...: running its installer`. What the flow found is said first, before its steps.

1. `gcloud auth login` (you choose the account and click Allow).
2. The flow selects or creates a Cloud project and enables `gmail.googleapis.com` and `calendar-json.googleapis.com`.
3. Fill in the OAuth consent screen at `https://console.cloud.google.com/auth/branding`: app name `goodvibes agent`, your support email, Audience External, your contact email, agree, Create.
4. At `https://console.cloud.google.com/auth/audience`, set Publishing status to **In production** (PUBLISH APP, Confirm). An app left in Testing gets refresh tokens that expire after seven days, and the integration then stops silently.
5. At `https://console.cloud.google.com/auth/clients`, Create client, type Desktop app, name `goodvibes agent`, Create. Copy the client id and secret (the secret is shown in full only once) and hand them over with "use your client id and secret" on the Google tab.
6. Open the consent link the Google tab shows in its own pane (the copy key copies it). Check the account shown at the top. Expect "Google hasn't verified this app": click Advanced, then "Go to goodvibes agent (unsafe)". Leave every permission ticked; Continue. The browser lands on a local page confirming the connection.
7. The flow reads your mailbox and calendar with the new credential and reports the account, both answers and the publishing status.

Scopes requested: `gmail.readonly`, `gmail.send`, `calendar.readonly`, `calendar.events`. Stored: the client secret as `GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF` (none is needed for a Desktop-app client signed in with PKCE), the refresh token as `GOODVIBES_GOOGLE_OAUTH_REFRESH_TOKEN`, the same one connection signing Google in on Calendar accounts stores; settings `calendar.google.clientId`, `calendar.google.clientSecretRef`, `google.oauth.projectId`, `google.oauth.publishingStatus`. No secret is written to settings files, logs, transcripts or status output.

### Google failures

| Symptom | Fix |
| --- | --- |
| "This browser or app may not be secure" | Sign in by hand in the window that opened, then re-run. |
| `IMAP: The mail server rejected the credentials for <address>.` or `SMTP: SMTP AUTH PLAIN failed: 535 …` | The app password is wrong or revoked. The failure shows the steps: delete the `goodvibes-agent` entry at the app passwords page, create a new one there, store it with "Store the mailbox password" in Mail, calendar and channels, and press "connect" on the Google tab again. |
| `IMAP: The mail server did not answer.` or another failure naming a server it could not reach | The failure names the server (`imap.gmail.com:993` or `smtp.gmail.com:587`): this machine's network or that address is the cause, and the app password was not checked. Press "connect" again once the network is up. |
| Worked, then broke about a week later | The OAuth app is in Testing. Publish it, then "ask for consent again" on the Google tab. |
| Google is not connected, a scope is missing, or the credential is dead | A request the daemon makes (its calendar and mail, a conversation it hosts) starts a consent asking for every scope at once, puts its link in Waiting for you, and is sent again when the consent completes; one consent at a time, other requests join the open one. A check ("check it") and a request made in a terminal program's own conversation open none: they say which part needs consent again, and "ask for consent again" on the Google tab is what renews it. |
| An API is not enabled on the Cloud project | Enabling it is put to your mode (asked under Ask me, decided by Jev under Jev decides as `google.enable-apis`), run with the gcloud signed in on this machine, then the request is sent again. Without gcloud the answer says so and names the command. |
| A send was refused | It waits in Waiting for you, under Sends, exactly as it would go out; the owner's answer there sends it as shown or drops it. |

Re-running any step is safe: each step checks what already exists and skips it.

The model's `google` tool reads and sends mail and reads and writes calendar events through the connected account; sends to new recipients are the owner's to allow.

## Chat channels

A channel is a chat surface the daemon sits behind: Slack, Discord, Telegram, ntfy, the generic webhook, Home Assistant, Google Chat, Signal, WhatsApp, telephony (SMS and voice), iMessage, Microsoft Teams, BlueBubbles, Mattermost and Matrix. A channel can carry conversations with the assistant, approvals for the owner, and notifications and deliveries.

### General setup procedure

1. Get the credentials from the provider (each surface below says which).
2. In the terminal app, open Devices and network (`Ctrl+G` then `m`) and press Pair something, A chat channel, then choose the surface. It lists the surface's declared fields, asks for every missing required value (and offers the optional ones), stores secret values in the daemon's secret store with a reference in the setting, and switches the surface on once every required field is set. A surface whose schema marks no field required (Slack, ntfy, the generic webhook, Google Chat) is switched on even when you skip every value, so enter its tokens before you finish, or set them with `/settings set` as below.
   - Alternatively set each key with `/settings set surfaces.<surface>.<field> <value>` and switch it on with `/settings set surfaces.<surface>.enabled true` or `goodvibes surfaces enable <surface>`.
   - In either program, the Channels tab of Mail, calendar and channels shows what a channel needs (Enter), checks it (`k`) and says what to set up next (`h`).
3. Prove it end to end: "send a test" (`t` on the channel's row of the Channels tab) sends a real test message through the daemon and reports the delivered or error outcome.
4. Send a first message from your own account. On a surface whose allowlists are empty it is not answered: it raises an owner claim (see "Who may talk to the assistant"). Accept it in Waiting for you (the menu, Ctrl+G then m): select the claim and press its accept key (or in the web UI inbox). You are then the surface's owner; send your message again and it is answered.
5. Check: `goodvibes surfaces check <surface>`, the Channels tab (each channel's state), and "who may write" (`w`) on its row.

A surface switched on, or given a credential, while the daemon runs is picked up without a restart. A surface switched off answers inbound requests with HTTP 503 `SURFACE_DISABLED`.

An answer to a channel message is recorded as owed (on the session's input) before it is sent and marked sent once it was handed to the channel. A daemon that stops while an answer is being sent sends it again when it starts: on the generic webhook (whose request carries the answer's identity as `Idempotency-Key`) and on Discord (the bot's post carries it as a nonce) the receiver drops the repeat; on every other surface the answer ends with the line `(Sent again after a restart; you may see it twice.)`. Each part of a long answer keeps one identity for every attempt at it.

A send that fails after its request left (a timeout, a reset connection, a 5xx or 429 answer) is sent again only on a surface that drops a repeat: the generic webhook, a Discord bot post or interaction edit, and Matrix. Anywhere else it is not repeated and is reported undelivered with `The message to <surface> may have arrived: the send failed after the request left, and <surface> cannot drop a repeat, so it was not sent again. Look in the conversation before sending it again.` A refusal the surface answered (Slack's `ok: false`, a Slack 429) is retried as before.

A surface's inbound webhook with no credential to check callers against answers HTTP 503 `Webhook not configured: set <setting>`, naming the setting (or environment variable) to set. "Check it" (`k` on the channel's row of the Channels tab) reports the same as the `inbound-credential` warning `Inbound messages are refused until <setting> is set.` for Slack, Discord, WhatsApp, Google Chat, Signal, iMessage, BlueBubbles, Mattermost and Matrix; it is a warning because Slack Socket Mode and a surface used only to send need none.

A channel credential is read in one order everywhere (status, the doctor, sending, the inbound webhooks, Telegram polling and the Slack and Discord notifications): the services file, then the setting, then the environment variable. A setting that holds a `goodvibes://secrets/...` or password-manager reference that does not resolve is reported as unresolved and is never replaced by the environment variable.

Logging out of a Slack, Discord or ntfy account (`logout` with `confirm: true`) removes every credential GoodVibes stored for it: the tokens, the signing secret or public key, the stored webhook URL and, for ntfy, the stored topic names. Environment variables still take precedence.

A Slack or Discord slash command is acknowledged only once its message is saved (a save takes milliseconds). When the save takes longer than 2.5 seconds, the acknowledgement says `Received, still saving: ...` and asks to send it again if no answer comes; sending it again is safe, because the command's id (Slack `trigger_id`, Discord interaction id) makes the second a no-op once the first is saved.

### Inbound addresses

Surfaces that receive provider webhooks are served by the daemon's control-plane server on the path `/webhook/<surface>`:

<!-- generated: webhook-paths -->

GitHub automation webhooks arrive at `POST /webhook/github`. When the daemon posts the agent's answer itself, the owed answer is recorded in the daemon's operation log (`control-plane/operations.jsonl` in the daemon's control-plane directory) before GitHub is answered, and the posted comment ends with a hidden marker `<!-- goodvibes:op=<id> -->`. After a restart an answer that was recorded and not confirmed posted is posted once (the issue's comments are read first for its marker). When the agent gives no answer (it failed or was cancelled, finished with no text, or stopped with the daemon), a notice is posted in its place the same way: "The agent ended <status> without an answer; mention me again to retry." ("The agent finished without an answer; ..." when it completed with no text, "The agent stopped when the daemon restarted, without an answer; ..." when it stopped with the daemon). Without a GitHub token nothing can be posted, and that is logged.

The control plane listens on `127.0.0.1:3421` by default. A provider on the internet can reach these paths only when the daemon is published at a public HTTPS address (remote access, a tunnel or a reverse proxy, described under "Network exposure" and "Remote access" in "The daemon, the web UI and networking"), and `web.publicBaseUrl` is set to that address where a surface registers its own webhook (Telegram webhook mode). Four surfaces can work with no public address: Slack with an app token (Socket Mode), Discord (gateway connection; interactions and slash commands still arrive at `/webhook/discord`), Telegram in `polling` mode, and ntfy (the daemon subscribes to its topics).

### Who may talk to the assistant

Each surface has an ingress policy.

- Every list that is set must admit a message; an empty list restricts nobody. A group, channel or thread is admitted when it is on the group list (if set), on the channel list (if set), and its sender is on the user list (if set).
- A surface with every list empty has no owner yet. The first message from an unknown sender is not answered: it raises an owner claim in the owner inbox, titled `Make <sender-id> (<name>) the owner of <surface>?`, with the choices `accept` and `decline`. Accepting puts that sender on the user list and makes that sender the surface's owner; from then on the surface answers only them. Declining is remembered and that sender is not asked about again. At most three claims per surface are open at once.
- Once a surface has an owner, a message from a sender not on the user list is not answered either: it raises `Let <sender-id> (<name>) reach you on <surface>?`. Accepting adds that sender to the user list (that sender is not made owner); declining is remembered.
- A chat set up for delegated review (`inbound.telegram.configure`) is outside these lists: every message in it goes to the delegated review whoever sent it, the owner is still recognised as the owner there, and nothing a sender does in it raises an owner or allowlist claim or makes anyone the owner. The chat stays delegated across restarts until the owner releases it (`inbound.telegram.release`). The owner's grant ends with the daemon process, so after a restart a new message there waits in memory, unread, for the retention the owner chose, and the owner inbox reports it waiting; confirming the chat again (`inbound.telegram.configure`) puts each waiting message to the owner for review.
- The `<sender-id>` in a claim is the provider's user id (on Telegram the numeric user id, on Slack the `U...` id). Use it with `--allow-users`. A Telegram message posted as a chat (a channel post, a message sent as a channel, an anonymous group admin) comes from that chat: its sender id is the chat's numeric id (negative) and its name the chat's username or title, so a post in a channel the bot was added to is a sender like any other and is never taken for the owner.
- An admitted message gets a conversational reply. A message from the owner that reads as a request for work is proposed back ("reply yes or go ahead to start it") and starts only when the owner answers yes in the same conversation (`conversationGate.mode` `propose`, the default, on every surface in `conversationGate.gatedSurfaces`). `confirm-all` confirms every message; `off` starts work at once. Reading a message as work needs a decision model; only a confident "work" reading is proposed, and an unsure one gets a conversational reply. With no decision model in use, no proposal is ever made: every admitted message is answered at once by a conversational agent turn.
- Work a guest (any admitted sender who is not the owner) asks for is proposed to the owner, never to the guest: the proposal (`<guest-id> on <surface> (not you) asks for work: <summary>`) goes to the owner's own direct conversation on that surface (or, when the owner has none there, their most recently used direct conversation on another surface) and is answered only there, by the owner. The guest is told `I asked the owner to agree to this: <summary>. You will hear here whether it starts.` and hears the outcome; a guest's own "yes" is ordinary chat. When none of the owner's conversations takes the proposal, the guest is told `Not started: the owner could not be asked about this: <summary>`.
- The owner and other admitted senders. This is the whole rule:

  | | The surface's owner | Any other admitted sender |
  | --- | --- | --- |
  | Talk to the assistant and get replies | Yes | Yes |
  | Start a turn that reads and answers | Yes | Yes (with no decision model in use, every message starts one) |
  | Agree to work | Yes (`yes` to their own work proposal, and to a guest's, in their own conversation) | No. Their work request is put to the owner; their own `yes` is ordinary chat. |
  | Change anything (write, edit, run a command, send, fetch, read app state or files outside the allowed directories) | Decided by the gate as on the surface (see below) | Never on their own word: every such call is put to the owner as an approval (`channel-request`), in every permission mode (`yolo` included) and with or without a decision model; in `just-vibes` it is held for the owner. A plain read of files inside the allowed directories runs. |
  | Answer a permission ask | Yes (see "Answering an approval from a channel") | No. A guest's text reply is ordinary chat. On Slack and Discord, an approval button pressed by a guest is refused with HTTP 403 `APPROVAL_ANSWER_REFUSED`; the ask stays pending. |
  | Approve or veto a purchase, type a card code | Yes | No |
  | `status`, `cancel`, `retry` on a run, agent or session | Yes, for work started from the same conversation | No: `Not done: <action> <id> was refused. Status, cancel and retry act on any run or agent, so only the owner of this channel may send them. Ask the owner, or have them change the channel's owner.` |

  Where the asks of a guest's turn go: never to the guest's chat. An approval is shown on a channel only in a conversation proven to be the owner's alone (their direct conversation with the bot, their ntfy topic); never in a group, even one only the owner has written in so far, a shared channel, a webhook route or a Home Assistant conversation. An approval about any of those, or raised in a guest's turn, goes to the owner's own direct conversation on that surface (newest first), or when none takes it, to their direct conversations on other surfaces; it is also listed in the owner inbox (Waiting for you in either terminal app and the web UI). The owner answers it by replying in any of their own direct conversations, or in the inbox. When none of the owner's conversations takes the prompt, the owner is alerted ("Waiting for your answer: <the ask in words> It is about a conversation on <channel> that is not yours alone, so it is not shown there, and none of your own conversations took it. Answer it in Waiting for you") and the alert is kept as a receipt for the next terminal or web UI the owner uses: an owner alert kept this way is shown to and cleared by you from any of your credentials (the operator token, a paired device, a sign-in under any name) whose scopes hold the right to read it, and by no guest.

  Work the owner asks for in a conversation that is not theirs alone (a group, a shared channel) is proposed the same way: the proposal is never posted there; it goes to their own conversations (`Start work on: <what>` and `You asked for it in a conversation on <channel> that is not yours alone, so it is answered here.`), answered from the one that took it. When none takes it, it waits in Waiting for you, Questions, as `Start this work? <what>` with `accept` (starts the work) and `dismiss` (leaves it undone), until the owner answers it, a newer request from that conversation replaces it, or it expires after `conversationGate.proposalTtlMs` (30 minutes by default, as every work proposal does; past `conversationGate.maxPendingProposals` waiting, the oldest is dropped).

  Authority belongs to the person, not the surface. The owner's own messages keep the surface's authority: on Telegram (a command-authority surface) the owner's turn runs as if typed in the terminal app, in their permission mode; on every other chat surface a change their turn asks for becomes an approval for them each time (`channel-request`); on email, webhook and ntfy it is refused. A guest's turn runs under the guest form of the surface (`guest:<surface>`), which carries no authority on any surface, Telegram included. A guest's message is also never handed to an agent already running in that conversation; it starts a guest's turn of its own. A surface with no owner (`open`, below) has only guests.

The rules are on the channel's row of the Channels tab of Mail, calendar and channels: "who may write" (`w`) shows them, "change who may write" (`e`) opens their form. A change replaces the rules at once (changing them again puts them back); it decides who may reach the assistant, so it is yours alone: the same is `channels.set-rules` from a script of yours or any of your credentials (it runs at once), and a model's call of it is decided under your mode. Its fields: enabled, require a mention, allow direct messages, allow groups, allow threads, commands without a mention and open take on or off; the direct-message and group policies take allow, deny or inherit; the users, channels, group ids and allowed commands take a comma list or `none`. A list replaces the whole stored list on every surface, so to remove one admitted sender set the list again without that sender; include yourself, or you lock yourself out. Open on makes a shared channel: while every list is empty, every sender is admitted and no owner claim is raised (off by default); everyone on it talks as a guest. The operator method `channels.policies.update` takes the same field as `open`, and `channels.policies.list` reports it.

A message names a command only when its first word is written as one (`/status`, `!status`, `/status@yourbot`); `allowedCommands` limits those.

#### Answering an approval from a channel

An approval prompt for a turn the owner started in their own direct conversation is shown there, and the owner answers it by replying in the same conversation (same chat and thread); a reply anywhere else does not count. An approval a guest's turn raised, or one about a group or shared channel, is shown in the owner's own direct conversation instead, and the owner answers it by replying in any of their own direct conversations. The prompt is the ask in the words Waiting for you shows (what waits, from whom, what it would do), never the call's arguments or an internal id, and it ends with where it is answered. With a decision model in use, any wording is read (approve, deny, or approve with changes, which declines the original call and passes the change back); a reply the model reads as unclear leaves the ask waiting and the message goes on as conversation. With several asks waiting in one conversation, the reply must make clear which one it answers. With no decision model in use, only the exact `/approve <id>` or `/deny <id>` is recognised (the id from the prompt), with nothing else on the line. Every channel's prompt says which reply answers it: `Reply /approve <id> or /deny <id>, or answer it in Waiting for you.` with the real id when no decision model is in use, otherwise `Reply yes or no, or say what to change; or answer it in Waiting for you.` An ask only the owner's own decision can approve (a held Telegram message, let in from the Telegram list) says only `Answer it in Waiting for you.`, since no reply decides it. Slack and Discord prompts also carry Approve and Deny buttons where a press decides it; only the owner's press counts. A guest's reply never answers an ask.

#### Run control

Every chat surface lets the owner ask about, cancel or retry a run, agent or session the daemon knows, by its id, for work started from the same conversation (anything else is refused: `This conversation did not start <id>, so it cannot act on it. Send the command from the conversation that did.`). With a decision model in use, any message that names a known id and asks for one of the three is read as the command (`cancel run-123`, "stop run-123"). With no decision model in use, only the exact form is recognised: `/status <id>`, `/cancel <id>` or `/retry <id>`, with the leading slash and nothing else on the line; any other wording is an ordinary message.

Only the channel's owner controls runs: a guest (anyone else the channel admits) who sends one of these, or presses a run's Cancel or Retry button on Slack or Discord, is refused (`Not done: cancel <id> was refused. Status, cancel and retry act on the owner's runs and agents, so only the owner of this channel may send them.`). The typed command and the button are the same control: a button cancels a run or an agent, as `/cancel` does.

### The Channels tab (both programs)

There is no `/channels`. The Channels tab of Mail, calendar and channels lists each channel with its state, read by itself; on a channel's row: Enter what it needs (no value shown), `s` set it up (a channel not set up or off), `t` send a test (a real test message through the daemon, sent at once; it cannot be called back), `k` check it (the daemon's checks and the repairs it offers), `f` how it is configured, `w` who may write, `e` change who may write, `p` what its sessions get, `g` give it a model or mode, `u` use the defaults; on the tab: `a` the channel accounts, `o` every channel's profile, `y` which are set up, `h` what to set up next, `i` what came in, `n` send a message, `d` what was sent, `v` how sends went, `b` the routes (where replies go), `O` what the channels carry, `c` Telegram's reading position. Each is a capability (`channels.*`) a model or a script runs too. Pairing a channel is Pair something, A chat channel, in Devices and network.

A profile change that loosens the permission mode a channel's sessions run under ("give it a model or mode" with a looser mode, one that leaves out a tighter mode the binding had, or "use the defaults" on a binding that held one) is your own act, like `config.set` of `permissions.mode`: made from any of your credentials, `channels.profiles.set` and `channels.profiles.delete` apply it at once and ask nothing; a credential whose stored scope list lacks the right is refused (`403` `OWNER_ONLY` or `MISSING_SCOPE`), and a model's change is decided under your mode.

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
8. In the terminal app (set both tokens before switching the surface on; pairing Slack in Devices and network would switch it on with nothing entered):

   ```text
   /settings set surfaces.slack.botToken <your-bot-token>
   /settings set surfaces.slack.appToken <your-app-token>
   /settings set surfaces.slack.enabled true
   goodvibes surfaces check slack
   ```

9. In Slack, open a direct message with the bot and send anything. It is not answered; an owner claim appears. In the terminal app: open Waiting for you from the menu, select the claim and press its accept key.
10. Send the message again: it is answered. A request for work is proposed back; reply `yes` to start it.
11. To use it in a channel: `/invite @<bot name>` in that channel, and turn on mentions so the bot answers only when addressed: "change who may write" (`e` on Slack's row of the Channels tab), require a mention on. With mentions off (the default), every message in a channel the bot is in is handled.
12. To allow a second person, accept their claim, or set the users in "change who may write" to `<your-U-id>,<their-U-id>` (listing replaces the list, so include yourself).

Slack delivers every message as a channel or thread conversation, direct messages included, so `--allow-dms` and `--dm-policy` do not separate Slack direct messages from channels; use the user list. A Slack start is reported running only once its socket opens; a socket that does not open within 30 seconds is a failed start. Without Socket Mode, set the request URLs and `surfaces.slack.signingSecret` as above. A change the assistant is asked for from Slack is approved by the owner each time (`channel-request`), even in `yolo`.

### Discord

| Setting | Required | Notes |
| --- | --- | --- |
| `surfaces.discord.botToken` | yes | Secret. Env `DISCORD_BOT_TOKEN`. |
| `surfaces.discord.publicKey` | for interactions | Secret. Env `DISCORD_PUBLIC_KEY`. Verifies interaction signatures at `/webhook/discord`; without it every interaction, Discord's PING included, is answered 503 `Webhook not configured: set surfaces.discord.publicKey`. |
| `surfaces.discord.applicationId`, `surfaces.discord.guildId` | for slash commands | |
| `surfaces.discord.defaultChannelId` | for notifications | |
| `DISCORD_WEBHOOK_URL` (env) | optional | Notifications into one channel without a bot token. |

Steps: create a Discord application and bot, install it into your server, pair it in Devices and network (Pair something, A chat channel, discord), optionally register slash commands through the surface's provider actions, verify, then mention the bot. A reply after Discord's fifteen-minute interaction window is posted to the command's channel.

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
5. In the terminal app: open Waiting for you from the menu, select the claim and press its accept key. You are the owner, and only you are on the user list: the bot answers nobody else until you admit them.
6. Send `/start` again: the bot replies with how to use it. Then send a request. A conversation gets a reply; a request for work is proposed back, and `yes` (or `go ahead`) starts it.
7. Optional, for deliveries (routines, notices) with no conversation to answer: `/settings set surfaces.telegram.defaultChatId <chat-id>`. A private chat's id is your numeric user id from the claim. A test (the Channels tab of Mail, calendar and channels, `t` on Telegram) sends its message to this chat; without it the test reports `delivered:false`.

The bot's own commands (answered by the adapter, never sent to an agent): `/start` and `/help` reply with usage; `/stop` explains that it does not cancel work (its reply says to send `cancel <id>`; with no decision model in use send `/cancel <id>`) and that the surface is switched off with `surfaces.telegram.enabled false`. In a group, the bot acts only on `/goodvibes <message>` or `@<your_bot> <message>` and ignores other text; the group's other members are answered only if they are admitted (each raises a "reach you" claim). While work runs, the owner can send `status <id>`, `cancel <id>`, `retry <id>` (`/status <id>` and so on without a decision model; see "Run control"). A message with only a photo, voice note or file is answered "I cannot read <kind>s yet. Send the request as text." Edits of a message already sent are not read.

A webhook registered for the bot blocks polling (Telegram answers `409 Conflict`); polling mode deletes it before its first poll. One bot token supports one ingress at a time: a second daemon or an old deployment polling the same token makes polling report a conflict.

### ntfy

| Setting | Notes |
| --- | --- |
| `surfaces.ntfy.baseUrl` | Default `https://ntfy.sh`. Every publish, poll, subscribe URL and credential check uses this one server; an emptied value means `https://ntfy.sh` everywhere. |
| `surfaces.ntfy.chatTopic` | Messages here go to the active shared terminal session (secret). Each is queued as the next thing said in that conversation: the terminal running it collects it, runs it as its next turn, and the answer is posted back to this topic through the topic's route. With no terminal session to take it, the post is answered `409`. |
| `surfaces.ntfy.agentTopic` | Messages here start agent work (secret). |
| `surfaces.ntfy.remoteTopic` | Messages here use daemon-owned remote chat (secret). |
| `surfaces.ntfy.topic` | Default delivery topic for notifications (secret). |
| `surfaces.ntfy.token` | Optional access token (secret). Env `NTFY_ACCESS_TOKEN`. |
| `surfaces.ntfy.defaultPriority` | Default `3`. |

On the public server a topic name is the only thing keeping strangers out, so each topic is a credential: its name is kept in the secret store (daemon tier, key `GOODVIBES_SURFACES_NTFY_CHAT_TOPIC` and so on) and the setting holds a `goodvibes://secrets/` reference; a literal name written into a setting is refused, and the settings screens, channel accounts, status and the model's tools show the reference or `(secret)`, never a name. Setting a topic in a settings screen, the setup wizard or channel setup stores it that way. Topics ship unset: `goodvibes surfaces enable ntfy` gives each unset topic an unguessable name, stores it and says which names to subscribe to (the names are stored before any other setting is written: when one cannot be stored it prints `Surface not enabled: ntfy. Its topic name could not be stored: <reason>. Nothing else was changed.` and exits `1`, and a name stored before the failure is reused on the next run), and the daemon does the same when ntfy starts with a topic unset. ntfy carries no sender identity, so a change asked for over ntfy is refused. `goodvibes surfaces` (the owner's own command) lists the topic names to subscribe to. The ntfy subscribe-URL action builds URLs only for a topic it is given.

### Generic webhook

`surfaces.webhook.defaultTarget` (where outbound JSON goes), `surfaces.webhook.secret` (shared secret for signing and verifying), `surfaces.webhook.timeoutMs` (default 10000). Inbound JSON is posted to `/webhook/generic`; a body sent as `application/json` must be a JSON object, and anything else (`null`, an array, a string or a number) is answered 400 `Invalid JSON body: expected a JSON object`. A `correlationId` (in the body, or the `x-goodvibes-correlation-id` header) is the message's identity: posting the same message again with the same `correlationId` (after a timeout or a lost answer, also across a daemon restart) answers as a duplicate and starts nothing. Outbound posts carry `Idempotency-Key`, the same for every attempt at one message. A webhook caller receives refusals as HTTP 403 with `ok: false`, `outcome: "refused"`, the reason and the next step. A change asked for over the webhook is refused outright, as released. A message that names no sender is read as yours, as released: holding the secret proves only that it came through the webhook, and the webhook's own rule (no change by it) holds whoever it names.

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
2. In the terminal app: Devices and network, Pair something, A chat channel, homeassistant, and enter the instance URL, the access token and a webhook secret you choose (or use `/settings set` for each key), then switch the surface on.
3. Make the daemon reachable from Home Assistant: Home Assistant calls the daemon's control plane, which listens on `127.0.0.1:3421` by default, so a Home Assistant on another machine needs the daemon exposed on the network (see "Network exposure" in "The daemon, the web UI and networking").
4. Send a prompt. Two routes:
   - Webhook, authenticated by the webhook secret: `POST http://<daemon>:3421/webhook/homeassistant` with header `x-goodvibes-homeassistant-secret: <secret>` (or `x-goodvibes-webhook-secret: <secret>`, or `Authorization: Bearer <secret>`) and a JSON body such as `{"type":"prompt","message":"turn on the kitchen lights","conversationId":"home","messageId":"ha-msg-1"}`. The prompt text may be in `message`, `prompt`, `text` or `task`; optional `areaId`, `entityId`, `userId`, `displayName`, `providerId`, `modelId`. A prompt with no `userId` is read as yours, as released; one with a `userId` that is not the channel's recorded owner is a guest's: its plain reads run and everything else is put to you (see "Where the instruction came from" in "Permissions and decisions"). The request is held until the turn ends (at most 120 seconds) and answers with `delivered`, `sessionId` and `assistantMessageId`; the reply text arrives as the event below. A body with a `tools` list is refused with 400. A body whose text is a run-control command (see "Run control" under "Who may talk to the assistant") controls a run started from the same conversation.
   - Conversation API, authenticated by an operator token with the `write:sessions` scope (`Authorization: Bearer <operator-token>`; tokens are described under "Credentials and pairing" in "The daemon, the web UI and networking"): `POST /api/homeassistant/conversation` with `{"text":"what is on my calendar today","conversationId":"home"}`. The answer carries `status`, `sessionId` and `assistant` with `text` and `speechText`. It waits up to 120 seconds by default (`timeoutMs` 1000 to 600000; `wait: false` returns at once). `POST /api/homeassistant/conversation/stream` returns the same as one server-sent `final` or `error` event. A `messageId` the caller chooses makes a repeat of either safe, also across a daemon restart: the utterance is posted once per installation and conversation (`surfaceId`, `conversationId`) and the repeat answers with that turn's outcome; `POST /api/homeassistant/conversation/cancel` with `sessionId` (or a known `messageId`, with the same `surfaceId` and `conversationId` the submit sent, when it sent them) stops a turn and answers `cancelled` (or `stopping` while a tool call ends); when nothing was running, a known `messageId` answers what that message came to (`completed` with its `assistant` reply, `cancelled` or `failed`) and a `sessionId` alone answers `not-running`. `GET /api/homeassistant/health` reports the surface's state and endpoints.
5. Receive replies: the daemon fires the event `goodvibes_message` on Home Assistant (`POST <instanceUrl>/api/events/goodvibes_message` with the access token). Its data includes `body`, `speechText`, `status`, `sessionId`, `conversationId`, `messageId` and `replyToMessageId`. In Home Assistant, an automation with an event trigger of that type can notify, speak or update a helper from it.

Prompts from Home Assistant run in isolated remote-chat sessions, never in a terminal session. A turn longer than two minutes is answered "Still working on that." (status `running`) and the final reply follows as a second event. The Home Graph routes under `/api/homeassistant/home-graph/*` build a separate knowledge space about the house; they are used by an integration and are not configured from the terminal apps.

### Google Chat

`surfaces.googleChat.webhookUrl` (secret; env `GOOGLE_CHAT_WEBHOOK_URL`) for outbound delivery; `surfaces.googleChat.verificationToken` (secret; env `GOOGLE_CHAT_VERIFICATION_TOKEN`) to verify inbound events at `/webhook/google-chat`; `surfaces.googleChat.appId`, `surfaces.googleChat.spaceId`. Create a Google Chat app or webhook in the target space and store the values. A surface that can only be checked by sending says so on retest and sends nothing.

### Signal

Requires a trusted Signal bridge paired with the account GoodVibes uses. Required: `surfaces.signal.bridgeUrl`, `surfaces.signal.account`. Optional: `surfaces.signal.token` (secret; env `SIGNAL_BRIDGE_TOKEN`), `surfaces.signal.defaultRecipient`. The bridge posts inbound messages to `/webhook/signal`. Signal payloads carry no mention data; with `--require-mention on`, a message is refused unless the bridge sets `mentioned: true`.

### WhatsApp

`surfaces.whatsapp.provider`: `meta-cloud` (default) or `bridge`. Required in `meta-cloud` mode: `surfaces.whatsapp.accessToken` (secret; env `WHATSAPP_ACCESS_TOKEN`); in `bridge` mode it is the bridge token (also env `WHATSAPP_BRIDGE_TOKEN`), needed only when the bridge asks for one, and the surface counts as configured without it. Optional: `verifyToken`, `signingSecret` (env `WHATSAPP_SIGNING_SECRET` or `WHATSAPP_BRIDGE_TOKEN`), `phoneNumberId`, `businessAccountId`, `defaultRecipient`, and `bridgeUrl` (required in bridge mode; the doctor fails the surface while it is unset). Inbound goes to `/webhook/whatsapp`.

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
```

### Voice in the System place

Voice has no slash command. In the System place (Ctrl+G then m, System), in both terminal programs:

| Where | Row | Keys |
| --- | --- | --- |
| This session | "Speak answers aloud" | `a` speak every answer / stop speaking them, `p` ask and hear the answer, `w` listen for the wake word again after it stopped by itself |
| Voice | "Voice runtime" | `i` install it (when not installed or partly), `t` stop speaking, `v` the wake word's state, `w` set up the wake word, `e` save the voice settings to a file, `o` read a voice settings file, `m` apply one |

The capabilities are `voice.review`, `voice.on`, `voice.off`, `voice.speak`, `voice.stop`, `voice.status`, `voice.setup`, `voice.wake-status`, `voice.wake-setup`, `voice.wake-again`, `voice.export`, `voice.inspect` and `voice.import`; a model runs them with `capability_run`, a script with `goodvibes do`.

`ui.voiceEnabled` turns the voice control surface on. The `voice-input` key action (Ctrl+G then v, or F8, by default) starts and stops recording in the terminal app.

### Local offline voice

`voice.local.sttEngine` (`whisper-cpp` or `faster-whisper`), `voice.local.sttBinary`, `voice.local.sttModelPath`, `voice.local.ttsEngine` (`piper` or `kokoro`), `voice.local.ttsBinary`, `voice.local.ttsModelPath`. The `local` provider reports `unconfigured` until an engine is set up.

Managed install: "install it" on the Voice tab of the System place (`voice.setup`) asks the daemon to download and set up piper (text to speech) with the `en_US-lessac-medium` voice, and whisper.cpp 1.8.2 with the `base.en` model (speech to text, about 148 MB). Every download is checksum-verified and resumable; installing again fetches only a part that failed. The Voice tab follows the install by itself, wherever it was started: each part's step (downloading, checking, unpacking, done or failed) with its bytes, then the result (each engine, each part, the settings it pointed at the runtime and those it left as you set them). The managed install has pinned builds for Linux x86_64 only; on any other platform it reports the engine unsupported, and you install the engine yourself and set the `voice.local.*` keys:

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

- The wake models: a classifier for "hey goodvibes" and a speech-embedding front end (about 6 MB in all), checksum-pinned and downloaded into `~/.goodvibes/voice/wake`. Installing GoodVibes downloads them, and a daemon retries at start if the install had no network. If they are still missing, turning `voice.wake.enabled` on in the terminal app or the Agent runs the wake setup plan, which downloads them (see below); setting up the wake word on the Voice tab and `goodvibes-daemon provision-wake-model` also fetch them.
- A recorder program on the host for the terminal apps: `pw-record`, `parecord`, `arecord`, `ffmpeg` or `sox` (`voice.wake.captureCommand` `auto` uses the first one found in that order).
- Speech to text: a configured speech-to-text provider (the managed local whisper, or a cloud provider from the table above). Without it a wake has nothing to transcribe.

Turning it on from nothing (terminal app):

On the Voice tab of the System place: `v` shows what is installed and what blocks wake; `w` sets up the wake word (fetches missing wake models, turns on the wake rows for this terminal, and proposes speech to text; choosing "Install it too" also starts the daemon's install of the local speech to text, which the Voice tab then follows). Then `/settings set voice.wake.enabled true`.

In both the terminal app and the Agent, turning on `voice.wake.enabled` from anywhere (the settings workspace, `/settings set`, a model's settings call) runs the same setup plan as setting up the wake word: it fetches missing wake models and prints the plan. In the Agent the same write also turns on `voice.wake.surfaces.agent` (off by default) and says so, because the switch alone would open no microphone there; the terminal app's row `voice.wake.surfaces.tui` is on by default. The follow-up line names "Install it too" on the Voice tab. While wake runs, the terminal footer shows the listening marker (`voice.wake.indicator`). When listening stops by itself (the recorder kept failing after its own restarts), it starts again when the terminal regains focus or the wake input device setting changes; `w` on the "Speak answers aloud" row of This session (System) starts it at once. `ui.voiceEnabled` (always-speak) is not needed for wake. The `voice.wake.*` settings belong to each app, not the daemon: the Agent keeps its own `voice.wake.enabled`, set with `/settings set voice.wake.enabled true` there.

The `voice.wake.*` settings, by group:

| Group | Settings | Use |
| --- | --- | --- |
| On/off and where | `enabled`; `surfaces.tui` (default on), `surfaces.agent`, `surfaces.webui`, `surfaces.app` | Turn detection on, and choose which apps listen. Turn `surfaces.tui` off when you talk to the Agent instead, so two apps do not both act on one phrase. The web UI and desktop app ask the browser for microphone permission only when their row is on; a plain-http origin cannot capture. |
| What it listens for | `models` (default `hey_goodvibes`), `customModelDir` | Comma-separated model ids; extra ids are loaded from `customModelDir` without checksum pinning. An empty list stops detection without stopping the service. |
| How sure it must be | `threshold` (0.9), `patienceFrames` (2), `cooldownMs` (2000), `vadThreshold` (0, off; 0.3 recommended) | Lower `threshold` toward 0.5 if it misses you; raise it if it fires when you did not speak to it. `vadThreshold` above 0 screens out non-speech frames first. |
| Audio input | `inputDevice` (empty: system default), `captureCommand`, `noiseSuppression` (`none` or `speex`) | List devices with `pactl list short sources` or `arecord -L`. `pw-record` takes a PipeWire node name or serial; `sox` cannot pick a device. Use `speex` in a noisy room. These rows also apply to push-to-talk (the `voice-input` key). |
| Feedback | `activationSound` (`chime`, `none`, `custom`), `activationSoundPath`, `indicator` (`statusline`, `banner`, `off`) | |
| Recording after the wake | `preRollMs` (500), `captureMaxSeconds` (10; 0 removes the ceiling), `silenceStopMs` (1200), `silenceFloorRms` (0: measured per utterance), `speechRetriggerMs` (150) | Raise `silenceStopMs` if it cuts you off mid-sentence; set `silenceFloorRms` if capture keeps running after you stop. |
| What happens to the transcript | `autoSubmit` (off) | On sends the transcript as a turn without review. Read when the transcript is ready, so a change made while one is being transcribed applies to it. |
| Audio retention | `retainAudio` (`none`, or `session-temp` for debugging, deleted when the session ends) | |
| Crash handling | `maxRestarts` (3), `restartBackoffMs` (2000), `crashWindowSeconds` (60) | A detector that crashes more than `maxRestarts` times in the window is stopped and reported. |
| Browser engine | `browserBackend` (`wasm` or `webgpu`) | Web UI and desktop app only. |

Failures:

| Symptom | Fix |
| --- | --- |
| Wake models reported missing or failing verification | Set up the wake word (System, Voice, `w`); again to resume. |
| No recorder found, or a named `captureCommand` is not installed | Install one of `pw-record`, `parecord`, `arecord`, `ffmpeg`, `sox`, or set `captureCommand` to `auto`. |
| A surface refuses to start with `vadThreshold` above 0 | The speech gate artifact is not installed there: set up the wake word (System, Voice, `w`), or set `vadThreshold` to 0. |
| Wakes but nothing is transcribed | No speech-to-text provider: set up the wake word with "Install it too" (System, Voice, `w`), or configure a cloud speech-to-text key. |
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

1. Turn purchases on, choosing how they run. In Settings (both terminal programs: the `Let GoodVibes make purchases` row; the web UI: Settings, payments) turning it on asks which of two ways, and nothing is preselected: `Ask me before every purchase (recommended)` (The safer way: nothing is bought until you approve it, naming the shop, the item and the most it may cost; `payments.confirmEveryPurchase` on) or `Buy, and give me <N> minutes to stop it` (A purchase within your budgets at a shop you can get your money back from goes ahead unless you say stop within N minutes; if the notice cannot reach you, it still goes ahead; `payments.confirmEveryPurchase` off, N is `payments.windows.vetoMinutes`). Both settings are written in one update. From a command line: `/settings set payments.confirmEveryPurchase true` (or `false`), then `/settings set payments.enabled true`. A choice already saved stays as it is until you pick another. While a stop window runs, its card (the terminal's Waiting for you, the web UI's Work list, a chat channel) says so on its face: `Inside your daily budget. It goes ahead when the time runs out, even if this notice never reached you.`, with `Stop it` selected.
2. Add a card: Money, Cards tab, `n` ("Add a card", a form; the number, expiry, security code and name hidden as typed, sent to the daemon after the last field). Fields: label, kind (`virtual` or `real`), number, expiry, security code (3 or 4 digits), cardholder name. The answer is `Stored card "<label>".` with the card's kind, brand, last four digits and expiry. A virtual card with an issuer cap is recommended: the issuer enforces its cap even when this software is wrong. The terminal apps cannot record the cap; the web UI's card form (Settings, payments) has an optional "Issuer cap" field, and the operator method `payments.cards.create` takes `issuerCapMinorUnits`. A recorded cap is your declaration; a purchase whose full total is over it is refused (`card-limit-exceeded`) before any window. A card cannot be edited: to change its cap, remove it (Money, Cards, `x` on the card) and add it again. Adding the same card again (the same label, number and expiry, for example after an answer that did not arrive) returns the card already stored and stores no second copy. A card number (and a security code asked for with `payments.cvvHandling` `prompt`) is taken only from a connection that reaches the daemon from its own machine, over https (`controlPlane.tls`, or a trusted proxy that ended TLS), or over a Tailscale address; over plain http on the local network (a LAN address or a `.local` name) the daemon refuses it with `403` `CARD_ENTRY_TRANSPORT` before reading it, and the web UI shows that reason instead of the card form or the code field.
3. Set the addresses: Money, Addresses tab, `Enter` on the billing or the shipping address in either program (a form of the fields `name`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`; a blank field keeps what is set), or the settings workspace (`/settings payments.shippingAddress`).
4. Set the currency and budgets:

   ```text
   /settings set payments.currency USD
   /settings set payments.budget.dailyItem 100
   /settings set payments.budget.dailyOverage 25
   /settings set payments.budget.perPurchaseCeiling 150
   /settings set daemon.timezone America/Chicago
   ```

   Amounts are written as you would say them (`19.99`). The day resets at midnight in `daemon.timezone` (UTC when empty). Every hold and spend records its currency: changing `payments.currency` starts new daily pools in the new currency for the rest of the day, and `payments.budget.status` lists what was spent earlier that day in the old currency (`earlierSpend`), in that currency, never converted.
5. Say where approval and veto prompts also go: `/settings set payments.notifyChannels telegram`. The only accepted value today is `telegram` (or empty); any other name is refused with `expected string (a comma-separated list; only 'telegram' can deliver a notice today)`. Every notice, window and confirmation always goes to the owner inbox (Waiting for you, the web UI) whatever this says.
6. Check: Money, Cards tab.

### Money

Cards, addresses and what may be bought without asking are in **Money** (the menu of places, in both terminal programs and the web UI). Each action is a control on the thing it acts on, and the same capability a script runs with `goodvibes do <id>`:

| Action | Control | Capability | Risk |
| --- | --- | --- | --- |
| See your cards | Money, Cards tab (the cards on the daemon; the addresses purchases use are on Addresses) | `payments.cards` | |
| See what is waiting for your answer | Waiting for you, Purchases tab (answer a purchase window, stop a checkout, type a security code) | `payments.pending` | |
| Approve one purchase ahead of time | Money, Repeat purchases, `a` (shop, at most, item) | `payments.approve` | spends money |
| Allow a repeat purchase | Money, Repeat purchases, `n` (the six blanks below) | `payments.repeat` | spends money |
| See repeat purchases you have allowed | Money, Repeat purchases tab | `payments.repeats` | |
| Stop a repeat purchase | Money, Repeat purchases, `x` on the one to stop | `payments.stop-repeat` | |
| Add a card | Money, Cards, `n` (each card field hidden) | `payments.add-card` | |
| Remove a card | Money, Cards, `x` on the card (asks first) | `payments.remove-card` | cannot be undone |
| Set your billing or shipping address | Money, Addresses, `Enter` on the address (blank keeps what is set) | `payments.address` | |

Every action but the two reads is your own: from any of your credentials it runs at once, and a model's call is decided under your mode as an act of yours (a model never answers a purchase window or types a card security code). A pressed key or a submitted form is the request; only removing a card asks first, and the outcome line says what the act did ("Nothing has been bought yet: ..."). In the terminal app the address is written to this machine's daemon settings; in the Agent to the connected host's.

"Approve one purchase ahead of time": the shop's domain, the most it may cost (in `payments.currency`), and the item in your words. The approval is used once, for a purchase matching all three that begins within five minutes; such a purchase needs no further answer up to that amount. Approving the same shop, item and amount again while the first approval is unused returns that approval rather than making a second. When recording an approval cannot be confirmed, the answer is `OUTCOME_UNKNOWN` ("The approval may have been recorded ..."), and the web UI says it may have been approved instead of "Nothing was approved". The approval is for that amount in the currency `payments.currency` named when it was given (the reply names it): a begin after `payments.currency` changed is a different purchase, does not spend it, and with `payments.confirmEveryPurchase` on is refused saying the merchant, item, amount or currency differs.

```text
goodvibes do payments.approve --input shop=shop.example --input most=25.00 --input "item=USB-C cable"
Approved ahead of time: "USB-C cable" from shop.example, at most 25.00.
It ends 11/18/2026, 10:20:00 AM; the amount is in USD.
```

"Allow a repeat purchase" lets a scheduled routine or trigger buy one thing without asking, within limits. Its blanks:

| Blank | Input | Rule |
| --- | --- | --- |
| Shop | `shop` (one per line for further shops) | 1 to 8 shop domains, each with a dot; picked from the shops you have bought from, or typed. |
| What may be bought | `item` | Your words, 1 to 200 characters. |
| Most per purchase | `each` | Above zero. |
| Most in any period | `per-period` | At least the per-purchase amount. |
| Period | `days` | 7, 30 (the usual), 90 or 365 days; typed, any whole number 1 to 366. |
| Last day | `until` | Optional, `YYYY-MM-DD`. Without it the authorisation lasts until you stop it. |

At most 32 repeat purchases are kept.

```text
goodvibes do payments.repeat --input shop=shop.example --input "item=dog food" --input each=60.00 --input per-period=120.00 --input days=30 --input until=2027-06-30
goodvibes do payments.repeats
goodvibes do payments.stop-repeat --input repeat=standing-1a2b3c4d
```

In the web UI the Repeat purchases screen lists the same allowances, each with Stop, under `Allow a repeat purchase…`, a sheet with the same six blanks and sentence; both are sent as the owner's own request.

The example lets a scheduled run buy "dog food" from either shop, at most 60.00 a purchase and 120.00 every 30 days, until 30 June 2027. A routine's purchase names the authorisation as `standingId` when it calls `payments.checkout.begin`. Every budget, ceiling and purchase window still applies to each purchase under it. A refusal names the field and ends with `Nothing was added.`, for example `maxPerPeriod must be one amount in USD, at least the per-purchase maximum.`

How a purchase is started: there is no owner command that buys. You ask the Agent in conversation ("buy one USB-C cable from shop.example, at most 25 dollars"). The Agent's model opens the shop's checkout page with its `browser` tool, then calls its `agent_operator_method` tool with `methodId` `payments.checkout.begin` and the open page (`sessionId`, `pageId`), `requestId`, `merchantDomain`, `checkoutUrl`, `item`, the requested and quoted lines, the shipping options, the stated total, the currency and optionally `cardId` (else `payments.defaultCardId`) and `requestedMax`. The daemon then reads the page itself, applies the decision below and runs the window. "Accepted" in the answer does not mean bought: `payments.purchase.status` with the `requestId`, Waiting for you's Purchases tab and the web UI Purchases panel show where it stands. The terminal app's model has neither tool, so purchases are started from the Agent (or from a daemon-hosted Agent session, or by an operator client calling `POST /api/payments/checkout/begin` with the `write:payments` scope). A routine or trigger purchase must name a standing authorisation as `standingId`.

How that call is checked, in order:

1. The permission gate decides the `agent_operator_method` call like any other tool call. `payments.checkout.begin` and `payments.purchase.cancel` are not owner-only methods, so the call is a judgment call: with a working decision model Jev decides it in `jev-decides` and `just-vibes` (held instead of refused in `just-vibes`), `ask-me` runs it unless the reading is critical, irreversible or security-weakening; without a decision model it is asked (held in `just-vibes`); `yolo` runs it; `plan` refuses it. The owner-only methods (answering a window, typing a card code, approving in advance, adding a standing authorisation) are refused to the model in every mode.
2. The tool screens the request: it is held if it would carry text the model may not send on (the judgment-input boundary) or card material. It does not run the outward-content check other operator calls get: a purchase's taint is judged by the daemon against the purchase itself.
3. A begin without `standingId` is sent as the owner's own request (the explicit-user-request context); a begin naming `standingId` claims no owner request and is bound to that entry's shops, item and maximums.
4. The daemon then applies every payment gate below (purchases enabled, the owner asked directly, taint of item, maximum, merchant and link, this daemon runs payments for its group, a card, a shipping address), then the budget decision and the window. These apply in every permission mode, `yolo` included.

The model may start a purchase (`payments.checkout.begin`) and cancel one, and read status and the purchase list. Everything else (answering a window, typing a security code, approving in advance, adding a standing authorisation) is the owner's act and is refused to the model.

### How a purchase is decided

1. Gates, each a refusal with no approval path: purchases enabled; the purchase was asked for by the owner directly, not by content the owner read; this daemon runs payments (alone it always does; in a cluster exactly one machine holds the group's payments role, chosen by the election, and every other machine refers the owner to it: `Refused: in this group of machines purchases run on one machine at a time, and that is <name>. Ask there (its terminal app, web UI or channels); it buys with its own card, address and daily budget.`); a usable card; a shipping address; item and maximum not taken from untrusted content; a checkout link that passes full link validation.
2. The merchant is graded on the domain that takes the card. Established recourse makes the later window a veto window; anything else makes it an approval window. Grading needs a decision model: with none in use (or the set model failing) the merchant is "not judged, because no decision model is in use", which is not established recourse, so every purchase opens an approval window (60 minutes, silence denies), even within every budget. An eBay auction or Best Offer listing is refused. `payments.majorRetailersAdditional` and `payments.majorRetailersExcluded` adjust the grade; `payments.ebayMinSellerFeedbackCount` (100) and `payments.ebayMinSellerPositivePercent` (98) set the eBay seller bar.
3. The page's prices are parsed into numbers, the cart must hold only what was asked for, and a subscription or recurring charge is refused. Without a decision model, a cart line whose label is not exactly a requested item is never passed over because the requested quantities are met: it is listed in the approval window for the owner to see.
4. Budget: the item price against what is left of `budget.dailyItem` (over it, the purchase needs approval: "This item costs USD 40.00 and only USD 25.00 is left in today's item budget, USD 15.00 short."; it is not refused for that); tax, mandatory fees and delivery against `budget.dailyOverage`, stepping delivery down from `payments.shipping.preferredTier` (`normal`, `fast`, `fastest`) one tier at a time until it fits; then the overage tolerance pool if `budget.overageToleranceEnabled`; otherwise refused. The full total is checked against the card's declared issuer cap (over it is refused), the per-purchase ceiling (over it needs approval) and the maximum the owner asked for (over it needs approval). A checkout in another currency is refused.
5. The pools are reserved before the owner is asked.
6. One notification goes out with what was chosen and what it will cost:
   - Veto window (within budget, recourse established): silence for `payments.windows.vetoMinutes` (10) proceeds; an objection cancels. An answer that could not be read (an unreadable owner inbox) is not silence: nothing is bought, and the purchase is refused `answer-unreadable`. An objection or denial given through `payments.purchase.deny` or `payments.purchase.cancel` (the web UI's buttons) is written to the purchase's record before it is reported accepted, so a daemon that stops right after never resumes that window and never buys on its silence.
   - Approval window (over budget, over the requested maximum, or no recourse): silence for `payments.windows.approvalMinutes` (60) denies; only an explicit approve proceeds. When the notice cannot be delivered, a within-budget purchase proceeds and an over-budget one is refused.
   - `payments.confirmEveryPurchase` `true` makes every purchase need the owner's approval.
7. The card is filled and the order submitted. Without a decision model, code checks the live page first: the approved total must be the amount on the order summary's total line (a "Total", "Order total" or "Grand total" line, never a subtotal), and when the page offers delivery choices the quoted one must be the one shown as selected; otherwise nothing is submitted and the purchase stops for the owner to start again. A card security code, 3-D Secure or CAPTCHA pauses for the owner (Waiting for you, Purchases tab). With `payments.cvvHandling` `prompt`, the security code is not stored and is asked every time.
8. The purchase is recorded as `purchased` only when the page the submit landed on, on the merchant's own domain, shows an order number, or shows a confirmation together with this submit's own total. Confirmation wording alone ("Thank you for your order") records `submitted-unverified`: the money is counted as spent, and the owner confirms or denies the order (`payments.purchase.reconcile`, the Purchases panel) or the shop's confirmation mail settles it.
9. The owner's report of a recorded purchase is saved with the purchase record and marked sent once a channel took it; a report the daemon did not get out before it stopped is sent at its next start. The same holds for a refund the shop's mail reports and for a shop mail that settles a `submitted-unverified` purchase: the note is saved in the same write as the refund or the move to `purchased`, and one no channel took is sent at the next start.

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

In every program it is Automation's CI watches tab: each watch with its repository (`my-org/my-repo#42` for a pull request, `my-org/my-repo@main` for a branch, tag or commit), its last verdict, where failures go and whether a fix session starts; it reads again by itself when a watch changes (LIST_CHANGED `ci-watches`).

| Action | Capability | Control in Automation | Risk |
| --- | --- | --- | --- |
| See your CI watches | `ci.watches` | the CI watches tab | |
| Check a repository's CI now | `ci.status` | `k` check a repository | |
| Watch a repository's CI | `ci.watch` | `n` watch a repository ("On a failure": only tell me, or also start a fix session) | |
| Check a watch now | `ci.run` | `g` check now, on a watch | |
| Stop watching a repository | `ci.unwatch` | `x` stop watching, on a watch (asks first) | cannot be undone |

The repository is written the way you say it: `my-org/my-repo`, `my-org/my-repo#42` or `my-org/my-repo@main`; the daemon reads the pull request or branch from it.

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
- "Also start a fix session" (`--trigger-fix-session` in `goodvibes-agent ci`) starts a fix session on a red verdict, seeded with the tails of up to five failing jobs' logs.
- A standing watch is polled every `watchers.ciPollIntervalMs` (never faster than 15 seconds), sends its verdict once, then retires. A watch whose branch is gone, or that gets no verdict in time, ends with a "no verdict" notice.
- A watch that starts a repair on a red verdict stays open until the repair has started: a repair that fails to start is tried again after its back-off, and one that is refused ends the watch once with "CI repair not started" and the reason. The poll summary counts the repairs that did not start.
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

Segments after the title may be in any order; `|` may be used instead of `·`. A date `MM-DD` is annual and `YYYY-MM-DD` is a one-off unless `annual` or `once` says otherwise; `once` needs a year, so a `MM-DD` line marked `once` is reported as unreadable. The kind is `gift-giving` (offers a gift conversation), `remember-only` (no gift) or `neither`, and is always the owner's choice; nothing infers it. `for <name>` says who it is about; `for me` marks the owner's own date (a `remember-only` date of the owner's own is listed but never pushed at them). `lead <n>` overrides the lead time for one occasion. A line that cannot be read is reported with a reason and never rewritten; you may also edit the file by hand.

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
| `remove` | Remove an occasion's line and every record against it, after asking the owner once. The unconfirmed call names the line (`removedLine` on the operator method, `line:` in the tool's answer); the confirmed call passes it back as `line`, and only that line goes. When other lines still declare the same occasion, its records stay. Repeating the confirmed call removes nothing more. | `occasionId`, `confirmed: true`, `line` |
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

Operator methods: `occasions.list`, `occasions.pending`, `occasions.state`, `occasions.sweep`, `occasions.propose`, `occasions.confirm`, `occasions.update`, `occasions.remove`, `occasions.answer`, `occasions.acknowledge`, `occasions.interview.get`, `occasions.interview.answer`, `occasions.interview.record`, `occasions.gifts`, `occasions.conflict.resolve`, `occasions.plans.list`, `occasions.plans.propose`, `occasions.plans.confirm`, `occasions.plans.update`, `occasions.plans.remove`. The methods that write the profile (`confirm`, `update`, `remove` and the plan equivalents) take a required `authority`; `update` without `confirmed` returns the line to put to the owner and writes nothing. Your reply about an occasion (`occasions.answer`, `occasions.interview.answer`, `occasions.acknowledge`) is your own act (risk class `owner-act`): from any of your credentials (a script, a device, a sign-in, the MCP set-up) it runs at once; your model in your own turn records it under your mode, as it does in the Agent's conversation.

## List-valued settings

Some settings hold a whole list. Each is read and written as one JSON value; a malformed list is refused whole.

| Setting | What it is for | Example |
| --- | --- | --- |
| `notifications.webhookUrls` | Webhook URLs that receive this machine's notifications (turn ends, approvals waiting, budget alerts). Each member is a `goodvibes://secrets/` reference to a URL kept in the secret store; a literal URL is refused. Applies at the next start. The daemon's, one list for every program; managed on the Notifications tab of Mail, calendar and channels. | `["goodvibes://secrets/goodvibes/GOODVIBES_NOTIFY_WEBHOOK_1A2B3C4D5E6F"]` |
| `sandbox.egressAllowlist` | Command names the exec sandbox lets reach the network. From the next command. | `["git","npm"]` |
| `sandbox.workspaceWritable` | Extra absolute paths sandboxed commands (exec commands and contract gates) may write. From the next command. Every sandbox boundary (exec commands, sandbox sessions, contract gates) hides the home directory except toolchain installs, shown read-only (`RUSTUP_HOME`, cargo's `bin` and config, `NVM_DIR`, `PYENV_ROOT`, `ASDF_DATA_DIR`, mise's data, bun's `bin`, `GOPATH/bin`, the user-level git config, the PATH folders inside home), and caches, shown writable (`GOCACHE`, `GOMODCACHE` and `GOPATH/pkg`, cargo's `registry` and `git`, bun's install cache, npm's cache, pnpm's store, yarn's cache, pip's and uv's caches, and `XDG_CACHE_HOME`), each from its variable or its default. The GoodVibes state, ssh and gpg keys, cloud and registry credentials (cargo's included), browser profiles and caches and shell history are never shown. A command that fails on a missing path in home, or on a write refused in a read-only toolchain folder, says so and names this setting. | `["/home/me/.cache/build"]` |
| `surfaces.email.imap.authservIds` | Authserv-ids your mailbox's receiving server writes in `Authentication-Results`, for a provider that is not built in. An entry starting with `.` matches the hosts under that domain. | `["mx.example.com"]` |
| `provider.fallbackModels` | Your fallback order: the provider-qualified models a turn moves to, in every program (terminal app, `run`, the Agent, hosted sessions, the daemon's agents), when the selected model fails on every sign-in of its provider and its retries. The provider half is matched by id or display name without regard to case. Empty: the turn stops and says so. | `["anthropic:claude-sonnet-5"]` |
| `cluster.peers` | Cluster peers (`host` or `host:port`) contacted directly as well as over multicast, for a network that drops multicast. | `["10.0.0.2","10.0.0.3:4000"]` |
| `conversationGate.gatedSurfaces` | Channel surfaces whose inbound messages pass the conversation gate before a session sees them. | `["slack","telegram"]` |
| `contract.gates` | Quality gates a contract runs before it reports work done: objects `{ "name", "command", "enabled" }` with optional `required` and `verification`; a gate passes or fails on its command's exit code. A gate that cannot run is refused when saved. Each gate command runs inside the sandbox boundary (the exec tool's boundary: network on, its tree, its report directory and `sandbox.workspaceWritable` writable, the home directory hidden except the toolchain installs and caches listed under `sandbox.workspaceWritable`) with credential variables withheld as for every exec command (`permissions.execEnvScrubAllowlist` keeps named ones); where this machine has no boundary it runs on the host, and its result says so (`backend: "host"`). | `[{"name":"tests","command":"bun run test","enabled":true}]` |
| `worktree.setup.commands` | Commands run in a new worktree before an isolated agent starts in it. `[]` (auto, the default) runs the install command each lockfile names; `{"mode":"none"}` runs nothing. | `["bun install"]` |
| `worktree.setup.carryOverGlobs` | Untracked files copied from the main checkout into a new worktree. `[]` (auto) copies `.env` and `.env.*`; `{"mode":"none"}` copies nothing. | `[".env","config/*.local.json"]` |

These are settings only; "lists" in this section means these list-valued settings. GoodVibes has no shopping-list feature. Both apps have the same checklist, the project's running list of things to do, kept in the Work place's Checklist list (add, change, mark, move on, take off, clear the finished ones, see or save it as Markdown). The Agent's model reads and changes it with the `agent_work_plan` tool, the terminal app's with the `work_plan` tool. Both are described in full in "The terminal app (`goodvibes`)" and "The Agent (`goodvibes-agent`)".

How to edit one, from each surface:

| Surface | How |
| --- | --- |
| Terminal app | `/settings set <key> <JSON list>`, for example `/settings set sandbox.egressAllowlist ["git","npm"]`; `[]` empties it. `/settings <key>` opens the settings workspace at the key. `-c <key>=<JSON list>` sets it for one launch. |
| Agent | `/settings <key>` opens the settings workspace at the key, where the list is edited. `/settings set` does not take a list. `-c <key>=<JSON list>` sets it for one launch. |
| Daemon command line | `goodvibes-daemon config get <key>`, `goodvibes-daemon config set <key> '<JSON list>'`, `goodvibes-daemon config unset <key>`, `goodvibes-daemon config list`. Quote the JSON for the shell. |
| Web UI | Settings: the key's field is a JSON editor that checks the list before it saves. |
| Operator API | `config.set` and the other `config.*` methods (described in "The daemon, the web UI and networking"). |

`notifications.webhookUrls` is set on the Notifications tab of Mail, calendar and channels (the `notify.*` capabilities), which keeps each URL in the secret store. A value that fails the key's check is refused whole with the key's hint, for example `list of absolute paths`.

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
