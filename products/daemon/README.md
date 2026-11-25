# GoodVibes daemon (`goodvibes-daemon`)

`goodvibes-daemon` is the GoodVibes background service. It keeps scheduled jobs, chat channels, the knowledge and memory stores and web sessions running when no terminal is open, serves the web UI, and lets your phone, other devices and other machines connect. The `goodvibes` terminal app and the `goodvibes-agent` assistant connect to it.

## Install and start

The [suite installer](../../docs/installation.md) installs the daemon and sets it up as a user service (systemd on Linux, launchd on macOS) that starts by itself, so you rarely run it by hand. Commands you are likely to use:

```sh
goodvibes-daemon status            # ask the running daemon what it is doing
goodvibes-daemon service-status    # whether the service is installed and running
goodvibes-daemon restart-service   # restart the service
goodvibes-daemon webui status      # where the web UI is served and who can reach it
goodvibes-daemon config get controlPlane.port
goodvibes-daemon help <command>    # any command's own arguments and flags
```

Run with no command, it serves in the foreground; `goodvibes-daemon install-service` registers it as a service yourself.

## Operator guides

- [Command reference](docs/commands-reference.md): complete vocabulary, flags, refusals and remote conventions
- [Configuration](docs/configuration.md): exact homes, layers, persistent keys and runtime overlays
- [Hosted sessions](docs/hosted-sessions.md): Jev authority, trust, detach/kill, leases and recovery
- [Inbox sources](../../packages/engine/docs/channel-surfaces.md#inbox-sources): the Slack, Discord and email inboxes it mirrors, screening, retention and machine groups
- [Suite installation and uninstall](../../docs/installation.md): install released suite binaries and configure the Linux user service
- [Troubleshooting](docs/troubleshooting.md): startup, authentication, binding, services and tool refusals

How the daemon fits with the terminal app, the Agent and the web UI, and what it holds: [How GoodVibes works](../../docs/how-goodvibes-works.md).

## Release and license

Monorepo releases are documented in the [release notes](../../docs/releases/), one file per release.

Package: `@goodvibes/daemon` · `private: true`.
The repository root owns the shared release version for all suite products.
[MIT license](LICENSE),
Copyright (c) 2026 Mike Davis.
