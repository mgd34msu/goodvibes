# Command reference

This reference is reconciled against the current [CLI catalog](../src/cli/command-catalog.ts),
[dispatcher](../src/cli/run.ts), and command adapters. The product is a partial
migration: a parsed command is not proof its configured runtime is deployable.
The shipped launcher admits unconfigured Slack/Discord/email membership, but
configured accounts need explicit trusted local source/screening ownership.
Service activation additionally needs an explicitly composed installed executable.
See [deployment boundaries](../README.md) and validation.

Unknown commands and unsupported flags exit 2 instead of starting a daemon.
`goodvibes-daemon --help --json` is the read-only machine catalog; it does not
contact or start a daemon. There is no docs-generation script for this page.

## Global options

Accepted before or after parser-owned commands. Raw-intercept commands must come first;
use environment homes for them (see [passthrough commands](#passthrough-commands)).

| Flag | Takes | Meaning |
| --- | --- | --- |
| `--daemon-home <dir>` | value | The daemon's own identity directory (operator tokens, daemon settings) |
| `-C`, `--cd`, `--working-dir <dir>` | value | The directory the daemon treats as its workspace |
| `-h`, `--help` | none | Print help and exit 0 |
| `-v`, `--version` | none | Print the version and exit 0 |

## Exit codes

The same numbers mean different things in the other programs; see [Exit codes](../../../docs/exit-codes.md) for all of them side by side.

| Code | Meaning |
| --- | --- |
| `0` | the command did what it says |
| `1` | it ran and failed, the reason is printed |
| `2` | the command line was wrong: an unknown command, an unknown flag, a flag this command does not take, or a missing value |

With `--json`, every failure (a parse error, a refusal, a command that throws, a
failed or refused service verb) is one `{"ok": false, "code", "error", "fix"}` document
on stdout instead of prose, with the same exit code. Codes: `PARSE_ERROR`,
`COMMAND_REFUSED`, `COMMAND_FAILED`; for the service verbs `SERVICE_ACTION_FAILED`,
`SERVICE_NOT_RUNNING`, `SERVICE_NOT_INSTALLED`, `SERVICE_DEFINITION_NOT_OURS`; for `webui`
`WEBUI_REFUSED` and `WEBUI_FAILED`. Every `--json` document is indented by two spaces,
one key per line, except the single-line `webui status --json`, `--help --json` and
`check-install-reader`.
| `3` | service commands: installed, but not running (`service-status`; `install-service`, `start-service`, `restart-service` when the service is not running afterwards) |
| `4` | service commands: not installed (`service-status`, `uninstall-service`, `start-service`, `stop-service`, `restart-service`) |
| `5` | `install-service`, `refresh-service`, `uninstall-service`: the service definition at that path was not written by GoodVibes, so nothing was changed |

## The remote-target convention

Every command that talks to an already-running daemon (`status`, `update`, `pair`,
`sessions`) accepts the same three flags, all optional:

| Flag | Default |
| --- | --- |
| `--host <name>` | the control plane's configured host (`127.0.0.1` on a default install). Another machine needs its connection type stated: `--host https://<name>` (encrypted) or `--host http://<name>` (the operator token travels unencrypted); a bare name is refused |
| `--port <n>` | the port in a `--host` URL, else that URL's scheme port (443 for `https://`, 80 for `http://`); with a bare host or none, the control plane's configured port |
| `--token <t>` | this machine's own operator token, read from `<daemon home>/operator-tokens.json` |

Authentication is `Authorization: Bearer <operator token>` against the control plane,
the same credential the terminal app and the web UI already use. The defaults are the
point. A headless box the operator has SSHed into works with no flags at all; the flags
exist for driving a machine in the next room, or for scripting. A missing token is a
refusal rather than an anonymous attempt. The daemon on this machine has never started
and so has never minted one, or the wrong directory was named.

For `status`, `update` and `sessions`, selected `network.outboundTls.*` settings
apply to their HTTPS and WSS transports, including relative CA paths beneath the
selected control-plane config directory. They do not alter global transport state.
`pair` and delegated `cluster` paths must be assessed separately; do not assume
all transports inherit that factory. Tokens and pairing output are credentials.
Never paste them into public logs or issue reports.

## Commands

### `serve` (default)

```
goodvibes-daemon [serve] [OPTIONS]
```

Start the composed control plane and admitted background services, then keep
running until stopped. Configured source pollers are admitted only with their
required authority; this is not a promise that every catalog capability is active. This is what a bare
invocation does; running with no command or with `serve` are the only two ways to
start serving. Any other first word is a command, and an unrecognized one is refused
rather than treated as "start serving" anyway.

Flags (beyond the global ones):

| Flag | Meaning |
| --- | --- |
| `--hostname`, `--host <host>` | Bind address for the control plane. `0.0.0.0` means every interface |
| `--port <n>` | Control-plane port to bind |
| `--provider <id>` | Run with this provider instead of the configured one. Not written to settings |
| `-m`, `--model <registryKey>` | Run with this model. A `provider:model` key also sets the provider |
| `-c`, `--config <key=value>` | Override one settings key for this run only. Repeatable. Never written to disk |
| `--enable <feature>` | Switch a capability on for this run through its real settings key. Repeatable |
| `--disable <feature>` | Switch a capability off for this run. Repeatable |

For a qualified embedding launcher, `goodvibes-daemon install-service` requests service installation.
The shipped partial launcher refuses activation without its required installed executable.
Foreground shutdown handles SIGINT/SIGTERM, fences new work and awaits owned drainage;
the default shutdown deadline is 15 seconds. Startup/cleanup failure or deadline expiry
exits 1, rather than reporting a successful drain.

Overrides apply in this order: repeated `--config` values, feature toggles,
provider/model flags, then endpoint flags. Explicit `--provider` wins over the
provider inferred from `provider:model`, regardless of argv order.
These overlays are not persisted. See [CLI dispatch and overrides](cli-and-package-contracts.md#command-grammar-and-dispatch).

### `install-service`

```
goodvibes-daemon install-service
```

Write the platform service definition and start it. Only an installed native daemon
(a release install) is admitted: a source run or a relocated copy refuses before any
service is touched. On systemd it also enables login lingering when it can, and says
whether it did; do not assume a system-wide service. Refuses an explicit
`--hostname`/`--port` (the installed unit carries no endpoint flags; use
`config set controlPlane.host` / `controlPlane.port` instead). A definition already at
the service's path that GoodVibes did not write is left as it is. Exits `0` when the
service is installed and running, `3` when it was installed but is not running (the
start failed or the daemon exited at once; the receipt says why), `5` when a definition
GoodVibes did not write is in the way, and `1` when it was not installed.

The release installer runs this on a first install.

### `refresh-service`

```
goodvibes-daemon refresh-service
```

Write the current service definition for this binary over the one GoodVibes wrote
earlier, or where none exists, and register it with the service manager (systemd
`daemon-reload`). Nothing is started or stopped: a running service keeps its previous
launch until `restart-service`, and a stopped one stays stopped. Lingering is not
changed. A definition that already matches is left untouched; a rewritten one is first
copied to `<path>.bak.<YYYYMMDDHHMMSS>` and keeps the working directory it named (unless
`--working-dir` or `GOODVIBES_WORKING_DIR` names another). A definition GoodVibes did not
write (no GoodVibes description or installer marker, or a link) is never written over.
Exits `0` when the definition is current (rewritten, written or already so), `5` when it
was not written by GoodVibes, and `1` when it could not be read, backed up or written.
Admitted like `install-service`.

The release installer runs this on every upgrade, so a unit written by an older release
(pinned `--hostname`/`--port`, an explicit `--daemon-home`, a moved binary) is brought to
the current launch.

### `uninstall-service`

```
goodvibes-daemon uninstall-service
```

Stop and unregister the service (`systemctl --user disable --now`,
`launchctl bootout gui/<uid>/<label>`, or ending and deleting the Scheduled Task), then delete its definition file. A service
that is already stopped is uninstalled the same way. A definition GoodVibes did not write
is left in place. The choice is saved first (`service.enabled` and `service.autostart`
`false`), so a daemon started by hand later does not install the service again; when it
cannot be saved (a managed-policy lock, a settings file that cannot be written) nothing is
removed and the receipt names why. Exits `0` when removed, `4` when nothing was installed,
`5` when the definition there was not written by GoodVibes, and `1` when the choice could
not be saved, removal failed or the service is still running.

### `service-status`

```
goodvibes-daemon service-status [--json]
```

Report the platform, the service name, the definition path, who wrote the definition
(`definitionOwner` in `--json`: `product`, `other`, `absent` or `unreadable`), and whether
the service is installed and currently running (queried live, not inferred from a pid file). Exit
codes: `0` installed and running, `3` installed but not running, `4` not installed,
`1` the platform refused the query (the error is printed; with `--json`, the
`{ok:false, code, error, fix}` document). The `--json` document carries
`"schema": "goodvibes.daemon.service-status"` and `"schemaVersion": 1` at its top level,
with the fields under `data`; the release installer checks both before it reads it.

### `start-service` / `stop-service` / `restart-service`

```
goodvibes-daemon start-service
goodvibes-daemon stop-service
goodvibes-daemon restart-service
```

Start, stop, or restart the service this binary manages, reporting what the platform
did. A verb aimed at a service that is not installed reports that (exit 4) rather than
dispatching a call that was always going to fail. A start or restart that leaves the
service not running exits `3`, the same "installed, not running" answer `service-status`
gives; a stop that leaves it running exits `1`. `restart-service` is the usual way to
pick up a settings change that only applies at boot (an endpoint binding, for example).

### `status`

```
goodvibes-daemon status [--json] [--host <http(s)://name>] [--port <n>] [--token <t>]
```

Talk to a daemon that is already running and print one page about it, one labeled
line per fact. A sub-question that fails becomes one line inside a successful
report, since a daemon with a broken channel is still up. The lines:

| Line | What it reports |
| --- | --- |
| `version` / `state` | what the daemon says about itself over `/status` |
| `health` | the overall roll-up from `/api/health`, with a line each for degraded domains, provider or integration problems, and quarantined MCP servers |
| `bound` | the scheme, host and port the control plane actually bound, flagged `NOT ready` with the bind errors when it is not |
| `uptime`, `starts`, `rejected`, `rollback`, `receipts` | the local lifecycle marker and update receipts. Read from files on the daemon's own host, so they appear for a local daemon and are named as unavailable for a remote one |
| `channels` | how many channels are switched on out of how many exist, plus a line for each switched-on channel that is not healthy. Disabled channels are not listed as problems |
| `cluster` | this machine's role and group, or that sharing is off, or that it is in no group yet |
| `sessions` | how many hosted sessions this daemon is running |

With no flags it asks the daemon on this machine. Exit 0 when the daemon answered,
1 when it could not be reached.

### `pair`

```
goodvibes-daemon pair [--json] [--host <http(s)://name>] [--port <n>] [--token <t>] [-y]
```

`qr` and `qrcode` are accepted spellings of the same command. Two forms.

With no `--host`, or one naming this machine (`127.0.0.1`, `localhost:3421`, `[::1]`,
`http://127.0.0.1:3421`: the same rule every daemon command uses), `pair` runs locally: it prints the same
pairing block a daemon prints once at startup, reusing the existing shared token (never
minting a new one), so a link printed here and one printed at boot are identical. It
asks the running daemon first whether it accepts that token and which address and scheme
it is bound to, so the QR carries what the daemon serves. A daemon that refuses the token
gets no link (pass the right one with `--token`). When no daemon answers, the link is
built from the settings and the token file, and the output says so; a daemon started on
a port other than its settings is found with `--port`.

With `--host` naming a different machine, `pair` runs remotely: it asks that daemon to
mint a brand-new per-device pairing token over `pairing.handoff.create` and prints the
pairing block for it. Minting is a different act than reprinting. It is a fresh token,
and every token that daemon already issued, its shared token included, is left
untouched. Because it changes state on a daemon that may not be this process's own, it
states the plan and asks for confirmation before acting; `-y`/`--yes`/`--non-interactive`
answers non-interactively. Without `-y`
nothing is called and nothing changes.

An unreachable daemon, a rejected token, and a daemon too old to serve the mint verb are
each refused by name, never a stack trace. A target daemon with no web origin
configured still gets its token and pairing fragment printed honestly. There is
nothing to build a scannable link or QR from in that case, so none is fabricated.

### `sessions`

```
goodvibes-daemon sessions list|kill <id> [--json] [--all] [--host <name>] [--port <n>] [--token <t>]
```

`session` is an accepted spelling of the same command.

| Subcommand | Effect |
| --- | --- |
| `sessions list` | every daemon-hosted session, most recently used first |
| `sessions kill <id>` | end one: its in-flight turn is interrupted and its loop taken apart, whoever is attached and whatever its detach policy says |

`--all` includes sessions that have already ended; they are kept, with the reason they
ended, until the retention window retires them. These are the daemon's own hosted
sessions (see [hosted session commands](cli-and-package-contracts.md#status-sessions-and-config)), not sessions a terminal runs
locally on this machine. `kill` with no id is a usage refusal (exit 2), never "kill
everything."

### `mcp`

```
goodvibes-daemon mcp serve [--categories <list|all>] [--allow-write] [--allow-destructive] [--host <http(s)://name>] [--port <n>] [--token <t>]
```

Serves the operator surface of a running daemon to a Model Context Protocol client over
stdio, so an editor or another agent can drive GoodVibes sessions through tools: one tool
per operator method, session lifecycle first. It lives on this binary because it is a
client of the daemon's operator API and connects by the [remote-target
convention](#the-remote-target-convention) (no flags: the daemon on this machine, with
this machine's operator token). The tool set is generated from the operator contract, so
a tool call is exactly the operator call of the same name.

By default it serves the agent slice: the `sessions`, `tasks`, `contracts` and `approvals`
methods that read, plus creating a session, sending it a message and steering it (about
20 tools). `--categories` picks other operator families (comma separated or repeated;
`all` for every family), `--allow-write` adds the methods that change state, and
`--allow-destructive` adds the methods the contract marks dangerous. The number of tools
served is printed on stderr at start. A client that cancels a tool call
(`notifications/cancelled`) stops the request to the daemon.

Stdout carries only protocol frames; every message for a person goes to stderr. The daemon
is checked before the first frame: when it is not running, or no operator token exists, or
the token is refused, the command prints one line naming that prerequisite on stderr and
exits `1`. It exits `0` when the client closes stdin, and `2` for anything other than
`mcp serve`.

MCP client configuration:

```json
{ "mcpServers": { "goodvibes": { "command": "goodvibes-daemon", "args": ["mcp", "serve"] } } }
```

For an editor that speaks the Agent Client Protocol instead, use `goodvibes acp` (see the
[TUI CLI flags](../../tui/docs/cli-flags.md#goodvibes-acp)).

### `config`

```
goodvibes-daemon config list|get <key>|set <key> <value>|unset <key> [--json]
```

| Subcommand | Effect |
| --- | --- |
| `config list` | schema settings with redacted effective values; JSON includes the surface settings-file path, not per-key origins |
| `config get <key>` | one setting |
| `config set <key> <value>` | write one setting to disk (checked against the schema first). A credential key is never written as plain text: the value goes to the secret store and the settings file keeps a `goodvibes://secrets/` reference. A credential key with no secret-store route refuses a literal and accepts a reference |
| `config unset <key>` | remove the global, daemon and shared value of one setting. A project settings value is untouched; when one still applies, the receipt says so instead of claiming the shipped default |

Values are read and written on this machine's settings files directly, so every verb
works whether or not a daemon is running. A running daemon picks up most changes live,
including a changed control-plane host or port; the write receipt says a key that is only read at startup applies the next time the daemon starts. It does not enumerate per-key reload behavior or the destination tier. Anything that reads like a
credential (a token, a password, an API key) prints as `<redacted>` in every read
path. See
[config output and sensitivity](cli-and-package-contracts.md#recursive-config-output)
for recursive rendering and reader-failure behavior.

### `update`

```
goodvibes-daemon update [--check] [--json] [--host <name>] [--port <n>] [--token <t>]
```

Asks the daemon (`update.status`) whether its update loop is on and, if not, why; how
often it checks; whether checks are failing and with what; a release downloaded and
waiting for an idle moment; a release a rollback rejected; and an interrupted update
that holds the loop off. `--check` runs one check now (`update.check`), the same check
the schedule runs, and reports whether it ran, found another check already running, or
found the loop off. It never forces an install. Both work for a remote daemon. The
receipt lines come from files on the daemon's own host, so a remote target names them
as unavailable. When the daemon on this machine does not answer, the command exits `1`
and prints what those files say: uptime, failed starts, rejected version and receipts.

### `send`

```
goodvibes-daemon send [message] [--channel <id>] [--to <address>] [--title <text>] [--list]
```

Send a message through any configured channel. The message is an argument or
stdin, so it composes with other tooling. The thirteen supported IDs come from the product surface catalog and canonical
channel delivery router. Listing is configuration inspection, not credential or provider verification. Each row below names the id `--channel` takes, what `--to`
means in that channel's own vocabulary, and what has to be configured before the
channel is usable. See [standalone send](cli-and-package-contracts.md#standalone-send)
for channel selection and credential ownership.

| `--channel` | Channel | `--to` names | Needs configured |
| --- | --- | --- | --- |
| `telegram` | Telegram | a chat id | a bot token |
| `ntfy` | ntfy push notifications | a topic | the ntfy server base URL |
| `discord` | Discord | a channel id | a bot token, application id and public key |
| `slack` | Slack | a channel id | a bot token and signing secret |
| `googleChat` | Google Chat | a webhook URL | an incoming-webhook URL |
| `webhook` | a plain HTTP webhook | a URL | the shared webhook secret |
| `signal` | Signal | a recipient | a Signal bridge URL and account |
| `whatsapp` | WhatsApp | a recipient | an access token and phone-number id |
| `imessage` | iMessage | a chat id | an iMessage bridge URL and account |
| `msteams` | Microsoft Teams | a conversation id | a bot app id and password |
| `bluebubbles` | BlueBubbles (iMessage via a Mac server) | a chat GUID | the BlueBubbles server URL and password |
| `mattermost` | Mattermost | a channel id | the server base URL and a bot token |
| `matrix` | Matrix | a room id | the homeserver URL, an access token and a user id |

| Flag | Meaning |
| --- | --- |
| `--channel <id>` | Channel to send to. With none named, your one configured channel is used and the receipt says which |
| `--to <address>` | Where within that channel: an ntfy topic, a Telegram chat, etc. |
| `--title <text>` | Title for channels that show one (ntfy) |
| `--list` | Show every channel, whether it is on, and where it sends |

A channel that is switched off is refused rather than silently redirected to the
default, and an unconfirmed send exits nonzero with structural diagnostics that withhold private provider errors.
Acceptance is not recipient arrival, and an uncertain send is never automatically retried. It works
with no daemon running: most of the point of a self-notification command is that
something has already stopped. This command's own flags follow the command word
(`send` is a passthrough command, see below).
`-c` aliases `--channel`; value flags accept `--flag=value`. Put `--` before
message text starting with a dash. `--list` cannot be combined with message,
channel, destination or title options. No channel argument requires exactly one
enabled channel with a configured destination. Required capability gates still apply.
The Discord row describes outbound delivery, not a qualified configured Discord inbox/DM catalog.

Only stdin input has its trailing line-feed bytes removed (`/\n+$/`). Interior
newlines, spaces and carriage returns are preserved. Explicit argument bytes
are unchanged; this is not general whitespace trimming.

When selection is refused, configured-ready suggestions contain only fixed
catalog IDs, never destination values, hostile input or provider prose. Here
"ready" means enabled with a configured destination, not verified credentials or
provider availability. An explicit selection still refuses rather than redirecting.
The default-selection receipt retains its preamble and unique-destination reason;
`--list` retains default and `--to` guidance.

Unconfirmed delivery retains a nonzero structural status diagnostic. Borrowed
provider prose, token URLs and unvalidated identifiers are not republished. This
is the explicit send diagnostic projection, not a content-classification or
secret-detection heuristic. The [standalone-send contract](cli-and-package-contracts.md#standalone-send)
retains credential/fetch/body drainage, explicit-repeat and no-hidden-retry rules.

### `cluster`

```
goodvibes-daemon cluster status|create|join|key|nodes|forget|rotate|leave|rename|groups
```

| Subcommand | Effect |
| --- | --- |
| `status` | what this machine is doing in its group |
| `create` | start a group here |
| `join` | join one (interactively, or with `--group` and `--key`) |
| `key` | print the join key for another machine to use |
| `nodes` | every machine in the group |
| `groups` | groups advertising themselves on this network |
| `forget <machine>` | drop a machine from the group |
| `rotate [--now]` | change the shared key |
| `rename <name>` | rename the group |
| `leave` | leave the group |

Talks to a running daemon over the same `--host`/`--port`/`--token` convention
`status` uses; `--json` gives a scriptable answer.

### `listener`

```
goodvibes-daemon listener token [--show] [--json]
```

The webhook listener (`danger.httpListener`) accepts its own bearer token and refuses
the operator token (`401` `OPERATOR_TOKEN_NOT_ACCEPTED`). The token is
`GOODVIBES_HTTP_TOKEN` when the daemon's environment sets it, otherwise the one the
daemon keeps in `<daemon home>/http-listener-token.json`, created the first time it
starts with the listener on. `listener token` says whether the listener is on and
where the token is; `--show` also prints the token, to give a webhook sender. It reads
only: it creates no token and contacts no daemon. `--json` prints `listenerEnabled`,
`source` (`file` or `environment`), `tokenFile`, `tokenStored` and, with `--show`,
`token`. With `--show` and no token yet it exits `1` (`LISTENER_TOKEN_MISSING`).

### `webui`

```
goodvibes-daemon webui enable|disable|status [--bundle-dir <dir>] [--lan|--loopback] [--json]
```

`--bundle-dir`, `--lan` and `--loopback` apply to `enable` only; `disable` and `status` refuse them.
`--json` applies to `status` and `enable`.

The web UI is a built bundle of static files served by the daemon's own control-plane
listener, on the same origin as the API. The URL to open is the control-plane
origin, not the declared `web.port`.

| Subcommand | Effect |
| --- | --- |
| `enable [--bundle-dir <dir>]` | serve the bundle at that directory. `web.publicBaseUrl` is never written: a stored copy of this daemon's own address (or the old placeholder) is cleared so links follow the settings, and an address you set is kept and named in the receipt |
| `enable --json` | the same, with the receipt as one document: `schema` `goodvibes.daemon.webui-enable`, `schemaVersion` 1, `url`, `alternateUrl` (when `url` uses a name) and `lines` |
| `disable` | stop serving it; the bundle stays on disk |
| `status` | configured serving path and exposure, not a live listener probe |
| `status --json` | read-only versioned configured `web.*` binding for development clients, with `serve` (`controlPlane.webui.serve`) and `bundleDir` (`controlPlane.webui.bundleDir`); not the daemon listener or proof it is running |

The release installer reads `status --json` first: when a bundle directory is configured
and serving is off, it only points `controlPlane.webui.bundleDir` at the new release's bundle
and says the web UI was left off; otherwise it runs `enable --json`.

`enable` changes no network exposure on its own. A daemon bound to loopback keeps
serving to this machine only. `--lan` binds every interface and turns
`controlPlane.enabled` on, since the listener answers other devices only with that
setting on; `--loopback` takes the binding back. Both are stated in the receipt.

### `provision-wake-model`

```
goodvibes-daemon provision-wake-model
```

Fetch the wake-word model files that are missing from the managed voice tree. The
installer runs this on a binary it has just placed, and a daemon start retries it, so
an install that happened offline heals on its own. A download that fails is reported
and exits 0 by default. A machine with no wake word still has a perfectly good
daemon; pass `--strict` to have a degraded outcome exit 1 instead.

### `completion`

```
goodvibes-daemon completion bash|zsh|fish
```

`completions` is an accepted spelling of the same command. Print a completion
script for the named shell on stdout, generated from the same
catalog the parser and the help text use, so it cannot drift from what the binary
accepts. `goodvibes` and `goodvibes-agent` print theirs from the same generator, so
the three programs complete the same way: command words, a command's sub-words right
after it, its flags and the values a flag lists; anywhere else the shell completes
file names. A shell other than these three is refused with exit 2. Install by writing
it somewhere the shell reads, for example:

```sh
goodvibes-daemon completion bash > ~/.local/share/bash-completion/completions/goodvibes-daemon
goodvibes-daemon completion zsh  > ~/.zfunc/_goodvibes-daemon
goodvibes-daemon completion fish > ~/.config/fish/completions/goodvibes-daemon.fish
```

### `help`

```
goodvibes-daemon help [command]
goodvibes-daemon --help --json
```

With no argument, print the command list and the global options. With a command
name, print that command's arguments, flags and behavior. `goodvibes-daemon <command>
--help` does the same thing for a real command.

### `check-install-reader`

```
goodvibes-daemon check-install-reader <installed-executable> | --describe
```

Internal to the release installer and CI. It reads an installation's data-reader requirements without loading settings, starting services or changing files, and `--describe` reports the readers compiled into this binary. It is not an operator command and has no `--help`.

### `version`

```
goodvibes-daemon version
```

Print the product binary name and manifest version, and exit 0. Same as `--version`/`-v`.
The daemon manifest and compiled fallback use the repository root version.

## Passthrough commands

`send`, `cluster`, `webui`, `provision-wake-model`, and the internal `check-install-reader` are dispatched with their own trailing-token vocabulary **before** any runtime is composed.
The top-level parser recognizes the command but leaves its trailing arguments to its adapter. Every token
after the command word belongs to that command's own vocabulary rather than to the
daemon parser (a `send` message may itself start with a dash, or contain `--port`).
Global options go before the command word, as for every other command: `goodvibes-daemon --daemon-home <dir> webui status` reads `<dir>`. After the command word, `--daemon-home` and `--working-dir` are that command's own arguments, not global options.

## Flags this binary refuses by name

This binary's parser used to accept these silently. Every one of them is a
terminal-app concern, which this binary is not, so each is now refused with a
message naming what it means and where it works:

| Flag | What it means |
| --- | --- |
| `--resume`, `-r` | resuming a conversation |
| `--continue` | continuing the last conversation |
| `--fork` | forking a conversation |
| `--print` | printing one conversation turn |
| `--prompt`, `-p` | sending a prompt |
| `--output`, `--output-format`, `-o` | choosing a conversation output format |
| `--open` | opening a browser window |
| `--no-alt-screen` | terminal screen handling |
| `--session`, `-s` | selecting a conversation |
| `--strict` | the terminal app's doctor strict mode. Inside `provision-wake-model` this flag is that command's own and is accepted |
