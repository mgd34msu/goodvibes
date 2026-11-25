# Plans and the checklist

GoodVibes uses two words, and keeps them apart:

- A **plan** belongs to a piece of work: its steps, written by a planning agent from what you asked for and what done means, and what each step waits on. It is opened from the piece of work in the Work place at any time (see [Work](native-work.md)). With "Show me the plan before it runs" on, the plan waits for you before the work starts: change, move or take out a step, have it written again, then approve it (that starts the work with exactly those steps) or throw it away.
- The **checklist** is the project's running list of things to do. The model keeps it with its `work_plan` tool while it works; you keep it in the Work place's Checklist list. It runs nothing.

## Plan mode

Plan mode (the permission mode, `Shift+Tab` or the Plan mode row of This conversation in Permissions and safety) lets the model read and not change anything; it answers with a plan in the conversation and changes nothing until you leave plan mode (the Plan mode row of This conversation in Permissions and safety, or `Shift+Tab`). Plan mode is a mode of the conversation, separate from the plan a piece of work has.

## The checklist

The checklist is kept in one file for all your GoodVibes programs: `~/.goodvibes/work-plans.sqlite`. The terminal app, the Agent and the daemon open it, so a project has one checklist whichever of them edits it; the web UI shows the same list through the daemon. Each item is its own row, the same rows the model keeps with `work_plan`, a spawned worker keeps with its own `work_plan`, and contracts link their steps to. An edit writes only the item it changes, so two programs editing the same project's checklist never overwrite each other. A checklist an earlier build kept in this program's knowledge database is moved into the shared file the first time it is opened.

In the Work place's Checklist list:

| Key | Does |
| --- | --- |
| `p` | Put an item on the checklist (what there is to do, for whom, notes, where it came from) |
| `Enter` | Change the selected item; a detail left empty stays as it is, `-` clears it |
| `m` | Mark it: not started, in progress, blocked, done, failed or cancelled |
| `o` | Move it on one state (not started, in progress, done, then back) |
| `x` | Take it off the checklist (asks first: it cannot be undone) |
| `C` | Clear the finished (done or cancelled) items (asks first) |
| `M` | See the checklist as Markdown |
| `E` | Save that Markdown to a file under `~/.goodvibes/tui/work-plans/` and say where |

The list follows the file: an edit made here, in the Agent, by the daemon or in the web UI shows up without a key. Finished items are removed by themselves once untouched for 30 days, or when they fall outside the 200 most recently touched finished items; failed and blocked items are never removed this way.

## Saved planning records from earlier versions

The planning interview of earlier versions is retired. Its saved records that were brought into the daemon's work are shown in the Work place's History list, with what they asked for and what done meant; they never run by themselves.
