# Reference

This appendix holds every complete list GoodVibes keeps in its code. Each list below is built from the program itself each time this file is generated, so it matches release 3.3.1 exactly. The other parts of this file explain how to use these things; this part is where to look up an exact name, flag, default or value.

## Settings

Every setting key the programs accept, grouped by its first segment. Each entry gives the key, what it does, its type, its default value as written in a settings file, the values it allows (an enumeration or a range), which file stores it, whether a project's own settings file may set it, and the environment variable that stands in for it when there is one.

How to read an entry. "Stored in" names one of three places, decided by the key:

- **The daemon file**: `~/.goodvibes/daemon/settings.json` (`<GOODVIBES_DAEMON_HOME>/settings.json` when that variable is set). There is one value, and the terminal app, Agent and the daemon all read it. `goodvibes-daemon config set <key> <value>` writes it. A change made in an app (`/settings`, `/settings set`) is sent to the running daemon, which writes it; with no daemon running the app writes the file itself.
- **The shared file**: `~/.goodvibes/shared/settings.json`. Only the five keys `tts.provider`, `tts.voice`, `tts.speed`, `tts.llmProvider` and `tts.llmModel` are read from it. A value there wins over each program's own file, and a change made in any program is written there.
- **Each program's own file**: every other key. Each program keeps its own value: the terminal app reads `~/.goodvibes/tui/settings.json` (its `/settings` and `/settings set` write it), Agent reads `~/.goodvibes/agent/settings.json` (its `/settings` writes it), and the daemon reads `~/.goodvibes/daemon-host/settings.json` (`goodvibes-daemon config set` writes it). Setting a key in one program does not change it in the others.

A few keys exist in one app only; their entries say so.

"A project file may set it" refers to the project's own file: `<project>/.goodvibes/tui/settings.json` for the terminal app, `<project>/.goodvibes/agent/settings.json` for Agent, and `<working directory>/.goodvibes/daemon-host/settings.json` for the daemon. It travels with a repository, so keys that could be abused are refused there or accepted only when stricter. A write to a key the project file already holds goes to the project file. See "Settings: layers, scopes and how to change them" in the overview.

A value in backticks is written exactly as shown in JSON (`true`, `30`, `"ask-me"`).

<!-- generated: settings -->

## Command line: `goodvibes`

The terminal app's top-level help, then the help page of every command, exactly as `goodvibes --help` and `goodvibes help <command>` print them. Usage lines use `<name>` for a value you supply, `[x]` for something optional and `a|b` for a choice.

<!-- generated: cli:goodvibes -->

## Command line: `goodvibes-agent`

Agent's top-level help, then the help page of every command, exactly as `goodvibes-agent --help` and `goodvibes-agent help <command>` print them.

<!-- generated: cli:goodvibes-agent -->

## Command line: `goodvibes-daemon`

The daemon's top-level help, then the help page of every command, exactly as `goodvibes-daemon --help` and `goodvibes-daemon help <command>` print them. Commands that read their own flags list them after the page.

<!-- generated: cli:goodvibes-daemon -->

## Slash commands: terminal app

Every slash command typed in the terminal app's prompt, in alphabetical order. Each entry gives the command and its argument pattern, what it does, its category in the command palette, its aliases, whether it changes anything, whether it asks before acting, and its subcommands with their argument hints. Type `/help` in the app for the same list.

<!-- generated: slash:tui -->

## Slash commands: Agent

Every slash command typed in Agent's prompt, in alphabetical order, read the same way as the list above.

<!-- generated: slash:agent -->

## Model tools

Every tool the model can call. A tool is called by the model, not typed by a person; the permission mode and the decision model decide whether each call runs. Each tool gives its name, what it does, its permission category (which permission rules apply: `read`, `write`, `execute` or `delegate`), and every input with its type and whether it is required.

<!-- generated: tools -->

## Exit codes

What each program's exit status means, with the stop reasons `run --output json` reports. Branch on an exit code only together with the program that produced it.

<!-- generated: exit-codes -->

## Environment variables

Every environment variable the programs and the installer read. "Read by" names who reads it: `goodvibes` (terminal app), `goodvibes-agent` (Agent), `goodvibes-daemon` (daemon), `terminal apps` (both terminal apps), `every program` (all three, through the shared platform), `installer` (the install and uninstall scripts), `web UI`, `relay server` (the stand-alone relay), `Cloudflare Worker` (the Worker GoodVibes deploys to Cloudflare, which reads these as Worker bindings, not from a shell). A credential variable is read before a stored secret of the same name, so setting it overrides what the secret store holds for that process. A variable marked "set by GoodVibes itself" appears here only so its name is recognised.

<!-- generated: env -->

## Installer options

Every option each install and uninstall script accepts. "Value" names what follows the option.

<!-- generated: installer-options -->

## Installer errors

Every refusal of the release installer with its id and exact message, then every refusal of the checkout installer. The part on installing explains the cause and the fix of each id.

<!-- generated: installer-errors -->

## Permission modes

Every permission mode with what the gate does at each stakes level, then the older saved values that still load and the mode each runs as.

<!-- generated: permission-modes -->

## Owner-only items

Every kind of call only the owner decides, with the reason the owner is shown. The part on permissions and decisions explains how each is recognised.

<!-- generated: owner-only -->

## Surface authority

Every surface a message can arrive on, whether a message there can direct work, and what happens to a change asked for there.

<!-- generated: surface-authority -->

## Remember tiers

Every tier an approval can be remembered at, which tools offer it, the label the prompt shows, and what the remembered rule then matches.

<!-- generated: remember-tiers -->

## Secret providers

Every source a secret reference can name.

<!-- generated: secret-providers -->

## Channel setup

Every channel surface's setup: its fields and the settings they write, the credentials it reads and where from, and the steps to take outside GoodVibes.

<!-- generated: channel-setup -->

## Webhook paths

Every path on the daemon's control-plane listener where a channel provider posts inbound messages.

<!-- generated: webhook-paths -->

## Ports

Every port GoodVibes listens on or connects to by default, and the setting that changes it.

<!-- generated: ports -->

## Cluster settings sync

Which daemon settings a cluster shares between its nodes and which stay on each machine, with the reason.

<!-- generated: cluster-sync -->

## Key bindings: terminal app

Every action of the terminal app that can be bound to a key, its default keys and what it does.

<!-- generated: keybindings:tui -->

## Key bindings: Agent

Every action of Agent that can be bound to a key, its default keys and what it does.

<!-- generated: keybindings:agent -->

## Hooks

The hook event paths, every hook point with what a hook there can do, and every field of a hook, a chain and a hook's result.

<!-- generated: hooks -->

## Operator API methods

Every method of the daemon's operator API, grouped by category. "HTTP route" is the request to make (path parameters in braces). "Scopes" are the token scopes the method needs. "Effect" says what calling it does. Authentication, scopes and request formats are explained under the operator API part of this file.

<!-- generated: operator-methods -->

## Operator scopes

Every scope an operator token or user can carry, grouped by what it covers, with how many methods and event streams need it.

<!-- generated: scopes -->

## Events

The event streams a client can subscribe to over the operator API, then every runtime event the platform emits, by domain, with its fields.

<!-- generated: events -->

## Errors

The JSON body of a failed request, the failure categories and kinds, the shared error codes, and every code a daemon route declares with its HTTP status and meaning.

<!-- generated: error-kinds -->

## Providers

Every built-in model provider: the id used in `provider:model` names and in settings, its display name, the other names it answers to, the environment variables it reads its key from, the ways to sign in, its API base address and the model it uses when none is named.

<!-- generated: providers -->
