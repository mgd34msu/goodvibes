# Work

Work is one thing, held and run by the daemon: a piece of work has what you asked for, what must be true when it is done, its plan of steps and its results. The terminal app, the Agent, the web UI and a phone show the same work, and it goes on when the window that asked for it closes.

## The Work place

Open it from the menu (`Ctrl+G` then `m`, row "Work and agents"), or with `/work`. It is read by itself when it opens and read again whenever a request, a piece of work, its run or its plan changes anywhere; nothing needs a key to show what is current.

- **Work**: each piece of work by what you asked for and where it stands: not started, its plan waits for you, starting, running, needs you, failed. Its detail shows what you asked for, what done means, its plan as numbered steps with what each waits on ("after 1, 2") and where each step stands, its results, the questions it waits on, its report and what it may spend.
- **History**: finished and stopped work, and work carried in from old planning records, each with its plan, steps and results.
- **Unanswered**: the work you asked for and the message you typed that have no answer from the daemon yet (see "When an answer is lost").
- **Checklist**: the project's running list of things to do (see below).
- **Tasks here** and **Daemon tasks**: what runs in the background, in this program and on the daemon.
- **Runners**, **Runner pools**, **Handed back**: the remote runners the daemon holds.

The keys shown are the ones that apply to the selected item now:

| Key | Does | Shown for |
| --- | --- | --- |
| `s` | Start it | not started |
| `x` | Stop it (asks first: it cannot be undone) | starting, running, needs you, a step failed |
| `t` | Run the failed step again | a step failed |
| `g` | Go on without the failed step | a step failed that no step still to run needs |
| `g` | Go on: the parts that were running run again, finished ones are kept | cut off when the daemon stopped |
| `a` | Answer what it asks | needs you |
| `b` | Change what it may spend | starting, running, needs you, a step failed |
| `v` | Check where it stands | any |
| `Enter` | Approve the plan and start it | its plan waits for you |
| `e`, `d`, `m` | Change, take out or move a step of the plan | its plan waits for you |
| `w` | Write the plan again | its plan waits for you |
| `X` | Throw the plan away (the work stays) | its plan waits for you |
| `n` | New work: what you want done and what done means, or a file that says both | the Work tab |
| `y` | Ask in your own words | the Work tab |
| `v`, `t`, `X` | Check, send again or drop work you asked for that has no answer | Unanswered |
| `v`, `t`, `g`, `X` | Check, try again, go on with or drop a message that has no answer | Unanswered |

A step that fails ends failed at once, with what failed in words (the connection to its model failed and could not be made again, the provider refused, ...); Work runs nothing again by itself, and your permission mode decides what comes next. In Ask me the work stops at that step and waits for one of these keys, asking nobody anything, and a restart of the daemon keeps it waiting there. In every other mode the decision model answers in your place (run it again, go on without it, or not); a step not run again (that answer, no decision model in use, or its third failure) ends the work failed, its line naming the step and what failed. A result that could not be put in the project (a conflict with your own edits, a hook that refuses) is decided the same way: in Ask me it waits for you, in every other mode the decision model puts it in again or not, and not put in, the work ends failed with its result on its own branch. Only a stop someone made reads "stopped": yours, or a decision's. A restart never fails or stops a piece of work: what was running ends with the daemon, and the work waits as cut off until you go on. A change of a step that is held back is said on the work ("Held back"), with what to do. A question the work itself asks in Ask me (its result to accept when no decision model checked it, a conflict it could not combine) is also in Waiting for you; in every other mode it is decided without you (a result no decision model checked is accepted by the rule of the mode, and says so).

Every key can be changed in the Keys place. Opening the place never starts anything, and no key approves anything for you.

## Show me the plan before it runs

Settings, "Show me the plan before it runs" (`planner.showPlanFirst`), off by default. Off: a piece of work you start has its plan written and run, and you can open the plan at any time. On: starting it writes the plan first (a planning agent splits what you asked for and what done means into steps), and the work waits in the Work place as "its plan waits for you": change a step, take one out, move one, or have the plan written again; then approve it (that starts the work with exactly those steps) or throw it away.

## A plan from plan mode

In plan mode the model only reads, but it can propose a piece of work with its plan. The proposal waits in Work as "its plan waits for you", with the same keys: change, move, take out or rewrite a step, approve it (that asks for the work and starts it with exactly that plan) or throw it away (nothing is left). Nothing runs until you approve it.

## Asking for new work

- Say what you want done in the conversation: the daemon decides whether it is an answer or a piece of work.
- New work (`n`) takes what you want done and what must be true when it is done (one line each, 1 to 100), or, in its "From a file" field, a JSON file with exactly `goal` (text) and `criteria` (a list of texts).
- Ask in your own words (`y`) sends your words to the daemon, which answers them or makes them a piece of work.

The goal and the criteria are kept exactly as written: spaces, line breaks, order and repeats. Each is at most 20,000 characters, and the whole request at most 262,144 bytes. Sending new work never starts it.

## When an answer is lost

Work you ask for is saved on this machine before it is sent (`native-work-submission.json`, in the program's own state folder; it holds no token), so work whose answer was lost waits in the Work place's Unanswered list: check it (`v`), send it again (`t`; the daemon keeps it once), or drop it (`X`) so a corrected one can be sent. A message you typed that has no answer waits there the same way: check it, try it again, go on with it, or drop it. The model and a script reach these as `work.submission`, `work.submission-retry`, `work.submission-discard`, `work.intake`, `work.intake-retry`, `work.intake-resume` and `work.intake-cancel`.

## The checklist

The checklist is the project's running list of things to do. The model keeps it with its `work_plan` tool while it works, and you add to it (`p`), change an item (`Enter`), mark it (`m`), move it on (`o`), take it off (`x`), clear the finished ones (`C`), see it as Markdown (`M`) or save that to a file (`E`). It records things to do and runs nothing; it is a checklist, never a plan. Finished items are removed by themselves once untouched for 30 days or outside the 200 most recently touched.

## What it needs

A connection to the daemon with permission to read and write work. For the daemon on this machine no pairing is needed. See [host pairing](host-pairing.md).
