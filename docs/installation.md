# Install and uninstall GoodVibes

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

This installs **released binaries**, the browser driver and the WebUI from
`mgd34msu/goodvibes-jev`. It resolves the release version once and uses that same
version and checksum manifest for all products. It never clones or builds source.
Missing assets or mismatched checksums stop installation before replacing programs.

To pin the complete suite:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.1.0 sh
```

The installer uses POSIX shell, curl or wget, tar, and sha256sum or shasum.
It detects Linux/macOS and x64/arm64; the selected release must publish the
complete asset set for that platform. Linux runtime companions are downloaded
with the binaries. No system Bun, Node, Git or package manager is required.

## Options

| Setting | Behavior |
| --- | --- |
| `GOODVIBES_VERSION` | One monorepo release, default `latest` |
| `GOODVIBES_INSTALL_DIR` | Command directory, default `~/.local/bin` |
| `GOODVIBES_AGENT=0` | Skip Agent and its browser driver |
| `GOODVIBES_WEBUI=0` | Skip WebUI |
| `GOODVIBES_VECTOR=0` | Skip the SQLite vector addon |
| `GOODVIBES_WAKE_MODEL=0` | Skip optional wake-word provisioning |
| `GOODVIBES_DAEMON_SERVICE=0` | Skip first-run service registration |
| `GOODVIBES_RESTART_DAEMON=0` | Leave running daemon/agent processes untouched |
| `GOODVIBES_SHADOW_REMOVE=ask|0|1` | Prompt, report only, or remove recognized older commands that shadow this installation |
| `GOODVIBES_UNINSTALL=1` | Uninstall managed programs/services while preserving user data |

`--version`, `--bin-dir`, `--no-service`, `--service`, `--decision-policy` and
`--uninstall` can also be passed through `sh -s --`. A decision policy is changed
only when explicitly selected; installing software does not require a live
judgment-model connection. Provider account setup remains in the application.

## Existing installations and services

The release installer retains the original installer’s command paths and
`~/.goodvibes` data. It handles upgrades, running daemon/agent restarts, systemd
user services and launchd agents. Existing custom services are distinguished from
installer-managed services; migration preserves settings and has rollback handling.
PATH setup and checks for older commands remain part of installation.

Saved data can require a newer reader than an earlier release provides. The
installer checks an existing installation’s reader requirements with the staged,
verified release before replacing programs. An incompatible or unreadable
requirement keeps the installed programs in place. Do not delete compatibility
evidence to force a downgrade. The evidence survives data-preserving uninstall.
Native build admission also checks explicit saved-data reader support: two
builds with the same version number need not support the same formats.

Installation holds transaction claims beside the three executables while suite
files are replaced. A competing updater is refused. If replacement is interrupted
after it begins, retained claims require inspection and recovery before another
attempt; the installer does not report a complete install or blindly retry it.

## Uninstall

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

This removes installer-managed programs, supporting files and service files,
keeping `~/.goodvibes` settings, sessions and memory. A saved installer can perform
this operation without release downloads. `scripts/uninstall.sh` also recognizes
receipt-owned installations made by the earlier checkout installer and invokes
their installed uninstaller. Their `--prefix` and `--purge` options remain available.

## Explicit developer source installation

`./scripts/install-from-checkout.sh` is the separate developer build path. It
requires a clean checkout and the build toolchain. Its receipt-owned program/data
layout is distinct from release-binary installations. The curl installer does not
fall back to building source when a release asset is unavailable.
