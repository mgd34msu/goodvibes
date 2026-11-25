# Work

Work is one thing, held and run by the daemon: a piece of work has what you asked for, what must be true when it is done, its plan of steps and its results. The terminal app, the Agent, the web UI and a phone show the same work, and it goes on when the window that asked for it closes.

## The Work place

Open it from the menu (`Ctrl+G` then `m`, row "Work and agents"), or with `/work`. It is read by itself when it opens and read again whenever a request, a piece of work, its run or its plan changes anywhere; nothing needs a key to show what is current.

- **Work**: each piece of work by what you asked for and where it stands: not started, its plan waits for you, starting, running, needs you, failed. Its detail shows what you asked for, what done means, its plan as numbered steps with what each waits on ("after 1, 2") and where each step stands, its results, the questions it waits on, its report and what it may spend.
- **History**: finished and stopped work, and work brought in from old planning records, each with its plan, steps and results.
- **Checklist**: the project's running list of things to do (see below).
- **Tasks here** and **Daemon tasks**: what runs in the background, in this program and on the daemon.
- **Runners**, **Runner pools**, **Handed back**: the remote runners the daemon holds.

The keys shown are the ones that apply to the selected item now:

| Key | Does | Shown for |
| --- | --- | --- |
| `s` | Start it | not started |
| `x` | Stop it (asks first: it cannot be undone) | starting, running, needs you |
| `g` | Go on after a stop or a failure | failed, or a start that was interrupted |
| `a` | Answer what it asks | needs you |
| `t` | Run a failed step again | needs you, running, failed |
| `b` | Change what it may spend | starting, running, needs you |
| `v` | Check where it stands | any |
| `Enter` | Approve the plan and start it | its plan waits for you |
| `e`, `d`, `m` | Change, take out or move a step of the plan | its plan waits for you |
| `w` | Write the plan again | its plan waits for you |
| `X` | Throw the plan away (the work stays) | its plan waits for you |
| `n` | New work: what you want done and what done means | always |
| `y` | Ask in your own words | always |
| `f` | Work from a file | always |

Every key can be changed in the Keys place. Opening the place never starts anything, and no key approves anything for you.

## Show me the plan before it runs

Settings, "Show me the plan before it runs" (`planner.showPlanFirst`), off by default. Off: a piece of work you start has its plan written and run, and you can open the plan at any time. On: starting it writes the plan first (a planning agent splits what you asked for and what done means into steps), and the work waits in the Work place as "its plan waits for you": change a step, take one out, move one, or have the plan written again; then approve it (that starts the work with exactly those steps) or throw it away.

## Asking for new work

- Say what you want done in the conversation: the host decides whether it is an answer or a piece of work.
- New work (`n`) takes what you want done and what must be true when it is done (one line each, 1 to 100).
- Ask in your own words (`y`) sends your words to the host, which answers them or makes them a piece of work.
- Work from a file (`f`) takes a JSON file with exactly `goal` (text) and `criteria` (a list of texts).

The goal and the criteria are kept exactly as written: spaces, line breaks, order and repeats. Each is at most 20,000 characters, and the whole request at most 262,144 bytes. Sending new work never starts it.

## When an answer is lost

A request is saved on this machine before it is sent (`native-work-submission.json`, in the program's own state folder; it holds no token), so a request whose answer was lost can be recovered: see where it stands, send it again (the host keeps it once), or drop it so a corrected one can be sent. The input you typed that waits for the host to admit it is kept the same way: see it, send it again, go on with what the host admitted, or drop it. The model and a script reach these as `work.submission`, `work.submission-retry`, `work.submission-discard`, `work.intake`, `work.intake-retry`, `work.intake-resume` and `work.intake-cancel`.

## The checklist

The checklist is the project's running list of things to do. The model keeps it with its `work_plan` tool while it works, and you add to it (`p`), change an item (`Enter`), mark it (`m`), move it on (`o`), take it off (`x`), clear the finished ones (`C`), see it as Markdown (`M`) or save that to a file (`E`). It records things to do and runs nothing; it is a checklist, never a plan. Finished items are removed by themselves once untouched for 30 days or outside the 200 most recently touched.

## What it needs

A connection to the daemon with permission to read and write work. For the daemon on this machine no pairing is needed. See [host pairing](host-pairing.md).
