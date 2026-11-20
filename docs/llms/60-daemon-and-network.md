# The daemon, the web UI and networking

This part covers `goodvibes-daemon`: what it runs, every command it takes, the files and ports it uses, how other devices reach it (the local network, TLS, Tailscale, the relay, remote nodes), the web UI it serves, how devices and terminals are paired with it, how several daemons form a cluster, the sessions it hosts, and its logs, retention and telemetry. The HTTP API that every client uses is in the next part, "The operator HTTP API". Installing the daemon as a service and keeping it updated are in "Installing, running as a service, updating and removing GoodVibes".

## Terms used in this part

| Term | Meaning |
| --- | --- |
| daemon | The program `goodvibes-daemon`. One long-running process per machine. |
| control plane | The daemon's HTTP listener. It serves the operator HTTP API, the live event streams and, when switched on, the web UI. Default address `127.0.0.1:3421`. |
| operator token | The shared bearer token the daemon writes to `<daemon home>/operator-tokens.json` the first time it starts. Every app on the daemon's own machine uses it. It has full authority. |
| device token | A per-device bearer token minted by pairing. It can be renamed and revoked one at a time, and it can be limited to a list of scopes. |
| sign-in | A username and password login (`POST /login`) that returns a session token, valid for 12 hours. |
| scope | A named permission such as `read:sessions` or `write:sessions`. The full list is in "Scopes" in the next part. |
| admin | A credential with full operator authority: the operator token, a device token minted without a scope list, or a sign-in user with the `admin` role and no scope list. |
| hosted session | A conversation whose model loop runs inside the daemon, so it keeps running when the client that started it closes. |
| node | One daemon that is a member of a cluster. |
| cluster (group) | Several daemons on one local network, all owned by the owner, that share inbound channel work so each inbox is read by exactly one of them. |
| join key | The secret a machine presents to join a group. It looks like `gvj1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, or it is a passphrase of at least 12 characters chosen at `cluster create`. |
| relay | A WebSocket rendezvous server that forwards end-to-end encrypted traffic between a device off the local network and a daemon that dialled out to it. |

## What the daemon does

The daemon is the one long-running host on a machine. It runs these things whether or not any terminal app or browser is open:

- the control plane (the operator HTTP API, Server-Sent Events, WebSocket);
- the channels (Telegram, Slack, Discord, email and the others in "Automation and services"), both the pollers that read inbound messages and the senders;
- scheduled and triggered work, watchers and check-ins;
- hosted sessions;
- the knowledge, memory and owner-inbox stores;
- cluster membership and the per-inbox election when clustering is on;
- its own update loop when `update.auto` is `true`.

The terminal app (`goodvibes`) and Agent (`goodvibes-agent`) connect to the daemon on their own machine. By default they run their own conversation turns in their own process and use the daemon for shared state, channels and scheduled work. The web UI runs entirely against the daemon.

## Files and directories

Paths below use the defaults: the user's home directory is `~`, the daemon home is `~/.goodvibes/daemon`, and the daemon's working directory is the directory it was started in (or `-C <dir>`).

| Path | What it holds |
| --- | --- |
| `~/.goodvibes/daemon/operator-tokens.json` | The operator token (`token`), a `peerId` and `createdAt`. Mode `0600`. Created on first start. |
| `~/.goodvibes/daemon/settings.json` | Daemon-owned settings (for example `controlPlane.*`, `web.*`, `cluster.*`). `goodvibes-daemon config set` writes daemon-owned keys here. |
| `~/.goodvibes/daemon/secrets.enc` | The daemon's encrypted credential store (AES-256-GCM). |
| `~/.goodvibes/secrets.key` | The key that encrypts every `secrets.enc` on the machine. Losing it makes the stores unreadable. |
| `~/.goodvibes/daemon/daemon-settings.json` | One saved value, `runtime.workingDir`: the working directory chosen through the API or the web UI while the daemon ran (a workspace change). The next start uses it when neither `-C` nor `GOODVIBES_WORKING_DIR` is given. Absent until such a change is made. |
| `~/.goodvibes/daemon/detached-daemon.json` | The running daemon's `pid`, the `host` and `port` it bound at start, `scheme`, `command` and `startedAt`. |
| `~/.goodvibes/hosted-sessions/` | Saved hosted sessions, so they survive a daemon restart. |
| `~/.goodvibes/tui/auth-users.json` | Sign-in users (password hashes, roles, scopes). |
| `~/.goodvibes/tui/auth-bootstrap.txt` | The first sign-in user's name (`admin`) and password, written once, mode `0600`. Its password signs in only while this file holds it; clear it with `goodvibes auth clear-bootstrap` (see "The bootstrap file"). |
| `~/.goodvibes/tui/connected-daemons.json` | On a machine whose terminal app talks to a daemon elsewhere: the token it sends to each daemon, keyed by origin, and sign-in sessions from `/accounts sign-in daemon`. Mode `0600`. |
| `~/.goodvibes/tui/control-plane/pairing-tokens.json` | Device tokens, stored as hashes, never as the secret. |
| `~/.goodvibes/tui/crashes.jsonl` | Crash records. `goodvibes-daemon status` names this file. |
| `~/.goodvibes/shared/` | Shared stores: `memory.sqlite`, `owner-inbox.sqlite`. |
| `<working dir>/.goodvibes/logs/activity.md` | The daemon's activity log. It rotates to `activity.md.1` at 10 MB. |
| `<working dir>/.goodvibes/tui/` | State the daemon keeps per working directory: `cluster/cluster-node-id` (this machine's cluster node identity; group key material is not here, it lives only in the encrypted secret store), `devices/device-grants.json` (device grants), `operator/channel-routes.sqlite` (channel routes), `remote/distributed-runtime.json` (remote nodes), `watchers.json`, `decisions.sqlite`, `checkpoints/` and `code-index.sqlite`. A daemon started in another directory starts this state afresh. |

Two switches move these files:

| Switch | Moves | Does not move |
| --- | --- | --- |
| `GOODVIBES_HOME=<dir>` (environment) | The whole tree: everything above under `~/.goodvibes`, which becomes `<dir>/.goodvibes`, including the daemon home, the secret stores and `secrets.key`. | The working directory (`-C`) and its `.goodvibes/`. |
| `--daemon-home <dir>` (or `GOODVIBES_DAEMON_HOME=<dir>`) | Everything this daemon keeps. `<dir>` itself is the daemon home (`settings.json`, the daemon secret store `secrets.enc`, `operator-tokens.json`, `owner-profile.md`, `daemon-settings.json`, the run record `detached-daemon.json`), and, unless `GOODVIBES_HOME` is also set, `<dir>` is the tree root too: sign-in users and the bootstrap file, device tokens, hosted sessions, memory and the owner inbox, knowledge stores, crashes, the client-scoped settings and `secrets.key` live under `<dir>/.goodvibes/`. | The working directory (`-C`). With `GOODVIBES_HOME` also set, the tree stays where that names. |

So one switch runs a daemon that shares nothing with another: `goodvibes-daemon --daemon-home /tmp/gv-test serve` has its own users, bootstrap password, device tokens and memory. A terminal app or Agent given the same directory as its daemon home (`goodvibes --daemon-home /tmp/gv-test`, `GOODVIBES_DAEMON_HOME=/tmp/gv-test goodvibes-agent`) reads that daemon's operator token and daemon settings from it; the clients' own trees do not move.

The full map of every file every program writes is in "Files and directories GoodVibes creates" in the overview.

## Ports and listeners

| Listener | Setting | Default | Protocol | Who connects |
| --- | --- | --- | --- | --- |
| Control plane | `controlPlane.port`, `controlPlane.hostMode`, `controlPlane.host` | `127.0.0.1:3421` | TCP, HTTP or HTTPS | The terminal app, Agent, the web UI, scripts, paired devices, reverse proxies. The web UI is served on this same port. |
| Webhook listener | `httpListener.port`, `httpListener.hostMode`, `httpListener.host` | `127.0.0.1:3422` | TCP, HTTP or HTTPS | External services posting webhooks. It is only opened when `danger.httpListener` is `true`. |
| Web UI development server | `web.port` | `3423` | HTTP | The web UI's development server (`bun run dev` in `products/webui`), when one runs. The daemon never binds it, and no link, pairing address, `goodvibes web` or `tailscale.serve.run` uses it. |
| Cluster | `cluster.port`, `cluster.multicastGroup` | UDP `61860`, multicast group `239.255.71.86` | UDP, IPv4 only | Other nodes of a cluster. Only opened when `cluster.enabled` is `true`. |
| Relay (outbound) | `relay.url` | not set | WebSocket out (`wss://`) | The daemon dials out; nothing listens. |

`controlPlane.hostMode` takes `local` (bind `127.0.0.1`), `network` (bind `0.0.0.0`) or `custom` (bind `controlPlane.host`). The same three values apply to `httpListener.hostMode`.

## Starting the daemon

Running `goodvibes-daemon` with no command, or with the word `serve`, starts it in the foreground. It keeps running until it is stopped with Ctrl-C or a signal. Any other first word is a command; an unknown word is refused with exit code `2` instead of starting the daemon.

```sh
goodvibes-daemon
```

What it prints on a normal start (the exact host and port follow your settings):

```text
goodvibes-daemon 3.3.1 starting: tree-home="/home/alex" daemon-home="/home/alex/.goodvibes/daemon" intended-host="127.0.0.1" intended-port=3421
goodvibes-daemon 3.3.1 bound: host="127.0.0.1" port=3421
goodvibes-daemon 3.3.1 host started (ready)
```

When standard output is an interactive terminal, the daemon also prints the device pairing block once, after `bound`. When standard output is not a terminal (a service, a redirect to a file), it never prints the pairing block, because the block contains a credential. Run `goodvibes-daemon pair` to see it at any time.

The pairing block is only a link when the daemon serves the web UI (`controlPlane.webui.serve` is `true` and its bundle has an `index.html`) or `web.publicBaseUrl` is set. Otherwise the daemon prints one of:

| Line | Cause | Fix |
| --- | --- | --- |
| `Device pairing link unavailable: enable a WebUI bundle or configure its public URL.` | The web UI is not served and `web.publicBaseUrl` is not set. | `goodvibes-daemon webui enable --bundle-dir <dir>`. |
| `Device pairing link unavailable: the configured WebUI bundle has no readable app shell.` | The web UI is switched on, but the bundle directory has no readable `index.html`. | Point it at a built bundle: `goodvibes-daemon webui enable --bundle-dir <dir>`. |
| `Device pairing link unavailable: the configured WebUI URL is not a usable HTTP(S) origin.` | The address the link would use is not an `http://` or `https://` origin (it carries a user name, a query or fragment, or names `0.0.0.0`). | Correct `web.publicBaseUrl` (`goodvibes-daemon config set web.publicBaseUrl https://<name>`), or unset it. |

After the block it prints `(print this again: goodvibes-daemon pair)`, or `goodvibes-daemon pair --port <n>` when the daemon was started on a port other than the one in its settings.

To have the daemon start at boot and restart after a crash, install it as a service: `goodvibes-daemon install-service`. That is described in "Installing, running as a service, updating and removing GoodVibes".

### Serving options

These flags apply only to a bare invocation or `serve`.

| Flag | Effect |
| --- | --- |
| `--hostname <host>`, `--host <host>` | Bind the control plane to this address for this run. `0.0.0.0` means every interface. |
| `--port <n>` | Bind the control plane to this port for this run. |
| `--provider <id>` | Use this provider for this run. Not written to settings. |
| `-m <registryKey>`, `--model <registryKey>` | Use this model for this run. A `provider:model` key also sets the provider. |
| `-c <key=value>`, `--config <key=value>` | Override one setting for this run only. Repeatable. Never written to disk. |
| `--enable <feature>` | Switch a capability on for this run through its real settings key. Repeatable. |
| `--disable <feature>` | Switch a capability off for this run. Repeatable. |

Examples:

```sh
# A second daemon for testing that shares nothing with the first: its own tree, port and workspace,
# not updating itself and never promoting itself to a service.
mkdir -p /tmp/gv-test/work
export GOODVIBES_HOME=/tmp/gv-test
export GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1   # do not download the wake-word model files into the test tree
goodvibes-daemon config set controlPlane.port 39421
goodvibes-daemon config set update.auto false
goodvibes-daemon config set service.enabled false
goodvibes-daemon -C /tmp/gv-test/work serve

# Serve on every interface for this run only.
goodvibes-daemon serve --host 0.0.0.0
```

Every other command for that test daemon, in another shell, needs the same `GOODVIBES_HOME`; it then finds the daemon's token and port by itself: `GOODVIBES_HOME=/tmp/gv-test goodvibes-daemon status`. Writing the port into the test tree's settings (rather than passing `--port`) is what lets every client of that tree, the terminal app included, find it. Notes on the test daemon:

- Its settings start empty, so no channel is switched on and it polls nothing. Do not copy the first daemon's `surfaces.*` into it, or both would read the same bot.
- `service.enabled false` keeps it from ever installing itself as the machine's service; a daemon run with `GOODVIBES_HOME` or `--daemon-home` never promotes itself either. An explicit `goodvibes-daemon install-service` is not refused, though: run with `GOODVIBES_HOME` set, it writes the machine's one service unit (in the login user's `~/.config/systemd/user/`, whatever `GOODVIBES_HOME` says) pointing at the test tree, with `Environment=GOODVIBES_HOME=<dir>` (see "The daemon's background service" in the install part). Do not run `install-service` for a test daemon. `update.auto false` keeps it from updating the installed programs.
- Leave `cluster.enabled` off in it; with it on, it would take part in the first daemon's cluster coordination on UDP 61860.
- To point a terminal app at it, run the terminal app with the same `GOODVIBES_HOME`; it dials the port in that tree's settings.
- Run the Agent with the same `GOODVIBES_HOME` too (it uses that tree unless `GOODVIBES_AGENT_HOME` is set) and it dials the test daemon's port. It still needs a token; give it the test daemon's operator token:

  ```sh
  GOODVIBES_CONNECTED_HOST_TOKEN="$(python3 -c "import json;print(json.load(open('/tmp/gv-test/.goodvibes/daemon/operator-tokens.json'))['token'])")" \
    goodvibes-agent --runtime-url http://127.0.0.1:39421 status
  ```

  `status` must show `baseUrl: http://127.0.0.1:39421`, `reachable: yes (HTTP 200)` and `access token: present (env:GOODVIBES_CONNECTED_HOST_TOKEN)`. Without the token it shows `reachable: yes (HTTP 401)` and `access token: missing`. With `GOODVIBES_HOME=/tmp/gv-test` set as well, the Agent's own state stays in the test tree.
- `GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1` keeps the test daemon from fetching wake-word model files at start. It does not stop other outbound requests the daemon makes at start, such as model catalog requests to providers.

A daemon started with `--port` or `--host` keeps that binding for its whole run: a later `config set controlPlane.port` is saved but does not move it. Without those flags, a changed `controlPlane.port`, `controlPlane.hostMode` or `controlPlane.host` moves the running daemon to the new address within about a second, in both directions (see "Which settings apply at once").

### Environment variables the daemon reads

The complete list of environment variables every program reads is in "Environment variables" in the reference. The ones that matter most for running a daemon:

| Variable | Effect |
| --- | --- |
| `GOODVIBES_DAEMON_TOKEN` | Serve this value as the operator token instead of the one in `operator-tokens.json`. While it is set, the shared token cannot be revoked through the API (`SHARED_TOKEN_NOT_REPLACEABLE`). |
| `GOODVIBES_HTTP_TOKEN` | The bearer token the webhook listener accepts. Defaults to the operator token. |
| `GOODVIBES_DAEMON_HOME` | The daemon home, as `--daemon-home` (which wins over it): the daemon's identity files there, and, unless `GOODVIBES_HOME` is set, everything else the daemon keeps under `<dir>/.goodvibes/`. |
| `GOODVIBES_WORKING_DIR` | The working directory, as `-C`. |
| `GOODVIBES_HOME` | Where the `.goodvibes` tree lives instead of the user's home directory. |
| `GOODVIBES_TAILNET_ADDRESSES` | Comma-separated Tailscale addresses (or `100.64.0.0/10`) the programs accept as private over plain HTTP when Tailscale itself cannot be asked. |

## The `goodvibes-daemon` command line

The exact help text of every command is in "Command line: `goodvibes-daemon`" in the reference. This section explains each command with examples.

### Global options and where to put them

These options are accepted by every command:

| Option | Effect |
| --- | --- |
| `--daemon-home <dir>` | Run this daemon entirely out of `<dir>`: its identity files (`settings.json`, the daemon secret store, `operator-tokens.json`, `owner-profile.md`, `daemon-settings.json`) in `<dir>`, and its users, device tokens, memory and other stores under `<dir>/.goodvibes/` unless `GOODVIBES_HOME` names that tree. Default `~/.goodvibes/daemon` with the tree at `~/.goodvibes` (see "Files and directories"). |
| `-C <dir>`, `--working-dir <dir>`, `--cd <dir>` | The directory the daemon treats as its workspace. |
| `-h`, `--help` | Print help and exit `0`. |
| `-v`, `--version` | Print the version and exit `0`. |

The commands `send`, `cluster`, `webui`, `provision-wake-model` and `check-install-reader` read every word after their name as their own arguments. Give global options before the command word:

```sh
goodvibes-daemon --daemon-home /srv/gv/daemon cluster status
```

`goodvibes-daemon help <command>` prints one command's help. `goodvibes-daemon --help --json` prints a catalog of command names, not of flags: `{"schema":"goodvibes.daemon.cli-catalog","schemaVersion":1,"commands":[...]}`, where each command has only `name`, `subcommands` (for example `["list","kill"]` for `sessions`) and `machineQueries`. The one machine query today is `webui status --json`, whose result has schema `goodvibes.daemon.webui-binding`. It never starts or contacts a daemon. The flags are only in the text help.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command did what it says. |
| `1` | It ran and failed; the reason is printed. |
| `2` | The command line was wrong: an unknown command, an unknown flag, a flag this command does not take, or a missing value. Exception: `cluster` exits `1` for its own usage errors (an unknown flag, `cluster <subcommand> --help`, an unknown subcommand), with code `usage` in `--json`. `webui` exits `2` for its usage errors and for `no bundle directory to serve`. |
| `3` | `service-status`: installed, but not running. `install-service`: installed, but it did not start. |
| `4` | `service-status`, `start-service`, `stop-service`, `restart-service`, `uninstall-service`: no service is installed. |
| `5` | `install-service`, `refresh-service`, `uninstall-service`: a service definition that GoodVibes did not write is already at that path, so nothing was changed. |
| `130` | `cluster join`: the person answered a prompt with nothing (it prints `cancelled`). Not listed in the help. |

The top-level help (`goodvibes-daemon --help`) lists codes `0` to `5` as in this table, without `130`.

### Talking to a daemon: `--host`, `--port`, `--token`

`status`, `pair`, `sessions`, `mcp serve`, `update` and `cluster` talk to a running daemon over HTTP. With no `--host` they ask:

- the daemon named by `daemon.connectedHost.url`, when that key holds an address in the daemon program's own settings (`goodvibes-daemon config get daemon.connectedHost.url`; it is kept in `~/.goodvibes/daemon-host/settings.json`). The scheme and port come from that URL (`https://` without a port means 443). This machine's operator token is never sent there: give `--token`, or the command is refused with `no credential is stored for <origin>; this machine's operator token is never sent to another daemon`;
- otherwise the daemon on this machine, at the port in its settings, with this machine's operator token.

| Flag | Effect |
| --- | --- |
| `--host <name>` | The machine to ask. For another machine it must start with `http://` or `https://`, for example `--host https://10.0.0.7:3421` or `--host https://homelab.example`. `http://` sends the token unencrypted over the network. |
| `--port <n>` | That daemon's control-plane port. A `--host` URL is read as a browser reads it: the port written in it (`--host http://10.0.0.7:3422`, `--host https://goodvibes.example.com:443`), else `--port`, else the scheme's port, 443 for `https://` and 80 for `http://`. So a daemon behind a proxy on 443 is `--host https://goodvibes.example.com`, and a daemon serving directly on 3421 is `--host https://10.0.0.7:3421`. A port in the URL and a different `--port` are refused. With a bare host name for this machine, or no `--host`, the default is this machine's `controlPlane.port` (3421). |
| `--token <t>` | The operator token or device token for that daemon. Default: for this machine's own daemon (a loopback or local address at its `controlPlane.port`, or its `controlPlane.publicBaseUrl` once that address answers the daemon identity check without the token), this machine's operator token; in a terminal app's `/cluster`, the token or `/accounts sign-in daemon` session stored for that exact address; for any other daemon, nothing: the command is refused (`token-missing`) and nothing is sent. |

Errors these commands print, and what to do:

| Message | Cause | Next step |
| --- | --- | --- |
| `no operator token was found for this machine` | The daemon has never started here, or `--daemon-home` points elsewhere. | Start the daemon once (`goodvibes-daemon`), or pass `--token`. |
| `no credential is stored for <origin>; this machine's operator token is never sent to another daemon` | `--host` (or `daemon.connectedHost.url`) names a daemon that is not this machine's, and no `--token` was given. | Pass that daemon's own token with `--token`. |
| `could not reach the daemon on this machine` | Nothing answers at that host and port. | `goodvibes-daemon service-status`; check `--port`. |
| `'<host>' is another machine, and its connection type was not stated` | `--host` named another machine without a scheme. | Use `--host https://<host>:<port>` or `--host http://<host>:<port>`; without a port the URL means 443 or 80. |
| `'10.0.0.7:3422' is not a usable --host: the port goes in --port` (exit `1`) | A bare `host:port` without a scheme. | `--host 10.0.0.7 --port 3422`, or the URL form `--host http://10.0.0.7:3422`. |
| `<where> refused the operator token` | Wrong token for that daemon. | Pass the right one with `--token`. |
| `<where> does not know this command` | That daemon runs an older build, or it is not a GoodVibes daemon. | Update it. |

### `status`

Ask a running daemon what it is doing: version, uptime, the address it bound, the last update, channel and inbox health, its place in the cluster, and how many sessions it hosts. Exit `0` when the daemon answered, `1` when it could not be reached.

```sh
goodvibes-daemon status
```

```text
goodvibes daemon on this machine
  version:  3.3.1
  state:    running
  health:   healthy
  bound:    http://127.0.0.1:3421
  uptime:   9s
  receipts: none written
  crashes:  none recorded (/home/alex/.goodvibes/tui/crashes.jsonl)
  channels: 2 of 17 switched on
            Web control plane: unknown
  cluster:  off, this machine handles its own inbound work
  sessions: 0 hosted by this daemon
```

`--json` prints one document `{ "ok": true, "data": { "target", "isLocal", "identity", "health", ... } }`. The uptime, update and rollback lines come from files on the daemon's own machine, so for a remote daemon they are reported as unavailable.

The `bound:` line is the listener the daemon actually holds, with the scheme it speaks (`http` behind a TLS proxy too): `http://0.0.0.0:<port>` for `hostMode` `network`. When it differs from the settings (a rebind the system refused, see the daemon log) a second line says `the settings name <host>:<port>; this listener has not moved to it`; with no listener bound the line ends `(NOT ready)` and says so.

When the daemon cannot be reached:

```text
could not reach the daemon on this machine
  check the daemon is running: goodvibes-daemon service-status (Unable to connect. Is the computer able to access the url?)
```

### Service commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `install-service` | Writes the service definition for this platform and starts it. | `0` installed and running; `3` installed but not running; `5` a foreign definition is there; `1` not installed. |
| `refresh-service` | Rewrites the definition for the current binary without starting or stopping anything. A rewritten definition is backed up beside itself first. The release installer runs it on every upgrade. | `0` current; `5` foreign definition left alone; `1` could not read, back up or write. |
| `uninstall-service` | Stops and unregisters the service, then deletes its definition. | `0` removed; `4` nothing installed; `5` foreign definition left; `1` failed or still running. |
| `service-status [--json]` | Reports the platform, service name, definition path, `definitionOwner` (`product`, `other`, `absent`, `unreadable`), installed and running. systemd and launchd are asked live. | `0` running; `3` installed, not running; `4` not installed; `1` the platform refused the query. |
| `start-service` | Starts the installed service. An absent service is reported as absent, not installed. | `4` no service is installed |
| `stop-service` | Stops it until it is next started by the system. The definition stays, so it comes back: on Linux at the next boot when lingering is on for the user (which `install-service` switches on), otherwise at the user's next login (the unit is `WantedBy=default.target`); on macOS at the user's next login (the launch agent has `RunAtLoad`); on Windows at the user's next logon (the task is `/SC ONLOGON`). To keep it off, use `uninstall-service`. | `4` no service is installed |
| `restart-service` | Restarts it. Use it to apply a setting that is only read at start (see "Which settings apply at once"). | `4` no service is installed |

The service is a systemd user unit on Linux (`goodvibes.service`), a launchd user agent on macOS (`sh.goodvibes.daemon`), and a Scheduled Task on Windows. `service.serviceName` changes the name. On Linux, `install-service` also enables lingering (`loginctl enable-linger <user>`) so the daemon starts at boot without anyone logging in; when that fails it says so and prints the command to run.

### `pair`

Print the device pairing block: the web origin, the offers a new device can accept, what that device will be able to do in its browser, and a QR code of the deep link that opens the web UI already signed in. Aliases: `qr`, `qrcode`.

Local form (no `--host`, or a `--host` naming this machine):

```sh
goodvibes-daemon pair
```

It reprints the existing operator token in the link; it does not mint a new one. It first asks the running daemon whether it accepts the token and which address and scheme it is bound to. When no daemon answers, it builds the link from the settings and the token file and says so.

Example output for a daemon served over plain HTTP on the local network (QR code shortened):

```text
GoodVibes daemon 3.3.1: scan to pair a device (opens the web app signed in):

  http://desktop.local:3421

  http://desktop.local:3421/#pair=<token>&offers=notifications%2Crelay%2Cpasskey

Offers (each declinable in the web app):
  Notifications, This device gets a push when an agent needs your input or a run finishes. Decline and it pairs without push.
  Relay, Reach this daemon from off the LAN through the rendezvous relay, which sees only ciphertext and connection metadata. Decline to stay LAN-only.
  Passkey, Register a passkey on this device to confirm sensitive actions with a tap. Decline and sensitive actions ask another way.

This device will get:
  Offline app (installable / background sync), needs https, available via tailscale
  Push notifications, needs https, available via tailscale
  Voice input (microphone), needs https, available via tailscale

Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.

█▀▀▀▀▀█ ...
```

The three "This device will get" lines read `available` when the address is a secure context (`https://`, or `localhost`). The line before the QR code describes the connection: the one above for plain HTTP on a local network; `Connection is encrypted by Tailscale. Everything works except browser-gated features, which need https: serve this machine over Tailscale https to get them.` for plain HTTP to a Tailscale address; none for `https://`. The address `pair` prints is the web UI's address from the settings (a set `web.publicBaseUrl`, else the control-plane address while the daemon serves the bundle), which the running daemon moves to within about a second of a change. With no web UI served and no `web.publicBaseUrl`, `pair` prints no link: `no web UI is served by this daemon and web.publicBaseUrl names none, so a pairing link would open nothing`, exit `1`.

The local form prints a link only when there is a web UI to open: the daemon serves the bundle, or `web.publicBaseUrl` names where it runs. Otherwise it prints `no web UI is served by this daemon and web.publicBaseUrl names none, so a pairing link would open nothing` and exits `1`; switch the web UI on first (see "Serving the web UI").

Remote form (`--host` naming another machine) asks that daemon to mint a new device token and prints the block for it. Minting changes state on that daemon, so it states the plan and asks for confirmation; `-y` (`--yes`, `--non-interactive`) answers yes. Without `-y` nothing is changed.

```sh
goodvibes-daemon pair --host https://homelab.example:3421 --token <your-operator-token> -y
```

Once the shared operator token has been revoked (see "Revoking the shared operator token"), the local form no longer prints it. The daemon then prints `Device pairing: the shared token was revoked and replaced, so no pairing link carries it. Pair a device with its own token: goodvibes-daemon pair -y`.

### `sessions`

List or end the hosted sessions of a running daemon. Alias: `session`.

```sh
goodvibes-daemon sessions list
goodvibes-daemon sessions list --all --json
goodvibes-daemon sessions kill hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c
```

`list` prints each session most recently used first:

```text
1 session hosted by the daemon on this machine:

hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c  idle
    API demo
    in /home/alex/projects/app
    1 turns  ·  1 client attached  ·  on last detach: survive  ·  4m ago
```

`--all` includes ended sessions, which are kept with the reason they ended until `hostedSessions.terminatedRetentionMs` passes. `kill <id>` ends one session: its running turn is interrupted, whoever is attached, whatever its detach policy. An unknown id prints `This daemon hosts no session <id>.` and exits `1`. Sessions a terminal app runs in its own process are not listed; only sessions running inside the daemon are.

### `mcp serve`

Speak the Model Context Protocol on standard input and output, with one MCP tool per operator method of the daemon it connects to, so an MCP client (an editor, another agent) can drive GoodVibes.

```sh
goodvibes-daemon mcp serve
goodvibes-daemon mcp serve --categories sessions,tasks --allow-write
goodvibes-daemon mcp serve --categories all --allow-write --allow-destructive
```

| Flag | Effect |
| --- | --- |
| `--categories <list>` | Operator method families to serve, comma-separated or repeated; `all` for every family. |
| `--allow-write` | Also serve the methods that change state. |
| `--allow-destructive` | Also serve the methods the contract marks dangerous. |
| `--host`, `--port`, `--token` | As for `status`. |

With no flags it serves the agent slice: the sessions, tasks, contracts and approvals methods that read, plus creating a session, sending it a message and steering it. Creating a session, sending a message and steering are admin methods: with a scoped device token as `--token`, those tools are listed but the daemon refuses each call with `403` `ADMIN_REQUIRED`, which the MCP client receives as a failed tool call. Give `mcp serve` an admin credential (a device token minted without a scope list) if those tools must work. In 3.3.1 that is 24 tools; the command prints the count on standard error when it starts, for example `goodvibes-daemon mcp serve: serving 24 tools (sessions, tasks, contracts, approvals; reads and the session lifecycle); --allow-write and --categories serve more`.

Standard output carries only protocol frames; every message for a person goes to standard error. When the daemon is not running, or the token is missing or refused, it prints one line on standard error and exits `1` before writing any frame. It exits `0` when the client closes standard input. A client cancellation (`notifications/cancelled`) stops the request to the daemon.

MCP client configuration:

```json
{ "command": "goodvibes-daemon", "args": ["mcp", "serve"] }
```

### `config`

Read and write this machine's settings files directly. It works whether or not a daemon is running.

```sh
goodvibes-daemon config list
goodvibes-daemon config get controlPlane.port
goodvibes-daemon config set cluster.nodeName desktop
goodvibes-daemon config set cluster.peers '["10.0.0.2", "10.0.0.3:61860"]'
goodvibes-daemon config unset relay.url
```

- `set` checks the value against the setting's type and range first. A daemon-owned key is written to `~/.goodvibes/daemon/settings.json`. Any other key (for example `telemetry.otelMode`, `service.*`, `permissions.mode`) is written to the daemon's own surface file, `~/.goodvibes/daemon-host/settings.json`, which the daemon reads and the terminal app and Agent do not; to change such a key for the terminal app or Agent, set it in that app.
- A credential key (a token, password or API key) is stored in the encrypted secret store; the settings file keeps a reference.
- `unset` removes the global, daemon and shared value; a project settings value still applies.
- `list` and `get` print anything that looks like a credential as `<redacted>`.
- `--json` prints one document.
- A running daemon applies most keys live, including a changed control-plane host or port. A key read only at start applies at the next start.

Examples of what it prints:

```text
$ goodvibes-daemon config set cluster.nodeName desktop
cluster.nodeName = desktop
  written to disk. A running daemon applies most keys live, including a changed control-plane
  host or port; a key that is only read when the daemon starts applies the next time it starts.

$ goodvibes-daemon config set cluster.port 70000
config: could not write cluster.port: expected number (integer port in [1, 65535]).

$ goodvibes-daemon config get nope.key
config: not a settings key. Run `goodvibes-daemon config list` to see them.

$ goodvibes-daemon config unset relay.url
relay.url =   (back to its shipped default)
```

The last two exit `1`. Every setting key, its type, default and allowed values are in "Settings" in the reference.

### `update`

Ask the daemon whether its update loop is on, how often it checks, whether checks fail, whether a downloaded release is waiting for an idle moment, whether a rollback rejected a release, and whether an interrupted update is holding the loop off.

```sh
goodvibes-daemon update
goodvibes-daemon update --check
```

```text
goodvibes daemon updates on this machine
  version:  3.3.1
  updates:  off: update.auto is not true, so this daemon will not update itself
  receipts: none written
```

`--check` runs one check now, the same check the schedule runs, and reports whether it ran, whether another check was already running, or whether the loop is off. It never forces an install; a verified release still waits until no work is in flight. When the daemon on this machine does not answer, `update` exits `1` and prints what the daemon's own files say. How updates and rollbacks work is in "Installing, running as a service, updating and removing GoodVibes".

### `send`

Send a message through a configured channel: Telegram, ntfy, Discord, Slack, Google Chat, Signal, WhatsApp, iMessage, Teams, BlueBubbles, Mattermost, Matrix or a webhook. It works with no daemon running.

```sh
goodvibes-daemon send --list
goodvibes-daemon send "backup finished" --channel ntfy --title "homelab"
echo "disk at 91%" | goodvibes-daemon send --channel telegram
goodvibes-daemon send --channel slack --to C0123456789 -- "-1 is the answer"
```

| Flag | Effect |
| --- | --- |
| `--channel <id>` | The channel. With none named, exactly one switched-on channel with a destination must exist; it is used and named. |
| `--to <address>` | A topic, chat or room inside the channel, for this message. |
| `--title <text>` | A title, where the channel supports one. |
| `--list` | Show every channel and where it would send. Destinations that carry a credential are withheld. |

The message is the arguments or, with none, standard input. Use `--` before text that starts with a dash. A switched-off channel is refused, never redirected. Success means the channel accepted the request, not that it arrived. An uncertain send is never retried. `--list` on a machine with nothing configured prints one line per channel, for example `ntfy: off; topic: not set (surfaces.ntfy.topic)`, then `No default channel is configured.` Setting up each channel is in "Automation and services".

### `cluster`

Manage this machine's membership of a group of daemons. The subcommands are `status`, `create`, `join`, `key`, `nodes`, `groups`, `forget`, `rotate`, `rename`, `leave`, `publish` and `accept`. Every procedure is in "Clusters". `cluster --help` prints the same page as `goodvibes-daemon help cluster`: the subcommands, then every flag below (in the block headed Options `cluster` reads itself), then the global options (exit `0`). `cluster <subcommand> --help` is refused with `'--help' is not a flag this command understands` (exit `1`).

The flags `cluster` accepts, after the subcommand, in any order. A value can be given as `--flag value` or `--flag=value`. An unknown flag is an error, never ignored.

| Flag | Used by | Effect |
| --- | --- | --- |
| `--name <name>` | `create`, `rename` | The group name. `rename` also takes it as its one argument. |
| `--passphrase <phrase>` | `create` | Use this phrase (at least 12 characters) as the join key instead of a generated one. |
| `--group <id>` | `join` | The group to join. |
| `--key <join key>` | `join` | The join key. |
| `--qr` | `key` | Also print the join key as a QR code. |
| `--now` | `rotate` | Stop accepting the old key at once, and replace the signing key and the join key too. |
| `-y`, `--yes` | `leave`, `forget`, `rotate --now`, `publish`, `accept` | Confirm without the interactive question. |
| `--json` | all | Print one JSON document: `{"ok":true,"data":...}` or `{"ok":false,"code":...,"error":...,"fix":...}`. |
| `--host <name>`, `--port <n>`, `--token <t>` | all | Talk to another daemon, as for `status` (including the `daemon.connectedHost.url` rule when `--host` is absent). |

`forget <machine>`, `publish <setting>` and `accept <setting>` each take one argument.

### `webui`

Switch the web UI on or off and say who can reach it. See "Serving the web UI".

### `provision-wake-model`

Fetch any wake-word model files missing from the managed voice tree. The installer runs it, and a daemon start retries it. A download that fails is reported and still exits `0`. Wake words are described in "Automation and services".

### `completion`

Print a shell completion script for `bash`, `zsh` or `fish` (alias `completions`):

```sh
goodvibes-daemon completion bash > ~/.local/share/bash-completion/completions/goodvibes-daemon
goodvibes-daemon completion zsh  > ~/.zfunc/_goodvibes-daemon
goodvibes-daemon completion fish > ~/.config/fish/completions/goodvibes-daemon.fish
```

### `check-install-reader`, `help`, `version`

`check-install-reader <installed-executable>` is run by the release installer: it checks whether this release can read an installation's saved data without loading settings or changing files. `--describe` lists the readers compiled in. A person does not need to run it.

`help [command] [--json]` prints help. `version` (and `-v`, `--version`) prints `goodvibes-daemon 3.3.1`.

## Network exposure

By default the daemon is reachable only from its own machine: the control plane binds `127.0.0.1`, and even when it binds a wider address it answers only requests that come from this machine.

Two settings decide exposure, and both must allow a request:

| Setting | Values | Effect |
| --- | --- | --- |
| `controlPlane.hostMode` (with `controlPlane.host`) | `local`, `network`, `custom` | Which address the listener binds. |
| `controlPlane.enabled` | `false` (default), `true` | Whether requests from other machines are served. With `false`, a request from any address that is not this machine's is refused with HTTP `403` and code `CONTROL_PLANE_LOCAL_ONLY`, whatever the binding. Channel webhooks under `/webhook/` are answered either way. It takes effect on the next request. |

### Making the daemon reachable on the local network

1. Make sure a web UI bundle exists: `goodvibes-daemon webui status` names its directory. The release installer (`install.sh`) places the bundle in `<install dir>/webui/<version>` (`~/.local/bin/webui/<version>` by default) and runs `goodvibes-daemon webui enable --bundle-dir <install dir>/webui/<version>` itself, without `--lan` or `--loopback`, so it changes no exposure. The checkout installer (`scripts/install.ts`) runs `goodvibes-daemon webui enable --loopback --bundle-dir <prefix>/current/webui` instead. In a source checkout run by hand, the bundle is built into `products/webui/dist`; pass it with `--bundle-dir`.
2. Run:

   ```sh
   goodvibes-daemon webui enable --lan
   ```

   This sets `controlPlane.webui.serve` to `true`, `controlPlane.hostMode` and `web.hostMode` to `network` (bind every interface), `controlPlane.enabled` to `true`, and `web.publicBaseUrl` to the address it prints when `web.publicBaseUrl` is empty, holds the shipped default `http://127.0.0.1:3423`, or equals the address the previous binding produced; any other value is kept. It prints the address other devices use, for example:

   ```text
   web UI: served by the daemon from <bundle directory>
     http://desktop.local:3421
     reachable from your network at http://desktop.local:3421; the control-plane listener uses its configured binding.
     a device that cannot resolve that name can use http://192.168.0.171:3421
     To take it back to this machine only:  goodvibes-daemon webui enable --loopback
     A running daemon applies this within about a second; no restart is needed.
   ```

3. Nothing to restart: a running daemon releases `127.0.0.1:3421` and binds `0.0.0.0:3421` within about a second. A daemon started with `--host` or `--port` keeps that binding for its whole run; restart it without them.
4. Check the bound address on the daemon's machine (see "Checking which address the daemon is bound to"):

   ```sh
   ss -ltn 'sport = :3421'                  # Linux: the Local Address column must read 0.0.0.0:3421
   lsof -nP -iTCP:3421 -sTCP:LISTEN         # macOS (and Linux): the NAME column must read *:3421
   ```

   `127.0.0.1:3421` a few seconds later means the daemon was started with `--host` or `--port`, or the new address could not be bound: `goodvibes-daemon status` then prints `the settings name 0.0.0.0:3421; this listener has not moved to it`, and the daemon's activity log says why.
5. Allow TCP port `3421` in the machine's firewall if it has one.
6. From another device on the network, check that it answers: `curl http://192.168.0.171:3421/api/control-plane/auth` (the machine's own address) prints a JSON document starting `{"authenticated":false`. No answer means the bind, the firewall or the address is wrong.
7. Pair each device (see "Pairing a phone or another browser").

To go back to this machine only:

1. Run `goodvibes-daemon webui enable --loopback`. It sets `controlPlane.hostMode` and `web.hostMode` back to `local` and leaves `controlPlane.enabled` at `true`. It rewrites `web.publicBaseUrl` to the loopback address only when `web.publicBaseUrl` is empty, holds the shipped default `http://127.0.0.1:3423`, or still equals the address the previous binding produced; when it holds anything else, it keeps it and prints `note: web.publicBaseUrl is set to <url>; links use that, the bundle is served at the URL above.` When that note appears and you want links to stop naming the network address, run `goodvibes-daemon config unset web.publicBaseUrl`.
2. The running daemon releases `0.0.0.0:3421` and binds `127.0.0.1:3421` within about a second. From the moment it reads the new setting, the old listener answers another machine only with `403` `CONTROL_PLANE_LOCAL_ONLY` (`the control plane is set to listen on 127.0.0.1, so a request from <address> is not served`), so nothing the setting refuses is served while it moves. If `127.0.0.1:3421` cannot be bound, it does not go back to every interface: it binds loopback on the previous port or nothing, and says so in its log and in `status`.
3. Check: `ss -ltn 'sport = :3421'` must show `127.0.0.1:3421` (`lsof -nP -iTCP:3421 -sTCP:LISTEN` must show `127.0.0.1:3421`), and the `curl` from another device must get no answer.

### Restarting the daemon

A new address needs no restart (see "Which settings apply at once"); a daemon started with `--host` or `--port`, and `controlPlane.tls.*`, do.

| How the daemon runs | Restart |
| --- | --- |
| As the service | `goodvibes-daemon restart-service` (exit `4` when no service is installed). |
| In a terminal (`goodvibes-daemon`, `goodvibes-daemon serve`) | Stop it with Ctrl-C, then run the same command again. Leave out `--host` and `--port`, which would override the settings for the whole run. |
| Through `GOODVIBES_HOME` for a test daemon | Stop it, then start it again with the same `GOODVIBES_HOME`. |

### Checking which address the daemon is bound to

Ask the operating system, on the daemon's machine, which address holds the control-plane port (3421 unless `controlPlane.port` says otherwise):

```sh
ss -ltn 'sport = :3421'                  # Linux
lsof -nP -iTCP:3421 -sTCP:LISTEN         # macOS, also Linux
```

| `ss` Local Address | `lsof` NAME | Meaning |
| --- | --- | --- |
| `127.0.0.1:3421` | `TCP 127.0.0.1:3421 (LISTEN)` | This machine only. |
| `0.0.0.0:3421` | `TCP *:3421 (LISTEN)` | Every interface: other machines can connect. |
| `<an address>:3421` | `TCP <an address>:3421 (LISTEN)` | That address only (`hostMode` `custom`). |
| nothing | nothing | Nothing listens on that port: the daemon is stopped, or on another port. |

Binding decides who can connect; `controlPlane.enabled` decides whether a connection from another machine is served. A request from another machine to a daemon with `controlPlane.enabled` `false` gets `403` with code `CONTROL_PLANE_LOCAL_ONLY` and the body `{"error":"This daemon serves only its own machine","code":"CONTROL_PLANE_LOCAL_ONLY","state":"controlPlane.enabled is off, so a request from <address> is not served","next":[...],"status":403}`. Either answer proves the bind; no answer within a few seconds means the address is not bound or a firewall drops it.

`goodvibes-daemon status` prints the listener the daemon holds on its `bound:` line, and a second line when that differs from the settings. Do not use these as proof of the bind: `goodvibes-daemon webui enable` or `webui status` (they print what the settings will give), `goodvibes-daemon pair` (its link comes from the settings) and `detached-daemon.json` (the address of the last start). The line the daemon prints when it starts, `goodvibes-daemon 3.3.1 bound: host="0.0.0.0" port=3421`, is right for that start.

### How a running daemon moves to a new address

A change of `controlPlane.hostMode`, `controlPlane.host` or `controlPlane.port` (by `config set`, `webui enable --lan`/`--loopback` or an edit of the settings file) is applied by the running daemon within about a second:

- A new port is bound before the old listener is released, so the API never goes down, as long as the old listener serves nothing the new setting leaves out (it was on loopback, or on the same host). Otherwise the old listener is released first.
- The same port on another host (`127.0.0.1:3421` to `0.0.0.0:3421` and back) cannot be held twice, so the old listener is released and the new one bound.
- If the new address cannot be bound, the daemon goes back to the previous address only when the new setting still allows it; otherwise it binds `127.0.0.1` on the previous port, so the API stays reachable from this machine for a correction, or nothing. It writes `[ERROR] DaemonServer: the new control-plane binding could not be bound; still serving on the previous address` (or `no control-plane listener is bound`) to its activity log, and `status` shows the difference.
- Until the new listener is bound, a listener wider than the setting (every interface while it names loopback) answers only this machine; other machines get `403` `CONTROL_PLANE_LOCAL_ONLY`, channel webhooks included.

A daemon started with `--host` or `--port` keeps that binding for its whole run.

Plain HTTP on a private network is a supported posture. The connection is not encrypted on that network, and browsers withhold three features from a page that is not a secure context (HTTPS, or `localhost`): installing the app and its service worker, push notifications, and the microphone. `pairing.posture.get` (see the next part) reports each of these as available or `needs https, available via tailscale`. A `100.64.0.0/10` address is accepted over HTTP only when a running Tailscale vouches for it or `GOODVIBES_TAILNET_ADDRESSES` lists it, because carrier-grade NAT uses the same range.

### TLS

`controlPlane.tls.mode` takes three values:

| Value | Effect |
| --- | --- |
| `off` (default) | Plain HTTP. |
| `proxy` | The daemon still serves plain HTTP, but describes its own address as `https`, for a daemon behind a TLS-terminating reverse proxy. Set `controlPlane.publicBaseUrl` (and `web.publicBaseUrl`) to the external `https://` address. |
| `direct` | The daemon serves HTTPS itself with `controlPlane.tls.certFile` and `controlPlane.tls.keyFile`. Empty paths mean `certs/fullchain.pem` and `certs/privkey.pem` under `~/.goodvibes/tui/`. A missing file stops the daemon from starting, with `Certificate file not found: <path>` or `Private key file not found: <path>`. |

The daemon never creates or renews certificates. The webhook listener has the same three modes under `httpListener.tls.*`.

Direct TLS, end to end:

```sh
mkdir -p ~/.goodvibes/tui/certs
cp /etc/letsencrypt/live/homelab.example/fullchain.pem ~/.goodvibes/tui/certs/fullchain.pem
cp /etc/letsencrypt/live/homelab.example/privkey.pem ~/.goodvibes/tui/certs/privkey.pem
chmod 600 ~/.goodvibes/tui/certs/privkey.pem
goodvibes-daemon config set controlPlane.tls.mode direct
goodvibes-daemon restart-service
ss -ltn 'sport = :3421'          # the bound address (lsof -nP -iTCP:3421 -sTCP:LISTEN on macOS)
goodvibes-daemon status --host https://homelab.example:3421 --token <your-operator-token>   # direct TLS on the daemon's own port 3421
```

For another machine to reach it, the daemon must also be bound to an address it can reach (`webui enable --lan`, or `config set controlPlane.hostMode network` with `controlPlane.enabled` `true`), which a running daemon applies within about a second; the `ss` line must then read `0.0.0.0:3421`.

Behind a reverse proxy (nginx, Caddy, Traefik) that terminates TLS and forwards to `127.0.0.1:3421` on the same machine (a proxy on another machine also needs the daemon bound to an address it can reach: `goodvibes-daemon config set controlPlane.hostMode network`, or `custom` with `controlPlane.host`, and then `controlPlane.enabled` `true`):

```sh
goodvibes-daemon config set controlPlane.tls.mode proxy
goodvibes-daemon config set controlPlane.trustProxy true
goodvibes-daemon config set controlPlane.enabled true
goodvibes-daemon config set controlPlane.publicBaseUrl https://goodvibes.example.com
goodvibes-daemon config set web.publicBaseUrl https://goodvibes.example.com
goodvibes-daemon webui enable            # needs a configured bundle; otherwise add --bundle-dir <dir>
goodvibes-daemon restart-service
ss -ltn 'sport = :3421'                  # 127.0.0.1:3421 for a proxy on this machine; 0.0.0.0:3421 for one elsewhere
goodvibes-daemon status --host https://goodvibes.example.com --token <your-operator-token>
```

The last line dials port 443, the port of an `https://` URL that names none (see "Talking to a daemon: `--host`, `--port`, `--token`"). The restart applies `controlPlane.tls.mode`; the other keys apply without it (see "Which settings apply at once").

`controlPlane.trustProxy` makes the daemon take the client address from `x-forwarded-for` and the scheme from `x-forwarded-proto`. Only switch it on when a proxy you control is the only thing that can reach the listener. With it on, the client address is the forwarded one, so `controlPlane.enabled` must be `true` or every forwarded request is refused with `403` `CONTROL_PLANE_LOCAL_ONLY`. With `controlPlane.trustProxy` `false` (default), a same-machine proxy's requests arrive from `127.0.0.1` and are served even with `controlPlane.enabled` `false`; the proxy is then the boundary, and every request still needs a token. A request that carries a forwarding header (`forwarded`, `x-forwarded-for`, `x-real-ip`, `via` and similar) is never treated as coming straight from the daemon's own machine, so the operator token used through a proxy is reported as credential `shared-token`, not `local`. The proxy must pass WebSocket upgrades for `/api/control-plane/ws` and must not buffer `text/event-stream` responses.

### Cross-origin browsers (CORS)

A web page served from a different origin than the daemon can call it only when `controlPlane.cors.enabled` is `true` and its origin is listed, comma-separated, in `controlPlane.cors.allowedOrigins` (for example `http://localhost:5173`). Wildcards are never used. The WebSocket upgrade checks `controlPlane.cors.allowedOrigins` whether or not CORS is on. The web UI served by the daemon itself is same-origin and needs none of this.

### Which settings apply at once

From the code that reads each control-plane key, verified on a running 3.3.1 daemon for `controlPlane.port`, `controlPlane.hostMode`, `controlPlane.host`, `controlPlane.enabled`, `controlPlane.streamMode` and `controlPlane.tls.mode`. A running daemon re-reads its settings files every 250 milliseconds, so "at once" means within about a second of `config set`. When in doubt, restart: a restart applies every key, and does no harm.

| Key | When a change applies |
| --- | --- |
| `controlPlane.port`, `controlPlane.hostMode`, `controlPlane.host` | At once, in both directions (`local` to `network` and back, a new port, a new `custom` host): the daemon moves its listener within about a second and a listener wider than the new setting serves only this machine meanwhile (see "How a running daemon moves to a new address"). |
| Any of the three, with the daemon started with `--host`/`--hostname` or `--port` | Never during that run: the flags win until the daemon is started without them. |
| `controlPlane.enabled`, `controlPlane.trustProxy` | At once, on the next request (observed: `config set controlPlane.enabled false` refused the next request from another machine with `403`). |
| `controlPlane.streamMode` | At once, on the next request. |
| `controlPlane.webui.serve`, `controlPlane.webui.bundleDir`, `web.staticAssetsDir` | At once, on the next request. |
| `controlPlane.cors.enabled`, `controlPlane.cors.allowedOrigins` | At once, on the next request. |
| `controlPlane.openaiCompatible.enabled`, `controlPlane.openaiCompatible.pathPrefix` | At once, on the next request. |
| `controlPlane.publicBaseUrl`, `web.publicBaseUrl` | At once: read each time a link or address is built. |
| `controlPlane.gateway` | At once (it is a runtime switch). |
| `controlPlane.tls.mode`, `controlPlane.tls.certFile`, `controlPlane.tls.keyFile` | Only when the listener binds: at the next daemon start, or at the next rebind caused by a port change. In testing, `config set controlPlane.tls.mode direct` left the running daemon answering plain HTTP. A renewed certificate file is likewise read only then: `goodvibes-daemon restart-service` after renewing. |
| `httpListener.*`, `danger.httpListener` | At the next daemon start. |

### Live update streams

`controlPlane.streamMode` chooses which live stream the daemon serves: `sse` (`GET /api/control-plane/events` only), `websocket` (`/api/control-plane/ws` only) or `both`. The one not served is refused with HTTP `409` and code `STREAM_MODE_NOT_SERVED`. The terminal apps and the web UI read the Server-Sent Events stream, so `websocket` alone leaves them without live updates.

The default is `sse` (the settings reference lists it), so the WebSocket stream is refused until the setting is changed. To serve the WebSocket stream as well:

```sh
goodvibes-daemon config set controlPlane.streamMode both
```

No restart is needed. The listener reads the setting on every request, and a running daemon polls its settings files every 250 milliseconds, so a change made with `config set` (or by editing the file) applies to the next request after the file is read again. In testing, the first upgrade attempted one second after `config set controlPlane.streamMode both` was accepted (`101`), and one second after `config set controlPlane.streamMode websocket`, `GET /api/control-plane/events` was refused with `409`. A value other than `sse`, `websocket` or `both` is treated as `both`. `controlPlane.gateway` (default `true`) switches the streams and the authenticated control routes off entirely when `false`.

### The webhook listener

The webhook listener receives inbound webhooks from external services. It opens only when `danger.httpListener` is `true`. It binds `httpListener.host:httpListener.port` (default `127.0.0.1:3422`) and accepts the bearer token in `GOODVIBES_HTTP_TOKEN`, or the operator token when that is not set. `POST /webhook` fires the owner's hooks, so it needs what the daemon's own hook routes need: the operator token, an admin sign-in or a paired device with full authority; a narrowed device token or a sign-in without the admin role is refused `403` `ADMIN_REQUIRED` naming the `hook.fire` effect, and nothing fires. `httpListener.trustCloudflare` (with `httpListener.trustProxy`) reads the client address from `CF-Connecting-IP`, but only from a peer inside a published Cloudflare range. `goodvibes listener test` (terminal app) checks it.

### Settings for listeners and exposure

<!-- generated: settings:controlPlane -->

<!-- generated: settings:httpListener -->

<!-- generated: settings:web -->

## Serving the web UI

The web UI is a built bundle of static files (an `index.html` and its assets). The daemon serves it on the control-plane listener, at the same origin as the API, so the address to open is the control-plane address, `http://127.0.0.1:3421` by default, not `web.port`.

Its pages are sent with `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' <relay>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`, where `<relay>` is the `wss://` and `https://` origin of `relay.url` when one is set. The page runs only its own scripts (and the WebAssembly and worklets it builds from them), connects only to this daemon and the relay, and cannot be framed by another site. A script injected into it cannot read the credential at all: on the direct route the daemon holds it in an HttpOnly cookie, and nothing token-shaped is written to localStorage, sessionStorage or IndexedDB (see "Signing in to the web UI"). Signing out (account menu, or Sign out in Account) forgets what this page holds and ends the sign-in session on the daemon with `POST /logout`, which also clears the cookie and the identity marker, so the old credential stops working everywhere; when the daemon cannot be reached the page says "Signed out here; the daemon session could not be ended" with Try again. Sign-ins and sign-outs of one page run in the order they were asked for; a sign-in still in flight when the browser signs out or signs in another way is dropped, and what it set is ended, rather than kept over the newer one. The service worker caches only the app shell and its build files: never an API response, `/login`, `/logout`, or any response marked `no-store` or `private`. A reply, tool result or data block shows an image inline only when it is a `data:` or `blob:` image or an artifact the daemon serves (`/api/artifacts/...`); any other image URL is shown as a link (`Image: <alt text>`) that opens in a new tab when clicked, so rendering a message never sends a request to a server the message names.

| Command | Effect |
| --- | --- |
| `goodvibes-daemon webui status` | What is served, from where, and who can reach it. |
| `goodvibes-daemon webui status --json` | The `web.*` binding the web UI's development server listens on. It is not the web UI's address and not proof that a listener is running. |
| `goodvibes-daemon webui enable [--bundle-dir <dir>]` | Serve the bundle in that directory, or the one already in `controlPlane.webui.bundleDir`. Writes `controlPlane.webui.serve` `true`, `controlPlane.webui.bundleDir` (as an absolute path), `web.enabled` `true`, and `web.publicBaseUrl` when it is empty or holds the shipped default `http://127.0.0.1:3423` (any other value is kept). Changes no network exposure. With no `--bundle-dir` and no `controlPlane.webui.bundleDir` it does not fall back to `web.staticAssetsDir`: it prints `webui: no bundle directory to serve.` and `Pass one:  goodvibes-daemon webui enable --bundle-dir <dir>` and exits `2`. |
| `goodvibes-daemon webui enable --lan` | Also set the binding to every interface and serve other devices; a running daemon moves within about a second (see "Making the daemon reachable on the local network"). |
| `goodvibes-daemon webui enable --loopback` | Also set the binding to loopback only; a running daemon moves within about a second, and meanwhile answers other machines only with `403` `CONTROL_PLANE_LOCAL_ONLY`. |
| `goodvibes-daemon webui disable` | Stop serving it: writes `controlPlane.webui.serve` `false` and `web.enabled` `false`. The bundle and `controlPlane.webui.bundleDir` stay, so a later bare `webui enable` serves it again. |
| `--lan` and `--loopback` together | Refused: `webui: --lan and --loopback ask for opposite things; pass one of them`, exit `2`. `--bundle-dir`, `--lan` and `--loopback` with `disable` or `status` are refused the same way. |

Examples:

```text
$ goodvibes-daemon webui status
web UI: not served by this daemon (controlPlane.webui.serve is off).
  a bundle directory is configured (web.staticAssetsDir): dist/web
  Serve it:  goodvibes-daemon webui enable --bundle-dir <dir>

$ goodvibes-daemon webui enable --bundle-dir /nonexistent/dir
webui: refusing to serve /nonexistent/dir: no directory at /nonexistent/dir.
  Nothing was changed.

$ goodvibes-daemon webui enable --bundle-dir /home/alex/goodvibes/products/webui/dist
web UI: served by the daemon from /home/alex/goodvibes/products/webui/dist
  http://127.0.0.1:3421
  reachable from this machine only (the control-plane listener is bound to loopback).
  To reach it from another device on your network:  goodvibes-daemon webui enable --lan
  A running daemon applies this within about a second; no restart is needed.
```

A directory with no `index.html` is refused with `<dir> holds no index.html, so it is not a built web UI bundle`; a missing one with `no directory at <dir>`; both exit `1` and change nothing. When the daemon serves the bundle, `controlPlane.webui.bundleDir` wins over `web.staticAssetsDir` (the daemon itself does fall back to `web.staticAssetsDir` when `bundleDir` is empty; only the `webui enable` command does not).

When the change takes effect on a running daemon:

- Serving or not serving the bundle (`enable`, `disable`, a new `--bundle-dir`): at once, on the next request.
- The address (`--lan`, `--loopback`): within about a second, in both directions; no restart (see "How a running daemon moves to a new address"). A daemon started with `--host` or `--port` keeps that binding until it is restarted without them.

On a machine whose only address is loopback, `--lan` still sets the network binding but prints `reachable from this machine only` and writes `http://127.0.0.1:3421` into `web.publicBaseUrl`. `status` or `disable` with `--lan`, `--loopback` or `--bundle-dir` is refused with `<flag> only applies to 'webui enable', not '<subcommand>'` (for example `--lan only applies to 'webui enable', not 'status'`), exit `2`.

The bundle itself is public: anyone who can reach the listener can load the page. Every API call the page makes needs a token.

`web.hostMode`, `web.host` and `web.port` are where the web UI's development server listens (it reads them from `goodvibes-daemon webui status --json`); nothing else binds them, and no link, pairing address, `goodvibes web` or `tailscale.serve.run` uses them. The web UI's address has one owner: the control-plane address while the daemon serves the bundle, otherwise a set `web.publicBaseUrl`, otherwise none. `web.publicBaseUrl` also overrides the address used in pairing links and notification links when the web UI is reached through a tunnel or proxy the daemon cannot describe; `goodvibes web` prints both. `web.enabled` only switches the web channel on or off.

### Signing in to the web UI

The web UI shows "Sign in to GoodVibes" until it has a credential, with one sentence, `Run goodvibes pair on your computer and scan the code.`, and the button `Scan the code`. Four ways in:

1. Open a pairing link (`.../#pair=<token>`) or scan its QR code with the device's camera. The code travels in the URL fragment, which a browser never sends to a server, so it does not appear in any access log.
2. Scan the QR code from inside the sign-in page (`Scan the code`). A code that names another daemon address than this page's is not sent here: the page says `That code is for GoodVibes at <origin>, and this page is at <origin>. It was not sent here` and offers `Open the daemon at <origin>`, which opens that daemon's page with the sign-in code in the URL fragment (a username and password are typed again there).
3. Under `Other ways to sign in`, paste a code into `Sign-in code` and press `Sign in`.
4. Under `Other ways to sign in`, `Use a username and password` ("Username", "Password"), which creates a 12-hour sign-in.

Where the credential lives:

- Direct route (the page talks to the daemon's own origin): every way in is one `POST /api/browser-session` (`{ "token": "<code>" }` or `{ "username": "…", "password": "…" }`, JSON, from the daemon's own origin or one in `controlPlane.cors.allowedOrigins`; anything else is refused `403` `ORIGIN_NOT_ALLOWED`). The daemon checks what was presented (a password through the same limits and lock as `POST /login`) and binds it to the `goodvibes_session` cookie: HttpOnly, so no page script can read it, SameSite=Strict, and Secure when the page came over TLS. The answer names who signed in (`principalId`, `credential`, `expiresAt`) and never the credential. Beside the cookie the daemon sets `goodvibes_identity`, a readable marker holding a fresh generation and who is signed in (no credential), with the same end; every tab of the browser reads it to notice a sign-in or sign-out. A refused code changes nothing. A sign-in session's cookie moves its end with the session each time the page reads its sign-in; a device or operator token's cookie lasts 400 days (the longest a browser keeps one) unless the token is revoked first. The page works across a reload with nothing stored.
- Cross-site defence on the cookie: a request that authenticates by the cookie is held to the page's origin, not to SameSite alone. A state-changing request must carry the daemon's own `Origin` (or one in `controlPlane.cors.allowedOrigins`); a read, the event stream included, is refused when it names another origin; the WebSocket upgrade refuses another origin, and refuses a cookie without an `Origin`. A page on another port of the same host carries the cookie but is refused `403` `ORIGIN_NOT_ALLOWED`.
- Phone node (the web UI as a device node, `?view=phone`): its remote peer token is a credential of its own. Paired directly, `POST /api/browser-session/node` binds it to a separate HttpOnly, SameSite=Strict cookie, `goodvibes_node`, with `Path=/api/remote`: only the peer routes read it, and only as a peer token, while operator routes never do, so the node's narrower peer rights and the sign-in's rights stay apart. A peer request on that cookie must carry the daemon's own `Origin`. The page keeps only the node's id and name (`goodvibes.webui.phoneNode`), so a reload stays paired; unpairing calls `POST /api/browser-session/node/end`, which clears the cookie. Paired over the relay, the token is held in the page's memory and a reload pairs again.
- Relay route: the relay tunnel builds every request in the page, so a sign-in made over the relay (a code, or a username and password through `POST /login`) is held in the page's memory only, and so is the relay pairing. Reloading the page forgets both: the page starts on the direct route, and when the daemon is reachable only through the relay it asks for the relay code and a sign-in again. A direct sign-in's cookie is not usable over the relay, so moving onto the relay also asks to sign in.

`Other ways to sign in` also holds the relay code (`Not on the same network as your computer?`) and `Where do I find a code?`: `goodvibes pair` shows one, and the GoodVibes service prints one when it starts. A refused pairing link or pasted code shows `That code didn't work. It may have expired; run goodvibes pair again.`; a pasted code stays in the field to correct. The page reaches the daemon whatever the browser says about its own network: with no network beyond the machine (no interface but loopback), a daemon on loopback is still used, and "Can't reach the daemon" means the daemon itself did not answer. A daemon that answers the sign-in check with a server fault (any `5xx`) shows "The daemon could not answer" instead: the code is kept and the check is repeated every 5 seconds; only a refusal of the code (`401`) shows the sign-in page. A relay code (`gvrelay1.…`, see "The relay") only provides a route to the daemon; a sign-in code is still needed to sign in.

### Views

The web UI has five destinations, chosen in the sidebar and reflected in the address as `?view=<id>`:

| View | `?view=` | Tabs (`&tab=`) | What it shows |
| --- | --- | --- | --- |
| Chat | `chat` | none; `&session=<id>` opens one session | Conversations with the model: messages, tool activity (kept with each reply, so it shows after a reload), artifacts, queued messages (listed once, above the composer, until they are sent), search, a composer with attachments and voice. An approval the chat's own turn is waiting on is shown above the composer with Approve and Deny (one that needs an answer or a choice of edits opens in Work). The model menu lists the providers that are set up. |
| Work | `work` | `all`, `sessions`, `agents`, `processes`, `checkpoints`, `plan` | Everything running or finished: hosted and shared sessions, agents, contracts and their units, approvals, owner questions, tasks, CI watches, background processes, checkpoints and rewind, the work plan, and steering of a running session. A hunk marked Reviewed in a session's changes keeps the mark only while its lines are exactly what was reviewed: after a refresh, changed content reads unreviewed. Messages saved in this browser under another pairing are shown only as a count (`Sign in as that pairing to recover them`); their text is not shown. |
| Library | `library` | `memory`, `knowledge`, `review` | Memory records; what the knowledge base knows, by subject (each fact with `From <source> · <when>`; the sources it read; the graph's nodes, issues and wiki projections under Details), its map, packet and activity; items waiting for review. |
| Personal | `personal` | `calendar`, `mail`, `occasions` | Calendar, mail and dates the owner cares about. In Mail, Mark read, Archive and Delete send the message's mailbox generation with its UID; a draft opened from Drafts and saved again replaces that draft (the folder keeps one copy); opening a reply or a draft while the composer holds unsaved writing asks first. |
| Phone | `phone` | none | Lets this browser act as a device node (camera, location, clipboard on request). |

A message typed in Chat, or a steer or follow-up sent from Work, is held by the tab until the daemon answers for it, scoped to the daemon and the signed-in account and cleared on sign-out. A send that failed or got no answer stays as a failed message with Resend (also after a reload of the tab or after leaving the chat and coming back); Resend sends it again under its own id, so the daemon records it at most once, keeps it a steer when it was one, and uploads only the attached files that did not upload before. A send with no answer says it may have been sent. When a new chat cannot be created, the message and its files go back to the composer; text typed since is kept, with the returned text after it. A wake phrase sent with `voice.wake.autoSubmit` goes as its own message and leaves the composer as it was. Unanswered steers and follow-ups are never dropped from the list in Work by newer ones.

Old addresses still work: `?view=sessions` and `?view=hosted-sessions` open Work on `sessions`; `?view=fleet` and `?view=approvals-tasks` open Work on `all`; `?view=knowledge`, `?view=memory` open Library; `?view=calendar`, `?view=mail`, `?view=dates` open Personal; `?view=admin`, `?view=providers`, `?view=principals` and `?view=checkin` open the settings dialog.

### The settings dialog

The settings dialog opens from the account menu, or with `?settings=<section>` in the address. The account menu's "Earlier notices" lists every toast the page has shown, newest first, until the page is closed or another account signs in. It has seven pages; each holds one or more sections:

| Page | Sections (`?settings=` id) | What they hold |
| --- | --- | --- |
| General | `general` Display, `network` Network, `all` Advanced, `about` About | Theme, density, language; Tailscale, Cloudflare, relay and the listeners; the Triggers screen (supervised triggers, their runs, and the commands they may run) and every other setting; daemon status, this browser's connection, local sign-in. |
| Account | `account` Sign-in, `devices` Devices and pairing, `people` People and channels | Sign-in, operator token, step-up verification, owner profile, mail and calendar accounts; paired devices and their tokens, power, this browser as a phone node, Telegram delegated intake; principals and channel profiles. |
| Models and providers | `models` Model, `credentials` Credentials, `usage` Usage | The current model, providers, sign-in routes, decision models; the credential store and accounts; usage, budgets, payments (cards, purchase windows, repeat purchases). |
| Voice | `voice` | Dictation, spoken replies, wake word. |
| Notifications | `notifications`, `checkins` Check-ins | Push notifications, installing the app, occasion reminders; check-in settings. |
| Memory | `memory` | Memory provenance and diagnostics. |
| Permissions | `permissions` | The four modes (Ask me, Jev decides, Just vibes, YOLO) as cards, each with what it does; picking one sets `permissions.mode`. Under the chosen card, when it is not the mode in force, why (`Asking you for now: no decision model chosen`). Under Advanced: approval rules, the MCP servers and tools screen, the permission evaluator and its simulation, the sandbox, tool policy. |

Every setting the daemon knows appears in exactly one section; a namespace no section lists appears under Advanced.

### Slash command actions in the web UI

The web UI draws the actions of the slash commands the daemon runs from the same descriptions the terminal apps use (`packages/engine/contracts/artifacts/command-actions.json`), so a button, its blanks, its sentence and its done line say what the terminal says. The command palette (Ctrl+K or ⌘K) lists each such action that changes something by its label (`Schedule something to run`, `Block a tool`, `Allow a repeat purchase`); choosing one opens its sheet. A sheet shows the action's blanks as pick-lists, switches and fields (a blank that belongs to a choice shows only while that choice is made; a step of four or more usual settings is folded under `More settings`), the sentence of what will happen above the button, and `From a terminal:` with the typed line that does the same (a secret is left out of it). Its button says the action's verb (`Schedule it`, `Block`, `Stop blocking`, `Switch on`), and is red only for what cannot be undone. Pressing it sends the request as the owner's own (`x-goodvibes-explicit-user-request: true`), which purchase allowances and letting triggers run a command require. An action only a terminal app can do (one that belongs to that terminal's session) is shown greyed with the reason.

Two sheets have the daemon read what was typed before anything is kept: "Schedule something to run" and "Change a schedule" call `automation.schedules.preview` (a time described in words, such as `every weekday at 9am`, is read once, by the decision model when one is set, else only the fixed forms: an ISO time, a cron pattern, `every 30m`, `in 2h`), and "Watch for something" calls `watchers.triggers.preview`. `Check` shows the reading (`Read as: 0 9 * * 1-5 [Europe/Vienna]. Next run: 2026-11-23 09:00 Europe/Vienna.`); the button then keeps exactly that, and changing a blank asks for `Check` again. A refusal ("Not kept: ...") is shown in the sheet, which stays open.

Four screens are drawn from one command each. Each sits where it belongs (Schedules in Work, from the Scheduled group and New; MCP servers and tools under Settings > Permissions > Advanced; Repeat purchases under Settings > Models and providers > Usage, with payments; Triggers under Settings > General > Advanced), and the palette also opens each in a side panel (`Schedules`, `MCP servers and tools`, `Repeat purchases`, `Triggers`):

| Screen | Rows | Actions on a row | At the top |
| --- | --- | --- | --- |
| Schedules | Each schedule: name, when it runs in words, its next run, `(paused)`, a failed last run. | Run, Pause or Resume, Change (the schedule editor: blanks left empty keep what it has, shown as `Now: ...`), and Remove a schedule in More. The Work view opens this screen from the Scheduled group's `See your schedules` and from New (`Schedule something to run…`, `See your schedules`). | Schedule something to run. |
| MCP servers and tools | Each server: connected or not, not started because a project file of a folder not yet trusted names it (`heldForTrust` in `mcp.config.get`; trusting the folder starts it), tools held back, trust level, role, the config file that keeps it; `Tools (n)` opens its tools, each with its rule (`follows github's limits`, `blocked, kept`, a rule for one terminal's session, changed only there). | Accept a server's changed tools (when held back); More: set its trust level or role, remove it. A tool: Block or Stop blocking; More: let it go beyond its server's limits, or make it follow them again. | Add a server, Reconnect every server from its config. |
| Repeat purchases | Each allowance in the daemon's words (shops, item, limits, what is left this period, its last day). | Stop. | Allow a repeat purchase. |
| Triggers | Who supervises them, then each trigger: what it watches, its state, how often it fired, its last error; `Runs` shows its newest runs. Under it, the commands triggers may run. | Start a trigger that gave up (when its breaker is open); More: Stop. | Watch for something; Let triggers run a command. |

Each screen ends with the command's actions only a terminal app can do, greyed, each with its reason.

## Credentials and pairing

### The three kinds of credential

| Credential | How it is made | Authority | Where it is kept | How it ends |
| --- | --- | --- | --- | --- |
| Operator token (shared) | Written on the daemon's first start. | Full (admin). From the daemon's own machine it is reported as credential `local`; from elsewhere as `shared-token`. | `~/.goodvibes/daemon/operator-tokens.json` | Revoking it replaces it (see below). |
| Device token | Pairing: a QR code, `goodvibes pair`, `goodvibes-daemon pair --host ... -y`, or the API (`pairing.tokens.create`). Starts with `gvp_` (the operator token starts with `gv_`). | Full, unless minted with a scope list. Reported as credential `device-token`, or `agent` for the Agent's own pairing. | Hash only, in `pairing-tokens.json`; the secret is shown once. | Revoked one at a time, immediately. |
| Sign-in | `POST /login` with a username and password. | The user's role: `admin` gives full authority; any other role reads everything except the owner's private content and writes nothing. A user can be given a narrower scope list. | In memory; users in `auth-users.json`. | After 12 hours, on `POST /logout`, or when revoked. |

A newly minted device token is an offer until it is first used: it is not listed as a device, does not count toward `device.nodes.maxPaired`, and stops working if nobody uses it within 15 minutes (`PAIRING_OFFER_EXPIRED`). The first request that uses it turns it into a paired device. With `device.nodes.maxPaired` devices already paired, an offer made under the name of a device that is already paired is allowed, and replaces that device only at its first use (the old device token is revoked then, and what the old pairing minted moves to the new one); an offer that expires unused leaves the paired device working.

### Pairing a phone or another browser

Preconditions: the daemon is running, it serves the web UI (`goodvibes-daemon webui status`), and the phone can reach its address (same network, Tailscale, or a public address).

1. On the daemon's machine, make the web UI reachable from the phone: on the same network, `goodvibes-daemon webui enable --lan`, then check that `ss -ltn 'sport = :3421'` shows `0.0.0.0:3421` (no restart is needed) (all of it in "Making the daemon reachable on the local network"); over Tailscale, the Tailscale steps in "Remote access" instead (they keep the daemon on loopback, so no restart is needed).
2. Show a pairing code. Any of these works:
   - `goodvibes pair --name "my phone"` (terminal app; mints a named device token on the connected daemon and prints its link and QR code);
   - `/devices pair device` inside either terminal app;
   - `goodvibes-daemon pair` (prints a link carrying the shared operator token).
3. Scan the QR code with the phone's camera, or open the link on the phone.
4. The web UI opens signed in and lists the offers: notifications, relay, passkey. Each can be accepted or declined; declining one does not stop the pairing.
5. Check the result. A code from `goodvibes pair` or `/devices pair device` gives the phone its own device token, and the phone appears in the web UI under Settings, Account, Devices and pairing. A link from `goodvibes-daemon pair` (local form) carries the shared operator token instead, so the phone is not listed as a device of its own and stops working when the shared token is revoked; prefer `goodvibes pair`.

What failure looks like: the page cannot load (the address is not reachable: check `controlPlane.enabled`, the binding and the firewall); "The pairing link was rejected" (the token expired unused after 15 minutes, or was revoked: show a new code); a refusal with code `DEVICE_NODES_MAX_PAIRED` because `device.nodes.maxPaired` (default 8) devices are already paired (revoke one, or raise the setting, then use the same code before it expires).

The offers:

| Offer | Accepting it |
| --- | --- |
| Notifications | Registers this browser for web push. Needs a secure context (HTTPS or `localhost`). |
| Relay | Stores the relay route so the device can reach the daemon off the local network. Offered only when `relay.enabled` is `true`. |
| Passkey | Registers a WebAuthn passkey used for step-up confirmation of sensitive actions. Offered only to a pairing with full authority, and accepted only from the device that paired with that hand-off's token, once, within 30 minutes; completing the hand-off needs what `stepup.credentials.register` needs (admin authority, never the Agent's credential). |

### Managing paired devices

Paired devices are listed, renamed and revoked in the web UI (Settings, Account, Devices and pairing) and through these API methods (all through `POST /api/control-plane/methods/<id>/invoke`, see the next part):

| Method | Does |
| --- | --- |
| `pairing.tokens.list` | `{ "tokens": [...], "legacySharedRevoked": false }`. Each token has `id`, `name`, `createdAt`, `lastSeenAt` and `origin` (`owner-pairing` for a device the owner paired himself through the pairing QR or `pair`, which makes the owner's own acts; `automation` for every other token, see "A change only the owner makes" in "The operator HTTP API"); `mintedBy` (the id of the paired device that minted it) appears only when a paired device minted it, `scopes` only when it was minted with a narrower scope list (absent means full operator authority), and `client: "agent"` only on the Agent's own pairing. Never the secret. `legacySharedRevoked` is `true` once the shared operator token has been revoked (`pairing.tokens.revokeShared`). Offers not yet used (see "The three kinds of credential") are not listed. |
| `pairing.tokens.create` | Mint a device token. Input `name` (required), `scopes`, `client: "agent"`, `attemptId`. The secret is returned once. |
| `pairing.tokens.rename` | Input `id`, `name`. |
| `pairing.tokens.delete` | Input `id`. Revocation is immediate: the next request with that token gets `401`. Every token that device minted is revoked with it (`alsoRevoked`). |
| `pairing.tokens.migrate` | A client using the shared token mints its own device token. |
| `pairing.tokens.revokeShared` | Revoke the shared operator token. |
| `pairing.handoff.create` | Mint a token together with the offer set and the `#pair=` deep link. |
| `pairing.posture.get` | Which browser features an origin gets over its scheme. |

A device minted with a scope list holds only those scopes; it is not admin. A caller can only grant scopes it holds.

### Pairing a phone with limited access

`goodvibes pair` and the pairing QR codes always mint a device token with full authority; neither takes a scope list. For a phone that should only, for example, read sessions:

1. Mint a scoped token with an admin credential (see "Minting a scoped token for a script" in "The operator HTTP API"), for example `{"body":{"name":"kitchen tablet","scopes":["read:sessions","read:transcripts","read:events"]}}` to `pairing.tokens.create`.
2. Build the link by hand: the web UI origin, then `/#pair=` and the token, for example `http://desktop.local:3421/#pair=<token>`. Without `&offers=...` the phone is offered no notifications, relay or passkey set-up.
3. Open it on the phone within 15 minutes, or type the token into the sign-in page's "Operator token" field.

The phone then sees only what those scopes allow; screens that need more show an error. A scoped credential that itself holds `write:control-plane` can call `pairing.handoff.create`, and the token that mints carries the caller's own scope list.

### A lost phone

Do all of these that apply, on the daemon's machine or from another signed-in device:

| What the phone holds | How to cut it off |
| --- | --- |
| Its own device token (paired with `goodvibes pair`, `/devices pair device` or a QR) | Revoke it: web UI Settings, Account, Devices and pairing; or `pairing.tokens.delete` with its id (from `pairing.tokens.list`). Its next request gets `401`; its open streams get a `closed` frame; tokens it minted are revoked with it. |
| The shared operator token (paired with `goodvibes-daemon pair`, local form) | `pairing.tokens.revokeShared` (see below). |
| A sign-in session | Rotate that user's password: `goodvibes auth rotate-password <username> --password-stdin` ends that user's sessions on a running daemon within a few seconds, with no restart. Or end one session at once with `goodvibes auth revoke-session <id>` (ids from `goodvibes auth sessions`), or all of one user's with `goodvibes auth revoke-sessions <username>`; both act on the running daemon, through `local_auth.sessions.delete` (`GET /api/local-auth` lists the sessions). |
| A passkey (accepted the Passkey offer) | `GET /api/stepup/credentials` lists passkeys (`credentialId`, label, creation time); `DELETE /api/stepup/credentials/{credentialId}` removes one (admin, from the daemon's own machine; over the relay it needs a step-up itself). Removing the last passkey leaves nothing to confirm relay actions until a new one is registered. In a group, a passkey removed on one machine confirms nothing on any machine. |
| A relay pairing code (`gvrelay1.…`) | Each pairing carries a relay code for that one device, listed and revoked like a device token: `/devices relay-codes` in the terminal app, `goodvibes-agent relay codes`, the operator method `relay.codes.list` or the web UI's Settings, "Relay devices", show each code's id, name, creation and last use (never the code); `/devices relay-revoke <code>`, `goodvibes-agent relay revoke <id>`, `relay.codes.revoke` (admin) or the web UI's Revoke button revoke one. Every relay connection the code opened ends at once (its open event streams are closed, its requests stopped), and from its next request the phone is refused through the relay (`401` `relay-code-revoked`); every other device keeps working, and the phone still connects directly on the home network with a valid token. A relay code the phone asked for with its own device token is also revoked when that device token is revoked, on any machine of the group. To cut every device off at once, switch the relay off: `goodvibes-daemon config set relay.enabled false` refuses relayed requests at once (`503` `relay-disabled`). |
| Web push (accepted Notifications) | Revoking the phone's device token also ends the push subscription the phone registered with it, on every machine of the group: no machine pushes to it again. A subscription the push service reports gone is removed by the daemon too. |

### Revoking the shared operator token

The shared operator token is the one every pairing link printed by `goodvibes-daemon pair` (local form) carries. When a copy of it may have leaked:

1. Make sure every other device you use has its own device token (pair it with `goodvibes pair`, or have it call `pairing.tokens.migrate`).
2. Call `pairing.tokens.revokeShared`. The daemon writes a new value to `operator-tokens.json`; the apps on its own machine read it there and stay signed in. Every other copy stops working at once.
3. If the daemon was started with `GOODVIBES_DAEMON_TOKEN`, the call is refused with `SHARED_TOKEN_NOT_REPLACEABLE` (409); change the variable and restart instead.

After the shared token is revoked, `goodvibes-daemon pair` (local form) no longer prints a link with it. It states that and offers to mint a device token instead; `goodvibes-daemon pair -y` mints one on this machine's daemon and prints its pairing block.

### Sign-in users

The first sign-in user is `admin`, with a random password in `~/.goodvibes/tui/auth-bootstrap.txt`:

```text
GoodVibes bootstrap auth
username=admin
password=<random>
purpose=Use these credentials only for local daemon/http listener /login routes when those surfaces are enabled.
note=Normal platform host usage does not require these credentials.
```

Manage users with the terminal app (`goodvibes auth ...`, described in "The terminal app (`goodvibes`)") or the API (`local_auth.*`, all admin):

| Method | Route |
| --- | --- |
| `local_auth.status` | `GET /api/local-auth` |
| `local_auth.users.create` | `POST /api/local-auth/users` with `username`, `password`, optional `roles` (omitted: admin) and `scopes` |
| `local_auth.users.delete` | `DELETE /api/local-auth/users/{username}` |
| `local_auth.users.password.rotate` | `POST /api/local-auth/users/{username}/password` |
| `local_auth.users.scopes.set` | `POST /api/local-auth/users/{username}/scopes` with `scopes` (a list, or `null` for the role's default) |
| `local_auth.sessions.delete` | `DELETE /api/local-auth/sessions/{sessionId}` |
| `local_auth.bootstrap.delete` | `DELETE /api/local-auth/bootstrap-file` |

The last user with the `admin` role cannot be deleted. Five sign-in attempts per minute are allowed from one address; past that the daemon answers `429` with code `RATE_LIMITED`. A sign-in whose password was changed (or whose user was deleted) while the password check ran is refused with `401` `PASSWORD_CHANGED_DURING_SIGN_IN`: the newer password decides, so sign in with it.

Roles: `admin` is the only role with a meaning; any other role name (the terminal app's `goodvibes auth add-user` uses `user` by default) gives the non-admin set: every read scope except the owner's private ones, and no writes. Through the API, `local_auth.users.create` without `roles` creates an **admin**; pass `"roles":["user"]` for a read-only user.

### The bootstrap file

`~/.goodvibes/tui/auth-bootstrap.txt` holds the password of the first user, `admin`, in plain text. It is written once, when the user store is created.

- **The file is the password.** The generated password signs in only while this file still holds it. Deleting the file, emptying it or clearing it with `goodvibes auth clear-bootstrap` withdraws the password at once: a sign-in with it then gets `401` `BOOTSTRAP_CREDENTIAL_WITHDRAWN` (`this generated password signed in only while the bootstrap credential file held it, and that file was deleted or cleared`), and every sign-in made with it ends within about a second. `admin` keeps its account; give it a password with `goodvibes auth rotate-password admin`.
- **Another user's sign-in leaves it alone.** While `admin` still has the generated password, nobody else's sign-in deletes the file. The daemon deletes it by itself only once nothing signs in with it any more (the user it names has a password of its own), at the next sign-in with a real password.
- The one right way to finish with it:

```sh
printf '%s\n' '<a new admin password>' | goodvibes auth rotate-password admin --password-stdin
goodvibes auth clear-bootstrap      # prints "Bootstrap credential file removed." or "... was already absent."
```

`rotate-password` deletes the file itself when it names that user, so `clear-bootstrap` after it is only a check. The API equivalents are `local_auth.users.password.rotate` and `local_auth.bootstrap.delete` (`DELETE /api/local-auth/bootstrap-file`). Removing the file by hand ends the generated password as surely as the command does.


## Host pairing: giving the terminal app its own credential

By default the terminal app on the daemon's machine uses the shared operator token. Host pairing gives the terminal app a device token of its own on the daemon, so the shared token can be revoked without signing the terminal out.

```sh
goodvibes host pair                      # preview: shows the host, the name and what would be created
goodvibes host pair --bootstrap-shared --apply
goodvibes host unpair                    # forget the stored credential on this machine
```

| Flag | Effect |
| --- | --- |
| `--url <exact-origin>` | The daemon to pair with, as an exact origin such as `http://10.0.0.7:3421` (no path, query or fragment). Default: the connected daemon. |
| `--name <device-name>` | The device name. Default `GoodVibes TUI`. |
| `--bootstrap-shared` | Use the shared operator token to ask for the new credential. |
| `--apply` | Create it. It needs a fresh typed confirmation in an interactive terminal; `--yes` and scripted approval are not supported. |

The request is `pairing.tokens.migrate`, sent once with an attempt id. When the reply is lost, running the same command again repeats that attempt and the daemon answers with the same credential, never a second one. `unpair` only forgets the credential on this machine; it stays valid on the daemon until revoked there. The terminal app's `/devices pair host` and its other options are in "The terminal app (`goodvibes`)".

## A terminal app on another machine

The terminal app on a laptop can use a daemon on a home server instead of one of its own. Which credential is sent where:

| Request from the laptop's terminal app to | Credential sent |
| --- | --- |
| A daemon on the laptop itself (a loopback address the app did not reach through `daemon.connectedHost.url`) | The laptop daemon's own operator token, from the laptop's `~/.goodvibes/daemon/operator-tokens.json` (or `GOODVIBES_DAEMON_TOKEN`). When the laptop's settings declare `controlPlane.publicBaseUrl` and the app dials that address, the token is sent there only after the address answers the daemon's identity challenge once per app run, without the token: the first call waits for that check (at most 2 seconds) and then goes ahead, or fails with `CREDENTIAL_NOT_FOR_TARGET` when the address did not prove it is this machine's daemon. |
| The daemon named by `daemon.connectedHost.url` | The token stored for that exact origin in the laptop's `~/.goodvibes/tui/connected-daemons.json`; while an `/accounts sign-in daemon` sign-in for that origin is held, its session token instead. Neither the laptop's own operator token nor `GOODVIBES_DAEMON_TOKEN` is ever sent there, even when the address is a loopback port (a forwarded port, another user's daemon); with nothing stored the call is refused with `CREDENTIAL_NOT_FOR_TARGET`. `daemon.connectedHost.enabled` set to `false` stops the app dialling any daemon. |
| Native work (contracts, the work ledger) on the connected daemon | A device credential from `/devices pair host` for that origin when one exists. |

End to end:

1. **On the server**, make the control plane reachable from the laptop: `goodvibes-daemon webui enable --lan` (or `config set controlPlane.hostMode network` and `config set controlPlane.enabled true`), check that `ss -ltn 'sport = :3421'` shows `0.0.0.0:3421` (no restart is needed), and allow TCP 3421 in its firewall. Or use Tailscale and keep it on loopback (see "Tailscale").
2. **Get a credential for the laptop**, on the server: `goodvibes pair --name "laptop"` prints a device token (in the link after `#pair=`); or, from the laptop with the server's operator token, `goodvibes-daemon pair --host http://server.lan --token <server operator token> -y`. A device token can be revoked on its own later; the server's operator token works too but cannot. **Use the device token within 15 minutes:** until its first request it is only an offer, and an offer nobody uses expires (`PAIRING_OFFER_EXPIRED`). Do steps 3 and 4 straight away; step 4 is the first use that turns it into a paired device. A token that expired unused is refused with code `PAIRING_OFFER_EXPIRED` (`this pairing code was not used within 15 minutes of being made, so it expired`); mint a new one.
3. **On the laptop**, store it and point the app at the server. Either:
   - run `goodvibes setup`, open `Use it from other devices`, choose "Connect to an existing running daemon", and give the host, the port (3421) and the token. It writes both items below and restarts the app's connection; or
   - by hand: write the token for the server's origin, then set the address:

     ```sh
     mkdir -p ~/.goodvibes/tui
     cat > ~/.goodvibes/tui/connected-daemons.json <<'JSON'
     { "version": 1, "tokens": { "http://server.lan:3421": "<the device token>" } }
     JSON
     chmod 600 ~/.goodvibes/tui/connected-daemons.json
     ```

     and set `daemon.connectedHost.url` to `http://server.lan:3421` in the terminal app (`/settings` in the app, or the `daemon.connectedHost.url` line of `~/.goodvibes/tui/settings.json`). The key in `tokens` must be exactly the origin: scheme, host and port, with no path; the default port of the scheme is left out (`https://server.example`, not `https://server.example:443`).
4. **Check** the server and the token from the laptop: `goodvibes-daemon status --host http://server.lan:3421 --token <the device token>` must print the server's status. (`goodvibes control-plane status` describes only the laptop's own control-plane binding, not the connected daemon.)
5. To go back to a daemon on the laptop, clear `daemon.connectedHost.url`; the token for the server stays in `connected-daemons.json` for next time.

The laptop's conversation turns still run in the laptop's terminal app, so model provider credentials are needed on the laptop; the server's channels, schedules, memory and hosted sessions are the server's. The laptop's own `operator-tokens.json` is not touched by any of this.

## Remote access

Three ways reach the daemon from outside the local network. None is on by default.

### Tailscale

Tailscale gives the daemon an encrypted address and a real `https://` name on the owner's tailnet with no certificate handling. Manual setup, which works in 3.3.1:

1. Install Tailscale on the daemon's machine and the phone, and log both in (`tailscale up`).
2. Serve the daemon's control-plane port over HTTPS on the tailnet:

   ```sh
   tailscale serve --bg 3421
   ```

3. Tell the daemon the address devices should use:

   ```sh
   goodvibes-daemon config set web.publicBaseUrl https://desktop.your-tailnet.ts.net
   goodvibes-daemon webui enable        # add --bundle-dir <dir> when no bundle is configured yet
   ```

4. On the phone, open `https://desktop.your-tailnet.ts.net` and pair (`goodvibes pair`). The page is a secure context, so installing the app, push and the microphone all work.
5. To stop: `tailscale serve --https=443 off`, then `goodvibes-daemon config unset web.publicBaseUrl`.

`tailscale serve` forwards from `localhost`, so the daemon can stay bound to loopback with `controlPlane.enabled` `false`.

The daemon also has three API methods for this (Settings, General, Network in the web UI shows them): `tailscale.get` (read-only: is the binary there, logged in, the MagicDNS name, the serve the daemon started), `tailscale.serve.run` (admin: runs `tailscale serve --bg <port>`, records a receipt, and on success sets `web.publicBaseUrl` to the `https://` address) and `tailscale.serve.stop` (admin: runs `tailscale serve --https=443 off` and puts `web.publicBaseUrl` back). `tailscale.serve.run` serves the port the web UI is served on, the control-plane port while the daemon serves the bundle; with no web UI served it is refused with `409` `WEB_UI_NOT_SERVED` and runs nothing (serve the bundle first with `goodvibes-daemon webui enable`). When the tailnet has Serve switched off, Tailscale prints a link to switch it on; the receipt carries it as `enableUrl`.

### The relay

The relay lets a device off the local network reach the daemon when the daemon has no public address and no open inbound port. The daemon dials out to a relay server over WebSocket and registers under a rendezvous id derived from its own identity key. A device dials the same id. The two run an end-to-end encrypted handshake inside the connection, so the relay forwards only ciphertext; it sees connection metadata, never content or tokens.

Three things must all be true before the daemon dials: `relay.enabled` is `true` (default), the runtime feature `relay-connect` is on (default), and `relay.url` is set (default empty). With `relay.url` empty the daemon stays local-network only.

Setting it up, end to end:

1. Run a relay server on a machine that the phone and the daemon can both reach: it needs a public address and one open inbound port (the daemon's own network needs none). The relay is a Bun program; run it with `bun`. From a GoodVibes source checkout:

   ```sh
   GOODVIBES_RELAY_PORT=8787 bun packages/engine/daemon-api/src/relay-server-entry.ts
   ```

   From the published `@goodvibes/engine` package the same program is `daemon-api/dist/relay-server-entry.js`. `GOODVIBES_RELAY_PORT` sets the port (default `8787`); `GOODVIBES_RELAY_HOST` sets the bind address (default all interfaces; use `127.0.0.1` behind a reverse proxy on the same machine). `GET /` on the relay reports how many daemons and devices are connected.
2. Put TLS in front of it so it is reached as `wss://relay.example.com`.
3. Point the daemon at it and restart. The registration is opened only when the daemon starts: a running daemon never dials a newly set or changed `relay.url` by itself (the code that would re-read it has no caller in 3.3.1).

   ```sh
   goodvibes-daemon config set relay.url wss://relay.example.com
   goodvibes-daemon restart-service
   ```

4. Check the registration with `relay.reachability.get` (API, scope `read:control-plane`). Its `status` is `disabled` (one of the three gates is off), `idle`, `connecting`, `registered` (the relay answered within the last two pings), `reconnecting`, `refused` (the relay refused the registration; the reason and next step are in `lastRefusal`) or `stopped`. The daemon records its rendezvous id in `relay.rendezvousId`; setting that key does nothing.
5. Pair a device for the relay while it is on the local network: run `/devices pair relay [--name <name>]` in the terminal app or `goodvibes-agent relay pair [name]`, or call `relay.pairing.mint` (admin, optional `name`), and give the device the code it returns (`gvrelay1.…`, or a link with `#relay=<code>`). Each call issues a relay code for one device, carried inside the pairing and sent by the device on every relayed request; the daemon keeps only its hash and refuses a request whose code it did not issue or has revoked (`401` `relay-code-revoked`). Pair each device separately, so each can be revoked alone (see "A lost phone"). `relay.pairing.mint` returns `pairing: null`, and keeps no code, until the daemon has registered; it refuses with `409` `RELAY_CODE_LIMIT` once 64 codes are held. Treat the code like a credential: it routes a device to the daemon until it is revoked.
6. Off the network, the web UI uses the relay automatically when the daemon's direct address does not answer. A token is still required to sign in. The relay pairing and a sign-in made over the relay are held in the page's memory only: after a reload the page asks for the relay code and a sign-in again (see "Signing in to the web UI").

`relay.requireStepUpForMutations` (default `false`) makes every state-changing operator call that arrives through the relay require a recent passkey confirmation. `relay.label` is a name shown in relay pairing payloads.

When relay settings apply: `relay.enabled`, the `relay-connect` flag and `relay.requireStepUpForMutations` are read on every relayed request, and `relay.label` each time a relay pairing is minted, so changes to them apply at once with no restart. `relay.url` is read only when the daemon starts. Turning `relay.enabled` or `relay-connect` off therefore cuts relay traffic at once: requests over the still-open registration are answered `503` with code `relay-disabled`, and `relay.reachability.get` reports `disabled`. The registration itself stays open until the daemon restarts. The daemon pings the relay every 25 seconds and re-registers when a ping goes unanswered. The relay forwards messages of up to 4 MiB each (larger ones are split); one buffered response may be up to 32 MiB and one request up to 64 MiB.

<!-- generated: settings:relay -->

### Cloudflare

There is no `goodvibes-daemon` command for Cloudflare. The integration is driven by eight admin API methods (also behind Settings, General, Network in the web UI). It was read from the code; a run needs a Cloudflare account and the network, so it was not run for this guide.

| Method | Route | Does |
| --- | --- | --- |
| `cloudflare.status` | `GET /api/cloudflare/status` | Whether it is on and ready, which settings and credentials are configured (booleans only), warnings, and the tunnel connector's state (`not-configured`, `not-installed`, `starting`, `connected`, `failed`, `stopped`). Changes nothing. |
| `cloudflare.token.requirements.get` | `POST /api/cloudflare/token/requirements` | The API permissions each selected component needs, and how to make the one-off bootstrap token. Reads nothing from Cloudflare. |
| `cloudflare.token.create` | `POST /api/cloudflare/token/create` | Uses a bootstrap token once (never stored) to create a narrower operational token; `storeApiToken` saves it as a `goodvibes://` secret. Creates run one at a time and are recorded in `operations.jsonl` before they are sent; the token's name ends in the create's id. A create whose answer was lost fails with `CLOUDFLARE_TOKEN_OUTCOME_UNKNOWN`; the next create revokes any token an earlier one made but never stored, and lists what it could not in `residual`. |
| `cloudflare.credentials.verify` | `POST /api/cloudflare/validate` | Checks an API token and returns its account. |
| `cloudflare.resources.list` | `POST /api/cloudflare/discover` | Lists the account's zones, subdomain and existing resources. Read-only. |
| `cloudflare.provision` | `POST /api/cloudflare/provision` | Creates or updates the selected components, answered `202` with one step per resource (`ok`, `skipped`, `warning`). Creates billable resources. |
| `cloudflare.worker.verify` | `POST /api/cloudflare/verify` | Checks the deployed Worker's health route and its proxy to this daemon. |
| `cloudflare.disable` | `POST /api/cloudflare/disable` | Switches the integration off here (`cloudflare.enabled` `false`, the batch queue back to `local`), stops the tunnel connector, and removes the Worker's daemon credential, cron trigger and workers.dev route when it can. |

The components are `workers`, `queues` (on by default), `zeroTrustTunnel`, `zeroTrustAccess`, `dns`, `kv`, `durableObjects`, `secretsStore` and `r2` (off by default). Their main use is batch work: a Worker and Queue in Cloudflare that hold jobs for the daemon.

What a tunnel gives, from the code:

- With `zeroTrustTunnel`, `provision` creates a remotely managed Cloudflare Tunnel whose ingress rule sends `daemonHostname` (a name in one of the account's zones) to `tunnelServiceUrl` (default `cloudflare.daemonBaseUrl`, for example `http://127.0.0.1:3421`), and the daemon itself runs the `cloudflared` connector with the tunnel's token. `cloudflared` must be on the daemon's `PATH`; otherwise the connector state is `not-installed`. With `dns` as well (and a `zoneId` or `zoneName`), it writes a CNAME from `daemonHostname` to `<tunnel id>.cfargotunnel.com`.
- The connector forwards from this machine, so the daemon can stay on `127.0.0.1` with `controlPlane.enabled` `false`, as with a same-machine proxy (see "TLS").
- With `zeroTrustAccess`, `provision` puts a Cloudflare Access application on `daemonHostname` whose only policy admits the GoodVibes service token it creates. That is for the Worker: a person's browser or phone is not admitted. Access with a person's sign-in (an identity policy) is not built; add one yourself in the Cloudflare dashboard if you want it. When Access was asked for and could not be applied, the hostname is not published.
- Without `zeroTrustAccess`, the tunnel publishes `daemonHostname` to the whole internet, and the daemon's tokens are the only protection.

A minimal tunnel-only request, sent with an admin credential to `POST /api/control-plane/methods/cloudflare.provision/invoke` (the invoke envelope is in "The operator HTTP API"), with placeholders:

```json
{"body":{"apiTokenRef":"goodvibes://<stored token>","accountId":"<account id>","zoneName":"example.com",
 "components":{"workers":false,"queues":false,"zeroTrustTunnel":true,"dns":true},
 "daemonHostname":"goodvibes.example.com","tunnelServiceUrl":"http://127.0.0.1:3421"}}
```

Then check `cloudflare.status` until `tunnelConnector.state` is `connected`, set `web.publicBaseUrl` to `https://goodvibes.example.com`, and pair devices as for a reverse proxy. The `cloudflare.*` settings are listed under "Settings" in the reference.

### Remote nodes (peer API)

A remote node is another program (a runner on another machine, or a device app) that pairs with the daemon as a peer, then pulls work from it. It uses the peer API under `/api/remote`:

| Endpoint | Route | Credential |
| --- | --- | --- |
| `pair.request` | `POST /api/remote/pair/request` with `peerKind` (`node` or `device`), `label`, and optional `capabilities`, `commands`, `platform`, `deviceFamily`, `version`, `clientMode`, `requestedId`, `ttlMs`, `metadata` | none |
| `pair.verify` | `POST /api/remote/pair/verify` with `requestId`, `challenge` | none |
| `peer.heartbeat` | `POST /api/remote/heartbeat` | peer token |
| `work.pull` | `POST /api/remote/work/pull` with optional `maxItems`, `leaseMs` | peer token |
| `work.complete` | `POST /api/remote/work/{workId}/complete` with `status`, `result` or `error` | peer token |

Pairing a remote node:

1. The node calls `pair.request` and receives a `request` and a `challenge`.
2. The owner approves it: `POST /api/remote/pair/requests/{requestId}/approve` (admin), or rejects it with `.../reject`. `GET /api/remote/pair/requests` lists pending requests.
3. The node polls `pair.verify`. It answers `404` while the request is pending, then returns `peer` and a scoped peer `token` (scopes `remote:heartbeat`, `remote:pull`, `remote:complete`). A rejected, expired or already-verified request answers `410` `REMOTE_PAIR_REQUEST_SETTLED`; the node must request again.
4. The node sends `peer.heartbeat` about every 30 seconds and `work.pull` about every 2 seconds.

A peer token is on the authority record: a peer paired with one machine of a group is accepted by every machine (the first call to another machine takes the peer in there), and a token rotated or revoked on any machine is refused on all of them.

One address may make 10 `pair.request` calls per minute; past that the daemon answers `429` `RATE_LIMITED` with `Retry-After: 60`. The owner manages peers with `remote.peers.list`, `remote.peers.get`, `remote.peers.disconnect`, `remote.peers.token.rotate`, `remote.peers.token.revoke`, `remote.peers.invoke`, `remote.work.list`, `remote.work.cancel` and `remote.snapshot` (`GET /api/remote`). `goodvibes remote` in the terminal app prints the posture. `remote.peers.token.rotate` takes an optional `scopes` list: left out, the new token holds every published peer scope; `scopes: []` is refused with `400` (`a peer token needs at least one scope; omit scopes for the published set`). A peer heartbeat without `capabilities` or `commands` keeps the stored lists; one with `[]` clears them.

## Clusters

### What a cluster does and does not do

A cluster is several daemons on one local network, all belonging to the owner, configured with the same channels. Together they make sure each inbound surface is read by exactly one of them, and they move a surface to another machine when its holder stops.

The surfaces that are shared this way are the inbound readers: Telegram polling, ntfy subscriptions, Slack and Discord socket connections, and the email and other inbox pollers. Each surface has its own election, so different surfaces can be held by different machines.

Four pieces of work that would otherwise happen once per machine are roles, elected the same way: purchases (the `payments` role), the scheduled check-in (`checkin`), the occasion reminders (`occasions`) and the group's schedules, reminders and url watchers (`automation`). Exactly one machine holds each at a time; `cluster status` lists a role this machine holds among its surfaces, as `elected for the payments role` (and so on). Everything else runs on every node independently, whoever holds a surface: outbound sends, sessions, hosted sessions, the control plane and the HTTP API, filesystem watchers and watchers a component registers, triggers, the knowledge and memory stores.

Clustering is off by default (`cluster.enabled` `false`). Switching it on asserts that every GoodVibes daemon on this network is yours. A group (made with `cluster create` and `cluster join`) is what stops a stranger's daemon on a shared network from taking part: every coordination message is signed with the group key, and a message from outside the group is dropped.

### What is and is not synchronised between nodes

Every piece of state is in exactly one of these classes:

- **Replicated**: every member holds the same copy; a change on any member reaches all of them.
- **Per node**: each daemon keeps its own; nothing crosses between nodes.
- **Elected owner only**: every node can do it, but for each inbound surface or role exactly one node, the elected holder, does it at a time.

Device tokens, sign-in users, the day's payment spend, the group's schedules and url watchers, and what was answered for each occasion live on the **authority record** (`<home>/.goodvibes/tui/control-plane/authority-record.json`, mode 0600), one per daemon home and shared by every process of it. In a group it is carried between members in messages signed with each machine's own identity key, which never rotates, so a member behind on group keys still takes it; password hashes travel sealed to each member. A revocation is a permanent entry, never a deletion, so a machine that was away cannot bring a revoked credential back. A revoked or removed entry is kept for `cluster.revocationRetentionMinutes` (default 43200, 30 days; at least four gossip rounds, `4 × cluster.rosterGossipSeconds` counted as at least 30 s, rounded up to minutes, and a lower value of either setting is refused naming the minimum) and then dropped; a machine that dropped one keeps treating it as revoked, whatever copy of it a store on that machine still holds. A machine that has not held the group's record for longer than that window (it was off or cut off), or has never synced with the group it is in, sends nothing of its own and answers no request for its record until it has taken a member's whole record as the truth: what that record no longer holds is dropped on it and never issued again, unless that machine made it after it last synced; its schedules and url watchers are not armed meanwhile. `cluster status` on it then says `on returning after longer than cluster.revocationRetentionMinutes, N entries the group had removed were dropped here, not brought back` with the entries. When every member was away that long, the one with the newest record answers and the others merge it without dropping anything. A change goes out at once and again on each housekeeping pass until every member has it; the roster gossip carries each member's record head, and a member whose record differs asks for the newer one. `authority.status` (`GET /api/authority/status`, admin, `read:config`) returns `revision`, `digest`, `revocationFloor`, live and revoked counts per kind, and `behind` / `behindOn` (members whose record differs). `cluster status` shows the same head as `authority: revision N, digest …, the same on every member heard`. A record file that exists and cannot be read authenticates no device token from it until it can. Every change is announced on the runtime bus as `AUTHORITY_CHANGED` (`security` domain; kinds and ids only, never a value).

| State | Class | Detail |
| --- | --- | --- |
| Member list (roster), group name, removals, key generations (who minted each, why, a commitment to its key, the signing public key and join verifier in force) | Replicated | Entries of the authority record: sent to every member at once; a member that missed a change (a lost message, or off at the time) takes it when the gossip of record heads every `cluster.rosterGossipSeconds` (default 60, checked every 30 s) or a datagram on a newer key shows it is behind. |
| Group signing key, group keys, join key | Replicated | Kept only in each member's encrypted secret store; each new generation's keys travel sealed to every current member with its record entry. Rotated every `cluster.keyRotationHours` (default 24) and on `rotate`, `rotate --now` and `forget`. Never in settings, logs or status. |
| Settings under `surfaces.`, `conversationGate.`, `automation.`, `checkin.`, `watchers.`, `integrations.`, `atRest.`, `device.`, `payments.`, `calendar.`, `google.oauth.`, `profile.`, `occasions.`, `hostedSessions.`, and the key `daemon.timezone` (daemon-owned settings only) | Replicated | A change written on any member, by `config set` or by hand, reaches every member; in testing a `config set atRest.retentionMaxTotalMb 600` on one node was read back on another within 15 seconds. Exceptions below. |
| Credentials those replicated settings name (a channel's bot token, a calendar OAuth credential, mailbox credentials under `surfaces.`) | Replicated | Sealed to each receiving member's key for the trip, then stored in the receiver's own encrypted secret store. |
| `controlPlane.*`, `httpListener.*`, `web.*`, `relay.*`, `cluster.*`, `voice.local.*`, `cloudflare.*`, `push.*`, `judgment.*`, `danger.httpListener`, `profile.path`, `email.passwordRef`, `email.smtpPasswordRef`, `hostedSessions.maxSessions`, every listening port | Per node | These describe one machine. |
| `storage.secretProviders.*` (8 keys: the 1Password, Bitwarden and Bitwarden Secrets Manager command paths and their environment and config settings), `network.privateDeliveryHosts`, `worktree.setup.commands`, `worktree.setup.carryOverGlobs` | Per node | Daemon-owned keys with no replication ruling; a key nobody has ruled on stays on its own machine. Set them on each node. |
| Every other secret in the secret store (provider API keys, the decision model key, anything not named by a replicated setting) | Per node | Only a secret a replicated setting names can be selected for replication. |
| Settings that are not daemon-owned (the terminal app's and Agent's own preferences, including the provider and model choice) | Per node | Never considered for replication. |
| Inbound channel intake: Telegram polling, ntfy subscriptions, Slack and Discord socket connections, inbound mail and the inbox pollers | Elected owner only | One election per surface. A node competes only for surfaces it is configured to serve. |
| Channel webhooks (`/webhook/...`) | Per node | Each node answers the webhooks sent to its own address. |
| Outbound sends (`goodvibes-daemon send`, replies, notifications) | Per node | Any node can send. |
| Purchases (payments) | Elected owner only | The machine holding the `payments` role buys; `payments.budget.status` reports `isPaymentsLeader` `true` there and `false` elsewhere. A purchase begun on another machine is refused with code `disabled`, naming the holder: `Refused: in this group of machines purchases run on one machine at a time, and that is <name>. Ask there (its terminal app, web UI or channels); it buys with its own card, address and daily budget.` While an election is under way it says the group is choosing one. A machine that takes the role (the holder stopped or crashed) first recovers any checkout a previous holding of the role left interrupted on it. Payment settings replicate; cards are kept per node, so add the card on each machine that may hold the role. |
| Payment spend ledger and daily budgets used | Replicated (the day's totals) | Each machine keeps its own ledger and writes its spend per day into the authority record (one counter per machine, only ever raised). The machine holding the `payments` role counts what every machine spent that day, so when the role moves mid-day the group still has one daily budget. Holds for purchases in flight stay on the machine that made them. |
| Schedules, reminders and automation jobs (`automation-jobs.json`) | Replicated (authority record); elected owner runs them | A job created, changed, disabled or removed on any machine is the same on every machine and is listed on all of them; it runs once in the group, on the machine holding the `automation` role, the only machine that arms its timer. That machine writes each occurrence onto the record before starting it, so when the role moves (the holder stopped or crashed) the new holder neither runs that occurrence again nor skips the next: an occurrence that fell due while no machine held the role runs at once on the new holder, or is recorded as missed once it is older than `automation.catchUpWindowMinutes`. A removal is permanent: a machine that was asleep or off through it drops the job when it returns instead of bringing it back. A job asked to run now runs where it was asked. The scheduled check-in job is not shared (see check-ins below). Jobs a machine had before it joined are added to the group's. |
| Automation runs and routes (`automation-runs.json`, routes) | Per node | A run is listed on the machine that ran it; the job's last run time and counts travel with the job. |
| Watchers (`watchers.json`) | Replicated for url watchers (authority record); elected owner polls them | A webhook or polling watcher created through `watchers.create` on any machine is listed on every machine and polled only by the machine holding the `automation` role, which writes each run's start onto the record; a new holder runs it one interval after the last run any machine started. Starting, stopping, changing or removing one on any machine applies on all of them. Filesystem watchers (they look at that machine's own disk) and watchers a component registers (CI watch, the daemon's own pollers) stay per node. The `watchers.*` settings replicate. |
| Check-ins and occasion reminders | Elected owner only | Their settings replicate, so every machine holds the check-in schedule and the reminder sweep; only the holder of the `checkin` role runs a scheduled check-in (elsewhere its run is recorded as `skipped`, `Another machine in this group runs the scheduled check-in.`), and only the holder of the `occasions` role sweeps for reminders. A check-in asked for by hand runs where it was asked. What is recorded against an occasion (`occasions-state.json`: answers, gift history, raised reminders, interviews, calendar mirrors) is on the authority record, one entry per occasion, so an occasion answered on one machine is not asked again by the machine holding the `occasions` role, whichever it is; when two machines change one occasion at the same moment both changes are kept, the later of each record winning. The occasions themselves are lines of each machine's owner profile, which stays per node. |
| Sessions, hosted sessions, transcripts, queued inputs | Per node | A client sees the sessions of the daemon it connects to. |
| Approvals (`approvals.jsonl`) | Owned by the node that raised them; read and decided from every member | Each approval belongs to the node it was raised on, which alone decides it. Every member lists the others' approvals (id `<id>@<node>`, from summaries each node sends when an approval changes; never the request's arguments), and an approve, deny, claim or cancel on another node's approval is relayed to that node, signed with this machine's identity key, and applied there once, as decided by `<person>@<this node>`. No answer within 5 seconds is reported as unknown (`NODE_UNREACHABLE`), never as failed or done. A removed member's approvals are dropped and its relayed decisions refused. |
| Owner questions and the rest of the owner inbox (`owner-inbox.sqlite`) | Per node | A question raised on one node is answered on that node. |
| Tasks, agents, contracts, the fleet | Per node | |
| Memory (`memory.sqlite`), knowledge stores, checkpoints | Per node | |
| Device tokens and their revocations | Replicated (authority record) | A device paired on any machine works on every machine of the group; revoking it on any machine (`pairing.tokens.delete`) refuses it on all of them, survives restarts, and is taken by a machine that was asleep or off as soon as it hears the group (it asks every member for its record when it starts or is re-keyed). Revoking a device revokes what it minted. Unused pairing offers stay on the machine that made them until first use. |
| Sign-in users (`auth-users.json`), their passwords, roles, scopes and deletion | Replicated (authority record) | A user added on any machine (API or `goodvibes auth add-user`) signs in on every machine. A password change or a deletion on any machine ends that user's sign-ins on all of them. A user the group never changed (such as each machine's own setup `admin`) stays that machine's own; once changed on one machine, that user is the group's. Sign-in sessions themselves stay on the machine that issued them. |
| Device capability grants ("always allow") and their revocations | Replicated (authority record) | A grant given on any machine is in force on every machine of the group; revoking it on any machine (`devices.grants.revoke`) refuses it on all of them, survives restarts, and is taken by a machine that was asleep or off when it returns. A request still waiting for the phone under a grant that is then revoked is withdrawn and answers `grant-revoked-before-claim`; one the phone had already picked up answers `grant-revoked-after-claim`, saying what took effect (a capture is kept under the capture retention and not returned). Last-used times and the grants ledger stay per node (`devices/device-grants.json`). |
| Remote-node peer tokens (`remote.peers.*`) | Replicated (authority record) | A peer (a remote node or a phone's device node) paired on one machine is accepted on every machine; the first time it calls another machine, that machine takes the peer in. A token rotated or revoked on any machine is refused on all of them. Presence, queued work and the peer audit stay per node. |
| Push subscriptions (`push.subscriptions.*`) | Replicated (authority record) | A browser registered for notifications through one machine receives every machine's pushes; turning it off on any machine, or a push service proving it dead, stops every machine pushing to it. Its endpoint and keys are sealed to each machine for the trip. Delivery outcomes stay per node. |
| Step-up passkeys (`stepup.credentials.*`) | Replicated (authority record) | A passkey registered through one machine confirms relayed actions on every machine; one removed on any machine (a lost phone) confirms nothing anywhere. Each machine keeps its own signature counter and refuses a counter that goes backwards from what it saw. |
| Relay codes (`relay.codes.*`) | Per node, on the authority record | A relay code is good only for the daemon that issued it (the rendezvous is that daemon's). A code issued to a paired device is revoked with that device, on any machine of the group. |
| Operator token | Per node | Each machine keeps its own. |
| Owner profile document | Per node | Only the `profile.*` policy settings replicate (not `profile.path`). |

A machine that joins brings its own device tokens, users, grants, peers, push subscriptions and passkeys into the group's record; nothing is removed. A username that exists on both sides as separate accounts is not overwritten: each machine keeps its own account, changes to it stay on that machine, and `authority.status` (`userConflicts`) and `cluster status` (a line `user "<name>" exists as separate accounts made on different machines`) report it. The owner keeps one: `cluster publish user:<name> --yes`, run on the machine whose account the group should keep, revokes every other account of that name; `cluster accept user:<name> --yes` gives up this machine's account for the other one. Afterwards every machine signs the name in with the kept account's password, the conflict line is gone everywhere, and sign-ins of the account given up end.

A joining machine takes the group's copy of the replicated settings. When a machine's own value of a replicated setting differs from the group's in a way the group did not cause, it is kept, a warning is logged (`this machine's value for a shared setting differs from the group's and was kept`), and `cluster status --json` lists it under `replication.localDifferences`. `cluster publish <setting> --yes` sends this machine's value to the group; `cluster accept <setting> --yes` takes the group's value here (it prints `this machine now runs the group's value of <setting>`). Both refuse a setting that is not replicated or that holds a credential: `<setting> is not a shared setting this command publishes` or `... can take from the group`. A change made on a machine before it holds the group's settings is held and sent once it has them (`publish` then answers `held`).

### What each node must be able to reach

- Every node must receive the others' UDP datagrams on `cluster.port` (default `61860`), either through the IPv4 multicast group `cluster.multicastGroup` (default `239.255.71.86`, sent with a TTL of 1 so it never leaves the local network) or directly.
- On a network that drops multicast (many corporate Wi-Fi networks, some VPNs), list the other nodes in `cluster.peers` as `host` or `host:port`. Messages then go to every listed host as well as to the multicast group; the peer list is added to multicast, it does not replace it. A machine joins the multicast group on `127.0.0.1` and on every non-internal IPv4 interface it has. IPv6 peers are not supported; they are dropped with a warning.
- Every node must use the same `cluster.port` and `cluster.multicastGroup`. Several daemons on one machine can share the port: the socket is opened with address reuse, and multicast loopback is on, so daemons on the same host find each other through `127.0.0.1` exactly as machines on a network do.
- The firewall must allow UDP `61860` in and out between the nodes.
- Each node must itself be configured to serve a surface (hold its credential) to take part in that surface's election. Shared settings normally take care of this.
- Nodes do not need to reach each other's control plane.

### Creating a group

On the first machine:

1. Switch clustering on and restart:

   ```sh
   goodvibes-daemon config set cluster.enabled true
   goodvibes-daemon config set cluster.nodeName desktop
   goodvibes-daemon restart-service
   ```

2. Create the group:

   ```sh
   goodvibes-daemon cluster create --name "home"
   ```

   With `--json`:

   ```json
   {
     "ok": true,
     "data": {
       "groupId": "g7BXD4Z810PV93J4J",
       "groupName": "home",
       "joinKey": "gvj1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
       "generatedKey": true
     }
   }
   ```

   `--passphrase <phrase>` uses a phrase you choose as the join key instead of a generated one; it must be at least 12 characters (`that join phrase is too short to be worth having`). A machine already in a group is refused with `this machine is already in a group`.

The group name is advertised on the local network in clear text, so choose one you do not mind others seeing. `cluster create` does not check `cluster.enabled`; a group created while it is off is saved but nothing is sent until clustering is on and the daemon restarted.

### Adding a machine (join)

On the machine to add:

1. Switch clustering on and restart, as in step 1 above (with its own `cluster.nodeName`).
2. Get the join key on any machine already in the group:

   ```sh
   goodvibes-daemon cluster key
   goodvibes-daemon cluster key --qr
   ```

   It can be shown any number of times, from any member. It prints:

   ```text
   join key for "home"  [gG9JJ1P6CHMSME4AK]

     gvj1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX

   (not a terminal, so no clipboard copy was attempted)

   to add a machine: run  cluster join --group gG9JJ1P6CHMSME4AK --key <the key above>
   ```

   On an interactive terminal it tries to copy the key to the clipboard instead of printing the note. On a machine in no group it answers `this machine is not in a group, so it has no join key to show` and exits `1`.
3. Join, either interactively or in one line:

   ```sh
   # Interactive: lists the groups advertising on this network, asks which, then asks for the key without echoing it.
   goodvibes-daemon cluster join

   # Scriptable:
   goodvibes-daemon cluster join --group g7BXD4Z810PV93J4J --key gvj1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
   ```

   In the interactive form, the group can be named by its full id, a unique prefix of the id, or its name. A blank answer cancels (exit `130`).
4. The joined machine asks for the group's shared settings at once. Check with `goodvibes-daemon cluster status` and `goodvibes-daemon cluster nodes`.

Join failures:

| Message | Cause | Next step |
| --- | --- | --- |
| `sharing inbound work with your other machines is switched off on this machine` | `cluster.enabled` is `false`. | `config set cluster.enabled true`, restart. |
| `this machine is already in a group` | The machine is in a different group. (Joining the group it already belongs to, with that group's current key, is allowed: that is how a machine is put back.) | `cluster leave` first. |
| `a machine in that group answered and the join key did not match` | A member was reached and refused the key: a mistyped key, or a key that was replaced (by `rotate --now` or `forget`). Exit `1`. | Get the current key with `cluster key` on a member and join again. |
| `no machine in that group accepted the join key, either the join key is wrong, or no machine in that group is reachable on this network` | Nothing answered within 15 seconds. | Check that a member is running, that both machines are on the same network and UDP 61860 is open, and set `cluster.peers` if multicast is dropped; then check the key. |
| `a group and a join key are both needed, and this is not an interactive terminal` | Script without `--group` and `--key`. | Pass both. |
| `no goodvibes groups are advertising themselves on this network` | Nothing heard. | Check the other machine is on with clustering enabled, or join by id. |

`cluster groups` lists the groups advertising on this network that this machine is not in. A machine advertises every `cluster.beaconSeconds` (default 15); the advertisement carries the group id, name, member count and version only.

```text
$ goodvibes-daemon cluster groups
GROUP       ID                  MACHINES  VERSION  SEEN
home        gG9JJ1P6CHMSME4AK   1         3.3.1    8s ago
```

With nothing heard it prints `no goodvibes groups are advertising themselves on this network`, with advice to check multicast or join by id, and exits `0`.

Successful joins print:

```text
$ goodvibes-daemon cluster join --group gG9JJ1P6CHMSME4AK --key gvj1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
joined "home"  [gG9JJ1P6CHMSME4AK]
the group now has 2 machines.
```

With `--json`: `{"ok":true,"data":{"groupId":"gG9JJ1P6CHMSME4AK","groupName":"home","memberCount":3}}` (and a `warning` field when the first request for the group's settings did not go out; the machine asks again by itself).

### Listing members and status

```sh
goodvibes-daemon cluster status
goodvibes-daemon cluster nodes
goodvibes-daemon cluster status --json
```

`status` reports the membership (`no-group`, `member` or `unreadable-key-material`), the group, this node's id and name, which surfaces this machine holds and why, the key generations, the shared-settings state (counts and provenance, never values), the election timing in force, datagram counters (sent, received, dropped for another group, bad signature, malformed, old key generation, no group) and one line of advice when there is something to do. Example on a machine with clustering off:

```text
this machine is not in a group
machine: machine 9b16a341 (9b16a341-3555-4d53-b094-4d32f8937dc8)
version: 3.3.1

sharing inbound work with your other machines is switched off here, turn it on with `config set cluster.enabled true`
```

A member's `status`:

```text
group:    home  [gG9JJ1P6CHMSME4AK]
machine:  bravo (86462aea-850a-4eea-a537-0b0e1e549cf9)
members:  3
version:  3.3.1
surfaces: none held by this machine right now

group key: generation 0, rotates every 24h
           1 of at most 16 generations kept; accepting 0

shared settings: 255 settings and 0 credentials at revision 255
                 last change from c5e16a0c-32e4-4f25-b027-18e7de00da97 6s ago

election:  heartbeat 30s, master timeout 90s, boot probe 3s
traffic:   10 sent, 28 received; dropped 8 from other groups, 0 unverified, 0 on an old key, 0 malformed
```

`nodes` lists each member with its name, node id and when it was last heard, then removed machines with when and why:

```text
$ goodvibes-daemon cluster nodes
group: home  [gDNW3P625APR8TAVY]

MACHINE       NODE ID                                 LAST SEEN
bravo         5a519427-dd79-41ad-959c-5819e85bc592    4s ago
alpha         f2fe41dd-f99c-478e-8192-4708c3d94062    0s ago  (this machine)

removed from this group:
  c90d75fb-9008-4c67-ad19-5a424f2b37a0  1s ago  (removed by the operator)
```

A machine's name is `cluster.nodeName`, or `machine` and the first 8 characters of its node id; the hostname is never used. `goodvibes-daemon status` shows the node's place in one line, for example `cluster:  standby in "the workshop" of 3`, or `cluster:  in no group yet, \`goodvibes-daemon cluster create\` starts one`.

### Leaving a group

On the machine that leaves:

```sh
goodvibes-daemon cluster leave --yes
```

```text
left "the workshop" [gG9JJ1P6CHMSME4AK]
this machine no longer coordinates with it. The other machines still list it,
run `cluster forget` on one of them to tidy up.
```

On a machine in no group it answers `this machine is not in a group` with `there is nothing to leave` and exits `1`. Leaving deletes the group keys on this machine only. The other members keep it on their roster (its "last seen" just grows) until someone runs `cluster forget` on one of them. A machine that left can join again with the current join key, and is admitted again under its same node id.

### Removing a machine (forget)

On any other member:

```sh
goodvibes-daemon cluster nodes
goodvibes-daemon cluster forget laptop --yes
```

```text
$ goodvibes-daemon cluster forget charlie --yes
removed charlie (c90d75fb-9008-4c67-ad19-5a424f2b37a0) from the group
the group key was replaced immediately, so that machine's copy no longer works.
2 machines remain.
```

The machine is named by its full node id, its exact name, or a unique prefix of its node id (a prefix of the name does not work: `cluster forget charl` answers `no machine called 'charl' is in this group`). A name or prefix that matches several machines is refused and lists them. A machine cannot remove itself: `a machine cannot remove itself from the group` with `run \`cluster leave\` on this machine instead, or \`cluster forget\` from another machine in the group`.

The removed machine is told. A running one takes the removal with the change itself (it is signed with the sending member's identity key, which the removed machine can check) and drops the group's keys at once; one that was asleep, stopped or restarting asks the group for its record when it next hears it or starts, and a member answers with its removal. Its log says `cluster: this machine was removed from its group by another member and no longer holds its keys`, and its `cluster status` says:

```text
this machine is not in a group: another member told it the group removed it 2m ago
machine: charlie (79584424-1e8b-48d1-b084-fb381beb3016)
version: 3.3.1

this machine was removed from the group "home" [gVSTYHAVRJB7QSPEN] by another member; to put it back, run `cluster key` on a machine in that group, then `cluster join --group gVSTYHAVRJB7QSPEN --key <key>` here
```

To bring it back on purpose, run `cluster join --group <id> --key <current join key>` on it; no `cluster leave` is needed, before or after it has found out. The old join key is refused (`a machine in that group answered and the join key did not match`); the current one admits it again, under its same node id.

`forget` may follow `rotate --now` (or the other way round) at any spacing. Removing a machine is one change to the group's record that does two things at once: it revokes the machine's membership, a revocation no member that missed it can undo, and it adds a new group key generation that replaces the group key, the group signing key and the join key immediately, with no grace period. The removed machine's keys stop being accepted as each member takes the new generation. Add a machine later with the new join key from `cluster key`. If the new key cannot be saved, nothing is changed and the command says so; run `cluster forget` again.

### Rotating keys

```sh
goodvibes-daemon cluster rotate
goodvibes-daemon cluster rotate --now --yes
```

| Form | Effect |
| --- | --- |
| `rotate` | Replaces the group's internal key. The old one stays accepted for `cluster.keyRotationGraceMinutes` (default 5), so nothing is interrupted. Routine hygiene; it also happens by itself every `cluster.keyRotationHours`. |
| `rotate --now` | Stops accepting the old key at once and also replaces the group signing key and the join key. Use it when a key may have leaked. A machine asleep at the time takes the new key from the group when it wakes; a machine to be added needs the new join key. |

What they print:

```text
$ goodvibes-daemon cluster rotate
the group key is now generation 1
the previous key stays accepted for a few minutes so nothing is interrupted while
the other 2 machine(s) pick the new one up.

accepting generations 1 and 0

$ goodvibes-daemon cluster rotate --now --yes
the group key is now generation 2
the previous key stopped being accepted immediately, and the key the group signs with
was replaced too. A machine that is asleep right now takes the new key from the group when it wakes.

accepting generation 2
```

Key changes converge in any order and at any spacing (`rotate --now` then `forget` within a second, `forget` then `rotate --now`, several in a row, two members rotating at once). Each key generation is an entry of the group's record (who minted it, why, and a commitment to the key, never the key), and the key itself travels with it sealed to every current member, never to a removed one. The change is sent at once and again on each 30-second pass until every member's record covers it. A member that missed it, or several, notices on the group's next datagram (a generation it does not hold) or the next gossip of record heads, and asks a member for the record; the answer carries the newest generation, which it takes directly, however many it skipped. These requests and answers are signed with each machine's identity key, which never changes, so they work however far behind a member is. Which generations a machine accepts is worked out from the record, the same way on every machine, so a machine that joins later never reopens a key a removal closed. In testing every member, including one paused, one stopped and one restarted through the changes, showed the newest generation and the same record by the next status read after it was running again. A removal or `rotate --now` hands the new group signing key and join key to every remaining member the same way.

The join key is never rotated by the schedule; it changes only on `rotate --now` and on `forget`. Run `cluster key` afterwards to see the new one. A machine that was off through several rotations catches up by itself when it starts, as long as the group still lists it; its log says `took authority record changes from the group` and `adopted a replacement group key`.

### Renaming a group

```sh
goodvibes-daemon cluster rename "the workshop"
```

```text
the group is now called "the workshop"
this name is visible to anything on this network, and every machine in the
group will pick it up shortly.
```

The name is an entry of the group's record, so it is sent to every member at once (a member that missed it takes it with the next gossip of record heads), and it is advertised on the network.

### Confirmation

`leave`, `forget`, `rotate --now`, `publish` and `accept` cannot be undone. At an interactive terminal they ask `<what it does>. Type yes to continue:`. In a script, with `--json`, or from a slash command they must be given `--yes` (`-y`); otherwise they fail with code `not-confirmed`, exit `1` and change nothing:

```text
$ goodvibes-daemon cluster forget charlie
cluster: cluster forget was not run: this removes charlie from the group and replaces the group key immediately, and it was not confirmed
  nothing was changed. Run it again with --yes to confirm: cluster forget charlie --yes
```

### A complete run on one machine

These commands were run on three daemons on one machine, inside a network namespace with only a loopback interface, each daemon with its own `GOODVIBES_HOME`, working directory and control-plane port (39431, 39432, 39433), sharing UDP port 61860 over loopback multicast. Replace `--port` with your daemons' ports, or leave it out on separate machines. Each machine had `cluster.enabled` `true` and its own `cluster.nodeName` (alpha, bravo, charlie) before it started.

```sh
goodvibes-daemon cluster create --name home --json --port 39431                    # on alpha
goodvibes-daemon cluster key --port 39431                                          # on alpha
goodvibes-daemon cluster groups --port 39432                                       # on bravo: lists "home"
goodvibes-daemon cluster join --group <id> --key <join key> --port 39432           # on bravo: joined, 2 machines
goodvibes-daemon cluster join --group <id> --key <join key> --port 39433           # on charlie: joined, 3 machines
goodvibes-daemon cluster nodes --port 39431                                        # alpha, bravo, charlie
goodvibes-daemon cluster rename "the workshop" --port 39431
goodvibes-daemon cluster rotate --port 39431                                       # generation 1, old key still accepted
goodvibes-daemon cluster rotate --now --yes --port 39431                           # generation 2, new join key
goodvibes-daemon cluster status --port 39432                                       # repeat on every member until each shows "generation 2"
goodvibes-daemon cluster key --port 39431                                          # the new join key
goodvibes-daemon cluster forget charlie --yes --port 39431                         # removed; group key and join key replaced again
goodvibes-daemon cluster leave --yes --port 39432                                  # bravo leaves
goodvibes-daemon cluster join --group <id> --key <current join key> --port 39432   # bravo is admitted again
```

The outputs are the ones shown in the sections above. A wrong key (`gvj1-AAAA-...`) was refused at once with `a machine in that group answered and the join key did not match`.

### Election

Each surface has its own election. When several nodes can serve a surface, the winner is decided the same way on every node:

1. the newest daemon version wins;
2. then the node holding the fewest surfaces wins, which spreads surfaces across machines;
3. then a fixed hash of the node id and the surface id.

The holder sends a heartbeat every `cluster.heartbeatSeconds` (default 5). A node shut down normally hands its surfaces over at once. A node that crashes is noticed only by its silence: it is replaced after `cluster.masterTimeoutSeconds` (default 15, three missed heartbeats; never less than two heartbeats) plus a short election, about 20 seconds in all. A crashed node that is restarted takes its surfaces back after its boot probe. A starting node listens for `cluster.bootProbeSeconds` (default 3) before claiming a surface. A cluster holds at most 64 members.

### Clustering without a group

With `cluster.enabled` `true` and no group, a machine listens (so `cluster join` can list groups) but sends nothing and gates nothing. `cluster.secret` is for machines that coordinate without a group: when it is set, their messages are signed with it and unsigned messages are ignored. When it names a stored secret that cannot be read (deleted, or the secret store cannot be opened), the machine sends and takes no coordination messages at all rather than run unsigned; its `/status` cluster section reports `electionAuthentication: "unavailable"`, `cluster status --json` the same, and the daemon log says `cluster.secret names a stored secret that could not be read`. Store the phrase again (`secrets set`) or clear `cluster.secret`, then restart. Inside a group it is not used.

### Diagnosing a node that is behind or unreachable

The product has no single "behind" or "unreachable" state for a node. These are the signs it does report, what each means, and where to read it:

| Sign | Meaning | Where |
| --- | --- | --- |
| `could not reach <where>` (code `unreachable`) | The node's control plane did not answer the command: the daemon is stopped, or its HTTP port is not reachable from where you ran the command. This says nothing about the cluster. | Any `goodvibes-daemon` command with `--host`. |
| `LAST SEEN` growing on the other members, or `not heard since this daemon started (...)` | The other members hear no cluster traffic from this node: it is stopped, it lost the network, UDP 61860 or multicast is blocked between them, or it no longer holds a key they accept. | `cluster nodes` on a healthy member. |
| `group key: generation N` lower on this node than on the others | Behind on keys: it missed a rotation. Its datagrams are dropped by the others as "on an old key". | `cluster status` on each node. |
| `... on an old key` climbing in the `traffic:` line | This node is receiving datagrams signed with keys it does not accept (if it is the one behind), or is receiving them from a node that is behind. | `cluster status`. |
| `0 received` or a `received` count that does not move | Nothing arrives: multicast is dropped or UDP 61860 is blocked. | `cluster status`. |
| `shared settings: ... at revision N` lower than elsewhere, or `differs from another machine or is still catching up; settings are being exchanged`, `... change(s) from the group not applied here yet`, `... credential(s) known to the group have not arrived here yet` | Behind on shared settings. It catches up by itself (retried every 30 seconds, credentials every minute) as long as it can hear the group. | `cluster status`. |
| `version:` older than the other nodes | Behind on the program version. It still works; the newest version wins each election. | `cluster status`, `goodvibes-daemon status`. |
| `membership: unreadable-key-material` (`--json`) with advice `group membership storage could not be confirmed ...` | The node cannot read its group keys from the encrypted secret store (for example `secrets.key` missing or changed). It retries every 30 seconds; a restart retries at once. | `cluster status`. |

A procedure, run in this order:

1. On the suspect node: `goodvibes-daemon status`. Exit `1` with `could not reach the daemon on this machine` means the daemon is down: `goodvibes-daemon service-status`, then `start-service`.
2. On a healthy member: `goodvibes-daemon cluster nodes`. Note the suspect's `LAST SEEN`.
3. On every node: `goodvibes-daemon cluster status`. Compare `group key: generation`, `version`, the `shared settings` revision, and the `traffic:` line.
4. If the suspect's `received` count does not grow: check that UDP 61860 is allowed in and out on both machines, that every node has the same `cluster.port` and `cluster.multicastGroup`, and that multicast crosses the network; if it does not, set `cluster.peers` on every node (`goodvibes-daemon config set cluster.peers '["10.0.0.2","10.0.0.3"]'`) and restart them.
5. If the suspect's key generation is lower than the others' while its `received` count grows, it catches up by itself within about a minute of hearing the group. If it stays lower, its `cluster status` will say whether the group removed it; to put it back, `cluster join --group <id> --key <current join key>` on it (no `leave` needed).
6. Read its log for `cluster:` lines: `grep "cluster:" <working dir>/.goodvibes/logs/activity.md | tail -30`. `took authority record changes from the group` followed by `adopted a replacement group key` is a member catching up; `this machine was removed from its group by another member` means it was removed; `dropped a reply to this machine's return that it could not authenticate` means a machine whose own record no longer lists it could not be re-keyed.

### Which node holds a channel

`cluster status` lists only the surfaces this machine holds (`surfaces held by this machine:` with lines such as `cecb9f3b947e049ad6e5b13dd53118f9: elected for ntfy (ntfy:cecb9f3b)`). The full picture, from any node, is in its status document:

```sh
goodvibes-daemon status --json | python3 -c "import json,sys;c=json.load(sys.stdin)['data']['identity']['cluster'];print(json.dumps(c['surfaces'],indent=1));print(json.dumps([{k:p[k] for k in ('nodeId','version','holds')} for p in c['peers']],indent=1))"
```

Each entry of `surfaces` is one inbound surface this node can serve: `label` (`ntfy:cecb9f3b`, a digest, never the topic or bot name), `kind`, this node's `role` for it (`master` when it holds it, `standby`, `probing`, `electing`, `awaiting-handoff`, `resigning`, `fenced`, `stopped`), `holderNodeId` (the node this one believes holds it), and `consuming`. `peers` lists the other nodes with their `version` and the surface digests each `holds`. Match `holderNodeId` against `cluster nodes` to get the machine's name.

A surface cannot be moved by command. To move one, stop its holder (`goodvibes-daemon stop-service` on that machine): a clean stop hands it over at once; a crash is noticed after `cluster.masterTimeoutSeconds`. A `fenced` role means the consumer did not stop when told to; only a restart of that daemon clears it. Such a surface carries `drainFailure`, the reason its consumer did not stop, and stays listed as `fenced` (never `stopped`) after the cluster is stopped, whose stop then fails naming it.

### Cluster failure codes

With `--json`, every failure is `{ "ok": false, "code": "<code>", "error": "...", "fix": "..." }` and exit code `1`. The codes: `usage`, `not-confirmed`, `not-interactive`, `no-group-found`, `invalid-port`, `invalid-host`, `token-missing`, `unreachable`, `auth-refused`, `route-missing`, `unreadable-reply`, `refused` (the daemon's own refusal; its `error` and `fix` are passed through). Over HTTP the routes are `GET /api/cluster/status|key|nodes|groups` and `POST /api/cluster/create|join|forget|rotate|leave|rename|publish|accept`, all admin; a refusal is HTTP `409` with `{ "ok": false, "error", "fix" }`.

### Cluster settings

Changes to `cluster.enabled`, `cluster.peers` and `cluster.secret` need a daemon restart; the daemon's own refusal messages say so. The settings marked "Applies after the daemon restarts" in their description also need one.

<!-- generated: settings:cluster -->

## Hosted sessions

A hosted session is a full conversation loop (the same orchestrator, tools and permission gate a terminal runs) composed inside the daemon for one workspace folder. It keeps working when the client that started it closes, and any client can attach to it later.

Ways to create one:

- the web UI (Work, new session);
- Agent with `hostedSessions.routeConversationTurns` `true` (its turns run in the daemon);
- inbound channel conversations with `hostedSessions.promoteInboundConversations` `true`;
- the API method `sessions.hosted.create` (see "Starting a hosted session and sending a turn" in the next part).

The workspace must be the daemon's working directory or a registered workspace, or a folder inside one (`sessions.hosted.workspaces` lists them; `workspaces.registrations.add` adds one). The home directory and the filesystem root cannot be registered.

What happens when clients leave is the detach policy:

| Policy | When the last client detaches |
| --- | --- |
| `kill` (default) | The session ends with reason `detached`. |
| `survive` | The session stays alive and idle, and can be attached again from any client. |

`hostedSessions.detachPolicy` sets the default; `detachPolicy` on `sessions.hosted.create` overrides it for one session. An attachment is a lease of `hostedSessions.attachmentTtlMs` (default 10 minutes); a client whose control-plane connection is open renews it automatically, and attaching again renews it. A crashed client's lease lapses, and the session then counts as detached.

At most `hostedSessions.maxSessions` (default 8) sessions are live at once; another create is refused with the count and the setting named. Ended sessions are kept, listable with their reason and with their transcript readable through `sessions.hosted.history` (by the credential that created them, one an owner shared them with through `sessions.hosted.share`, or an admin one), for `hostedSessions.terminatedRetentionMs` (default 24 hours), also across a daemon restart. Each session's newest `hostedSessions.maxMessagesPerSession` messages (default 500) are saved to disk; after a daemon restart, attaching rebuilds the loop and adds a line to the transcript saying the turn that was running did not survive.

End a session with `goodvibes-daemon sessions kill <id>` or `sessions.hosted.kill`.

<!-- generated: settings:hostedSessions -->

## Fleet

The fleet is every agent and process the daemon is responsible for: spawned agents, Agent Client Protocol agents it hosts, contract units, workflows, triggers, schedules, watchers and background processes. `fleet.maxSize` (default 8) is the ceiling on agents this daemon runs at once; agents launched outside GoodVibes and only observed do not count.

The web UI shows the fleet in Work, grouped by the work board (the reading in `@goodvibes/engine/contracts` `readWorkBoard`, the same one the terminal's "Your agents" panel reads): Waiting for you (every open ask: approvals and the owner inbox's questions, purchase windows, claims, held actions and reports, each in the words of its presentation), Running now (only nodes that serve you in a working state, running tasks and hosted turns), Scheduled (idle or paused schedules, triggers, watchers and CI watches) and Finished (the ten newest). "Open sessions between turns" lists the newest 50 sessions; "Show older sessions" reads further back with `sessions.search` until every one is listed. A node's `serves` field decides whether it is yours or the platform's own: a `system` node (heartbeats, pollers, the code index) is counted in the line "Background services: N healthy" and listed only while stalled or failed. The header chip, the sidebar badge and the account menu read the board's counts. An approval for a chat also shows inline in that chat, with its choices. The API methods (all through the invoke route; see the next part) are:

| Method | Does |
| --- | --- |
| `fleet.snapshot` | Every live and finished process as a flat list linked by `parentId`, at most 2000 nodes. Each node carries `serves`: `system` for the platform's own upkeep (the runtime and daemon heartbeats, the CI watch poller, the code index), `you` for everything else; an agent node carries `progress` (`filesRead`, `filesChanged`, counted from its settled read, write and edit calls) and, while a call runs, its activity in the tool's words (`Writing docs/usage.md`); a schedule, trigger or watcher node carries `schedule` (its `cadence`, `lastRunAt`, `lastOutcome`; for a trigger `firedCount`, `lastFiredAt`, `since`). An agent's label is its archetype's display name (`Helper agent` for `general`). |
| `fleet.list` | The same, filtered by kind and state, with cursor pagination. |
| `fleet.stop` (admin) | Hard-stop one node; `cascade: true` stops its descendants first. |
| `fleet.interrupt` (admin) | End an agent's current turn, or pause a trigger or schedule. |
| `fleet.resume` (admin) | Re-arm a paused trigger or schedule. |
| `fleet.archive`, `fleet.archiveFinished`, `fleet.unarchive`, `fleet.archived.list` | Move finished trees out of the live view and back. |
| `fleet.attempts.list`, `fleet.attempts.judge`, `fleet.attempts.pick` | Best-of-N attempt groups: list, ask a judge model, pick a winner (`confirm: true` to apply). |
| `fleet.conflicts.list`, `fleet.conflicts.resolve`, `fleet.conflicts.retry` | Work items whose merge conflicted. |
| `fleet.graph.get` | `GET /api/fleet/workstreams/{workstreamId}/graph`, one workstream's dependency graph. |
| `fleet.observed.steer` | Type text into an observed outside coding-agent session; the owner is asked first. |

<!-- generated: settings:fleet -->

## Encryption, retention and redaction of stored data

There is no switch that turns on encryption at rest, and none is needed for the one thing GoodVibes encrypts itself:

- **Encrypted, always:** the secret stores (`secrets.enc`, one per tier): provider API keys, channel bot tokens, OAuth credentials, the cluster group keys and every other credential put in the secret store. They are encrypted with AES-256-GCM using the 32-byte key in `~/.goodvibes/secrets.key` (mode `0600`). The key is created once and never rotated by the programs. If the key file is empty or malformed, the programs refuse to write to the stores rather than overwrite them, and the message says to restore the key from a backup. The stores and their read order are described in "Secrets" in "Permissions, decisions and safety".
- **Not encrypted:** everything else is plain files and plain SQLite databases: settings, `operator-tokens.json` (the operator token itself, protected only by mode `0600`), sign-in users (password hashes), device tokens (hashes), sessions and transcripts, hosted sessions, memory, knowledge stores, the owner inbox, the activity log and crash logs.
- **The user's own step:** to protect those at rest, use the operating system's whole-disk or home-directory encryption (LUKS on Linux, FileVault on macOS, BitLocker on Windows). GoodVibes neither sets it up nor checks for it. `secrets.key` sits beside the stores it encrypts, so the secret stores are only as safe as the disk once someone can read the user's files.

What the programs do instead for the plain files:

| Setting | Default | Effect |
| --- | --- | --- |
| `atRest.redactionEnabled` | `true` | Credential patterns (API keys, bearer tokens, GitHub, GitLab, Slack and AWS credentials) are replaced with `[REDACTED_*]` markers when the per-agent transcript journal is written. Crash reports are always redacted. Home paths are not redacted. |
| `atRest.retentionMaxAgeDays` | `30` | Transcript journals, the execution ledger, the activity log, crash logs and crash-recovery snapshots older than this are deleted at start and every six hours. Saved conversations are never deleted by it. |
| `atRest.retentionMaxTotalMb` | `512` | Each of those file sets is kept under this many megabytes, oldest first. |

These `atRest.*` settings are shared settings in a cluster.

<!-- generated: settings:atRest -->

## Backups

There is no backup command. To back up a GoodVibes installation, stop the daemon (`goodvibes-daemon stop-service`) and copy:

| Path | Why |
| --- | --- |
| `~/.goodvibes/` | Every setting, credential store, token, session, memory and knowledge store, and the cluster group key material inside the secret store. |
| `~/.goodvibes/secrets.key` | Without it every `secrets.enc` is unreadable. Keep it with the backup of the stores it encrypts, and protect the backup accordingly. |
| A checkout installation (`scripts/install-from-checkout.sh`): its data directory, `~/.local/share/goodvibes-data/` unless `--data-dir` named another | Instead of `~/.goodvibes/`: that installation's commands run with `GOODVIBES_HOME` set to the data directory, so its whole tree is `<data dir>/.goodvibes/` (daemon home `<data dir>/.goodvibes/daemon/`, `secrets.key` included), plus the installer's `environment` file and ownership record in the data directory itself. Its service's working directory is the `--workspace` given to the installer (the checkout itself by default), so the per-working-directory state below is under `<workspace>/.goodvibes/`. Stop it with `goodvibes-daemon stop-service` as for a release installation. |
| `<project>/.goodvibes/` in each project | Project settings, checkpoints, the code index, the activity log. |
| `<daemon working directory>/.goodvibes/` | The daemon's per-working-directory state under `tui/`: the cluster node id (`tui/cluster/cluster-node-id`), device grants (`tui/devices/`), channel routes (`tui/operator/channel-routes.sqlite`), remote-node state (`tui/remote/`), watchers (`tui/watchers.json`) and decision records, plus its activity log (`logs/activity.md`). The service runs in the working directory written into its definition: the release installer runs `install-service` from the home directory, so for that service this is `~/.goodvibes/` and already covered; `install-service` run by hand records the directory it was run in (or `-C <dir>`). A daemon started with `-C <dir>` (or a saved working directory, see `daemon-settings.json`) keeps it under `<dir>/.goodvibes/`. The service's working directory is the `WorkingDirectory=` line of `~/.config/systemd/user/goodvibes.service` on Linux. Without it a restored daemon starts with a new cluster node id and without its device grants and channel routes. |

Then start the daemon again. To restore, stop the daemon, put the files back at the same paths with the same owner and modes (`operator-tokens.json`, `secrets.key` and the secret stores are `0600`), and start it. On a new machine, install GoodVibes first, then restore while the daemon is stopped. Restore `secrets.key` together with the `secrets.enc` files it encrypted: a store encrypted under another key cannot be read, and the programs refuse to write to a store they cannot read. Settings that hold absolute paths (`controlPlane.webui.bundleDir`, `controlPlane.tls.certFile`, registered workspaces, project paths) must name paths that exist on the new machine; with a different home path or user name, correct them with `goodvibes-daemon config set` (and `goodvibes-daemon webui enable --bundle-dir <dir>`). The service definition, the installed programs and the web UI bundle are not part of the backup; the installer puts them back. A restored cluster member rejoins its group by itself when it starts, as long as it was not removed. Do not run the old machine and its restored copy at the same time: they would share one node id. The API also exports and imports some data on its own: `memory.records.export` and `memory.records.import`, `calendar.ics.export` and `calendar.ics.import`, and the home graph (`homeassistant.homeGraph.export` and `.import`). `goodvibes support-bundle export` (terminal app) collects settings, diagnostics and posture for a support report; it is not a backup.

## Logs and diagnostics

There is no log level to set: no setting, flag or environment variable changes what the daemon logs. Everything is always recorded:

- **The activity log**, `<working dir>/.goodvibes/logs/activity.md`, gets every entry the daemon writes, at every level, `DEBUG` included, as lines `[<ISO time>] [DEBUG|INFO|WARN|ERROR] <message>`, some followed by a JSON block. Credentials and card numbers are masked before they are written. It rotates to `activity.md.1` at 10 MB, and the retention settings `atRest.retentionMaxAgeDays` and `atRest.retentionMaxTotalMb` prune it. For a service, the working directory is the unit's `WorkingDirectory=` (`systemctl --user cat goodvibes.service`) or the plist's `WorkingDirectory`. Cluster messages (`cluster: ...`), relay messages (`relay: ...`) and update messages are all here.
- **Standard output and error** carry only the start-up lines (`starting`, `bound`, `host started`), the pairing block on an interactive terminal, and a few `[goodvibes-daemon] ...` warnings. Under systemd they go to the journal; under launchd (macOS) the plist names no output file, so they are discarded.

| Where | What |
| --- | --- |
| `<working dir>/.goodvibes/logs/activity.md` | Everything, as above. Read it with `tail -f`. |
| `journalctl --user -u goodvibes.service` | Start-up lines and fatal start-up errors when the daemon runs as a systemd user service (Linux). |
| `~/.goodvibes/daemon/service/<platform>.log` (or `service.logPath`) | Output of a daemon started by the service commands when `service.platform` is `manual`. `service-status --json` names it as `logPath`. |
| `~/.goodvibes/tui/crashes.jsonl` | Crash records, always redacted. |
| `goodvibes-daemon status` | Health, channels, cluster, sessions, last update. |
| `ops.doctor` (API) | Give it a symptom in plain words ("stuck turn", "approval never answered") and it runs the matching checks against the live daemon. |
| `GET /api/health`, `GET /api/ops/memory` | Health snapshot; memory pressure and budgets. |
| `goodvibes control-plane status` (terminal app) | Bind posture, reachability, local sign-in, bootstrap file and tokens. |

### Giving the service environment variables (for example OTLP export)

The service definition GoodVibes writes sets only `GOODVIBES_DAEMON_TOKEN`, `GOODVIBES_HTTP_TOKEN` (each only when it was set in the environment of the command that installed the service) and `NODE_ENV`. Other variables, such as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, have to be added outside that file, because `refresh-service` (which every upgrade runs) rewrites it.

On Linux (systemd), use a drop-in, which `refresh-service` does not touch:

```sh
mkdir -p ~/.config/systemd/user/goodvibes.service.d
cat > ~/.config/systemd/user/goodvibes.service.d/otel.conf <<'CONF'
[Service]
Environment=OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example:4318/v1/traces
Environment=OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%%20<your-collector-token>
CONF
systemctl --user daemon-reload
goodvibes-daemon config set telemetry.otelMode remote-export
goodvibes-daemon restart-service
systemctl --user show goodvibes.service -p Environment
```

(`%%` is how a unit file writes a literal `%`.) If `service.serviceName` is set, use that name instead of `goodvibes`.

On macOS (launchd), the plist GoodVibes writes is rewritten on upgrade, so edits to its `EnvironmentVariables` do not last. Set the variables in the user's launchd domain and restart the service:

```sh
launchctl setenv OTEL_EXPORTER_OTLP_TRACES_ENDPOINT https://collector.example:4318/v1/traces
goodvibes-daemon config set telemetry.otelMode remote-export
goodvibes-daemon restart-service
```

`launchctl setenv` values are lost when the user logs out or the machine restarts; repeat them then (for example from a login item). This macOS recipe follows launchd's documented behaviour and was not run on a Mac for this guide.

## Telemetry

By default no telemetry leaves the machine. The programs contain exactly two telemetry exporters, both off by default, and neither has a built-in destination: each sends only to an address the owner supplies.

| Setting | What leaves the machine |
| --- | --- |
| `telemetry.otelMode` `off` (default) or `in-process` | Nothing. Spans (`in-process`) are kept in the daemon's memory and served only through its own API (`/api/v1/telemetry/...`). |
| `telemetry.otelMode` `remote-export` with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set (or `OTEL_EXPORTER_OTLP_ENDPOINT`, to which `/v1/traces` is added) | Trace spans, as OTLP/HTTP JSON, `POST`ed in batches of up to 512 to that endpoint, with the headers in `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (or `OTEL_EXPORTER_OTLP_HEADERS`) as `key=value,key=value`. The spans are the telemetry API's safe view, the same projection a read client gets without asking for the raw view: content attributes are withheld (`[REDACTED_TEXT]`), among them tool arguments and output (`tool.args`), agent and task descriptions (`agent.task`, `task.description`), prompts, questions and answers, and credential-shaped text in what remains is masked. They carry, among other attributes: model provider and model, token counts, stop reasons and errors (`llm.*`); the turn id, outcome, token counts and the prompt's length in characters (`turn.*`); the tool name; MCP server ids, plugin ids and paths, transport endpoints, session ids and message counts. With `remote-export` and neither variable set, nothing is sent and the daemon logs `telemetry.otelMode is remote-export with no OTLP endpoint, spans are recorded in-process only`. |
| `telemetry.decisionOtlpEnabled` `true` with `telemetry.decisionOtlpEndpoint` set | One record per permission-gate decision, as an OTLP span (`<endpoint>/v1/traces`), log (`<endpoint>/v1/logs`) or both, per `telemetry.decisionOtlpSignal` (`span`, `log`, `both`; default `span`). Attributes: `decision.id` (a rising number), `tool.name`, `command.class`, `permission.mode`, `decision.layer`, `decision.reason`, `decision.allowed`, `policy.bundle.id` when set, and the resource attribute `service.name`. Tool arguments are not included. The trace id is derived from the session id. |
| `telemetry.includeRawPrompts` | Nothing; it only allows raw (unredacted) reads through the daemon's own API, which also need `read:telemetry` and admin or `read:telemetry-sensitive`. |

Outbound traffic that is not telemetry also happens by default, and is listed here so nothing is a surprise: the daemon checks for updates at `update.releasesUrl` (GitHub) every `update.intervalMinutes` when `update.auto` is `true` (default); at start it fetches the public model lists of providers whose list needs no key (in testing a fresh daemon with no credentials fetched those of openrouter, aihubmix, groq, mistral, huggingface, nvidia, llm7 and opencode-zen, cached under `~/.goodvibes/tui/provider-models/` for 24 hours); and each conversation turn calls the chosen model provider.

Reading telemetry through the API (all need `read:telemetry`):

| Route | Returns |
| --- | --- |
| `GET /api/v1/telemetry` | Snapshot: aggregates, runtime state, recent records. |
| `GET /api/v1/telemetry/events` | Event feed with cursor resume. |
| `GET /api/v1/telemetry/errors` | Records with error metadata. |
| `GET /api/v1/telemetry/traces` | Readable spans. |
| `GET /api/v1/telemetry/metrics` | Aggregates and runtime metrics. |
| `GET /api/v1/telemetry/stream` | Server-Sent Events stream of telemetry. |
| `GET /api/v1/telemetry/otlp/v1/traces`, `.../otlp/v1/logs`, `.../otlp/v1/metrics` | The same data as OTLP JSON documents. |

<!-- generated: settings:telemetry -->
