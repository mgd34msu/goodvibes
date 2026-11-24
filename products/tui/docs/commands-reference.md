<!-- GENERATED FILE: DO NOT EDIT BY HAND.
     Regenerate with `bun run docs:commands`.
     Source of truth: the slash-command registry (src/input/commands.ts).
     Only that command rewrites it; rerun it after changing a command. -->

# Command Reference

GoodVibes ships **96** built-in slash commands across **10** categories. Every command below is generated directly from the command registry, so this list is always complete and current. Type a command in the composer prefixed with `/`, or press `Ctrl+P` (or `?`, or run `/help`) to search them all in the command palette.

## Categories

- [Agents and work](#agents-and-work): 14
- [Change code](#change-code): 8
- [Channels and devices](#channels-and-devices): 10
- [Help and setup](#help-and-setup): 7
- [Memory and knowledge](#memory-and-knowledge): 3
- [Models and providers](#models-and-providers): 8
- [Run and check](#run-and-check): 5
- [Sessions and history](#sessions-and-history): 19
- [Settings and safety](#settings-and-safety): 16
- [Tools and extensions](#tools-and-extensions): 6

## Agents and work

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/agents` | None | `open [--target <select>] \| hostable \| host <coding agent> [<folder>] \| team \| start <kind of agent> <what to do...> \| recipe <recipe> <what to do...> \| archetypes \| archetype <archetype> \| start-archetype <archetype> <what to do...> \| hand-off [--review] [--reason <why>] [--success <done when>] [--workspace <where>] [--priority <priority>] <the work...> \| handed-off [<hand-off>] \| contract [<contract>] \| contracts-view \| stop-group <group> \| stop-branch <agent>` | What your agents are doing: open the live view, start agents, host a coding agent, hand work on, and stop work |
| `/checkin` | None | `status \| run` | The proactive check-in: its settings and what each one did, or one now |
| `/cluster` | None | `status [--host <which machine>] [--token <its access token>] \| groups [--host <which machine>] [--token <its access token>] \| create [--name <group name>] [--passphrase <passphrase>] [--host <which machine>] [--token <its access token>] \| join <group> [--key <join key>] [--host <which machine>] [--token <its access token>] \| nodes [--host <which machine>] [--token <its access token>] \| key [--qr] [--host <which machine>] [--token <its access token>] \| rename [--host <which machine>] [--token <its access token>] <new name...> \| rotate [--now] [--host <which machine>] [--token <its access token>] \| forget <machine> [--host <which machine>] [--token <its access token>] \| leave [--host <which machine>] [--token <its access token>] \| publish <shared setting> [--host <which machine>] [--token <its access token>] \| accept <shared setting> [--host <which machine>] [--token <its access token>]` | Share inbound channel work with your other goodvibes machines on this network |
| `/communication` | None | None | The routes agents talk to each other over, and their recent messages |
| `/context` | None | `show \| files \| given \| window \| set-window <size> \| clear-window` | What fills the model's context, and how large its window is |
| `/graph` | None | `<workstream>` | See how a workstream's steps depend on each other and where it is stuck |
| `/plan` | None | `status \| on \| off` | Plan without changing anything: writes, commands and network calls are blocked for this session |
| `/schedule` | None | `list \| add [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--target <where it runs>] [--model <model>] [--provider <provider>] [--deliver <answer goes to>] [--allow-unsafe-external-content] [--external-source <outside source>] [--reasoning <how hard it thinks>] [--thinking <thinking>] [--wake <when it wakes>] [--fallback <fallback models>] [--tool <tools it may use>]... [--template <template>] [--light-context] [--paused] <what it does...> \| run <schedule> \| pause <schedule> \| resume <schedule> \| stop-run <run> \| retry-run <run> \| change <schedule> [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--task <or a task>] [--success-criteria <done when>] [<what it does...>] \| remove <schedule>` | Run something at set times, with or without the app open |
| `/settings` | None | `open [<where...>] \| list [<matching...>] \| get <setting> \| set <setting> <value...> \| reset <setting>` | See and change every setting |
| `/tasks` | None | `list [--status <only>] [--kind <kind>] \| processes \| open \| show <task> \| output <task> \| create <kind> <owner> <title...> \| start <task> \| update <task> <what changes> <new text...> \| complete <task> [<result...>] \| fail <task> <what went wrong...> \| pause <task> [<note...>] \| resume <task> [<note...>] \| cancel <task> [<note...>] \| retry <task> [<note...>]` | The work running here and on the daemon: see it, start it, finish it, pause or cancel it |
| `/todo` | None | `list \| open \| markdown \| export \| add [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...> \| edit <item> [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...> \| mark <item> <state> \| next <item> \| remove <item> \| clear-done` | Keep this project's to-do list |
| `/triggers` | None | `list \| watch <name> [--definition <definition>] [--match <lines that match>] [--url <address>] [--file <file>] [--every <how often>] [--say <tell the agent>] [--deliver <answer goes to>] [--run <command to run>] [-- <command>...] \| history <trigger> [--count <how many>] \| stop <trigger> \| restart <trigger> \| commands \| allow-command <name> [-- <command>...]` | Act when something happens |
| `/verbosity` | None | `show \| set <print level> \| set-domain <kind of notification> <how much of it>` | Set how much the app prints: quiet, balanced or operator |
| `/workstream` | None | `list \| status <workstream> \| start <request...> \| stop <workstream> \| answer <workstream> <question> <answer...> \| retry <workstream> <step> \| budget <workstream> <most it may spend> \| plan <goal...> \| plans \| show <plan> \| replan <plan> <new goal...> \| edit <plan> <step> <what the step does...> \| drop <plan> <step> \| move <plan> <step> [--to <new position>] \| approve <plan> \| launch <plan> \| discard <plan>` | Plan, start, follow and steer work that runs in steps |

### /agents: Your agents

`/agents` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Open Your agents | `/agents open [--target <select>]` | Opens the live view of what is running, what waits for you and what is scheduled. | None |
| See coding agents you can host | `/agents hostable` | Lists the third-party coding agents found on this machine (Claude Code, Codex, opencode) that can be hosted. | None |
| Host a coding agent | `/agents host <coding agent> [<folder>]` | <coding agent> starts as a long-running session in the folder given and shows as a row in Your agents, where you steer and stop it. | None |
| See team modes and recipes | `/agents team` | Shows the team modes and recipes you can start agents from, with the tasks running now. | None |
| Start an agent in a team mode | `/agents start <kind of agent> <what to do...>` | An agent (<kind of agent>) starts on "<what to do>" in this session; Your agents shows its progress. | None |
| Run a recipe of agents | `/agents recipe <recipe> <what to do...>` | The <recipe> recipe runs on "<what to do>": each step starts when the one before it finished, and a step that fails stops the rest. | None |
| See agent archetypes | `/agents archetypes` | Lists the built-in and project agent archetypes, their family, and any that have problems to fix. | None |
| See one archetype | `/agents archetype <archetype>` | Shows archetype <archetype>: its family, how it works, its tools, where it is defined and its problems. | None |
| Start an agent from an archetype | `/agents start-archetype <archetype> <what to do...>` | An agent from archetype <archetype> starts on "<what to do>" in this session; Your agents shows its progress. | None |
| Hand coding work to the terminal app | `/agents hand-off [--review] [--reason <why>] [--success <done when>] [--workspace <where>] [--priority <priority>] <the work...>` | "<the work>" goes to the terminal app as a new shared session on the connected host, which asks before it changes anything. | None |
| See work you handed off | `/agents handed-off [<hand-off>]` | Shows the work you handed off <hand-off>, with its session, whether it was taken, and its latest answer. | None |
| See a work contract | `/agents contract [<contract>]` | Shows work contract <contract>: what was asked, its state, and its groups and units. | None |
| Open the work contracts view | `/agents contracts-view` | Opens the full-screen view of work contracts and the agents running them. | None |
| Stop a group of agents | `/agents stop-group <group>` | Every agent still running in group <group> is stopped. | cannot be undone |
| Stop an agent and the agents it started | `/agents stop-branch <agent>` | Agent <agent> and every agent it started, and they started, are stopped. | cannot be undone |

### /checkin: Check-ins

`/checkin` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See check-in settings and what they did | `/checkin status` | Shows whether check-ins are on, when they run and where they go, and the last ten check-ins: quiet, delivered or skipped. | None |
| Check in now | `/checkin run` | One check-in runs now: it reads how things stand and, when something needs you, sends a message to the check-in channel. | sends something outside this machine |

### /cluster: Cluster

`/cluster` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See this machine's group | `/cluster status [--host <which machine>] [--token <its access token>]` | Shows the group this machine is in, its members and its key's age. | None |
| See the groups on this network | `/cluster groups [--host <which machine>] [--token <its access token>]` | Shows the groups other machines on this network announce. | None |
| Start a group on this network | `/cluster create [--name <group name>] [--passphrase <passphrase>] [--host <which machine>] [--token <its access token>]` | A new group is started on this machine, until you change it; other machines join it with its key. | None |
| Join a group | `/cluster join <group> [--key <join key>] [--host <which machine>] [--token <its access token>]` | This machine joins <group> and shares inbound channel work with its members, until you change it. | sends something outside this machine |
| See the machines in the group | `/cluster nodes [--host <which machine>] [--token <its access token>]` | Shows each machine in the group, when it was last seen and what it serves. | None |
| See the key others join with | `/cluster key [--qr] [--host <which machine>] [--token <its access token>]` | Shows the group's join key; anyone with it can join the group. | None |
| Rename the group | `/cluster rename [--host <which machine>] [--token <its access token>] <new name...>` | The group is named "<new name>" on every machine, until you change it. | None |
| Change the group's join key | `/cluster rotate [--now] [--host <which machine>] [--token <its access token>]` | The group gets a new join key, until you change it; machines pick it up on their own. | None |
| Remove a machine from the group | `/cluster forget <machine> [--host <which machine>] [--token <its access token>]` | <machine> is removed from the group and the group key is replaced at once. | cannot be undone |
| Leave the group | `/cluster leave [--host <which machine>] [--token <its access token>]` | This machine leaves its group; joining again needs the key. | cannot be undone |
| Share a setting with the group | `/cluster publish <shared setting> [--host <which machine>] [--token <its access token>]` | <shared setting> on every machine in the group is replaced with this machine's value (for user:<name>, this machine's account becomes the group's and the others end). | cannot be undone |
| Take the group's value of a setting | `/cluster accept <shared setting> [--host <which machine>] [--token <its access token>]` | This machine's <shared setting> is replaced with the group's (for user:<name>, this machine's account of that name ends). | cannot be undone |

### /communication: Agent communication

`/communication` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Open agent communication | `/communication` | Opens the view of the routes agents talk over and their recent messages. | None |

### /context: Context

`/context` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what fills the context | `/context show` | Shows how many tokens each message of this conversation takes, and the total. | None |
| See the project instruction files | `/context files` | Lists the project instruction files (AGENTS.md, CLAUDE.md and the like) read into each turn, any cut short, and any held back with why. | None |
| See what the last turns were given | `/context given` | Shows, for the last turns, how many memories, personas, skills and routines were given to the model, how many were left out, and roughly how many tokens it took. | None |
| See the context window size | `/context window` | Shows the current model's context window: what it says, any size you set and any limit learned from the provider. | None |
| Set the context window size | `/context set-window <size>` | The current model's context window will be taken as <size> tokens until you change it. | None |
| Go back to the automatic window size | `/context clear-window` | The size you set and any limit learned for the current model are cleared, and its own window size applies until you change it. | None |

### /graph: Workstream task graph

`/graph` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See a workstream's task graph | `/graph <workstream>` | Shows <workstream>'s steps, what each waits on, which are stuck, and how many run at once. | None |

### /plan: Plan mode (nothing is changed)

`/plan` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See whether plan mode is on | `/plan status` | Says whether plan mode is on, and the mode in force. | None |
| Turn plan mode on | `/plan on` | Writes, commands and network calls are blocked for this session only; your saved mode is not changed. | None |
| Turn plan mode off | `/plan off` | Writes, commands and network calls are allowed again under the mode you had before, for this session only. | loosens a protection |

### /schedule: Schedules

`/schedule` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your schedules | `/schedule list` | Shows each schedule: its name, when it runs, its next and last run, and what it does. | None |
| Schedule something to run | `/schedule add [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--target <where it runs>] [--model <model>] [--provider <provider>] [--deliver <answer goes to>] [--allow-unsafe-external-content] [--external-source <outside source>] [--reasoning <how hard it thinks>] [--thinking <thinking>] [--wake <when it wakes>] [--fallback <fallback models>] [--tool <tools it may use>]... [--template <template>] [--light-context] [--paused] <what it does...>` | "<what it does>" will run at the times you gave, whether or not this app is open, until you change it. | None |
| Run a schedule now | `/schedule run <schedule>` | <schedule> will run once now; its usual times stay as they are. | None |
| Pause a schedule | `/schedule pause <schedule>` | <schedule> will not run until you change it; it is kept, and Resume a schedule starts it again. | None |
| Resume a schedule | `/schedule resume <schedule>` | <schedule> will run again at its next time, until you change it. | None |
| Stop a run that is going | `/schedule stop-run <run>` | Run <run> is stopped; its schedule keeps its usual times. | cannot be undone |
| Run a failed run again | `/schedule retry-run <run>` | Run <run> runs again as a new run; its schedule keeps its usual times. | None |
| Change a schedule | `/schedule change <schedule> [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--task <or a task>] [--success-criteria <done when>] [<what it does...>]` | <schedule> will run with what you changed, until you change it again. | None |
| Remove a schedule | `/schedule remove <schedule>` | <schedule> will stop running and be removed. | cannot be undone |

### /settings: Settings

`/settings` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Open settings | `/settings open [<where...>]` | Opens settings at <where>. | None |
| List settings as text | `/settings list [<matching...>]` | Shows every setting matching <matching>, with its value. | None |
| See one setting | `/settings get <setting>` | Shows <setting>: its value, where it is set, and what it does. | None |
| Change a setting | `/settings set <setting> <value...>` | <setting> will hold the value given until you change it; a password or key goes to the secret store, never into a settings file. | None |
| Put a setting back to its default | `/settings reset <setting>` | <setting> goes back to its default until you change it. | None |

### /tasks: Tasks

`/tasks` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your tasks | `/tasks list [--status <only>] [--kind <kind>]` | Shows the tasks here and on the daemon, newest first, with their state, kind and owner. | None |
| See commands running in the background | `/tasks processes` | Lists the commands running in the background here, which have finished, and whether a running one can be given input, a terminal, or sudo. | None |
| Open the tasks view | `/tasks open` | Opens the live view of tasks and agents. | None |
| See one task | `/tasks show <task>` | Shows task <task>: its state, owner, times, parent and children, and where it runs. | None |
| See what a task produced | `/tasks output <task>` | Shows the result of task <task>, or its error. | None |
| Add a task to run here | `/tasks create <kind> <owner> <title...>` | Task <title> (<kind>, for <owner>) is added to this terminal and waits to be started, until you change it. | None |
| Start a waiting task | `/tasks start <task>` | Task <task> starts now, until you change it. | None |
| Change a task's title, description or result | `/tasks update <task> <what changes> <new text...>` | The <what changes> of task <task> becomes "<new text>", until you change it. | None |
| Mark a task done | `/tasks complete <task> [<result...>]` | Task <task> is marked done, until you change it. | None |
| Mark a task failed | `/tasks fail <task> <what went wrong...>` | Task <task> is marked failed with "<what went wrong>", until you change it. | None |
| Pause a task | `/tasks pause <task> [<note...>]` | Task <task> waits where it is, until you change it. | None |
| Resume a paused task | `/tasks resume <task> [<note...>]` | Task <task> goes on from where it waited, until you change it. | None |
| Cancel a task | `/tasks cancel <task> [<note...>]` | Task <task> is stopped and marked cancelled. | cannot be undone |
| Run a failed task again | `/tasks retry <task> [<note...>]` | Task <task> is queued to run again, until you change it. | None |

### /todo: To-do list

`/todo` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your to-do list | `/todo list` | Shows every item on the to-do list with its state. | None |
| Open the to-do panel | `/todo open` | Opens the to-do list as a panel you can move through with the keys. | None |
| See it as a Markdown checklist | `/todo markdown` | Shows the to-do list as a Markdown checklist. | None |
| Save it as a Markdown file | `/todo export` | Writes the to-do list as a Markdown checklist into this project and says where. | None |
| Add an item | `/todo add [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...>` | "<title>" is added to your to-do list until you change it. | None |
| Change an item | `/todo edit <item> [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...>` | Item <item> becomes "<title>", with the other details you gave, until you change it. | None |
| Mark an item done, blocked or another state | `/todo mark <item> <state>` | Item <item> is marked <state> until you change it. | None |
| Move an item to its next state | `/todo next <item>` | Item <item> moves on one state (not started, in progress, done, then back to not started) until you change it. | None |
| Remove an item | `/todo remove <item>` | Item <item> is deleted from your to-do list. | cannot be undone |
| Remove the finished items | `/todo clear-done` | Every item that is done or cancelled is deleted from your to-do list. | cannot be undone |

### /triggers: Triggers

`/triggers` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your triggers | `/triggers list` | Shows who supervises the triggers and each trigger: what it watches, its state and how often it fired. | None |
| Watch for something | `/triggers watch <name> [--definition <definition>] [--match <lines that match>] [--url <address>] [--file <file>] [--every <how often>] [--say <tell the agent>] [--deliver <answer goes to>] [--run <command to run>] [-- <command>...]` | <name> will watch what you gave and act each time it fires, until you change it. | None |
| See what a trigger did | `/triggers history <trigger> [--count <how many>]` | Shows the newest runs of <trigger>: when, the outcome, and how a watched command ended. | None |
| Stop a trigger | `/triggers stop <trigger>` | <trigger> will stop watching, and a command it started is stopped. | cannot be undone |
| Start a trigger that gave up | `/triggers restart <trigger>` | <trigger>, which stopped after repeated failures, will watch again until you change it; fix what made it fail first. | None |
| See commands triggers may run | `/triggers commands` | Shows each command you let triggers run, with the digest a trigger names. | None |
| Let triggers run a command | `/triggers allow-command <name> [-- <command>...]` | A trigger may run <command> as <name> when it fires, with nobody asked, until you change it. | loosens a protection |

### /verbosity: How much the app prints

`/verbosity` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See how much the app prints | `/verbosity show` | Shows the print level, what it does, and any kind of notification set on its own. | None |
| Set how much the app prints | `/verbosity set <print level>` | The app prints at the <print level> level until you change it. | None |
| Set one kind of notification's level | `/verbosity set-domain <kind of notification> <how much of it>` | Notifications of <kind of notification> are shown at <how much of it> for this session only. | None |

### /workstream: Workstreams

`/workstream` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your workstreams | `/workstream list` | Shows every workstream of this session with its state. | None |
| See how a workstream is going | `/workstream status <workstream>` | Shows <workstream>'s steps, their state, its spending limit and any question it is waiting on. | None |
| Start work on a request | `/workstream start <request...>` | Starts a workstream for "<request>" now; it runs in steps until it finishes or you stop it. | None |
| Stop a workstream | `/workstream stop <workstream>` | <workstream> will stop; steps that are running are cancelled and it cannot be resumed. | cannot be undone |
| Answer a workstream's question | `/workstream answer <workstream> <question> <answer...>` | <workstream> gets your answer to <question>: "<answer>". It goes on from there until you change it. | None |
| Run a step of a workstream again | `/workstream retry <workstream> <step>` | Step <step> of <workstream> runs again now. | None |
| Change a workstream's spending limit | `/workstream budget <workstream> <most it may spend>` | <workstream> may spend up to $<most it may spend> in all, until you change it. | spends money |
| Plan work before it runs | `/workstream plan <goal...>` | A plan for "<goal>" is made and kept until you change it; nothing runs until you approve and launch it. | None |
| See your plans | `/workstream plans` | Shows every plan, whether it is approved, and how many steps it has. | None |
| See a plan | `/workstream show <plan>` | Shows <plan>'s steps and how it was split. | None |
| Plan again from a new goal | `/workstream replan <plan> <new goal...>` | <plan> is planned again from "<new goal>", replacing its steps, until you change it. | None |
| Change a step of a plan | `/workstream edit <plan> <step> <what the step does...>` | Step <step> of <plan> will do "<what the step does>", until you change it. | None |
| Take a step out of a plan | `/workstream drop <plan> <step>` | Step <step> is taken out of <plan>, until you change it. | None |
| Move a step of a plan | `/workstream move <plan> <step> [--to <new position>]` | Step <step> of <plan> moves to position <new position>, until you change it. | None |
| Approve a plan | `/workstream approve <plan>` | <plan> is marked approved, ready to launch, until you change it. | None |
| Launch an approved plan | `/workstream launch <plan>` | <plan> starts now as a workstream; it runs in steps until it finishes or you stop it. | None |
| Throw a plan away | `/workstream discard <plan>` | <plan> and its steps are deleted. | cannot be undone |

## Change code

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/changes` | None | `[<which changes>]` | Changed files with their diff: stage hunks, comment for the model, mark reviewed |
| `/checkpoint` | None | `list \| make [<name...>] \| restore <checkpoint> \| rewind <turn> [<what goes back>]` | Snapshots of the workspace's files: see them, make one, put the files back, or go back to an earlier turn |
| `/codebase` | None | `status \| build \| search [--limit <how many>] <words...>` | This project's code index: how it stands, build it, and search it |
| `/editor` | None | None | Write the message in your own editor, then come back with it |
| `/git` | None | `status \| log \| diff \| init \| commit` | The repository this session runs in: what changed, recent commits, and committing every change |
| `/intelligence` | None | `review \| diagnostics [<file>] \| symbols <file> \| outline <file> \| definition <file> <line> [--column <column>] \| references <file> <line> [--column <column>] \| hover <file> <line> [--column <column>] \| install <language>` | Look up symbols, definitions and references in your code, install the language server a language needs, and see what is ready |
| `/review` | None | None | Review this session's file changes hunk by hunk: comment to steer the model, or revert a hunk |
| `/worktree` | None | `review \| open \| inspect <worktree> \| setup <worktree> \| attach <worktree> <its id> [--to <attached to>] \| attached <attached to> <its id> \| recover <attached to> <its id> \| pause <worktree> \| resume <worktree> \| keep <worktree> \| discard <worktree> \| cleanup <worktree>` | See and look after the git worktrees parallel work runs in |

### /changes: Changes

`/changes` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See changed files and their diff | `/changes [<which changes>]` | Opens the Changes view with the changed files and their diff. | None |

### /checkpoint: Checkpoints

`/checkpoint` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your checkpoints | `/checkpoint list` | Lists the workspace checkpoints, newest first, with how old each is and how much it added. | None |
| Make a checkpoint now | `/checkpoint make [<name...>]` | The workspace's files as they are now are kept as a checkpoint, held longer than the automatic ones; nothing changes in the files. | None |
| Put the files back to a checkpoint | `/checkpoint restore <checkpoint>` | The workspace's files go back to checkpoint <checkpoint>; the current files are kept as a checkpoint first, which /checkpoint restore brings back, and the conversation is unchanged. | None |
| Go back to an earlier turn | `/checkpoint rewind <turn> [<what goes back>]` | What changed after turn <turn> is taken back (<what goes back>): messages after it are dropped and files go back to how they were then. /undo rewind brings them back only while no new message has been added. | cannot be undone |

### /codebase: Code index

`/codebase` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See how the code index stands | `/codebase status` | Shows what is indexed, how search results are found, what was skipped, and the last build and reindex. | None |
| Build the code index | `/codebase build` | The code index of this project is built in the background; Your agents shows it under Background services while it runs. | None |
| Search the code index | `/codebase search [--limit <how many>] <words...>` | Finds the parts of this project's code that match <words>, each labelled semantic or lexical. | None |

### /editor: Write in your editor

`/editor` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Write the message in your editor | `/editor` | Opens the message you are writing in $VISUAL or $EDITOR; when you close it, the text comes back here. | None |

### /git: Git

`/git` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what changed | `/git status` | Shows the files that are staged, changed, new or deleted, and what committing every change would include. | None |
| See recent commits | `/git log` | Shows the last ten commits: short hash, date and message. | None |
| See changes not yet staged | `/git diff` | Counts the changes not yet staged and opens them in the Changes view, where hunks can be staged. | None |
| Start a repository here | `/git init` | A new, empty git repository is created in this folder and kept until you change it. | None |
| Commit every change | `/git commit` | Every change in this repository, new files included, is committed as one commit (only the staged files, when some are staged), which stays in its history until you change it. | None |

### /intelligence: Code intelligence

`/intelligence` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what code intelligence is ready | `/intelligence review` | Shows whether problems, symbols and hover answers are ready, the language servers and their state, the problems tracked, and what to run when something is not ready. | None |
| See the problems in a file | `/intelligence diagnostics [<file>]` | Shows the errors and warnings tracked for the file named. | None |
| See the symbols in a file | `/intelligence symbols <file>` | Lists the symbols of <file>, from its language server or, without one, from its syntax tree. | None |
| See the outline of a file | `/intelligence outline <file>` | Shows the outline of <file>: its declarations and their lines. | None |
| Find where a symbol is defined | `/intelligence definition <file> <line> [--column <column>]` | Finds where the symbol at line <line>, column <column> of <file> is defined. | None |
| Find where a symbol is used | `/intelligence references <file> <line> [--column <column>]` | Finds every use of the symbol at line <line>, column <column> of <file>. | None |
| See what a symbol is | `/intelligence hover <file> <line> [--column <column>]` | Shows the type and documentation of the symbol at line <line>, column <column> of <file>. | None |
| Install the language server for a language | `/intelligence install <language>` | The language server for <language> is downloaded into your GoodVibes bin folder, and code lookups use it from then on, until you change it. | None |

### /review: Review this session's changes

`/review` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Review this session's changes | `/review` | Opens this session's file changes hunk by hunk: c comments on a hunk, Enter sends the comments to the model, x reverts a hunk at once (its receipt says how to undo it). | None |

### /worktree: Worktrees

`/worktree` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your worktrees | `/worktree review` | Shows every worktree with its state, branch, age, size and why it is kept. | None |
| Open the worktrees in Agents | `/worktree open` | Opens Agents on the worktree list. | None |
| See one worktree | `/worktree inspect <worktree>` | Shows <worktree>'s state, owner, session, task, setup and what to do next. | None |
| Run a worktree's setup again | `/worktree setup <worktree>` | The cold-start setup (worktree.setup.commands and carried-over files) runs again in <worktree>. | None |
| Tie a worktree to a session or task | `/worktree attach <worktree> <its id> [--to <attached to>]` | <worktree> is tied to <attached to> <its id> until you change it. | None |
| See a session's or task's worktrees | `/worktree attached <attached to> <its id>` | Shows the worktrees tied to <attached to> <its id> and their states. | None |
| See how to recover a session's or task's worktrees | `/worktree recover <attached to> <its id>` | Shows the worktrees tied to <attached to> <its id> and the line that brings each back. | None |
| Pause a worktree | `/worktree pause <worktree>` | <worktree> is marked paused until you change it. | None |
| Resume a worktree | `/worktree resume <worktree>` | <worktree> is marked active again until you change it. | None |
| Keep a worktree | `/worktree keep <worktree>` | <worktree> is marked kept, so the retention sweep leaves it, until you change it. | None |
| Remove a worktree | `/worktree discard <worktree>` | <worktree> is removed from disk; its branch is kept and anything uncommitted is saved on it first. | cannot be undone |
| Stop tracking a worktree that is gone | `/worktree cleanup <worktree>` | <worktree>'s tracking record is removed; use it once the worktree itself is gone. | cannot be undone |

## Channels and devices

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/calendar` | None | `upcoming [--days <how many days>] \| get <event> \| add [--title <title>] [--start <starts>] [--end <ends>] [--location <where>] [--notes <notes>] [--again] \| change <event> [--title <title>] [--start <starts>] [--end <ends>] \| delete <event> \| status \| all \| import <file> \| export [<file>] \| accounts \| connect <account> [--with <sign in with>] [--code <address or code>] \| use-app <account> <client id> [--secret <client secret>] \| disconnect <account> \| subscriptions \| subscribe [<feed address>] [--name <name>] [--every <read every>] [--allow-private-host] \| refresh [<feed>] \| unsubscribe <feed>` | See what is coming up, add, change and remove events, and the feeds and accounts your calendar reads |
| `/channels` | None | `status \| readiness [--show <show>] \| configured <channel> \| guide [<channel>] \| setup <channel> \| doctor <channel> \| test <channel> \| accounts \| rules [<channel>] \| set-rules <channel> [--enabled <accept messages>] [--require-mention <only when mentioned>] [--commands-without-mention <commands without a mention>] [--allow-dms <direct messages>] [--allow-groups <group messages>] [--allow-threads <thread messages>] [--dm-policy <direct messages from others>] [--group-policy <groups not on the list>] [--open <open to anyone>] [--allow-users <users>] [--allow-channels <conversations>] [--allow-group-ids <groups>] [--allowed-commands <commands>] \| profiles \| profile <channel> [<one conversation>] \| set-profile <channel> [<one conversation>] [--model <model>] [--provider <provider>] [--permission-mode <permission mode>] \| remove-profile <channel> [<one conversation>] \| triage [--limit <how many>] \| send [--channel <to>] [--title <title>] [--route <route>] [--webhook <webhook address>] [--link <link>] <message...> \| deliveries [--limit <how many>] \| overview \| routes \| delivery \| open \| telegram-cursor` | Your channels (Slack, Telegram, ntfy, ...): their state and setup, who may reach the assistant, and what each one's sessions get |
| `/cloudflare` | None | `status \| setup \| requirements [--component <also use>]... [--no-component <leave out>]... [--all] \| create-token [--bootstrap-token <bootstrap token>] [--bootstrap-env <bootstrap variable>] [--component <also use>]... [--no-component <leave out>]... [--all] [--account <account>] [--zone-id <zone id>] [--zone <zone>] [--new] \| discover [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--component <also use>]... [--no-component <leave out>]... [--all] [--zone-id <zone id>] [--zone <zone>] [--fast] \| validate [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] \| provision [--component <also use>]... [--no-component <leave out>]... [--all] [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--zone-id <zone id>] [--zone <zone>] [--daemon-url <daemon address>] [--daemon-hostname <daemon hostname>] [--worker-name <worker name>] [--worker-subdomain <worker subdomain>] [--worker-hostname <worker hostname>] [--worker-url <worker address>] [--worker-cron <worker schedule>] [--batch-mode <batch mode>] [--queue <queue>] [--dlq <dead-letter queue>] [--tunnel-name <tunnel name>] [--tunnel-id <tunnel id>] [--tunnel-service-url <tunnel target>] [--tunnel-token-ref <tunnel token reference>] [--access-app-id <access app>] [--access-service-token-id <access service token>] [--access-service-token-ref <access token reference>] [--kv-namespace-name <kv namespace>] [--kv-namespace-id <kv namespace id>] [--do-namespace-name <durable objects namespace>] [--r2-bucket-name <r2 bucket>] [--secrets-store-name <secrets store>] [--secrets-store-id <secrets store id>] [--operator-token <operator token>] [--operator-token-ref <operator token reference>] [--worker-client-token <worker client token>] [--worker-client-token-ref <worker client token reference>] [--no-verify] [--no-store-token] [--no-workers-dev] \| verify [--worker-url <worker address>] [--worker-token <worker token>] [--worker-token-ref <worker token reference>] \| disable [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--worker-name <worker name>] [--bootstrap-token <bootstrap token>] [--bootstrap-env <bootstrap variable>] [--keep-cron] [--keep-worker-subdomain]` | Set up, check and turn off the optional Cloudflare integration for batches and remote work |
| `/devices` | None | `list \| pair <what to pair> <channel> [--name <name>] [--bootstrap-shared] [--apply] \| rename <device> <new name...> \| revoke <device> \| migrate-shared [<name...>] \| revoke-shared \| host-status \| unpair-host \| relay-status \| relay-codes \| relay-revoke <relay code> \| requests \| approve <request> [--replace] \| reject <request> \| nodes \| grants \| revoke-grant <grant> \| captures \| delete-capture <capture>` | Pair a device, this terminal, a relay device or a chat channel, and see and revoke what is paired |
| `/mail` | None | `status \| list [<how many>] \| read <message> \| draft <to> [--subject <subject>] <message...> \| send <to> [--subject <subject>] [--again] <message...> \| settings \| set <setting> <value...> \| password [<password>]` | Read your inbox, write a draft and send mail, from the mailbox set up under surfaces.email |
| `/notifications` | None | None | Every notice and notification in full, newest first; Enter goes to its subject |
| `/notify` | None | `list [--show] \| add [<address>] \| remove <address> \| clear \| test \| send <message...> \| failed \| resend <which> [--to-current]` | The webhook addresses (ntfy.sh format) notifications go to: add, remove, test, send, and resend the ones that failed |
| `/remote` | None | `list \| open \| show [<connection>] \| contract <runner> \| supervisor [<runner>] \| capabilities [<runner>] \| recover [<runner>] \| stop <connection> \| dispatch [--template <kind of agent>] <task...> \| dispatch-pool <pool> [--template <kind of agent>] <task...> \| pools \| pool <pool> \| create-pool <pool id> [<label...>] \| assign <pool> <runner> \| unassign <pool> <runner> \| artifacts \| review <artifact> \| export <runner> [--to <file>] \| artifact-export <artifact> [--to <file>] \| rerun-local <artifact> \| import <file> \| setup \| setup-export <file> \| env \| env-export <file> \| tunnel \| tunnel-export <file> \| bootstrap-export <file> \| bootstrap-inspect <file> \| session-export <file> \| session-inspect <file> \| session-import <file>` | Run work on self-hosted runners and review what they hand back |
| `/scan` | None | None | Look for model servers on this computer and your local network, and add what is found |
| `/telegram` | None | `list \| configure <chat> <bot> [--hold <each message waits>] [--for <hold the chat for>] \| approve <message> [--keep <keep the original>] [--record <keep the review>] \| deny <message> \| status <message> \| read <message> \| cancel <message> \| revoke <configuration> \| release <chat>` | Hold a Telegram chat's messages for your decision, decide each one, and read and close the reviews |

### /calendar: Calendar

`/calendar` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what is coming up | `/calendar upcoming [--days <how many days>]` | Lists the events of the days ahead, from every calendar this program reads. | None |
| See one event | `/calendar get <event>` | Shows <event> with its times, place, guests and notes. | None |
| Add an event | `/calendar add [--title <title>] [--start <starts>] [--end <ends>] [--location <where>] [--notes <notes>] [--again]` | "<title>" starting <starts> is added to the calendar, until you change it; a shared calendar tells its guests. | None |
| Change an event | `/calendar change <event> [--title <title>] [--start <starts>] [--end <ends>]` | <event> changes to what you gave, until you change it again; its guests are told. | sends something outside this machine |
| Remove an event | `/calendar delete <event>` | <event> is removed from the calendar; a shared calendar tells its guests. | cannot be undone |
| See whether the calendar is connected | `/calendar status` | Shows whether the daemon's calendar is set up and reachable, and what to do next if not. | None |
| See every event | `/calendar all` | Lists every event this program keeps, with the events of the feeds you subscribe to. | None |
| Import events from a file | `/calendar import <file>` | The events in <file> are added; one already imported is skipped. | None |
| Export events to a file | `/calendar export [<file>]` | Every event is written as iCalendar to the file you name, or shown here. | None |
| See your calendar accounts | `/calendar accounts` | Lists the calendar accounts this program is signed in to and whether each still works. | None |
| Sign in to a calendar account | `/calendar connect <account> [--with <sign in with>] [--code <address or code>]` | This program signs in to your <account> calendar and reads it, until you change it. | None |
| Use your own calendar app to sign in | `/calendar use-app <account> <client id> [--secret <client secret>]` | Signing in to your <account> calendar uses your own app, client id <client id>, until you change it; then sign in with /calendar connect. | None |
| Sign out of a calendar account | `/calendar disconnect <account>` | This program signs out of your <account> calendar and forgets its sign-in. | cannot be undone |
| See the feeds you subscribe to | `/calendar subscriptions` | Lists each calendar feed, its masked address, how it is doing and how often it is read. | None |
| Subscribe to a calendar feed | `/calendar subscribe [<feed address>] [--name <name>] [--every <read every>] [--allow-private-host]` | Read now. It is read again whenever your calendar is shown and this feed is more than <read every> minutes old; its events show read-only beside yours, until you change it. | None |
| Read the feeds again now | `/calendar refresh [<feed>]` | Each feed, or the one you name, is read again now. | None |
| Stop subscribing to a feed | `/calendar unsubscribe <feed>` | <feed> is removed with its events and its stored address. | cannot be undone |

### /channels: Channels

`/channels` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your channels | `/channels status` | Lists each channel the daemon has, whether it is on and whether it is ready. | None |
| See which channels are set up | `/channels readiness [--show <show>]` | Lists the channels this program can send to, what each is missing and where it sends. | None |
| See how one channel is configured | `/channels configured <channel>` | Shows which settings <channel> has and lacks and what to do next; no secret value is shown. | None |
| Walk through setting up channels | `/channels guide [<channel>]` | Shows the setup steps, done and left, starting with the next channel to set up. | None |
| See what a channel needs to be set up | `/channels setup <channel>` | Lists the settings and secrets <channel> needs; no value is shown. | None |
| Check a channel that isn't working | `/channels doctor <channel>` | Runs the daemon's checks on <channel> and lists the repairs it offers; nothing is repaired. | None |
| Send a test message through a channel | `/channels test <channel>` | The daemon sends a real test message through <channel> and reports whether it was delivered. | sends something outside this machine |
| See the accounts behind your channels | `/channels accounts` | Lists each channel account, whether it is configured, linked and signed in; no secret is shown. | None |
| See who may reach the assistant | `/channels rules [<channel>]` | Shows the daemon's rules for who may write to the assistant on each channel, or on <channel>. | None |
| Change who may reach the assistant | `/channels set-rules <channel> [--enabled <accept messages>] [--require-mention <only when mentioned>] [--commands-without-mention <commands without a mention>] [--allow-dms <direct messages>] [--allow-groups <group messages>] [--allow-threads <thread messages>] [--dm-policy <direct messages from others>] [--group-policy <groups not on the list>] [--open <open to anyone>] [--allow-users <users>] [--allow-channels <conversations>] [--allow-group-ids <groups>] [--allowed-commands <commands>]` | Who may write to the assistant on <channel> changes to what you gave, until you change it. | loosens a protection |
| See channel profiles | `/channels profiles` | Lists the model and permission mode each channel's sessions are given. | None |
| See what one channel's sessions get | `/channels profile <channel> [<one conversation>]` | Shows the profile of <channel> and the model and permission mode its sessions get, with where each comes from. | None |
| Give a channel its own model or permission mode | `/channels set-profile <channel> [<one conversation>] [--model <model>] [--provider <provider>] [--permission-mode <permission mode>]` | Sessions from <channel> get the model and permission mode you gave, until you change it. | None |
| Remove a channel's profile | `/channels remove-profile <channel> [<one conversation>]` | Sessions from <channel> get the host's defaults again, until you change it. | None |
| See what came in on your channels | `/channels triage [--limit <how many>]` | Lists the newest messages on your channels and what each needs. | None |
| Send a message to a channel | `/channels send [--channel <to>] [--title <title>] [--route <route>] [--webhook <webhook address>] [--link <link>] <message...>` | "<message>" is sent to the channel you named, or to the default target. | sends something outside this machine |
| See what was sent to channels | `/channels deliveries [--limit <how many>]` | Lists the newest confirmed sends and whether each was delivered. | None |
| See what the channels carry | `/channels overview` | Shows the active route families, sessions, tasks, waiting approvals and remote contracts. | None |
| See the active routes | `/channels routes` | Lists each active route binding of the channels. | None |
| See how outbound messages are delivered | `/channels delivery` | Shows the outbound delivery snapshot of each channel. | None |
| Open the routes view | `/channels open` | Opens the view of channel routes and the agents behind them. | None |
| Pick up Telegram where it left off | `/channels telegram-cursor` | Shows the saved Telegram reading positions to review and bind one. | None |

### /cloudflare: Cloudflare

`/cloudflare` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See whether Cloudflare is set up | `/cloudflare status` | Shows whether the Cloudflare integration is on and ready, which parts are deployed, and the batch settings. | None |
| Set Cloudflare up step by step | `/cloudflare setup` | Opens the guided Cloudflare setup, one question at a time. | None |
| See what the API token needs | `/cloudflare requirements [--component <also use>]... [--no-component <leave out>]... [--all]` | Lists the permissions the API token needs for the parts chosen, and how to make the bootstrap token. | None |
| Create the API token GoodVibes uses | `/cloudflare create-token [--bootstrap-token <bootstrap token>] [--bootstrap-env <bootstrap variable>] [--component <also use>]... [--no-component <leave out>]... [--all] [--account <account>] [--zone-id <zone id>] [--zone <zone>] [--new]` | A Cloudflare API token for the parts chosen is created on your account and stored by the daemon, until you change it; the bootstrap token is used once and not kept. | None |
| Find your Cloudflare accounts and resources | `/cloudflare discover [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--component <also use>]... [--no-component <leave out>]... [--all] [--zone-id <zone id>] [--zone <zone>] [--fast]` | Asks Cloudflare which accounts, zones, queues, KV namespaces and R2 buckets the token can see. | None |
| Check a Cloudflare token | `/cloudflare validate [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>]` | Asks Cloudflare whether the token works and which account it belongs to. | None |
| Deploy GoodVibes on Cloudflare | `/cloudflare provision [--component <also use>]... [--no-component <leave out>]... [--all] [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--zone-id <zone id>] [--zone <zone>] [--daemon-url <daemon address>] [--daemon-hostname <daemon hostname>] [--worker-name <worker name>] [--worker-subdomain <worker subdomain>] [--worker-hostname <worker hostname>] [--worker-url <worker address>] [--worker-cron <worker schedule>] [--batch-mode <batch mode>] [--queue <queue>] [--dlq <dead-letter queue>] [--tunnel-name <tunnel name>] [--tunnel-id <tunnel id>] [--tunnel-service-url <tunnel target>] [--tunnel-token-ref <tunnel token reference>] [--access-app-id <access app>] [--access-service-token-id <access service token>] [--access-service-token-ref <access token reference>] [--kv-namespace-name <kv namespace>] [--kv-namespace-id <kv namespace id>] [--do-namespace-name <durable objects namespace>] [--r2-bucket-name <r2 bucket>] [--secrets-store-name <secrets store>] [--secrets-store-id <secrets store id>] [--operator-token <operator token>] [--operator-token-ref <operator token reference>] [--worker-client-token <worker client token>] [--worker-client-token-ref <worker client token reference>] [--no-verify] [--no-store-token] [--no-workers-dev]` | The parts chosen are created or updated on your Cloudflare account (the worker, its queues and the rest) and the daemon is set to use them, until you change it. | spends money |
| Check the deployed worker | `/cloudflare verify [--worker-url <worker address>] [--worker-token <worker token>] [--worker-token-ref <worker token reference>]` | Calls the worker's health check and the daemon's batch proxy through it, and says whether each answered. | None |
| Turn the Cloudflare integration off | `/cloudflare disable [--account <account>] [--token <api token>] [--token-env <token variable>] [--token-ref <token reference>] [--worker-name <worker name>] [--bootstrap-token <bootstrap token>] [--bootstrap-env <bootstrap variable>] [--keep-cron] [--keep-worker-subdomain]` | The integration is turned off here, its worker schedule and workers.dev address are turned off at Cloudflare and the worker's daemon credential is removed, until you change it; with a bootstrap token the operational token this daemon made is revoked, which cannot be undone. | cannot be undone |

### /devices: Paired devices

`/devices` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your paired devices | `/devices list` | Lists each paired device with when it was paired and last seen, and whether the old shared token still works. | None |
| Pair something | `/devices pair <what to pair> <channel> [--name <name>] [--bootstrap-shared] [--apply]` | The <what to pair> you chose is paired and may reach the daemon, until you change it. | None |
| Rename a device | `/devices rename <device> <new name...>` | <device> is called <new name> in the device list, until you change it. | None |
| Revoke a device | `/devices revoke <device>` | <device> stops reaching the daemon at once and has to pair again for a new token. | cannot be undone |
| Give an old device its own token | `/devices migrate-shared [<name...>]` | A new token of its own is made for a device that still uses the shared token, kept until you change it; it is shown once in the Paired Devices view. | None |
| Retire the shared token | `/devices revoke-shared` | Every device still using the shared token is signed out and has to pair again; the apps on this machine get its replacement. | cannot be undone |
| See how this terminal reaches its daemon | `/devices host-status` | Shows whether this terminal holds a device pairing for its daemon, or uses this machine's operator token. | None |
| Forget this terminal's daemon pairing | `/devices unpair-host` | This terminal forgets its host credential and cannot reach that daemon until you pair it again, until you change it. | None |
| See whether the relay is reachable | `/devices relay-status` | Shows whether the relay is on, the daemon's live registration with it, and what the relay refused if it did. | None |
| See devices paired through the relay | `/devices relay-codes` | Lists each relay code, one per device paired through the relay, with when it was last used. | None |
| Cut a device off the relay | `/devices relay-revoke <relay code>` | The device paired with <relay code> is refused at its next request through the relay; every other device keeps working. | cannot be undone |
| See devices waiting to pair | `/devices requests` | Lists each device that asked to pair as a node (a browser's Phone node, a peer daemon) and waits for your approval, with what it offers and the node id it pairs as. | None |
| Approve a device waiting to pair | `/devices approve <request> [--replace]` | The device that sent <request> may finish pairing and then reach the daemon as a node until you change it: revoking it ends that. | None |
| Reject a device waiting to pair | `/devices reject <request>` | The device that sent <request> stays unpaired until you change it; to pair after all, it has to ask again. | None |
| See phones paired as device nodes | `/devices nodes` | Lists each phone paired as a device node and what it can serve. | None |
| See always-allow grants | `/devices grants` | Lists the "always allow" answers given to phone capabilities, with how often each was used. | None |
| Revoke an always-allow grant | `/devices revoke-grant <grant>` | The "always allow" answer <grant> is removed; the next request for that capability asks you again, until you change it. | None |
| See captures the daemon keeps | `/devices captures` | Lists the photos and screen captures the daemon is keeping, and when each is deleted. | None |
| Delete a capture now | `/devices delete-capture <capture>` | The capture <capture> and its record are removed from the daemon host now. | cannot be undone |

### /mail: Mail

`/mail` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See whether mail is connected | `/mail status` | Shows whether the mailbox is set up and reachable, and what to do next if not. | None |
| See your inbox | `/mail list [<how many>]` | Lists the newest messages in the inbox; nothing is marked read. | None |
| Read a message | `/mail read <message>` | Shows message <message> with its sender, subject and text. | None |
| Save a draft | `/mail draft <to> [--subject <subject>] <message...>` | A draft to <to>, "<subject>": "<message>", is kept in the account's Drafts folder until you change it; nothing is sent. | None |
| Send a message | `/mail send <to> [--subject <subject>] [--again] <message...>` | This goes to <to> and cannot be recalled: "<subject>": "<message>". | sends something outside this machine |
| See your mailbox settings | `/mail settings` | Shows each mailbox setting; the password shows only as stored or not. | None |
| Change a mailbox setting | `/mail set <setting> <value...>` | The mailbox setting <setting> becomes <value>, until you change it. | None |
| Store the mailbox password | `/mail password [<password>]` | The mailbox password is kept in the secret store, until you change it; settings hold only a reference to it. | None |

### /notifications: Notification history

`/notifications` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Open the notification history | `/notifications` | Opens every notice and notification collected, newest first. | None |

### /notify: Webhook notifications

`/notify` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See where notifications go | `/notify list [--show]` | Lists the webhook addresses notifications go to, by number. | None |
| Send notifications to an address | `/notify add [<address>]` | Notifications also go to the address you gave, kept in the secret store, until you change it. | None |
| Stop sending to an address | `/notify remove <address>` | Notifications stop going to address <address>, until you change it; its stored key is deleted. | None |
| Stop sending to every address | `/notify clear` | Every webhook address is removed and its stored key deleted. | cannot be undone |
| Send a test notification | `/notify test` | A test notification is sent to every address, and each one's answer is shown. | sends something outside this machine |
| Send a notification | `/notify send <message...>` | "<message>" is sent to every webhook address. | sends something outside this machine |
| See notifications that failed | `/notify failed` | Lists the notifications that could not be delivered, oldest first, with why. | None |
| Send failed notifications again | `/notify resend <which> [--to-current]` | The failed notification <which> is sent again. | sends something outside this machine |

### /remote: Remote runners

`/remote` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See remote runners at a glance | `/remote list` | Shows connections, runner contracts, pools, artifacts and supervisor sessions. | None |
| Open the remote screen | `/remote open` | Opens the full-screen view of remote runners, pools and artifacts. | None |
| See a remote connection | `/remote show [<connection>]` | Shows <connection>'s transport, errors, task, contract and tools. | None |
| See a runner's contract | `/remote contract <runner>` | Shows <runner>'s template, trust, transport, tools, write scope and review mode. | None |
| See a runner's supervisor session | `/remote supervisor [<runner>]` | Shows <runner>'s transport, heartbeat, negotiated protocol, capabilities and recovery steps. | None |
| See what a runner can do | `/remote capabilities [<runner>]` | Shows which capabilities <runner> supports and which it lacks. | None |
| See how to recover a runner | `/remote recover [<runner>]` | Shows <runner>'s heartbeat and last error, and the steps that recover it. | None |
| Stop a remote runner | `/remote stop <connection>` | The runner on <connection> is stopped; what it was doing is not finished. | cannot be undone |
| Start a remote runner on a task | `/remote dispatch [--template <kind of agent>] <task...>` | A self-hosted runner starts on "<task>" now, with only its template's tools; it runs until it finishes or you stop it. | None |
| Start a runner from a pool on a task | `/remote dispatch-pool <pool> [--template <kind of agent>] <task...>` | A runner from pool <pool> starts on "<task>" now, with only its template's tools; it runs until it finishes or you stop it. | None |
| See runner pools | `/remote pools` | Shows every runner pool with its runners, trust and template. | None |
| See a runner pool | `/remote pool <pool>` | Shows <pool>'s label, trust, template, limit and runners. | None |
| Make a runner pool | `/remote create-pool <pool id> [<label...>]` | Runner pool <pool id> is made, until you change it. | None |
| Put a runner in a pool | `/remote assign <pool> <runner>` | Runner <runner> joins pool <pool> until you change it. | None |
| Take a runner out of a pool | `/remote unassign <pool> <runner>` | Runner <runner> leaves pool <pool> until you change it. | None |
| See what runners handed back | `/remote artifacts` | Shows the review artifacts runners handed back, with their state and summary. | None |
| Review an artifact | `/remote review <artifact>` | Shows what <artifact> holds: the task, its result and the evidence. | None |
| Save a runner's work for review | `/remote export <runner> [--to <file>]` | What <runner> did is captured as an artifact and written to a file in this project. | None |
| Save an artifact to a file | `/remote artifact-export <artifact> [--to <file>]` | <artifact> is written to a file in this project. | None |
| Run an artifact's task here | `/remote rerun-local <artifact>` | A local agent starts in this project on the task <artifact> recorded, with only the tools it recorded (shown beside each artifact); it may come from another machine. | loosens a protection |
| Bring in an artifact from a file | `/remote import <file>` | The artifact in <file> is added for review, replacing a different artifact held here with the same id; a file that would replace a known runner's tools is refused. | cannot be undone |
| See how remote running is set up | `/remote setup` | Shows the agent command a remote runner starts, whether the daemon and listener are on, and what to do next. | None |
| Save the remote setup to a file | `/remote setup-export <file>` | The remote setup is written as JSON to <file>. | None |
| See the environment a remote agent needs | `/remote env` | Shows the shell lines that point a remote agent at this session. | None |
| Save the remote environment to a file | `/remote env-export <file>` | The shell lines a remote agent needs are written to <file>. | None |
| See how to tunnel remote traffic | `/remote tunnel` | Shows how remote agent traffic reaches this session through a tunnel you run. | None |
| Save the tunnel guidance to a file | `/remote tunnel-export <file>` | The tunnel guidance is written to <file>. | None |
| Save a start-up bundle for another machine | `/remote bootstrap-export <file>` | A bundle with the agent command, environment and links another machine starts from is written to <file>. | None |
| Look inside a start-up bundle | `/remote bootstrap-inspect <file>` | Shows the session, agent command and links in <file>. | None |
| Save this session's runners to a bundle | `/remote session-export <file>` | This session's runner pools, runner contracts and artifacts are written to <file>; the conversation is not. | None |
| Look inside a session bundle | `/remote session-inspect <file>` | Shows what <file> holds and what bringing it in here would replace; nothing is changed. | None |
| Bring in a session bundle | `/remote session-import <file>` | The runner pools, contracts and artifacts in <file> are brought in, replacing any held here with the same ids. | cannot be undone |

### /scan: Find local model servers

`/scan` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Find model servers nearby | `/scan` | Probes this computer and your local network for model servers (Ollama, LM Studio and the like) and adds each one found to your providers, until you change it. | None |

### /telegram: Telegram messages held for you

`/telegram` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what waits for you | `/telegram list` | Lists the messages waiting for your decision and the review queue. | None |
| Hold a chat's messages for you | `/telegram configure <chat> <bot> [--hold <each message waits>] [--for <hold the chat for>]` | Every message in chat <chat> on <bot> waits for your decision instead of being answered, for <hold the chat for> or until you change it. | None |
| Accept a waiting message for review | `/telegram approve <message> [--keep <keep the original>] [--record <keep the review>]` | <message> goes into your review queue; nothing in it is run. | None |
| Refuse a waiting message | `/telegram deny <message>` | <message> is refused; its original is released and nothing in it is run. | None |
| See where a message stands | `/telegram status <message>` | Shows whether <message> waits, is in review or was read, and whether its original is still kept. | None |
| Read an accepted message | `/telegram read <message>` | Shows the original of <message> and marks its review read. | None |
| Close a review | `/telegram cancel <message>` | <message> leaves the queue and its original is released. | cannot be undone |
| Stop holding new messages from a chat | `/telegram revoke <configuration>` | No new message is captured under <configuration>; the chat stays held until you hand it back. | cannot be undone |
| Hand a chat back to normal handling | `/telegram release <chat>` | Chat <chat> is answered normally again, until you change it. | None |

## Help and setup

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/deeplink` | None | `review \| open <view> [<target>] \| export <file> \| inspect <file>` | The goodvibes://open links to each view: see them, open one, or save them to a file and read one back |
| `/guidance` | None | `review \| dismiss <guidance> \| reset [<guidance>]` | Advice for what is happening now (an approval waiting, a server that needs sign-in, a long conversation), without interrupting the chat |
| `/helpers` | None | None | The local programming interfaces remote clients and web front ends use |
| `/managed` | None | `review \| staged \| history \| inspect <bundle file> \| export <profile> <bundle file> \| stage <bundle file> \| apply <bundle file> [--key <only these settings>]... \| apply-staged [--key <only these settings>]... \| rollback <apply> \| lock <setting> <who manages it> <why...> \| unlock <setting>` | Apply settings bundles your organisation manages, lock settings, and roll an apply back |
| `/release` | None | `review \| checklist \| save <file> [--replace] \| read <file>` | See whether this project is ready to release, and keep the evidence as a file |
| `/setup` | None | `checklist \| model \| sign-in \| add-provider <name> <address> \| store-key \| local-only \| browser \| other-devices \| connect-daemon \| webhooks \| chat-apps \| cloudflare \| who-signs-in \| how-it-works \| safety \| memory \| telemetry \| automation \| devices-voice \| provider-behaviour \| advanced \| history \| import-settings \| first-run \| pair [--name <name>] [--apply] \| unpair` | Set GoodVibes up, one topic at a time |
| `/startup` | None | `review \| doctor \| services \| hooks \| remote \| sandbox \| support-bundle <folder> [--overwrite] \| support-bundle-inspect <folder> \| export <file> [--overwrite] \| transfer-export <file> [--overwrite] \| transfer-inspect <file> \| transfer-import <file> \| link <view> [<item>] \| open-link <link>` | Check this setup, or save and bring in a setup |

### /deeplink: Links to views

`/deeplink` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the links to each view | `/deeplink review` | Lists the goodvibes://open link of each view. | None |
| Open a view by its link | `/deeplink open <view> [<target>]` | Opens <view>, with its target selected when one is given. | None |
| Save the links to a file | `/deeplink export <file>` | Every view's link is written to <file>. | None |
| Read a saved link file | `/deeplink inspect <file>` | Shows when <file> was saved and how many links it holds. | None |

### /guidance: Guidance

`/guidance` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See guidance for now | `/guidance review` | Shows the advice that applies now, with the line that acts on each, and how this session is doing for size. | None |
| Dismiss a piece of guidance | `/guidance dismiss <guidance>` | Guidance <guidance> is hidden for what it reports now; a new occurrence shows again, until you change it. | None |
| Show dismissed guidance again | `/guidance reset [<guidance>]` | Dismissed guidance <guidance> shows again when it applies, until you change it. | None |

### /helpers: Integration helpers

`/helpers` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the integration helper interfaces | `/helpers` | Shows the sessions, tasks, approvals, remote contracts and views the helpers expose, with their interface families and routes. | None |

### /managed: Managed settings

`/managed` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See managed settings at a glance | `/managed review` | Shows saved profiles, the staged bundle, active locks and rollback records. | None |
| See the staged bundle | `/managed staged` | Shows the bundle staged to apply, its stage id and each change it makes. | None |
| See applies you can roll back | `/managed history` | Shows each managed apply with its rollback token and how many settings it changed. | None |
| Look inside a managed bundle | `/managed inspect <bundle file>` | Shows what <bundle file> would change here and how risky it is; nothing is changed. | None |
| Save a profile as a managed bundle | `/managed export <profile> <bundle file>` | The settings of profile <profile> are written to <bundle file> as a managed bundle. | None |
| Stage a managed bundle to apply later | `/managed stage <bundle file>` | The changes in <bundle file> are staged, ready to apply, until you change it; nothing is applied yet. | None |
| Apply a managed bundle | `/managed apply <bundle file> [--key <only these settings>]...` | The settings in <bundle file> are applied and locked as managed until you change it; changes that touch security are listed, and /managed rollback <token> puts the previous values back. | loosens a protection |
| Apply the staged bundle | `/managed apply-staged [--key <only these settings>]...` | The staged settings are applied and locked as managed until you change it; changes that touch security are listed, and /managed rollback <token> puts the previous values back. | loosens a protection |
| Put back the values from before an apply | `/managed rollback <apply>` | The settings apply <apply> changed get their earlier values back, until you change it. | None |
| Lock a setting as managed | `/managed lock <setting> <who manages it> <why...>` | <setting> is locked as managed by <who manages it> ("<why>"), so it cannot be changed here, until you change it. | None |
| Unlock a managed setting | `/managed unlock <setting>` | The managed lock on <setting> is cleared, so it can be changed here again, until you change it. | loosens a protection |

### /release: Release readiness

`/release` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See release readiness | `/release review` | Shows the model in use, the project's eval tasks, this session's failure reports, remote work and the plugins and skills installed. | None |
| See the release checklist | `/release checklist` | Lists the checks to run before a release, each with its line. | None |
| Save the release evidence to a file | `/release save <file> [--replace]` | The release evidence (what "See release readiness" shows) will be written to <file>, until you change it. | None |
| Read saved release evidence | `/release read <file>` | Reads the release evidence saved in <file> and shows what it recorded. | None |

### /setup: Set up GoodVibes

`/setup` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what is set up | `/setup checklist` | Shows which of the things most people set once are done, and the line that sets each one that is not. | None |
| Choose a model | `/setup model` | Opens the form for the model new turns use and how hard it thinks. | None |
| Sign in or out of a provider | `/setup sign-in` | Opens the form for signing in to a provider with your browser, finishing a sign-in, or signing out. | None |
| Add a provider of your own | `/setup add-provider <name> <address>` | The provider <name> at <address> is added until you change it. | None |
| Store a password or key | `/setup store-key` | Opens the form for storing a provider or channel key, and how keys are stored. | None |
| Keep everything on this computer | `/setup local-only` | Opens the form that turns off the browser, network and webhook access. | None |
| Open GoodVibes in a browser | `/setup browser` | Opens the form for using GoodVibes from a web browser on this computer or your network. | None |
| Use it from other devices | `/setup other-devices` | Opens the form for letting your other devices reach GoodVibes: addresses and ports. | None |
| Use a daemon on another computer | `/setup connect-daemon` | Opens the form for pointing this program at a GoodVibes daemon already running on another computer; nothing on this computer is opened to the network. | None |
| Receive webhooks | `/setup webhooks` | Opens the form for receiving webhooks and events from other tools. | None |
| Connect chat apps and services | `/setup chat-apps` | Opens the form for connecting Slack, Discord, Telegram and the other chat apps and services. | None |
| Use Cloudflare | `/setup cloudflare` | Opens the form for using Cloudflare for batch and remote work. | None |
| Who can sign in here | `/setup who-signs-in` | Opens the form for the account that signs in to this GoodVibes from other devices. | None |
| How GoodVibes works with you | `/setup how-it-works` | Opens the form for how much GoodVibes tells you, how much guidance it gives, and when it asks. | None |
| Safety and sandboxing | `/setup safety` | Opens the form for the sandbox and the other safety features. | None |
| Memory and context | `/setup memory` | Opens the form for memory and how a long conversation is kept in context. | None |
| Record traces of what GoodVibes does | `/setup telemetry` | Opens the form for tracing what GoodVibes does. | None |
| Scheduled routines, watchers and triggers | `/setup automation` | Opens the form for scheduled routines, watchers and triggers. | None |
| Paired devices and voice | `/setup devices-voice` | Opens the form for paired phones and voice. | None |
| Provider behaviour | `/setup provider-behaviour` | Opens the form for how GoodVibes chooses and talks to providers. | None |
| Advanced switches | `/setup advanced` | Opens the form for the advanced runtime switches. | None |
| History and privacy | `/setup history` | Opens the setting for whether conversations are saved on this computer. | None |
| Bring over settings from the terminal app | `/setup import-settings` | Copies the settings the Agent shares with the terminal app into the Agent. | None |
| Run first-run again | `/setup first-run` | Opens the three-step first run: choose a provider, sign in, start. | None |
| Pair the Agent with a GoodVibes host | `/setup pair [--name <name>] [--apply]` | This Agent pairs with your GoodVibes host as <name>, after you confirm in this terminal. | None |
| Unpair the Agent from the GoodVibes host | `/setup unpair` | This Agent forgets its GoodVibes host credential and stops reaching that host. | None |

### /startup: Check, export or move your setup

`/startup` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what this setup has | `/startup review` | Shows the providers, services, plugins, hooks and servers this setup has. | None |
| Check this setup for problems | `/startup doctor` | Checks this setup and lists what is not working. | None |
| See the services and sign-ins | `/startup services` | Shows the configured services, provider sign-ins and their problems. | None |
| See the hooks | `/startup hooks` | Shows how many hooks and hook chains this setup manages. | None |
| See the remote runners | `/startup remote` | Shows the remote runners this setup can hand work to. | None |
| See the sandbox | `/startup sandbox` | Shows how commands are contained on this computer. | None |
| Save a support bundle | `/startup support-bundle <folder> [--overwrite]` | A support bundle about this setup is written to <folder>; credentials in it are masked. | None |
| Read a support bundle | `/startup support-bundle-inspect <folder>` | Shows what the support bundle in <folder> says about its setup. | None |
| Save the setup review to a file | `/startup export <file> [--overwrite]` | The setup review is written as JSON to <file>. | None |
| Save this setup to move it | `/startup transfer-export <file> [--overwrite]` | Settings, services, plugins and skills are written to <file> for another computer; literal credentials are left out. | None |
| Read a moved setup | `/startup transfer-inspect <file>` | Shows what the setup file <file> holds. | None |
| Bring in a moved setup | `/startup transfer-import <file>` | The settings and files in <file> replace the ones here, after you see the plan. | None |
| Make a link to a view | `/startup link <view> [<item>]` | Shows a goodvibes:// link that opens <view>. | None |
| Open a goodvibes:// link | `/startup open-link <link>` | Opens the view the link <link> names. | None |

## Memory and knowledge

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/knowledge` | None | `open \| status \| ask [--mode <answer>] [--limit <how many>] [--space <knowledge space>] <question...> \| search [--limit <how many>] <words...> \| list [--kind <which>] [--limit <how many>] \| get <item> \| queue [<how many>] \| packet [--scope <only about>]... <task...> \| lint \| candidates [<how many>] \| reports [<how many>] \| schedules \| ingest-url <address> [--title <title>] [--tags <tags>] [--folder <folder>] [--allow-private-hosts] \| import-urls <file> [--allow-private-hosts] \| import-bookmarks <file> [--allow-private-hosts] \| ingest-file <file> [--title <title>] [--tags <tags>] [--folder <folder>] \| ingest-artifact <artifact> [--title <title>] [--tags <tags>] [--folder <folder>] \| import-browser-history [--browsers <browsers>] [--sources <what>] [--limit <how many>] [--since-days <from the last>] \| ingest-connector <connector> [--input <input>] [--path <file>] [--content <text>] [--allow-private-hosts] \| map [--limit <how many>] [<about...>] \| connectors \| connector <connector> \| connector-doctor <connector> \| review-issue <issue> <verdict> [--value <changed facts>] [--reviewer <reviewed by>] \| consolidate [<how thorough>] \| reindex \| cancel-run <job>` | Your structured knowledge: ask it, search it, add pages and files, review what it flags, and keep it tidy |
| `/memory` | None | `list [--class <kind>] [--scope <where it applies>] \| add <kind> [--detail <detail>] [--tags <tags>] [--scope <where it applies>] [--session <from session>] [--task <from task>] [--file <from file>] <summary...> \| search [--class <kind>] [--scope <where it applies>] [--limit <at most>] [--semantic] [<words...>] \| show <record> \| edit <record> [--summary <summary>] [--detail <detail>] [--tags <tags>] [--scope <where it applies>] \| review <record> <it is> [--confidence <confidence>] [--reason <why>] [--by <reviewed by>] \| promote <record> <applies to> \| link <from> <to> <how they relate...> \| remove <record> \| queue [<at most>] [--scope <where it applies>] \| explain [--scope <files it would change>]... <task...> \| injections [<agent>] \| sync-files [--dir <folder>] \| review-files [--dir <folder>] \| apply-files <change> [--dir <folder>] \| export <file> [--scope <where it applies>] [--class <kind>] \| inspect <file> \| import <file> \| snapshots \| restore <copy> \| index \| rebuild-index \| capture <what> [<which>] \| open` | What the project remembers: decisions, constraints, incidents and patterns, with where each came from |
| `/web-search` | None | `[--limit <how many>] <words...>` | Search the web and list ranked results with where each came from |

### /knowledge: Knowledge

`/knowledge` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Open your knowledge | `/knowledge open` | Opens the knowledge view: sources, entries, issues and what is being added. | None |
| See how your knowledge stands | `/knowledge status` | Shows whether knowledge is ready, where it is kept, and how many sources, entries, links and issues it has. | None |
| Ask your knowledge a question | `/knowledge ask [--mode <answer>] [--limit <how many>] [--space <knowledge space>] <question...>` | Answers <question> from your knowledge, with the sources, facts and linked entries it used. | None |
| Search your knowledge | `/knowledge search [--limit <how many>] <words...>` | Lists the sources and entries that match <words>, best first, with why each matched. | None |
| See sources, entries or issues | `/knowledge list [--kind <which>] [--limit <how many>]` | Lists your knowledge's sources, entries or issues, newest first. | None |
| See one source, entry or issue | `/knowledge get <item>` | Shows <item> in full, with what it links to. | None |
| See issues waiting for review | `/knowledge queue [<how many>]` | Lists the knowledge issues waiting for you to review. | None |
| See the knowledge a task would get | `/knowledge packet [--scope <only about>]... <task...>` | Shows the compact knowledge a model would be given for <task>. | None |
| Check your knowledge for problems | `/knowledge lint` | Lists the problems found in your knowledge: broken links, duplicates, missing facts. | None |
| See entries that could be merged | `/knowledge candidates [<how many>]` | Lists the entries tidying found that could be merged, best first. | None |
| See what tidying did | `/knowledge reports [<how many>]` | Lists the reports of past tidying runs, newest first. | None |
| See when knowledge is tidied | `/knowledge schedules` | Lists the schedules that tidy and refresh your knowledge, and whether each is on. | None |
| Add a web page | `/knowledge ingest-url <address> [--title <title>] [--tags <tags>] [--folder <folder>] [--allow-private-hosts]` | The page at <address> is fetched and added to your knowledge, until you change it. | None |
| Add pages from a list of addresses | `/knowledge import-urls <file> [--allow-private-hosts]` | Every address in <file> is fetched and added to your knowledge, until you change it. | None |
| Add pages from a bookmarks file | `/knowledge import-bookmarks <file> [--allow-private-hosts]` | Every bookmark in <file> is fetched and added to your knowledge, until you change it. | None |
| Add a file | `/knowledge ingest-file <file> [--title <title>] [--tags <tags>] [--folder <folder>]` | File <file> is added to Agent Knowledge, until you change it. | None |
| Add a saved artifact | `/knowledge ingest-artifact <artifact> [--title <title>] [--tags <tags>] [--folder <folder>]` | Artifact <artifact> is added to Agent Knowledge, until you change it. | None |
| Add your browser history | `/knowledge import-browser-history [--browsers <browsers>] [--sources <what>] [--limit <how many>] [--since-days <from the last>]` | Pages from your browsers' history and bookmarks are added to Agent Knowledge, until you change it. | None |
| Add something through a connector | `/knowledge ingest-connector <connector> [--input <input>] [--path <file>] [--content <text>] [--allow-private-hosts]` | What connector <connector> reads from the input, file or text given is added to Agent Knowledge, until you change it. | None |
| See the knowledge map | `/knowledge map [--limit <how many>] [<about...>]` | Shows how many entries and links Agent Knowledge has, and for what is asked about. | None |
| See knowledge connectors | `/knowledge connectors` | Lists the connectors that can add to Agent Knowledge, and what each reads. | None |
| See one connector | `/knowledge connector <connector>` | Shows connector <connector>: what it reads and what it can do. | None |
| Check a connector | `/knowledge connector-doctor <connector>` | Checks whether connector <connector> is ready, and what to fix when it is not. | None |
| Review an issue | `/knowledge review-issue <issue> <verdict> [--value <changed facts>] [--reviewer <reviewed by>]` | Issue <issue> is answered with <verdict>, until you change it. | None |
| Tidy your knowledge | `/knowledge consolidate [<how thorough>]` | A tidying pass merges duplicates and fills gaps in your knowledge now, until you change it. | None |
| Rebuild the knowledge index | `/knowledge reindex` | Every source is read again and the entries and links are rebuilt from them, until you change it. | None |
| Stop a knowledge job | `/knowledge cancel-run <job>` | Knowledge job <job> is stopped. | cannot be undone |

### /memory: Memory

`/memory` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your memory | `/memory list [--class <kind>] [--scope <where it applies>]` | Lists memory records by kind, newest first, with where each applies. | None |
| Remember something | `/memory add <kind> [--detail <detail>] [--tags <tags>] [--scope <where it applies>] [--session <from session>] [--task <from task>] [--file <from file>] <summary...>` | "<summary>" will be remembered as <kind> for <where it applies> until you change it. | None |
| Search memory | `/memory search [--class <kind>] [--scope <where it applies>] [--limit <at most>] [--semantic] [<words...>]` | Finds memory records that match <words>. | None |
| See one record | `/memory show <record>` | Shows <record> in full: where it applies, its detail, tags, where it came from and what it is linked to. | None |
| Correct a record | `/memory edit <record> [--summary <summary>] [--detail <detail>] [--tags <tags>] [--scope <where it applies>]` | <record> will be corrected in place (its id, kind, origin and links stay) until you change it. | None |
| Say whether a record is still right | `/memory review <record> <it is> [--confidence <confidence>] [--reason <why>] [--by <reviewed by>]` | <record> will be marked "<it is>" until you change it. | None |
| Change where a record applies | `/memory promote <record> <applies to>` | <record> will apply to <applies to> until you change it. | None |
| Link two records | `/memory link <from> <to> <how they relate...>` | <from> will be linked to <to> as "<how they relate>" until you change it. | None |
| Forget a record | `/memory remove <record>` | Memory record <record> and its links will be deleted and cannot be recovered. | cannot be undone |
| See records waiting for review | `/memory queue [<at most>] [--scope <where it applies>]` | Lists the records whose review is due, least sure first. | None |
| See what memory a task would be given | `/memory explain [--scope <files it would change>]... <task...>` | Shows the reviewed memory that would be given to "<task>", and why. | None |
| See what memory a turn was given | `/memory injections [<agent>]` | Shows the memory each recent turn of <agent> was given. | None |
| Write memory as files | `/memory sync-files [--dir <folder>]` | Each project and team record is written as a file in <folder> and committed in that folder's own repository, until you change it; a file you edited is kept as it is. | None |
| See what edited memory files would change | `/memory review-files [--dir <folder>]` | Compares the memory files in <folder> with memory and lists what your edits would change; nothing is changed. | None |
| Take edited memory files into memory | `/memory apply-files <change> [--dir <folder>]` | The change <change> from your memory files will be made in memory until you change it; a deleted file deletes its record. | None |
| Save memory to a file | `/memory export <file> [--scope <where it applies>] [--class <kind>]` | Memory records and their links (<where it applies>) will be written to <file>, which is replaced if it is there, until you change it. | None |
| Read a memory file before loading it | `/memory inspect <file>` | Shows what the memory file <file> holds; nothing is loaded. | None |
| Load memory from a file | `/memory import <file>` | The records and links in <file> will be added to memory (a record already there is left as it is) until you change it. | None |
| See copies of memory | `/memory snapshots` | Lists the copies of memory taken each day, before a migration and before a restore, newest first. | None |
| Replace all memory with a copy | `/memory restore <copy>` | Every memory record, link and waiting proposal will be replaced by those in <copy>, until you change it; the records you have now are copied first, so restoring that copy puts them back. | None |
| See the search index | `/memory index` | Shows the semantic search index: whether it works, how many records it holds and how many wait to be embedded again. | None |
| Rebuild the search index | `/memory rebuild-index` | Every record is embedded again with the current provider, so semantic search covers all of memory; nothing is lost. | None |
| Remember an incident or a setting's state | `/memory capture <what> [<which>]` | <what> <which> will be remembered as a record until you change it. | None |
| Open the memory screen | `/memory open` | Opens the full-screen view of memory records. | None |

### /web-search: Search the web

`/web-search` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Search the web for words | `/web-search [--limit <how many>] <words...>` | <words> is sent to the web search provider and the ranked results are listed here. | None |

## Models and providers

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/accounts` | None | `review \| show <provider> \| routes <provider> \| repair <provider> \| open \| sign-in <service> <address> [--user <user name>] [--password <password>] [--key <kept as>] \| sign-out <service> <address> [--key <kept as>]` | Your model provider accounts, and signing in to a GoodVibes daemon or listener |
| `/image` | None | `<image file> [<message...>]` | Send an image file to the model with your next message |
| `/media` | None | `providers \| make [--as <make>] [--provider <provider>] [--model <model>] [--out <save as>] <description...> \| collect <provider> <job> [--out <save as>] [<resume values...>]` | Make an image or a video with a configured media provider, and see the providers |
| `/pin` | None | `list \| add <model> \| remove <model>` | Keep models you use at the top of the model picker |
| `/provider` | None | `list \| use <provider> [--model <model>] \| sign-in <provider> [--no-browser] [--manual] \| finish <provider> [<code or address>] \| sign-out <provider> \| show <provider> \| open \| add <name> <address> [--key <api key>] \| remove <provider> \| route <routing> \| pin-route <model> \| explain \| fallback \| export <file> [--replace] \| inspect <file> \| import <file>` | Where your models come from: switch provider, add your own, sign in with a subscription, and choose how requests are routed |
| `/secrets` | None | `list \| set <name> [<value>] [--scope <where to keep it>] [--storage <how to keep it>] \| link <name> <reference> [--scope <where to keep it>] [--storage <how to keep it>] \| get <secret> \| test <reference> \| providers \| storage \| trust <secret> \| delete <secret> [--scope <from>] [--storage <kept as>] \| use <name> [<value>]` | Keep passwords and keys where programs can read them, without showing them |
| `/tools` | None | `list \| contract <tool> \| verify <tool> \| verify-all \| activity` | The tools the model can call here: see them, read one's contract, check that tools keep their contracts |
| `/usage` | None | `open [<show>] \| alert <dollars> \| by-source [<over>] [--as <as>]` | Tokens, cost and context pressure, the spending alert, and cost by who spent it |

### /accounts: Accounts

`/accounts` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your provider accounts | `/accounts review` | Shows each model provider, how it is reached now and which way is preferred, how fresh its sign-in is, and anything wrong. | None |
| See one provider's account | `/accounts show <provider>` | Shows <provider>'s account: each way it can be reached, its sign-in, usage windows and what to do next. | None |
| See how a provider is reached | `/accounts routes <provider>` | Shows each way <provider> can be reached (a key, a subscription, a local server), whether it works, and why one is used. | None |
| See how to fix a provider's account | `/accounts repair <provider>` | Shows what is wrong with <provider>'s account and the steps that fix it. | None |
| Open the providers screen | `/accounts open` | Opens the full-screen view of your providers and their accounts. | None |
| Sign in to a daemon or listener | `/accounts sign-in <service> <address> [--user <user name>] [--password <password>] [--key <kept as>]` | Your password for <user name> will be sent to <address> to sign in to the <service>; the session it gives is kept until you change it (signing out ends it). | sends something outside this machine |
| Sign out of a daemon or listener | `/accounts sign-out <service> <address> [--key <kept as>]` | The <service> at <address> will be asked to end your session, and this terminal forgets it, until you change it (signing in starts a new one). | None |

### /image: Attach an image

`/image` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Send an image with a message | `/image <image file> [<message...>]` | <image file> is sent to the model with your message, as a new turn. | None |

### /media: Images and video

`/media` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the media providers | `/media providers` | Lists the media providers, what each makes, and whether each is set up. | None |
| Make an image or a video | `/media make [--as <make>] [--provider <provider>] [--model <model>] [--out <save as>] <description...>` | A media provider is asked to make <make> of "<description>" and may charge for it; what it makes is saved as a file. | spends money |
| Collect a job that was still being made | `/media collect <provider> <job> [--out <save as>] [<resume values...>]` | Job <job> is collected from <provider> and saved as a file; it was paid for when it was accepted, so nothing new is spent. | None |

### /pin: Pinned models

`/pin` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See pinned models | `/pin list` | Lists the models pinned to the top of the model picker. | None |
| Pin a model | `/pin add <model>` | <model> will be kept at the top of the model picker until you change it. | None |
| Unpin a model | `/pin remove <model>` | <model> will no longer be kept at the top of the model picker, until you change it. | None |

### /provider: Providers

`/provider` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your providers | `/provider list` | Shows the provider in use, every provider you have, your subscription sign-ins and how requests are routed. | None |
| Switch provider | `/provider use <provider> [--model <model>]` | Your conversations will use <provider> from the next message, until you change it. | None |
| Sign in with a subscription | `/provider sign-in <provider> [--no-browser] [--manual]` | A sign-in to <provider> starts in your browser; once it finishes, the sign-in is kept until you change it (signing out ends it). | None |
| Finish signing in with a code | `/provider finish <provider> [<code or address>]` | The sign-in to <provider> is finished with the code you give and kept until you change it (signing out ends it). | None |
| Sign out of a subscription | `/provider sign-out <provider>` | Your <provider> subscription sign-in is removed from this machine, and an API key you set for it is used again, until you change it. | None |
| See a subscription sign-in | `/provider show <provider>` | Shows <provider>'s subscription sign-in: whether you are signed in, until when, where it comes from and what to do next. | None |
| Open the sign-ins screen | `/provider open` | Opens the screen that lists your subscription sign-ins with their state. | None |
| Add a provider of your own | `/provider add <name> <address> [--key <api key>]` | <name> is added with the models <address> lists, and a key you give is kept in your secret store, until you change it. | None |
| Remove a provider of your own | `/provider remove <provider>` | <provider>'s provider file and its stored key are deleted, and its models leave the list. | cannot be undone |
| Choose how requests are routed | `/provider route <routing>` | Requests are routed the way you chose (<routing>) from the next one, until you change it; a model every request was sent to is let go. | None |
| Send every request to one model | `/provider pin-route <model>` | Every request goes to <model> and no other provider is tried, until you change it. | None |
| See why requests go where they go | `/provider explain` | Shows whether the model in use can serve a request and why, how requests are routed, and the last moves to another provider. | None |
| See where a failed request would go | `/provider fallback` | Shows, without sending anything, which providers a failed request could move to and which could not serve it. | None |
| Save your sign-ins to a file | `/provider export <file> [--replace]` | Your subscription sign-ins, with their tokens, are written to <file> and stay there until you change it: anyone who reads the file can use them, so delete it once it has been used. | loosens a protection |
| Check a sign-ins file | `/provider inspect <file>` | Shows the sign-ins <file> holds and what loading it would add or replace, without changing anything. | None |
| Load sign-ins from a file | `/provider import <file>` | The sign-ins in <file> are kept on this machine, each replacing any stored sign-in for the same provider. | cannot be undone |

### /secrets: Secrets

`/secrets` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your secrets | `/secrets list` | Shows every stored secret by name, where it is kept and whether something overrides it; no value is shown. | None |
| Store a secret | `/secrets set <name> [<value>] [--scope <where to keep it>] [--storage <how to keep it>]` | <name> will be kept in the <where to keep it> secret store (<how to keep it>) until you change it. | None |
| Point a secret at a password manager | `/secrets link <name> <reference> [--scope <where to keep it>] [--storage <how to keep it>]` | <name> will be read from <reference>, kept in the <where to keep it> secret store (<how to keep it>), until you change it. | None |
| Check a secret is stored | `/secrets get <secret>` | Says whether <secret> is stored and can be read; its value is not shown. | None |
| Test a secret reference | `/secrets test <reference>` | Reads <reference> once and says whether it gives a value; the value is not shown. | None |
| See where secrets can come from | `/secrets providers` | Lists the password managers and other places a secret can be read from, with a line for each. | None |
| See how secrets are kept | `/secrets storage` | Shows the storage rule, how many secrets are encrypted or plain text, and where each store is. | None |
| Use a secret from this project's store | `/secrets trust <secret>` | <secret> from this project's secret store will be used whenever you have not set it yourself, until you change it (a changed value asks again). | loosens a protection |
| Delete a secret | `/secrets delete <secret> [--scope <from>] [--storage <kept as>]` | The stored value of <secret> will be deleted; anything that reads it stops working until it is set again. | cannot be undone |
| Use a secret for this session only | `/secrets use <name> [<value>]` | Programs this app runs will read the value as $<name>, for this session only; it is not stored. | None |

### /tools: Tools

`/tools` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the tools available | `/tools list` | Lists the tools the model can call in this session; picking one shows what it does. | None |
| See one tool's contract | `/tools contract <tool>` | Shows tool <tool>: its description, its parameters, and whether it keeps its contract. | None |
| Check one tool keeps its contract | `/tools verify <tool>` | Checks that tool <tool> keeps the contract it declares. | None |
| Check every tool keeps its contract | `/tools verify-all` | Checks that every registered tool keeps the contract it declares. | None |
| Open tool activity | `/tools activity` | Opens Your agents, where each agent's tool calls show live; in the conversation each call is one line. | None |

### /usage: Usage

`/usage` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See usage and cost | `/usage open [<show>]` | Opens the Usage view: context pressure, this session's tokens and cost, turn by turn and per agent. | None |
| Set a spending alert | `/usage alert <dollars>` | You will be warned when this session's cost passes $<dollars> (0 turns the warning off), until you change it. | None |
| See cost by who spent it | `/usage by-source [<over>] [--as <as>]` | Shows what the daemon spent, split by agent, model, provider and the other ways it records cost. | None |

## Run and check

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/ci` | None | `watches \| status <repository> \| watch <repository> <tell me on> [--fix-session] \| run <watch> \| unwatch <watch>` | See a repository's CI job by job, and keep standing watches that tell you when it fails |
| `/eval` | None | `list [<task suite>] \| run [<task suite>] \| compare [<baseline>] \| gate [<task suite>] [--baseline <baseline>] [--save-baseline]` | Run a task suite through goodvibes run, compare it with a baseline, and stop on a regression |
| `/health` | None | `report \| check <area> [--provider <provider>] \| diagnose <what is wrong...> \| failure [<failure report>] [--as <as>] \| save-failure <file> [--report <failure report>] [--with-replay] [--replace] \| keep-failure [<failure report>] \| stop-agent <agent> [--note <why>] \| state [<parts...>] \| compat [--json]` | See whether everything is working, check one area, or find the cause of a problem |
| `/status` | None | None | See this session at a glance: model, context window and what is in force |
| `/test` | None | `[<only...>]` | Run the project's test command and show what passed and failed; Esc stops it |

### /ci: CI checks

`/ci` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your CI watches | `/ci watches` | Lists every standing CI watch, where it reports, and its last verdict. | None |
| Check a repository's CI now | `/ci status <repository>` | Shows each CI job of <repository> and its conclusion, and the verdict they give together. | None |
| Watch a repository's CI | `/ci watch <repository> <tell me on> [--fix-session]` | The daemon checks <repository>'s CI until it passes or ends, and reports a failure to <tell me on>, until you change it. | None |
| Check a watch now | `/ci run <watch>` | <watch> is checked now; a failure is reported and, if it says so, a fix session starts. | None |
| Stop watching a repository | `/ci unwatch <watch>` | <watch> is deleted; its repository is no longer checked. | cannot be undone |

### /eval: Evaluate on real tasks

`/eval` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the tasks in a suite | `/eval list [<task suite>]` | Lists the tasks in the task suite named, each with its instruction. | None |
| Run a task suite | `/eval run [<task suite>]` | Each task of the suite runs as one goodvibes run in a scratch copy, then its verify.sh says pass or fail; the suite itself is never changed. | None |
| Compare the last run with a baseline | `/eval compare [<baseline>]` | Compares the last suite run of this session with the baseline file, task by task. | None |
| Run a suite and stop on a regression | `/eval gate [<task suite>] [--baseline <baseline>] [--save-baseline]` | The suite runs, and the gate fails on a failed task or one worse than the baseline; a missing baseline is made from this run, until you change it. | None |

### /health: Health

`/health` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what needs attention | `/health report` | Checks setup, providers, accounts, settings, services, MCP servers, sign-in and the conversation's size, and names each thing that is not working with the line that fixes it. | None |
| Check one area | `/health check <area> [--provider <provider>]` | Shows <area> in detail: what is set up, what is working and what is not. | None |
| Describe a problem | `/health diagnose <what is wrong...>` | Finds the checks for <what is wrong> and runs them against this program's live state; no model is asked. | None |
| See a failure report | `/health failure [<failure report>] [--as <as>]` | Shows a failure report of this session: what failed, its cause and the evidence. | None |
| Save a failure report as a file | `/health save-failure <file> [--report <failure report>] [--with-replay] [--replace]` | The failure report's bundle will be written to <file> on this machine, until you change it. | None |
| Keep a failure report in memory | `/health keep-failure [<failure report>]` | The failure report is kept in durable memory as an incident record, once, until you change it. | None |
| Stop a running agent | `/health stop-agent <agent> [--note <why>]` | Agent <agent> is stopped; what it has not finished is not done. | cannot be undone |
| See the runtime store | `/health state [<parts...>]` | Shows what this program's runtime store holds now, part by part, with credentials masked; for debugging. | None |
| Check the connected host's compatibility | `/health compat [--json]` | Asks the connected host which routes it serves and whether the Agent's knowledge routes are ready. | None |

### /status: Status

`/status` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See this session at a glance | `/status` | Shows the model in use, its context window and where it came from, and the session's other states. | None |

### /test: Run the tests

`/test` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Run the project's tests | `/test [<only...>]` | The project's test command (the test gate, or the package.json test script) runs here and its results are shown; Esc stops it. | None |

## Sessions and history

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/clear` | None | None | Start a fresh conversation; the current one is saved as its own session |
| `/compact` | None | None | Summarise the older part of the conversation to free the context window |
| `/effort` | None | `show \| set <level>` | How hard the model thinks before it answers |
| `/help` | None | `[<about>]` | Every command and every key in one searchable list |
| `/hosted` | None | `status \| new [--on-leave <when everyone leaves>] [<first message...>] \| list [--all] \| attach <session> \| send <message...> \| send-later <message...> \| stop-tool [<tool>] \| leave \| end <session>` | Conversations that run in the daemon, so they go on when this window closes |
| `/model` | None | `choose \| list \| use <model> \| refresh \| backup <model> \| drop-backup <backup model>` | Choose the model your conversations use and its backups, and read the list of models again |
| `/notes` | None | `list \| show <note> \| search <words...> \| create [--title <title>] [--url <web page>] [--tags <tags>] <text...> \| edit <note> [--title <title>] [--url <web page>] [--tags <tags>] [<text...>] \| review <note> \| stale <note> <why...> \| delete <note> \| to-memory <note> [--kind <kind>] [--scope <where it applies>] \| to-persona <note> \| to-skill <note> [--enable] \| to-routine <note> [--enable] \| to-knowledge <note>` | Notes you keep beside your work: write, find and change them, and keep one as a memory, a persona, a skill or a routine |
| `/paste` | None | `list [<paste>] \| clipboard` | Put the clipboard into the prompt, and read folded pastes before you send them |
| `/queue` | None | `list \| edit <message> <new text...> \| delete <message>` | The messages you typed while a turn runs: see, change or take back one before it is sent |
| `/quit` | None | None | Close this program |
| `/redo` | None | `[<what>]` | Bring back what was undone last |
| `/replay` | None | `status \| runs \| load <run> \| step [<steps>] \| seek <revision> \| diff <other run> \| export <file>` | Every turn is recorded as a run: load one, step through it, compare it with another, and save the report |
| `/resume` | None | `<session> [--force]` | Continue a saved session here |
| `/retry` | None | `[<changed message...>]` | Send your last message again, as it was or changed |
| `/save` | None | `[--switch] [--replace] [<name...>]` | Save this conversation under a name to come back to |
| `/session` | None | `current \| list \| resume <session> [--force] \| save [--switch] [--replace] [<name...>] \| fork [<name...>] \| rename <name...> \| info [<session>] \| search <words...> \| delete <session> \| events [<kind>] [<from row>] [--last <how many>] \| groups [<kind>] [<from row>] [--last <how many>] \| hotspots [<kind>] \| find [--kind <kind>] [<words...>] \| next [<to>] \| prev [<to>] \| expand [<blocks>] \| collapse [<blocks>] \| bookmarks \| composer \| restored \| compactions \| save-file [<as>] [<file>] [--keep-secrets] [--replace] [--then <then>] \| save-saved <session> [<as>] [--print] [--out <file>] \| upload [<as>] [--keep-secrets] [--then <then>] \| branch [<name...>] \| branches \| switch-branch <branch> \| merge-branch <branch> \| graph [--session <session>] [--format <as>] \| link-task <task> [--session <in session>] [--depends-on <waits on>] [--label <label>] \| hand-off <task> [--to <to session>] [--session <in session>] [--reason <why>] \| accept <handoff> \| withdraw <handoff> \| cancel <task> [--scope <what>] [--task <task>] [--session <in session>] [--reason <why>]` | This conversation and your saved ones: resume, save, copy, export, branch and hand off work |
| `/template` | None | `list \| use <template> [<blanks...>] \| save <name> [--everywhere] \| show <template> \| edit <template> \| delete <template> [--everywhere]` | Prompts you keep and reuse: save your last message as one, use one as your next message, edit or delete one |
| `/title` | None | `[<title...>]` | See or change the conversation's title |
| `/undo` | None | `[<what>]` | Take back the last turn, file change or /checkpoint rewind |

### /clear: Start a fresh conversation

`/clear` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Start a fresh conversation | `/clear` | The current conversation is saved as its own session and a fresh one starts; /resume brings the saved one back. | None |

### /compact: Compact the conversation

`/compact` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Compact the conversation now | `/compact` | The older messages are replaced by a summary, so the model has room again; /session compactions lists what each compaction removed. | None |

### /effort: Reasoning effort

`/effort` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See how hard the model thinks | `/effort show` | Shows the level you chose, the level the model in use runs at, and the levels it offers. | None |
| Choose how hard the model thinks | `/effort set <level>` | The model will think at <level> from the next message, until you change it. | None |

### /help: Help

`/help` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See every command and every key | `/help [<about>]` | Shows every command and every key, or one command's actions and lines. | None |

### /hosted: Hosted sessions

`/hosted` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the hosted session you are in | `/hosted status` | Shows the hosted session this terminal joined, what leaving it would do, and the tool running in it. | None |
| Start a hosted session | `/hosted new [--on-leave <when everyone leaves>] [<first message...>]` | A conversation will start in the daemon for this project and this terminal joins it; it lasts until you change it (ending it, or as "When everyone leaves" says). | None |
| See hosted sessions | `/hosted list [--all]` | Lists the hosted sessions the daemon has, who has joined each, and what leaving would do. | None |
| Join a hosted session | `/hosted attach <session>` | This terminal joins hosted session <session>, shows its conversation so far and follows it live. | None |
| Send a message now | `/hosted send <message...>` | "<message>" will be sent to the hosted session now, into the turn it is running. | None |
| Send a message after this turn | `/hosted send-later <message...>` | "<message>" will wait and run after the hosted session's current turn. | None |
| Stop the tool that is running | `/hosted stop-tool [<tool>]` | The tool call <tool> in the hosted session will be stopped; the turn goes on without its result. | None |
| Leave the hosted session | `/hosted leave` | This terminal leaves the hosted session; it keeps running or ends, as its "when everyone leaves" setting says. | None |
| End a hosted session | `/hosted end <session>` | Hosted session <session> and the turn it is running will end, whatever its setting says. | cannot be undone |

### /model: Model

`/model` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Choose a model | `/model choose` | Opens the model picker: the Recommended short list first, each model with its price tier, and a tab for each job a model does. | None |
| See your model and the others you can use | `/model list` | Shows the model in use, its backup models, and every model you can switch to, by provider. | None |
| Switch model | `/model use <model>` | Your conversations will use <model> from the next message, until you change it. | None |
| Read the list of models again | `/model refresh` | Asks every provider you have set up for its models again, here and on the daemon, and says for each how many it has or why its list could not be read. | None |
| Add a backup model | `/model backup <model>` | When a turn fails on your model, it moves to <model> (after any backups already listed), until you change it. | None |
| Remove a backup model | `/model drop-backup <backup model>` | A turn that fails will no longer move to <backup model>, until you change it. | None |

### /notes: Notes

`/notes` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your notes | `/notes list` | Lists your notes, newest last, with whether you reviewed each. | None |
| Read one note | `/notes show <note>` | Shows note <note> in full, with what was made from it. | None |
| Find a note | `/notes search <words...>` | Lists the notes that mention <words>. | None |
| Write a note | `/notes create [--title <title>] [--url <web page>] [--tags <tags>] <text...>` | A note with the text "<text>" is kept until you change it; in the terminal app it lasts for this session, and the model keeps seeing it after a compaction. | None |
| Change a note | `/notes edit <note> [--title <title>] [--url <web page>] [--tags <tags>] [<text...>]` | Note <note> takes the changes given and is no longer marked reviewed, until you change it. | None |
| Mark a note reviewed | `/notes review <note>` | Note <note> is marked reviewed, until you change it. | None |
| Mark a note out of date | `/notes stale <note> <why...>` | Note <note> is marked out of date because "<why>", until you change it. | None |
| Delete a note | `/notes delete <note>` | Note <note> is removed. | cannot be undone |
| Keep a note as a memory | `/notes to-memory <note> [--kind <kind>] [--scope <where it applies>]` | Note <note> becomes a memory record (its title the summary, its text the detail), until you change it; the note stays. | None |
| Make a persona from a note | `/notes to-persona <note>` | Note <note> becomes a persona (its text the instructions), not in use, until you change it; the note stays. | None |
| Make a skill from a note | `/notes to-skill <note> [--enable]` | Note <note> becomes a skill (its text the steps), until you change it; the note stays. | None |
| Make a routine from a note | `/notes to-routine <note> [--enable]` | Note <note> becomes a routine (its text the steps), until you change it; the note stays. | None |
| Add a note's web page to Agent Knowledge | `/notes to-knowledge <note>` | The web page of note <note> is fetched and added to Agent Knowledge, until you change it; the note stays. | None |

### /paste: Paste

`/paste` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Read the pastes folded in the prompt | `/paste list [<paste>]` | Shows what each folded paste ([TEXT: pN, M lines]) in the prompt holds; with one chosen, its whole text. | None |
| Paste the clipboard into the prompt | `/paste clipboard` | The text or image on the clipboard goes into the prompt; nothing is sent until you send it. | None |

### /queue: Queued messages

`/queue` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your queued messages | `/queue list` | Lists the messages waiting to be sent after the running turn, in the order they will go. | None |
| Change a queued message | `/queue edit <message> <new text...>` | Queued message <message> is sent as <new text> instead, when the running turn ends. | None |
| Take back a queued message | `/queue delete <message>` | Queued message <message> is taken back and never sent. | cannot be undone |

### /quit: Quit

`/quit` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Close this program | `/quit` | This program closes; work the daemon runs goes on without it. | None |

### /redo: Redo

`/redo` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Redo the step undone last | `/redo [<what>]` | The step of the kind chosen that was undone last is brought back. | None |

### /replay: Replay recorded runs

`/replay` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the loaded run | `/replay status` | Shows which recorded run is loaded and where in it you are. | None |
| See the recorded runs | `/replay runs` | Lists the runs recorded so far, one per turn. | None |
| Load a recorded run | `/replay load <run>` | Run <run> is loaded for stepping through, from its first event. | None |
| Step through the loaded run | `/replay step [<steps>]` | The loaded run goes forward by the number of events given, each one shown. | None |
| Jump to a point in the loaded run | `/replay seek <revision>` | The loaded run jumps to revision <revision>. | None |
| Compare the loaded run with another | `/replay diff <other run>` | Compares the loaded run with run <other run>, event by event, and lists where they differ. | None |
| Save the replay report to a file | `/replay export <file>` | The report of the loaded run, with every difference found, is written to <file>. | None |

### /resume: Resume a session

`/resume` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Resume a saved session | `/resume <session> [--force]` | This conversation is set aside and <session> continues here, with its messages, model and agent records. | None |

### /retry: Ask again

`/retry` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Send the last message again | `/retry [<changed message...>]` | Your last message is sent again (changed, when you typed a new one) and answered as a new turn. | None |

### /save: Save this session

`/save` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Save this session under a name | `/save [--switch] [--replace] [<name...>]` | This conversation will be saved under the name given (or its title), until you change it. | None |

### /session: Sessions

`/session` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See this session | `/session current` | Shows this session's id, name, when it started, how many messages it has and its model. | None |
| See your saved sessions | `/session list` | Lists your saved sessions, newest first, with what each was doing when it was left. | None |
| Resume a saved session | `/session resume <session> [--force]` | This conversation is set aside and <session> continues here, with its messages, model and agent records. | None |
| Save this session under a name | `/session save [--switch] [--replace] [<name...>]` | This conversation will be saved under the name given (or its title), until you change it. | None |
| Continue in a copy of this session | `/session fork [<name...>]` | A copy of this session is saved under the name given and later turns go to the copy; this session stays as it is now, until you change it. | None |
| Rename this session | `/session rename <name...>` | This session will be called <name> until you change it. | None |
| See a saved session's details | `/session info [<session>]` | Shows a saved session: its title, model, provider, date, message count, file and what it was doing. | None |
| Search saved sessions | `/session search <words...>` | Finds saved sessions whose messages hold <words>, with the matching lines. | None |
| Delete a saved session | `/session delete <session>` | Saved session <session> and its messages will be deleted from this project. | cannot be undone |
| See this conversation's events | `/session events [<kind>] [<from row>] [--last <how many>]` | Shows the conversation's record entry by entry (messages, tool calls, approvals), newest page first. | None |
| See this conversation turn by turn | `/session groups [<kind>] [<from row>] [--last <how many>]` | Shows the conversation's record grouped by turn, newest page first. | None |
| See where this conversation spent most | `/session hotspots [<kind>]` | Counts the whole record by what took the most entries. | None |
| Find words in this conversation | `/session find [--kind <kind>] [<words...>]` | Lists the entries of this conversation that hold the words given; with none, searches in place. | None |
| Jump to the next entry | `/session next [<to>]` | Scrolls to the next entry of the kind chosen, after where you are. | None |
| Jump to the previous entry | `/session prev [<to>]` | Scrolls to the previous entry of the kind chosen, before where you are. | None |
| Open folded blocks | `/session expand [<blocks>]` | Opens the folded blocks of the kind chosen in this conversation. | None |
| Fold blocks | `/session collapse [<blocks>]` | Folds the blocks of the kind chosen in this conversation to one line each. | None |
| See bookmarked blocks | `/session bookmarks` | Lists the blocks you bookmarked (Ctrl+B) and jumps to one. | None |
| See what the composer waits on | `/session composer` | Shows the composer's mode, what it waits on, the turn's state and how full the context is. | None |
| See what a resume brought back | `/session restored` | Lists the entries a resume restored: approvals, tasks, remote state and notices. | None |
| See what compaction removed | `/session compactions` | Lists each compaction of this session: when, how much it removed and what it kept. | None |
| Save this conversation as a file | `/session save-file [<as>] [<file>] [--keep-secrets] [--replace] [--then <then>]` | This conversation will be written to <file> as <as> on this machine, until you change it. | None |
| Save a saved session as a file | `/session save-saved <session> [<as>] [--print] [--out <file>]` | The redacted transcript of <session> will be written out (<as>); an existing file is never replaced. | None |
| Upload this conversation and get a link | `/session upload [<as>] [--keep-secrets] [--then <then>]` | This conversation (<as>) will be written to a file and uploaded as a secret GitHub Gist that anyone with its link can read. | sends something outside this machine |
| Branch this conversation here | `/session branch [<name...>]` | A branch is kept of the conversation as it is now, under the name given; you go on in the current one, until you change it. | None |
| See this conversation's branches | `/session branches` | Lists the branches of this conversation and which one you are on. | None |
| Switch to a branch | `/session switch-branch <branch>` | The conversation goes on from branch <branch> until you change it. | None |
| Bring a branch's new messages in | `/session merge-branch <branch>` | The messages branch <branch> gained after it was made are added to this conversation, until you change it. | None |
| See the cross-session task graph | `/session graph [--session <session>] [--format <as>]` | Shows the tasks linked across sessions, what each waits on, and the handoffs waiting. | None |
| Add a task to the cross-session graph | `/session link-task <task> [--session <in session>] [--depends-on <waits on>] [--label <label>]` | Task <task> will be in the cross-session graph, with what it waits on, until you change it. | None |
| Hand a task to another session | `/session hand-off <task> [--to <to session>] [--session <in session>] [--reason <why>]` | Task <task> is offered to session <to session> and waits until it is accepted or taken back. | None |
| Accept a handoff | `/session accept <handoff>` | Handoff <handoff> is accepted for its destination session and its task is no longer blocked. | None |
| Take back a handoff | `/session withdraw <handoff>` | Handoff <handoff> is withdrawn and its task goes back to the status it had before. | None |
| Cancel tasks in the graph | `/session cancel <task> [--scope <what>] [--task <task>] [--session <in session>] [--reason <why>]` | The tasks chosen (<what>) will be cancelled; a cancelled task does not start again. | cannot be undone |

### /template: Prompt templates

`/template` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your templates | `/template list` | Lists your templates; picking one in the list sends it as your next message (Del deletes it, Ctrl+E edits it). | None |
| Use a template as your next message | `/template use <template> [<blanks...>]` | Template <template>, its blanks filled in, is sent as your next message. | None |
| Save your last message as a template | `/template save <name> [--everywhere]` | Your last message is kept as template <name> (<for>); a template already saved under that name there is replaced. | cannot be undone |
| See a template | `/template show <template>` | Shows template <template> as written. | None |
| Edit a template in your editor | `/template edit <template>` | Opens template <template> in your editor; the saved file is what /template use reads. | None |
| Delete a template | `/template delete <template> [--everywhere]` | Template <template> (<which one>) is deleted. | cannot be undone |

### /title: Conversation title

`/title` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Name this conversation | `/title [<title...>]` | This conversation will be titled as typed (with nothing typed, its title is shown) until you change it. | None |

### /undo: Undo

`/undo` runs its one action; it asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Undo the last step | `/undo [<what>]` | The last step of the kind chosen is taken back; /redo brings it back. | None |

## Settings and safety

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/about-me` | None | `show \| field <fact> \| person <person...> \| where <fact> \| status \| set <fact> <value...> \| note [<section>] <line...> \| undo <fact> \| forget <fact> \| forget-line <section> <line...>` | What the platform knows about you: read it, see where a fact came from, correct it, or forget it |
| `/approval` | None | `kinds [<kind>] \| waiting` | What each kind of approval asks about, and the approvals waiting on you |
| `/auth` | None | `review \| show <provider> \| repair <provider> \| export <file> [--replace] \| inspect <file>` | See how you are signed in to model providers and how to fix a sign-in |
| `/decisions` | None | `list [--when <when>] [--count <how many>] \| keep <decision> \| undo <decision> \| never <decision> \| always <decision> \| ask <decision>` | Calls Jev decided for you, and every answered inbox item: see them, undo one, or set a standing rule |
| `/held` | None | `list \| approve <held calls...> \| dismiss <held calls...>` | Calls just-vibes held for you instead of asking: approve them or set them aside |
| `/local-auth` | None | `review \| open \| add <user name> [--password <password>] [--again <password again>] [--role <role>] \| remove <user> \| password <user> [--password <password>] [--again <password again>] \| sign-out <session> \| remove-first-run-file` | Choose who may sign in to this machine's daemon and web app |
| `/payments` | None | `cards \| pending \| approve <shop> [--most <at most>] <what may be bought...> \| repeat [--shop <shop>]... [--item <what may be bought>] [--each <most per purchase>] [--per-period <most in any period>] [--days <period>] [--until <last day>] \| repeats \| stop-repeat <repeat purchase> \| add-card \| remove-card <card> \| address <address> [--name <recipient name>] [--line1 <address line 1>] [--line2 <address line 2>] [--city <city>] [--region <state or region>] [--postal-code <postal code>] [--country <country>]` | Cards, purchases, and what may be bought without asking |
| `/permissions` | None | `mode \| show \| rules \| never <command...> \| add <then> <for> <which...> \| revoke <rule>` | See which permission settings are in force, and the rules that decide calls without asking |
| `/power` | None | `status \| on \| off` | See whether this computer may sleep, and keep it awake |
| `/presets` | None | `open \| list \| export <file> [--overwrite] \| inspect <file> \| import <file> [--prefix <name prefix>] [--overwrite]` | Saved sets of display, model and behaviour settings: load one, save yours as one, and move them between machines |
| `/principals` | None | `list \| get <who> \| resolve <channel> <identity> \| create <name> <kind> [--identity <identities>]... \| update <who> [--name <name>] [--kind <kind>] [--identities <identities>] \| delete <who>` | The people, bots and services the daemon knows, and their identity on each channel |
| `/questions` | None | `list \| all \| show <item> \| answer <question> <answer...> \| withdraw <request> [<why...>]` | Permission asks, questions agents left, claims and purchase windows: see them and answer |
| `/security` | None | `report \| review \| tokens \| attack-paths \| trust \| folder \| trust-folder \| restrict-folder \| save-trust <file> [--replace] \| read-trust <file> \| policy \| load-policy <file> \| simulate-policy \| compare-policy \| lint-policy \| preflight \| enforce-policy \| restore-policy \| sandbox \| sandbox-advice \| sandbox-profiles \| sandbox-presets \| sandbox-probe \| contain-mcp \| host-mcp \| sandbox-sessions \| start-sandbox <profile> [--host] [<name...>] \| sandbox-session <sandbox session> \| stop-sandbox <sandbox session> \| run-in-sandbox <sandbox session> <command...> \| save-sandbox <sandbox session> <file> [--replace] \| read-sandbox <file> \| security-screen \| policy-screen \| sandbox-screen` | See what protects this machine: tokens, trust, policies and the sandbox, and change them |
| `/settings-sync` | None | `review \| open \| show <setting> \| conflicts \| resolve <setting> <keep> \| failures \| export <bundle file> \| inspect <bundle file> \| pull <bundle file>` | Carry your settings to another machine as a file, and settle values that disagree |
| `/update` | None | `check \| apply \| rollback \| daemon [--check] \| review \| save-review <file> [--replace] \| read-review <file>` | See whether a newer release is out, install it, or go back to the version before |
| `/voice` | None | `review \| speak <message...> \| stop \| on \| off \| status \| setup \| wake-status \| wake-setup [--with-speech-to-text] \| wake-again \| export <file> \| inspect <file> \| import <file>` | Hear answers spoken, set up the local voice runtime and the wake word, and keep the voice settings as a file |

### /about-me: About you

`/about-me` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what is known about you | `/about-me show` | Shows your profile by section, each fact with where it came from. | None |
| See one fact about you | `/about-me field <fact>` | Shows fact <fact>, its value and where it came from. | None |
| See what is known about a person | `/about-me person <person...>` | Shows what your profile records about <person>. | None |
| See where a fact came from | `/about-me where <fact>` | Shows where fact <fact> came from: the surface, the date and your exact words, and the values it replaced. | None |
| Check that your profile loads | `/about-me status` | Says whether your profile loaded, from where, and which facts did not parse. | None |
| Record or correct a fact | `/about-me set <fact> <value...>` | Fact <fact> is recorded as "<value>" in your own words, until you change it. | None |
| Add a line about you | `/about-me note [<section>] <line...>` | The line "<line>" is added to your profile, until you change it. | None |
| Put back a fact's earlier value | `/about-me undo <fact>` | Fact <fact> gets back the value it had before its last change, until you change it. | None |
| Forget a fact | `/about-me forget <fact>` | Fact <fact> and every earlier value kept for it are deleted from your profile. | cannot be undone |
| Forget a line | `/about-me forget-line <section> <line...>` | The line "<line>" is deleted from section <section> of your profile. | cannot be undone |

### /approval: Approvals

`/approval` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the kinds of approval | `/approval kinds [<kind>]` | Shows what each kind of approval asks about <kind>, and what to check before you answer one. | None |
| Open the approvals waiting on you | `/approval waiting` | Opens the list of approvals waiting on your answer. | None |

### /auth: Provider sign-ins

`/auth` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your provider sign-ins | `/auth review` | Shows each provider you can sign in to, whether you are signed in, and when it ends. | None |
| See one provider's sign-in | `/auth show <provider>` | Shows how <provider> is signed in: where its settings come from, the token's type and end, and anything wrong; no token is shown. | None |
| See how to fix a provider's sign-in | `/auth repair <provider>` | Shows what is wrong with <provider>'s sign-in and the steps that fix it. | None |
| Save a sign-in summary to a file | `/auth export <file> [--replace]` | A summary of your sign-ins (names of stored secrets and providers, no secret or token) will be written to <file>, readable by you only, until you change it. | None |
| Read a saved sign-in summary | `/auth inspect <file>` | Shows what the sign-in summary in <file> holds. | None |

### /decisions: What was decided for you

`/decisions` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what was decided for you | `/decisions list [--when <when>] [--count <how many>]` | Lists the calls Jev decided that you can still change, and what was decided, <when>. | None |
| Leave a decision as Jev made it | `/decisions keep <decision>` | <decision> stays as Jev decided it, and nothing changes until you change it. | None |
| Undo what a decision did | `/decisions undo <decision>` | The files the call in <decision> changed are put back as they were before it, until you change it. | None |
| Never allow calls like a decision's | `/decisions never <decision>` | Calls like the one in <decision> are refused from now on, until you change it. | None |
| Always allow calls like a decision's without asking | `/decisions always <decision>` | Calls like the one in <decision> run without asking from now on, until you change it. | loosens a protection |
| Ask me about calls like a decision's | `/decisions ask <decision>` | Calls like the one in <decision> are asked of you from now on, until you change it. | None |

### /held: Held calls

`/held` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the calls held for you | `/held list` | Lists the calls just-vibes held instead of asking you, with why each was held. | None |
| Approve a held call | `/held approve <held calls...>` | <held calls> may run for this session only, when the work carries on. | loosens a protection |
| Set a held call aside | `/held dismiss <held calls...>` | <held calls> is set aside and not run, for this session only; the model may make the call again. | None |

### /local-auth: Local sign-in

`/local-auth` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See who may sign in | `/local-auth review` | Shows the local users, their roles, the open sessions and whether the first-run sign-in file is still there. | None |
| Open the local sign-in screen | `/local-auth open` | Opens the full-screen view of local users and sessions. | None |
| Let someone sign in | `/local-auth add <user name> [--password <password>] [--again <password again>] [--role <role>]` | <user name> will be able to sign in to this machine's daemon and web app as a <role>, until you change it. | None |
| Stop someone signing in | `/local-auth remove <user>` | <user> will no longer be able to sign in, and the account is deleted; add it again to let them back in. | cannot be undone |
| Change someone's password | `/local-auth password <user> [--password <password>] [--again <password again>]` | <user>'s password will be replaced and everyone signed in as <user> is signed out, until you change it. | None |
| Sign someone out | `/local-auth sign-out <session>` | Session <session> will be ended; whoever uses it must sign in again. | cannot be undone |
| Remove the first-run sign-in file | `/local-auth remove-first-run-file` | The file holding the first-run sign-in is deleted; if no user has been added, nobody can sign in to the web app until one is. | cannot be undone |

### /payments: Payments

`/payments` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your cards | `/payments cards` | Shows the payment cards on the selected daemon (label, kind, last four digits and expiry, never the number) and the addresses purchases use. | None |
| See what is waiting for your answer | `/payments pending` | Opens the purchases waiting for you: approve or deny one, stop a checkout, or type a card's security code; each answer is asked again before it is sent. | None |
| Approve one purchase ahead of time | `/payments approve <shop> [--most <at most>] <what may be bought...>` | One purchase of "<what may be bought>" from <shop>, of at most <at most>, begun in the next five minutes, will need no further answer; it is used once and lasts for this session only. | spends money |
| Allow a repeat purchase | `/payments repeat [--shop <shop>]... [--item <what may be bought>] [--each <most per purchase>] [--per-period <most in any period>] [--days <period>] [--until <last day>]` | A schedule may buy "<what may be bought>" from <shop> without asking: at most <most per purchase> each time and <most in any period> in any <period> days, until you change it or its last day passes. Every other spending limit still applies. | spends money |
| See repeat purchases you have allowed | `/payments repeats` | Shows each repeat purchase you have allowed: what, from which shops, the limits, and what is left this period. | None |
| Stop a repeat purchase | `/payments stop-repeat <repeat purchase>` | No new purchase will start under <repeat purchase> until you change it; one already running keeps its window, where you can still stop it. | None |
| Add a card | `/payments add-card` | You will be asked the card's label, kind, number, expiry, security code and name, each hidden as you type; the card is stored on the selected daemon until you change it. | None |
| Remove a card | `/payments remove-card <card>` | Card <card> (its number, expiry, security code and name) will be deleted from the selected daemon. Cancel it with the issuer too if it should stop working everywhere. | cannot be undone |
| Set your billing or shipping address | `/payments address <address> [--name <recipient name>] [--line1 <address line 1>] [--line2 <address line 2>] [--city <city>] [--region <state or region>] [--postal-code <postal code>] [--country <country>]` | Your <address> address will be set to what you typed (blank fields keep their value) until you change it. | None |

### /permissions: Permissions

`/permissions` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what GoodVibes asks you about now, and why | `/permissions mode` | Shows the permission mode in force, what it does, why it differs from the one you chose, and the setting that changes it. | None |
| See the permission settings in force | `/permissions show` | Shows the permission mode and settings in force, where each comes from, and how many rules there are. | None |
| See the permission rules | `/permissions rules` | Lists every rule that decides a call without asking: what it covers, allow or deny, and where. | None |
| Never run a command | `/permissions never <command...>` | Every tool is refused a command that runs "<command>", in every permission mode and every project, until you change it. | None |
| Add a permission rule | `/permissions add <then> <for> <which...>` | In this project, a call matching <for> <which> will <then> until you change it. | None |
| Remove a permission rule | `/permissions revoke <rule>` | <rule> is removed, so a call it covered is decided as usual again (it may run, or be asked), until you change it. | None |

### /power: Sleep

`/power` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See whether this computer may sleep | `/power status` | Shows who holds this computer awake and why, and whether keep-awake is on. | None |
| Keep this computer awake | `/power on` | This computer will not sleep when idle, until you change it; the status bar shows it while it holds. | None |
| Let this computer sleep again | `/power off` | This computer may sleep when idle again, until you change it; work that holds it awake still does. | None |

### /presets: Presets

`/presets` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| Pick a preset | `/presets open` | Opens your presets: Enter loads one, Ctrl+S saves the current settings as one, Ctrl+D deletes one. | None |
| See your presets | `/presets list` | Lists your saved presets and when each was saved. | None |
| Save your presets to a file | `/presets export <file> [--overwrite]` | Every preset is written to <file>, to bring to another machine, until you change it. | None |
| Check a presets file | `/presets inspect <file>` | Shows what the presets file <file> holds, without adding anything. | None |
| Add presets from a file | `/presets import <file> [--prefix <name prefix>] [--overwrite]` | The presets in <file> are added to yours, until you change it. | None |

### /principals: Who is who

`/principals` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See who the daemon knows | `/principals list` | Lists every person, bot and service with their identities on each channel. | None |
| See one person, bot or service | `/principals get <who>` | Shows <who>'s kind and identities. | None |
| Find who a channel identity belongs to | `/principals resolve <channel> <identity>` | Shows who <channel>:<identity> is, if the daemon knows. | None |
| Add a person, bot or service | `/principals create <name> <kind> [--identity <identities>]...` | <name> (<kind>) is added to the daemon's registry, until you change it. | None |
| Change a person, bot or service | `/principals update <who> [--name <name>] [--kind <kind>] [--identities <identities>]` | <who> is changed to what you gave, until you change it. | None |
| Remove a person, bot or service | `/principals delete <who>` | <who> and its identities are removed from the daemon's registry. | cannot be undone |

### /questions: What waits on you

`/questions` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what waits on you | `/questions list` | Lists every open question, ask, claim and purchase window, with its answers. | None |
| See everything ever asked of you | `/questions all` | Lists every inbox item, open or answered, newest first, with who answered and where the answer went. | None |
| See one question in full | `/questions show <item>` | Shows <item> in full: who asked, when, the answers it takes, and where an answer went. | None |
| Answer a question | `/questions answer <question> <answer...>` | <question> is answered "<answer>" and the answer goes to whoever asked. | cannot be undone |
| Withdraw a request you raised | `/questions withdraw <request> [<why...>]` | Your request <request> stops waiting and is cancelled; nobody can approve it any more. | cannot be undone |

### /security: Security

`/security` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See what needs attention | `/security report` | Checks paired-device tokens, the policies, MCP servers and their routes, plugins and this folder's trust, and names each thing that needs attention with the line that fixes it. | None |
| See the whole security review | `/security review` | Shows every count the review reads: tokens, subscriptions, policy findings, MCP servers and their routes, and plugins. | None |
| See paired-device tokens | `/security tokens` | Lists each paired device's token with its policy, whether it stays in scope, when it is due for rotation and whether it is blocked. | None |
| See risky routes through MCP servers | `/security attack-paths` | Shows the routes by which an MCP server could reach files, the network or other tools further than its trust allows. | None |
| See what is trusted | `/security trust` | Shows the permission mode, how many secrets and services are set up, and how far each plugin and MCP server is trusted. | None |
| See whether this folder is trusted | `/security folder` | Shows whether this folder is trusted, restricted or not decided, and what each means here. | None |
| Trust this folder | `/security trust-folder` | This folder becomes trusted: its own hooks and MCP servers may run and tools may change it, until you change it. | loosens a protection |
| Restrict this folder | `/security restrict-folder` | This folder becomes restricted: its own hooks and MCP servers stay off, until you change it. | None |
| Save the trust summary to a file | `/security save-trust <file> [--replace]` | The trust summary (secret names, not values) will be written to <file>, until you change it. | None |
| Read a saved trust summary | `/security read-trust <file>` | Reads the trust summary saved in <file> and shows what it recorded. | None |
| See the policy in force | `/security policy` | Shows the policy bundle in force, the candidate waiting, the history and what the candidate would change. | None |
| Load a candidate policy | `/security load-policy <file>` | The bundle in <file> becomes the candidate policy until you change it; nothing is enforced until you enforce it. | None |
| See what the candidate policy changes | `/security simulate-policy` | Decides this machine's recorded calls again under the candidate and shows each one it decides differently; no model is asked. | None |
| Compare the candidate with the policy in force | `/security compare-policy` | Shows the rules the candidate adds, removes, changes and moves. | None |
| Check the policies for mistakes | `/security lint-policy` | Lints the policy in force and the candidate and lists each finding. | None |
| Review policy and MCP risk | `/security preflight` | Reviews the policy, the settings and the MCP servers' trust together and lists each issue. | None |
| Enforce the candidate policy | `/security enforce-policy` | The candidate becomes the policy in force, deciding the calls "See what the candidate policy changes" showed differently, until you change it. | loosens a protection |
| Go back to the previous policy | `/security restore-policy` | The policy in force before the last one is enforced again, until you change it. | loosens a protection |
| See the sandbox | `/security sandbox` | Shows whether commands and MCP servers run inside a process boundary on this machine, and which backend does it. | None |
| See what the sandbox should be | `/security sandbox-advice` | Says what to set for the sandbox on this machine, and why. | None |
| See the sandbox profiles | `/security sandbox-profiles` | Lists the sandbox profiles (commands, MCP servers) with what each may reach and the backend that runs it. | None |
| See the sandbox presets | `/security sandbox-presets` | Lists the presets for MCP servers, what each sets and its notes. | None |
| Probe the sandbox on this machine | `/security sandbox-probe` | Probes which process boundary this machine can run now, with any warnings. | None |
| Run MCP servers inside the sandbox | `/security contain-mcp` | Each MCP server runs inside its own process boundary, and the running ones are restarted inside it, until you change it. | None |
| Run MCP servers as host processes | `/security host-mcp` | MCP servers run as ordinary processes of this machine, with no boundary, and the running ones are restarted that way, until you change it. | loosens a protection |
| See the sandbox sessions | `/security sandbox-sessions` | Lists the sandbox sessions started here, with their profile, backend and state. | None |
| Start a sandbox session | `/security start-sandbox <profile> [--host] [<name...>]` | A <profile> sandbox session starts and stays until you stop it, for this session only. | None |
| See a sandbox session | `/security sandbox-session <sandbox session>` | Shows sandbox session <sandbox session>: its profile, backend, state and the last command it ran. | None |
| Stop a sandbox session | `/security stop-sandbox <sandbox session>` | Sandbox session <sandbox session> stops; what runs in it ends. | cannot be undone |
| Run a command in a sandbox session | `/security run-in-sandbox <sandbox session> <command...>` | Runs <command> inside sandbox session <sandbox session> (at most 10 seconds) and shows what it printed. | None |
| Save a sandbox session's record to a file | `/security save-sandbox <sandbox session> <file> [--replace]` | The record of sandbox session <sandbox session> will be written to <file>, until you change it. | None |
| Read a saved sandbox session record | `/security read-sandbox <file>` | Reads the sandbox session record saved in <file> and shows what it recorded. | None |
| Open the security screen | `/security security-screen` | Opens the security screen: tokens, governance, MCP routes and the latest failure. | None |
| Open the policy screen | `/security policy-screen` | Opens the policy screen: the bundles, their diff, the calls decided differently and the preflight. | None |
| Open the sandbox screen | `/security sandbox-screen` | Opens the sandbox screen: the boundary, the MCP containment and the sandbox sessions. | None |

### /settings-sync: Settings sync

`/settings-sync` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See where your settings come from | `/settings-sync review` | Shows which layers your settings come from, sync state, conflicts, locks and recent failures. | None |
| Open the settings sync screen | `/settings-sync open` | Opens the full-screen view of synced settings and conflicts. | None |
| See where one setting's value comes from | `/settings-sync show <setting>` | Shows <setting>'s value in each layer and which one wins. | None |
| See settings that disagree | `/settings-sync conflicts` | Shows the settings whose synced value differs from this machine's. | None |
| Settle a setting that disagrees | `/settings-sync resolve <setting> <keep>` | <setting> keeps the <keep> value until you change it. | None |
| See recent sync failures | `/settings-sync failures` | Shows the sync and managed-setting attempts that failed recently and why. | None |
| Save your settings to a sync bundle | `/settings-sync export <bundle file>` | Your settings are written to <bundle file> as a bundle another machine can pull. | None |
| Look inside a sync bundle | `/settings-sync inspect <bundle file>` | Shows what <bundle file> holds; nothing is changed. | None |
| Take the settings from a sync bundle | `/settings-sync pull <bundle file>` | The settings in <bundle file> replace yours until you change it, except keys a managed lock owns; what changed is listed, with the copy of your settings from before that puts them back. | loosens a protection |

### /update: Updates

`/update` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See whether a newer release is out | `/update check` | Asks the release page for the newest release and compares it with the one running. | None |
| Install the newer release | `/update apply` | The newest release is downloaded, checked and installed for every GoodVibes program here, until you change it; the version replaced is kept for going back. | None |
| Go back to the previous version | `/update rollback` | The version kept by the last update is put back for every GoodVibes program here, until you change it. | None |
| See the daemon's updates | `/update daemon [--check]` | Shows the connected daemon's own update state: its version, the newest release it found and when it looks again. | None |
| See this install | `/update review` | Shows the version installed, the newest release, how it was installed, whether a previous version is kept and what an update keeps. | None |
| Save this install's update state to a file | `/update save-review <file> [--replace]` | What "See this install" shows will be written to <file>, until you change it; it is a record, not an update. | None |
| Read a saved update state | `/update read-review <file>` | Reads the update state saved in <file> and shows what it recorded. | None |

### /voice: Voice

`/voice` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your voice settings | `/voice review` | Shows whether every answer is spoken aloud and how voice is set up here. | None |
| Ask and hear the answer spoken | `/voice speak <message...>` | <message> is sent as a message and the answer is played aloud. | None |
| Stop what is being spoken | `/voice stop` | Whatever is being played aloud now stops. | None |
| Speak every answer aloud | `/voice on` | Every answer will be played aloud until you change it. | None |
| Stop speaking every answer | `/voice off` | Answers will no longer be played aloud, until you change it. | None |
| See the local voice runtime | `/voice status` | Shows whether speech output and speech-to-text are installed here, and an install in progress. | None |
| Install the local voice runtime | `/voice setup` | The local speech output and, where this machine has a published bundle, speech-to-text are downloaded and set up; it can be hundreds of megabytes. | None |
| See wake-word detection | `/voice wake-status` | Shows whether the wake-word models are here and how listening for the wake word is set. | None |
| Set up the wake word | `/voice wake-setup [--with-speech-to-text]` | The wake-word models are downloaded and checked, and speech-to-text is installed too when chosen. | None |
| Listen for the wake word again | `/voice wake-again` | Listening for the wake word starts again after it stopped by itself (it also starts again when this terminal regains focus). | None |
| Save your voice settings to a file | `/voice export <file>` | The voice settings you changed from their defaults are written to <file>. | None |
| Read a voice settings file | `/voice inspect <file>` | Shows the settings in <file> without applying them. | None |
| Apply voice settings from a file | `/voice import <file>` | The voice settings in <file> are applied until you change it. | None |

## Tools and extensions

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/hooks` | None | `contracts [<only those about...>] \| open \| scaffold <name> <when it runs> [--type <what it does>] \| chain <name> <hook points in order> \| enable <hook> \| disable <hook> \| remove <hook> \| simulate <event> \| reload \| export [<file>] \| inspect <file> \| import <file> [--strategy <your hooks now>]` | Run your own steps when things happen: before a tool runs, after a turn, and more |
| `/marketplace` | None | `overview \| open \| browse [<looking for...>] \| recommend \| installed \| review <kind> <entry> \| provenance <kind> <entry> \| install-hint <kind> <entry> \| install <kind> <entry> [--scope <install for>] \| update <kind> <entry> [--scope <install for>] \| history <kind> <entry> [--scope <install for>] \| rollback <kind> <entry> [--scope <install for>] [--backup <backup>] \| receipt <kind> <entry> [--scope <install for>] \| uninstall <kind> <entry> [--scope <install for>] \| bundle-export <bundle file> [--scope <install for>] \| bundle-inspect <bundle file> \| bundle-import <bundle file> [--scope <install for>]` | Find, install and update curated plugins, skills, hook packs and policy packs |
| `/mcp` | None | `servers \| tools [<server>] \| block <server> <tool> [--keep] \| unblock <server> <tool> \| exempt <server> <tool> \| unexempt <server> <tool> \| add <name> [--url <address>] [--trust <trust>] [--role <role>] [--scope <kept for>] [--path <folders it may use>]... [--host <sites it may reach>]... [--env <environment>]... [--header <request header>]... [-- <command>...] \| remove <server> [--scope <from>] \| reload \| trust <server> <trust> \| restore-trust <server> \| role <server> <role> \| restore-role <server> \| quarantine <server> [<why...>] \| accept-tools <server> \| review \| repair [<server>] \| files \| open` | Connect tools from other programs |
| `/plugin` | None | `list \| enable <plugin> \| disable <plugin> \| reload \| quarantine <plugin> [<why...>] \| lift <plugin> \| trust <plugin> <trust tier> [<note...>] \| trust-key <plugin> <key file> \| verify <plugin> \| capabilities <plugin> \| open \| dirs \| inspect <plugin> \| review \| publish-local <catalog id> <plugin folder> <summary...> \| unpublish <catalog entry>` | Switch plugins on and off, set what each one may do, and publish your own |
| `/services` | None | `list \| show <service> \| check \| test <service> \| check-auth <service> \| trust <service> \| export <file> [--replace] \| import <file> \| open` | The API services your stored keys are sent to: see and check them, and use one a project defines |
| `/skills` | None | `list \| open \| show <skill> \| origins \| publish-local <catalog id> <skill folder> <summary...> \| unpublish <catalog entry>` | See the skill packs the model can use, and publish your own |

### /hooks: Hooks

`/hooks` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the hook points and your hooks | `/hooks contracts [<only those about...>]` | Shows each hook point <only those about>, what a hook there may do, and the managed hooks file. | None |
| Open the hooks screen | `/hooks open` | Opens the full-screen view of hook points and managed hooks. | None |
| Make a hook | `/hooks scaffold <name> <when it runs> [--type <what it does>]` | A managed hook <name> of kind <what it does> that runs at <when it runs> is added to the hooks file, switched on, until you change it. | None |
| Make a chain of hook points | `/hooks chain <name> <hook points in order>` | A managed chain <name> over <hook points in order> is added to the hooks file until you change it. | None |
| Switch a hook on | `/hooks enable <hook>` | <hook> runs at its hook point again, until you change it. | None |
| Switch a hook off | `/hooks disable <hook>` | <hook> stops running at its hook point, until you change it. | None |
| Remove a hook or chain | `/hooks remove <hook>` | The managed hook or chain <hook> is deleted from the hooks file; export first with /hooks export to keep a copy. | cannot be undone |
| See which hooks an event would run | `/hooks simulate <event>` | Shows the hooks and chains that <event> would run; nothing runs. | None |
| Read the hooks file again | `/hooks reload` | The managed hooks file is read again, so edits made by hand take effect now. | None |
| Save the hooks to a file | `/hooks export [<file>]` | Every managed hook and chain is written to <file> as a bundle. | None |
| Look inside a hooks bundle | `/hooks inspect <file>` | Shows how many hooks and chains <file> holds and their hook points; nothing is installed. | None |
| Install hooks from a bundle | `/hooks import <file> [--strategy <your hooks now>]` | The hooks and chains in <file> are installed, until you change it. | None |

### /marketplace: Marketplace

`/marketplace` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See the marketplace at a glance | `/marketplace overview` | Shows how many curated entries of each kind there are and how many are installed. | None |
| Open the marketplace screen | `/marketplace open` | Opens the full-screen marketplace to browse and install from. | None |
| Browse the catalog | `/marketplace browse [<looking for...>]` | Lists curated entries of every kind that match <looking for>. | None |
| See what fits this project | `/marketplace recommend` | Shows curated entries that fit this project, ranked when a decision model is set. | None |
| See what is installed | `/marketplace installed` | Lists every curated entry installed, where, and for which projects. | None |
| Check an entry before installing | `/marketplace review <kind> <entry>` | Shows the <kind> <entry>'s source, risk, compatibility and the scope it suits. | None |
| See where an entry comes from | `/marketplace provenance <kind> <entry>` | Shows the <kind> <entry>'s source, author, version, signature and trust notes. | None |
| See how an entry is installed | `/marketplace install-hint <kind> <entry>` | Shows the <kind> <entry>'s install guidance and trust notes. | None |
| Install an entry | `/marketplace install <kind> <entry> [--scope <install for>]` | The <kind> <entry> is installed for <install for> until you change it. | None |
| Update an installed entry | `/marketplace update <kind> <entry> [--scope <install for>]` | The installed <kind> <entry> (<install for>) is updated to the catalog's version until you change it; the old one is kept as a backup. | None |
| See an entry's backups | `/marketplace history <kind> <entry> [--scope <install for>]` | Lists the backups the <kind> <entry> can be rolled back to. | None |
| Roll an entry back to a backup | `/marketplace rollback <kind> <entry> [--scope <install for>] [--backup <backup>]` | The installed <kind> <entry> (<install for>) goes back to an earlier backup until you change it. | None |
| See an entry's install receipt | `/marketplace receipt <kind> <entry> [--scope <install for>]` | Shows when and where the <kind> <entry> was installed, and its provenance and compatibility. | None |
| Uninstall an entry | `/marketplace uninstall <kind> <entry> [--scope <install for>]` | The installed <kind> <entry> (<install for>) is removed from disk with its install receipt; /marketplace install installs it again from the catalog. | cannot be undone |
| Save your installs to a bundle | `/marketplace bundle-export <bundle file> [--scope <install for>]` | What is installed for <install for> is written to <bundle file> as a bundle another machine can bring in. | None |
| Look inside a marketplace bundle | `/marketplace bundle-inspect <bundle file>` | Shows what <bundle file> holds; nothing is installed. | None |
| Bring in installs from a bundle | `/marketplace bundle-import <bundle file> [--scope <install for>]` | The entries in <bundle file> are merged into what is installed for <install for>, by kind and id, until you change it. | None |

### /mcp: MCP servers and tools

`/mcp` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your servers | `/mcp servers` | Shows every MCP server, whether it is connected, its trust level, role and tool rules. | None |
| See a server's tools | `/mcp tools [<server>]` | Lists the tools <server> offers right now. | None |
| Block a tool | `/mcp block <server> <tool> [--keep]` | Every call to <tool> on <server> will be refused for this session only. | None |
| Stop blocking a tool | `/mcp unblock <server> <tool>` | <tool> on <server> will be callable again, under <server>'s usual trust and limits, until you change it. | loosens a protection |
| Let a tool go beyond its server's limits | `/mcp exempt <server> <tool>` | Calls to <tool> on <server> will pass <server>'s folder and site limits until you change it. A block of <tool>, a held-back server or a server set to refuse every call still refuses it. | loosens a protection |
| Make a tool follow its server's limits again | `/mcp unexempt <server> <tool>` | Calls to <tool> on <server> will be held to <server>'s folder and site limits again, until you change it. | None |
| Add a server | `/mcp add <name> [--url <address>] [--trust <trust>] [--role <role>] [--scope <kept for>] [--path <folders it may use>]... [--host <sites it may reach>]... [--env <environment>]... [--header <request header>]... [-- <command>...]` | <name> will be added to the <kept for> MCP config and started now, until you change it. | None |
| Remove a server | `/mcp remove <server> [--scope <from>]` | <server>'s entry (its command, arguments, environment and trust) will be deleted from the <from> MCP config and its tools stop being offered. | cannot be undone |
| Reconnect every server from its config | `/mcp reload` | Every MCP server is read again from its config file and reconnected. | None |
| Set a server's trust level | `/mcp trust <server> <trust>` | <server> will be set to "<trust>" until you change it. | None |
| Go back to the saved trust level | `/mcp restore-trust <server>` | <server> goes back to the trust level saved in its MCP config, which may allow more than the level set for this session, until you change it. | loosens a protection |
| Set a server's role | `/mcp role <server> <role>` | <server> will be treated as a <role> server until you change it. | None |
| Go back to the saved role | `/mcp restore-role <server>` | <server> goes back to the role saved in its MCP config, until you change it. | None |
| Hold back a server's tools for review | `/mcp quarantine <server> [<why...>]` | <server>'s tools will not be offered for this session only, until you accept them again. | None |
| Accept a server's changed tools | `/mcp accept-tools <server>` | <server>'s changed tools will be accepted and offered again for this session only. | loosens a protection |
| See which servers need attention | `/mcp review` | Shows the servers that are not connected or whose tools are held back, with what to do next. | None |
| See how to fix a server | `/mcp repair [<server>]` | Shows <server>'s state and the steps that fix it. | None |
| See where servers are configured | `/mcp files` | Shows each MCP config file in use, whether it can be written, and which servers come from it. | None |
| Open the MCP screen | `/mcp open` | Opens the full-screen view of servers, tools and config files. | None |

### /plugin: Plugins

`/plugin` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your plugins | `/plugin list` | Shows every plugin with its state and trust tier. | None |
| Switch a plugin on | `/plugin enable <plugin>` | <plugin> starts now and at every start, under its trust tier, until you change it. | None |
| Switch a plugin off | `/plugin disable <plugin>` | <plugin> stops now and does not start again, until you change it. | None |
| Load the plugins again | `/plugin reload` | Every switched-on plugin is stopped and started again from its files. | None |
| Quarantine a plugin | `/plugin quarantine <plugin> [<why...>]` | <plugin> is stopped and blocked from loading until you change it (lift the quarantine). | None |
| Lift a plugin's quarantine | `/plugin lift <plugin>` | <plugin> may load again, and starts now if it is switched on, until you change it. | loosens a protection |
| Set what a plugin may do | `/plugin trust <plugin> <trust tier> [<note...>]` | <plugin> is set to the <trust tier> tier on every app of this machine until you change it; a trusted tier without a valid signature is recorded in its trust note. | None |
| Save a plugin publisher's key | `/plugin trust-key <plugin> <key file>` | The key in <key file> is saved as <plugin>'s publisher key, until you change it, so its signature can be checked. | None |
| Check a plugin's signature | `/plugin verify <plugin>` | Checks <plugin>'s manifest signature against its publisher key. | None |
| See what a plugin asks to do | `/plugin capabilities <plugin>` | Shows the capabilities <plugin> declares and which its tier grants or withholds. | None |
| Open the plugins screen | `/plugin open` | Opens the full-screen view of your plugins. | None |
| See where plugins are looked for | `/plugin dirs` | Shows the folders plugins are loaded from, and your own plugin folder. | None |
| See one plugin | `/plugin inspect <plugin>` | Shows <plugin>'s version, state, tier, capabilities, signature and quarantine. | None |
| See how much your plugins may do | `/plugin review` | Counts your plugins by state and trust tier. | None |
| Publish a plugin folder to the local catalog | `/plugin publish-local <catalog id> <plugin folder> <summary...>` | The plugin in <plugin folder> is listed in the local curated catalog as <catalog id> ("<summary>"), until you change it. | None |
| Take a plugin out of the local catalog | `/plugin unpublish <catalog entry>` | <catalog entry> is removed from the local curated catalog; installs of it stay. | cannot be undone |

### /services: Services

`/services` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your services | `/services list` | Shows each service, how it signs in and where it is, and any service from this project that waits for you. | None |
| See one service | `/services show <service>` | Shows how <service> signs in, its address, and which of its credentials are stored. | None |
| Check every service | `/services check` | Checks each service for a missing key, password or address, and counts them by how they sign in. | None |
| Test a service's connection | `/services test <service>` | Sends one request to <service> with its stored credentials and shows how it answered. | None |
| Check that a service can sign in | `/services check-auth <service>` | Checks that <service>'s stored credentials make its sign-in headers now, and names the headers without their values. | None |
| Use a service this project defines | `/services trust <service>` | <service> from this project's services file is used, sending the stored key it names to the address it names, until you change it; this loosens a protection, so you are asked with exactly what it sends and where, and only that entry is approved. | loosens a protection |
| Save your services list to a file | `/services export <file> [--replace]` | Your services list (names, addresses and the names of their keys, never the keys) is written to <file>. | None |
| Replace your services list from a file | `/services import <file>` | Your services list is replaced by the one in <file>, until you change it; every new or changed service is listed with the stored key it sends and its host, and the old list is kept beside it as a.bak file that puts it back. | loosens a protection |
| Open the services screen | `/services open` | Opens the screen that lists your services, where one can be tested. | None |

### /skills: Skills

`/skills` alone opens these actions to choose from; each asks for what it needs.

| Action | Line | What happens | Risk |
| --- | --- | --- | --- |
| See your skills | `/skills list` | Lists every skill pack found, where it comes from, and what it is for. | None |
| Open the skills screen | `/skills open` | Opens the full-screen view of your skills. | None |
| See one skill | `/skills show <skill>` | Shows <skill>'s origin, path, description, dependencies and what it includes. | None |
| See where your skills come from | `/skills origins` | Counts your skills by where they were found. | None |
| Publish a skill folder to the local catalog | `/skills publish-local <catalog id> <skill folder> <summary...>` | The skill in <skill folder> is listed in the local curated catalog as <catalog id> ("<summary>"), until you change it. | None |
| Take a skill out of the local catalog | `/skills unpublish <catalog entry>` | <catalog entry> is removed from the local curated catalog; installs of it stay. | cannot be undone |
