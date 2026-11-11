# Install and uninstall GoodVibes

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

This installs **released binaries**, the browser driver and the WebUI from
`mgd34msu/goodvibes`. It resolves the release version once and uses that same
version and checksum manifest for all products. It never clones or builds source.
Missing assets or mismatched checksums stop installation before replacing programs.

To pin the complete suite:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.1.2 sh
```

The installer uses POSIX shell, curl or wget, tar, and sha256sum or shasum.
It detects Linux/macOS and x64/arm64; the selected release must publish the
complete asset set for that platform. Linux runtime companions are downloaded
with the binaries. macOS includes the daemon's required SQLite and vector
libraries and their release metadata. No system Bun, Node, Git or package manager
is required.

## Options

| Setting | Behavior |
| --- | --- |
| `GOODVIBES_VERSION` | One monorepo release, default `latest` |
| `GOODVIBES_INSTALL_DIR` | Command directory, default `~/.local/bin` |
| `GOODVIBES_AGENT=0` | Skip Agent; the shared browser driver is still installed |
| `GOODVIBES_WEBUI=0` | Skip WebUI |
| `GOODVIBES_VECTOR=0` | Retained compatibility input; required native vector libraries are still installed |
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

Version 3.1.1 installations using
`https://github.com/mgd34msu/goodvibes-jev/releases/latest` cannot discover the
new release after the repository was renamed to `goodvibes`. Their updater
rejects GitHub's repository-rename redirect before downloading a replacement.
Waiting for another automatic check does not resolve this error.

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
When an older updater installs a newer daemon using an older receipt format,
the running daemon preserves its confirmed reader support during its next
automatic update. Rollback uses that evidence only for the matching executable
and complete payload cohort; it does not infer compatibility from the version.
The incoming build must also confirm support for this receipt format before the
updater writes it.

Installation holds transaction claims beside the three executables while suite
files are replaced. A competing updater is refused. If replacement is interrupted
after it begins, retained claims require inspection and recovery before another
attempt; the installer does not report a complete install or blindly retry it.

## Automatic updates and rollback

Released native installations enable automatic updates by default. The daemon
checks shortly after startup and then hourly, deferring replacement while work
is active. The TUI and Agent also check at launch. An update selects one release
for installed sibling programs, their native companions, the browser driver and
the configured release WebUI. Programs already running continue their original
build until restarted. Source and package-managed runs keep their own update
mechanism.

On macOS, an installed daemon running under launchd prepares a one-shot restart
helper before replacing files for an automatic update or crash-loop rollback.
The helper restarts the service after the old daemon drains its work and exits.
If the helper cannot be prepared, the daemon reports the problem before replacing
files or stopping its runtime. A standalone daemon without launchd supervision
requires the released installer for this update path. Terminal launch updates
use their separate restart path.

To disable all unattended updates, set both `update.auto` and
`update.autoUpdateAtLaunch` to `false` in settings. Setting only
`update.autoUpdateAtLaunch` to `false` disables terminal launch updates and their
periodic updater unless `update.auto` was explicitly enabled. A daemon uses
`update.auto` independently. Installation preserves these existing choices.

`/update rollback` restores the retained complete suite when its programs and
directory assets agree on a previous release and its readers support saved data.
A failed daemon startup can request the same complete-suite rollback. A missing,
mixed or incompatible previous cohort is refused; retained transaction recovery
files require inspection. The installer itself preserves partial replacement
claims rather than promising crash-atomic installation or automatic rollback.

## Uninstall

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

This removes installer-managed programs, runtime companions, known native library
files and managed service files, keeping `~/.goodvibes` settings, sessions and memory.
Browser-driver, WebUI and retained directory backups are listed and preserved;
they may contain local additions or serve another deployment. Review those paths
before removing their contents. An active or interrupted update must be resolved
before uninstall can remove its programs. A saved installer can perform
this operation without release downloads. `scripts/uninstall.sh` also recognizes
receipt-owned installations made by the earlier checkout installer and invokes
their installed uninstaller. Their `--prefix` and `--purge` options remain available.

## Explicit developer source installation

`./scripts/install-from-checkout.sh` is the separate developer build path. It
requires a clean checkout and the build toolchain. Its receipt-owned program/data
layout is distinct from release-binary installations. The curl installer does not
fall back to building source when a release asset is unavailable.
