# Deployment and services

## Runtime shapes

GoodVibes supports a few distinct deployment shapes:

- local TUI only, with no daemon
- TUI connected to a daemon it adopted or autostarted (the default)
- a standalone `goodvibes-daemon` process, with no TUI attached
- daemon/API host behind a reverse proxy with HTTPS termination
- daemon/API host with direct HTTPS from GoodVibes itself
- omnichannel runtime with external routes and channel delivery
- distributed runtime with remote peers and node-host runners

## TUI-only mode

This is the default development and local-use path:

```sh
bun run dev
```

or, for the compiled build:

```sh
./dist/goodvibes
```

In this mode you still get the full TUI, tools, providers, knowledge system, artifacts, and local runtime surfaces.

## Adopting or autostarting the daemon, and the in-process HTTP listener

The daemon (`goodvibes-daemon`) is a separate product with its own binary and its own service
unit. This app never constructs one in-process. What `daemon.enabled` (default `true`) actually
does on this side:

- adopt a compatible daemon already listening at the configured `controlPlane.host`/`controlPlane.port`
- if none is reachable but a daemon service is installed on this machine and simply stopped, start
  that installed service and wait for it to answer
- otherwise, run with no daemon. This surface still gives you the full TUI, tools, providers,
  knowledge system, artifacts, and local runtime surfaces. Cross-surface session visibility and
  daemon-hosted capabilities are simply unavailable until a daemon appears

The HTTP listener is different. It genuinely runs in-process in this app when enabled, controlled by:

- `danger.httpListener` (default `false`)

The compiled binary built by `bun run build` includes this path because it compiles `src/main.ts`, and the main runtime bootstraps external services through the deferred startup path.

## Running the daemon

`goodvibes-daemon` is the daemon product in this repository (`products/daemon`) and ships in the same release as the TUI. Run it directly:

```sh
goodvibes-daemon                      # run in the foreground
goodvibes-daemon install-service      # install and start the user service unit
```

This path is useful for service-style deployments, automation entrypoints, and local integrations that do not need the interactive terminal UI. See the [daemon command reference](../../daemon/docs/commands-reference.md) and [daemon configuration](../../daemon/docs/configuration.md) for its full CLI and configuration reference.

The installed package also exposes a `goodvibes-daemon` launcher. The suite installer (`goodvibes.sh/install.sh`) puts both `goodvibes` and `goodvibes-daemon` on `PATH`.

## Connecting the TUI to an already-running daemon

The TUI normally adopts a compatible GoodVibes daemon it finds already listening at `daemon.connectedHost.url` when that is set, otherwise at the local bind address `controlPlane.host`/`controlPlane.port`, or starts an installed-but-stopped one, as described above. Adoption authenticates with a bearer token read from `<homeDirectory>/.goodvibes/daemon/operator-tokens.json`; if that file does not already hold the *same* token the target daemon was started with, the TUI cannot tell the two apart from a token it has never seen and will not adopt it.

Two ways to point a TUI instance at a daemon it did not start itself:

**Interactive.** In the onboarding wizard's Network step, set "GoodVibes daemon source" to "Connect to an existing running daemon," fill in that daemon's host, port, and token, and select "Connect to this daemon now." This saves the token beside that daemon's address in the terminal's own connected-daemon credentials (`~/.goodvibes/tui/connected-daemons.json`; the local daemon's `operator-tokens.json` is not touched), saves the address as `daemon.connectedHost.url`, and restarts the external-services controller immediately so you see whether the connection succeeded before finishing the rest of onboarding. The local bind settings (`controlPlane.*`) are left alone, so finishing onboarding keeps the connection, and running onboarding again starts from it. Choosing "Start a new daemon" clears `daemon.connectedHost.url` and the TUI goes back to the daemon on this machine.

**Non-interactive.** Set the `GOODVIBES_DAEMON_TOKEN` environment variable to run the daemon with a fixed, known token, and point the TUI at the same host/port and token:

```sh
# Start the daemon once, with a fixed, known token:
GOODVIBES_DAEMON_TOKEN=gv_shared_token goodvibes-daemon --hostname 0.0.0.0 --port 3421

# Point a TUI at it (any home directory, no shared operator-tokens.json needed):
GOODVIBES_DAEMON_TOKEN=gv_shared_token bun run dev \
  --config daemon.connectedHost.url=http://<daemon-host>:3421
```

`GOODVIBES_DAEMON_TOKEN` is read by both sides. The daemon uses it as the bearer token every route requires, and the TUI uses it as its token for that run only: nothing is written, so the local daemon and every other app keep their own token, and adoption needs no hand-edited files. To keep the connection across runs, use the interactive step above. This mirrors `src/verification/live-verifier.ts`'s existing fallback to the same variable when probing a daemon's HTTP surface from the outside.

## Background service and autostart

The fullscreen `/config` workspace exposes service settings under `Service`:

| Key | Default | What it does |
| --- | --- | --- |
| `service.enabled` | `true` | Enable the service-install and daemon-management verbs |
| `service.autostart` | `false` | Install/enable or disable/remove the OS autostart service |
| `service.restartOnFailure` | `true` | Restart the managed daemon service after failure |
| `service.platform` | `auto` | Target service manager platform |
| `service.serviceName` | empty: `goodvibes` on Linux and Windows (`goodvibes.service` under systemd), `sh.goodvibes.daemon` on macOS | The daemon's service unit name. The installer, `goodvibes service`, `goodvibes-daemon service-*` and the daemon's own promotion all use this one name and one unit definition |
| `service.logPath` | *(empty)* | File path for daemon/service logs; empty means `~/.goodvibes/daemon/service/<platform>.log`, the one service state directory every terminal and the daemon read (it also holds the pid file the manual platform starts, stops and restarts the service by) |

Changing `service.autostart` from the TUI is intended to reconcile the OS service, not just update JSON. On Linux this means writing/enabling/disabling the user `systemd` service. When service mode is enabled for the first time, the TUI installs the service definition, reloads user units, and starts/enables the daemon service if autostart is on. Disabling service mode or autostart removes/disables the OS-level autostart path.

`goodvibes service install`, `start` and `restart` act on the service as these settings describe it and change no setting; when a setting disagrees with what was done (for example `service.autostart` off while the platform starts the installed service at login) the command prints one line saying so. `start` and `restart` report `ok` only when the managed service is running and its enabled control-plane and HTTP-listener endpoints accept a connection, waiting up to ten seconds for that; otherwise they print the first problem and exit 1.

Use these commands to inspect the live state:

```sh
goodvibes service status
goodvibes status --output json
```

The daemon uses the daemon home under `~/.goodvibes/daemon` for daemon-owned runtime state.

## Web/browser surface

The browser operator surface is controlled separately from the daemon control plane:

| Key | Default | What it does |
| --- | --- | --- |
| `web.enabled` | `true` | Switch the web channel on (its status and delivery); the web UI itself is served by the control-plane listener after `goodvibes-daemon webui enable` |
| `web.hostMode` | `local` | Bind mode of the web UI's development server: `local`, `network`, or `custom` |
| `web.host` | `127.0.0.1` | Bind host of the web UI's development server |
| `web.port` | `3423` | Port of the web UI's development server; the daemon never binds it and no link uses it |
| `web.publicBaseUrl` | *(empty)* | Public base URL for web links and notification deep links, for a tunnel or proxy address. Empty derives links from the daemon's reachable address while it serves the web app; otherwise there is no web app and no link |
| `web.staticAssetsDir` | `dist/web` | Static asset directory for the embedded web surface |

The daemon/control-plane backend defaults to port `3421` and serves the web UI on that same port, the webhook/event listener defaults to `3422`, and the web UI's development server defaults to `3423`.

Host modes resolve as:

- `local`: bind loopback (`127.0.0.1`)
- `network`: bind all interfaces (`0.0.0.0`)
- `custom`: bind the configured host

When the WebUI is launched by external tooling rather than by the TUI, it should read the same settings or be launched with matching env overrides. Surface preferences live in `~/.goodvibes/tui/settings.json`, but the daemon-owned keys named here (`controlPlane.*`, `httpListener.*`, `web.*`, `surfaces.*`) live in the daemon's settings file, `~/.goodvibes/daemon/settings.json`, and are changed with `goodvibes-daemon config set <key> <value>`; a value in the daemon file overrides the TUI file. Setting `GOODVIBES_HOME` relocates the whole `.goodvibes` tree root, which moves both files under `<GOODVIBES_HOME>/.goodvibes/`.

## Inbound TLS

GoodVibes now treats inbound TLS as an explicit server concern.

The control-plane daemon and the webhook listener each carry the same shape of TLS keys, under their own prefixes:

| Key (per prefix) | What it does |
| --- | --- |
| `controlPlane.hostMode` / `controlPlane.host` / `controlPlane.port`, `httpListener.host` / `httpListener.port` | The bind address and port; `hostMode` takes `local`, `network`, or `custom` |
| `controlPlane.enabled` | Whether the control plane is served to other machines. Off (the default), the daemon answers only requests from this machine, whatever `hostMode` binds, and refuses others with `CONTROL_PLANE_LOCAL_ONLY`; turn it on to serve paired devices, the web UI from another device, or a reverse proxy (`goodvibes-daemon webui enable --lan` turns it on with the network binding). Channel webhooks under `/webhook/` are answered either way; each surface's own switch decides them. A settings file from before this setting took effect that binds the network and never stated it is given `true` once at load, with a notice, so a LAN setup keeps working |
| `controlPlane.streamMode` | Which live update stream is served: `sse` (`GET /api/control-plane/events`), `websocket` (`/api/control-plane/ws`) or `both` (the default). The terminal apps and the web UI read the SSE stream |
| `<prefix>.tls.mode` | `off` (plain HTTP), `proxy` (a reverse proxy terminates HTTPS), or `direct` (GoodVibes terminates HTTPS itself) |
| `<prefix>.trustProxy` | Trust proxy forwarding headers such as `X-Forwarded-For` |
| `<prefix>.tls.certFile` / `<prefix>.tls.keyFile` | Certificate chain and private key PEM paths for `direct` mode; empty falls back to the default cert directory below |

### Proxy mode

`proxy` is the recommended deployment shape for public HTTPS exposure. In this mode:

- GoodVibes still binds plain HTTP locally
- a reverse proxy such as Nginx, Caddy, Traefik, or Nginx Proxy Manager terminates HTTPS
- GoodVibes only trusts forwarded headers when the relevant `trustProxy` setting is enabled
- with `trustProxy` on, the client address is the last `X-Forwarded-For` entry, the one your proxy appended; entries to its left are whatever the client sent and are ignored, and `X-Real-IP` is not read. A request that arrives without the header is attributed to the connecting address

This is the right shape when a future web UI, browser clients, SSE, and WebSocket clients all need to share one public HTTPS origin.

### Direct mode

`direct` makes GoodVibes terminate HTTPS itself through Bun's native server TLS.

If no explicit certificate paths are configured, GoodVibes looks for:

- `~/.goodvibes/tui/certs/fullchain.pem`
- `~/.goodvibes/tui/certs/privkey.pem`

The `certs` directory sits under the settings directory of the program that starts the listener. The terminal app and the daemon share `~/.goodvibes/tui`; another program, such as the Agent, looks under its own settings directory.

That convention also works well with self-hosted Let's Encrypt deployment patterns where the operator copies or syncs certificate material into the GoodVibes home directory.

If `direct` is enabled and the certificate files are missing or invalid, GoodVibes fails that server startup clearly instead of silently downgrading to plain HTTP.

### TLS plaintext warning

If a control plane or HTTP listener is configured with `hostMode` other than `local` and `tls.mode = off`, GoodVibes emits a `[SECURITY]` warning at startup. The same warning appears in the onboarding wizard network step whenever a network-facing service is selected without TLS.

To suppress the warning, set `controlPlane.tls.mode` or `httpListener.tls.mode` to `direct` (or use the `proxy` deployment shape with a terminating reverse proxy).

### Cloudflare Zero Trust Tunnel and trustProxy

When the onboarding wizard applies with the Zero Trust Tunnel Cloudflare component selected, it writes:

- `controlPlane.trustProxy = true`
- `httpListener.trustProxy = true`
- `httpListener.trustCloudflare = true`

The two `trustProxy` keys let the login rate-limiter key on the client address the tunnel forwards rather than the tunnel's own egress address. On their own, that address is read from `X-Forwarded-For`.

**What `X-Forwarded-For` alone leaves open:** it is a header any client can set. A client that reaches the port directly, bypassing the tunnel, sets its own rate-limit bucket key and can rotate it at will.

`httpListener.trustCloudflare` closes that gap for the HTTP listener. The client address comes from `CF-Connecting-IP`, and only when the connecting peer is itself inside Cloudflare's published ranges (`isCloudflareIp`); otherwise the header is ignored. It requires `httpListener.trustProxy`. With that off, `CF-Connecting-IP` is ignored whatever this says, and the onboarding wizard's Zero Trust Tunnel step writes both, so this route arrives with the narrower read already on.

**What is still open:** the control plane has no `trustCloudflare` equivalent, so its rate-limiter is still keyed on `X-Forwarded-For`. Keep both ports reachable only through the tunnel. Restrict inbound traffic to Cloudflare egress IPs, which is what you want regardless, since direct exposure also bypasses tunnel-level access policies.

### CORS configuration

CORS enforcement is off by default (permissive, no origin checking) and is meant for multi-user, internet-exposed, or enterprise deployments where browser-based CSRF is a concern.

The listener takes `enforceCors` and `allowedOrigins` as constructor parameters, and neither is a `ConfigKey` the onboarding wizard can write. What it does read from config when the constructor says nothing is the shared control-plane allowlist, so those are the settings to write. They are daemon-owned, so set them through the daemon rather than by editing the TUI settings file:

```sh
goodvibes-daemon config set controlPlane.cors.enabled true
goodvibes-daemon config set controlPlane.cors.allowedOrigins "https://your-origin.example.com,https://another.example.com"
```

`allowedOrigins` is a comma-separated string, and the same allowlist governs the control-plane router and the webhook listener. Restart the daemon after changing it. With enforcement on, a listener bound to a network address refuses to start on an empty allowlist rather than serving every origin.

## Outbound HTTPS trust

GoodVibes now centralizes outbound trust handling for Bun `fetch` traffic. Provider calls, search, webhooks, downloads, telemetry, artifacts, and other fetch-based integrations inherit the same trust policy automatically.

Four keys configure it:

| Key | Default | What it does |
| --- | --- | --- |
| `network.outboundTls.mode` | `bundled` | `bundled` uses Bun's default bundled root certificates; `bundled+custom` adds operator-provided PEM roots on top; `custom` trusts only the configured custom roots |
| `network.outboundTls.customCaFile` | *(empty)* | Additional PEM file to trust in `bundled+custom` or `custom` mode. If it is missing or unreadable, https requests fail with an error naming it rather than falling back to the bundled roots |
| `network.outboundTls.customCaDir` | *(empty)* | Directory of PEM/CRT/CER files to trust in `bundled+custom` or `custom` mode |
| `network.outboundTls.allowInsecureLocalhost` | `false` | Disable certificate verification only for loopback HTTPS targets; intended for local development |

This is the right place to add enterprise or internal roots for outbound HTTPS access to providers, registries, proxies, or internal services.

## Build behavior

`bun run build` compiles:

- entrypoint: `src/main.ts`
- output: `dist/goodvibes`

This build does not produce a daemon executable. The daemon binary is built from `products/daemon` and ships in the same release (see the [daemon command reference](../../daemon/docs/commands-reference.md)).

## Local auth and service tokens

The daemon and listener are protected by local auth plus optional service tokens.

Two environment variables carry the tokens: `GOODVIBES_DAEMON_TOKEN` is the bearer token every daemon route requires, and `GOODVIBES_HTTP_TOKEN` protects the webhook HTTP listener.

Beyond fixed tokens, the runtime supports bootstrap credentials for first contact, local user management with password rotation (`goodvibes auth add-user` / `auth rotate-password`), session revocation, and local-auth review surfaces in the TUI and operator APIs.

## Services, profiles, and setup transfer

The services/config side is productized beyond a flat JSON file. It includes:

- a named service registry with inspect, auth resolution, connectivity tests, auth review, and doctor output
- first-class SecretRef-backed service credentials through env, GoodVibes local storage, file, exec, 1Password, Bitwarden, Vaultwarden, and Bitwarden Secrets Manager providers
- live profile management plus portable profile sync bundle export/import
- setup transfer bundles that can move config/services/ecosystem posture between environments

Key commands:

| Command | Does |
| --- | --- |
| `/services inspect\|test\|resolve\|auth\|auth-review\|doctor\|export\|import` | Manage API service configurations |
| `/profiles` | Browse and load config profiles |
| `/profile-sync` (alias `/profilesync`) | Export, import, and inspect profile sync bundles |
| `/setup transfer export\|inspect\|import` | Move setup-transfer bundles between environments |

Service entries can use an existing `tokenKey` field, a SecretRef in the key field, or explicit `tokenRef` / `passwordRef` / `webhookUrlRef` / `signingSecretRef` / `publicKeyRef` / `appTokenRef` fields:

```json
{
  "slack": {
    "name": "slack",
    "authType": "bearer",
    "tokenKey": "SLACK_BOT_TOKEN",
    "appTokenKey": "SLACK_APP_TOKEN",
    "tokenRef": {
      "source": "vaultwarden",
      "item": "GoodVibes Slack",
      "field": "password",
      "server": "https://vault.example.test"
    },
    "appTokenRef": {
      "source": "vaultwarden",
      "item": "GoodVibes Slack App",
      "field": "password",
      "server": "https://vault.example.test"
    }
  }
}
```

## Remote peers and execution backends

`remote.peers.invoke` (`POST /api/remote/peers/{peerId}/invoke`, admin only) runs a command on one of two kinds of target:

- a **paired peer**, a GoodVibes node or device that paired with this daemon: the command is queued as work the peer claims, and the answer is the queued work item (`remote.work.list` follows it);
- a **registered backend**, a host the daemon runs the command on itself: the command runs at once and the answer carries `backend` with the exit code and the first 4 KB of stdout and stderr (with their full size and whether they were cut).

Backends are registered by an admin with `remote.backends.register` (`POST /api/remote/backends`), listed with `remote.backends.list` and removed with `remote.backends.remove`. Four kinds exist:

| Kind | Runs | Settings |
| --- | --- | --- |
| `docker` | `docker exec <container> sh -c <command>` | `containerName`, optional `dockerHost` |
| `ssh` | the command over ssh with a key file written for the run and removed after | `sshHost`, `sshUser`, `identityRef`, optional `sshPort` |
| `cloud-terminal` | `gcloud compute ssh`, `aws ssm start-session` or `az vm run-command invoke` | `provider` (`gcp`, `aws`, `azure`), `credentialRef`, optional `projectId`, `location`, `instance` |
| `local-process` | the command on this machine, without a shell | optional `cwd`, optional `allowedCommands` |

Credentials (`identityRef`, `credentialRef`, a TLS `dockerHost`) are `goodvibes://secrets/` references only; a raw key or password is refused. A container, instance, project or location starting with `-` is refused, because the CLI receiving it would read it as an option. An id a paired peer already holds cannot be registered as a backend. On a backend, `payload` takes `args`, `stdin`, `env`, `timeoutMs` (at most 10 minutes; default 2 minutes) and `cwd`; any other payload field is refused by name. An Azure command cannot start with `@`, which the Azure CLI would read as a local file to upload. The registry is opened on first use, so a daemon with no backends does no work for them.

In the Agent, `agent_harness` modes `remote_backends`, `remote_backends_register`, `remote_backends_remove` and `remote_peers_invoke` reach these methods; a model's command is judged by the permission gate before it is sent, and arguments go in the command itself (`payload.args` is refused there).

## Integration helpers

GoodVibes exposes integration-helper and control/state APIs for external clients and helpers. This layer is explicitly control/state APIs, not a UI protocol. It is meant for callers like another GoodVibes instance, a future web frontend or companion app, setup/auth helpers, and operational integrations that need session, approval, account, health, knowledge, search, artifact, or delivery posture.

The front doors into this layer cover provider login/logout flows, install and update posture review, trust review bundles, bridge status/review/export/import paths, setup deep links, and portable install/update/auth review bundles with deeplink review and bundle packaging for operator surfaces.

The setup surface is broader than a single readiness screen. It also covers onboarding and doctor flows, review of services, hooks, remote, and sandbox posture, support-bundle export, setup-transfer export/inspect/import, and deep links into the cockpit, security, remote, knowledge, incident, hooks, orchestration, and tasks operator surfaces.

## Core control-plane entrypoints

The daemon exposes broad HTTP and streaming surfaces. The most important entrypoints:

| Entrypoint | Serves |
| --- | --- |
| `GET /status` | Daemon liveness and posture |
| `GET /api/control-plane` | The control-plane descriptor |
| `GET /api/control-plane/web` | Redirects to the web app, opened on the approval (`?approval=<id>`) or session (`?session=<id>`) it names, when the daemon serves it (`controlPlane.webui.serve`) or knows where it runs (`web.publicBaseUrl`, or `web.enabled` with `web.host`/`web.port`); otherwise serves the control plane's built-in page |
| `GET /api/control-plane/methods` | The typed method catalog |
| `GET /api/control-plane/events/catalog` | The event catalog |
| `GET /api/control-plane/events` | The event stream |
| `GET /api/control-plane/ws` | The WebSocket transport |
| `POST /task` | Task submission |
| `GET /api/tasks` | The task list |
| `GET /api/service/status` | Managed-service status (admin only; it includes the installed unit file) |

The control-plane method catalog is the canonical typed surface for external clients. For every method it describes the method itself, its category and scopes, its input and output schemas, its event domains, and its transport metadata.

## Service startup behavior inside the TUI

Before adopting or autostarting a daemon, and before starting its own in-process HTTP listener, the TUI probes the configured bind ports first and skips startup cleanly if another instance already owns them. That avoids duplicate local-service hangs while still allowing the TUI to run normally.

## Related docs

- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
