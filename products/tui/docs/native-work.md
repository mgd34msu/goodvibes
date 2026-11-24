# Work on the host (`/work`)

Work is a task the daemon (the host) keeps for a project: a goal, the criteria that say when it is done, and the attempts made at it. Both terminal programs reach it with the same `/work` command.

## The work view

`/work open` opens the work view for the project the daemon has for this folder; `/work open <project id>` opens another one. Each work reads as a task:

```
Fix login redirect: not started
  Checked: unverified, No verification has been recorded.
  Fix login redirect: you can start, check, stop
```

A work reads as `not started`, `waiting to start` (`: needs a resume` when the host asks for one), `running`, `passed, being checked`, `interrupted: needs a resume`, `stopped before it started`, `stopped`, `ended`, `finished`, `cancelled` or `released`. Choose a work's key row; the hint line shows only the keys that apply to it now:

| Key | Does | Shown when |
| --- | --- | --- |
| `Ctrl+S` | Start it | not started |
| `Ctrl+G` `i` | Check on it: where it stands on the host now | always (the only key once it stopped, finished or was cancelled) |
| `Ctrl+G` `c` | Stop it (press twice) | not started, waiting to start, running |
| `Ctrl+R` | Resume it | the host says it needs a resume, or it passed and is being checked |

With no attempt the row reads `nothing to run here yet`. A typed `/work start`, `/work status`, `/work cancel` or `/work resume` is sent whatever the row shows; the host decides.

Opening the view never starts or resumes anything, and no key approves anything for you. Closing the view stops only the requests this view sent and has not had answers to; the work keeps running on the host. The tabs: **Work** (each task), **Goal and criteria**, **Needs you** (what the host is waiting on you for), **Results** (outcomes recorded earlier), **Imported** (old planning records brought in), **Connection** (whether the host answers), and **Details** (the work, attempt and evidence identifiers and revisions, for reporting a problem).

A work's reported state, whether its criteria are checked, its progress and its recovery state are each shown as they are; one is never taken for another. When an answer from the host is lost, the result is unknown until you check again.

## Asking for new work

- `/work new` opens a form: what you want done, and what must be true when it is done (one criterion per line, 1 to 100). Typed: `/work new --done-when "an upload that fails twice still finishes" add retries to the uploader`.
- `/work request <your own words>` sends a request in your own words; the host decides whether it becomes work.
- `/work submit-file <path>` sends a JSON file with exactly `goal` (text) and `criteria` (a list of texts). The rest of the line is the path, so a path with spaces needs no quotes (quotes are accepted too); a `file://` address works as well.

The goal and the criteria are kept exactly as written: spaces, line breaks, order and repeats. Nothing rewrites them. Each is at most 20,000 characters, and the whole request at most 262,144 bytes. Sending new work never starts it: start it from the work view.

## When an answer is lost

A request is saved on this machine before it is sent (`native-work-submission.json`, in the program's own state folder; it holds no token), so a request whose answer was lost can be recovered:

- `/work submission` asks the host whether it has the request, and sends nothing.
- `/work submission-retry` asks first; only when the host says it does not have it is the same request sent again (the host keeps it once).
- `/work submission-discard` asks first; when the host does not have it, the saved request is dropped so a corrected one can be sent.

A saved request is tied to the daemon, folder, project and signed-in person it was made for: another one never sends it. It is removed once the host has confirmed it. A saved file that is damaged, too large or cannot be confirmed sends nothing.

The input journal beside it holds only input in flight: from when it is sent until the host answers for good (blocked, refused or cancelled), its work has been started, or the turn it led to has ended; then it is removed. It never refuses new input for being full.

Input typed with `/workstream start` waits for the host to admit it: `/work intake` shows it, `/work intake-retry` sends it again, `/work intake-resume` goes on with what the host admitted, and `/work intake-cancel` drops it.

## What it needs

A paired connection to the daemon with permission to read and write work. For the daemon on this machine no pairing is needed. See [host pairing](host-pairing.md).
