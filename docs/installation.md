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
| `GOODVIBES_DAEMON_VERSION`, `GOODVIBES_AGENT_VERSION`, `GOODVIBES_WEBUI_VERSION` | Internal per-program pins that default to `GOODVIBES_VERSION`; use `GOODVIBES_VERSION`, because updates and rollback treat the programs as one release |
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
If the daemon cannot save the selected policy, the installation still finishes
(the programs are already replaced), says the policy was not saved and prints the
`goodvibes-daemon config set judgment.policy` command to run afterwards.

The installer trusts the release's GitHub download origin over HTTPS. The checksum
manifest comes from the same origin as the assets, so the checksums catch a corrupt
or mismatched download rather than a compromised release host.

## Existing installations and services

Version 3.1.1 installations using
`https://github.com/mgd34msu/goodvibes-jev/releases/latest` cannot discover the
new release after the repository was renamed to `goodvibes`. Their updater
rejects GitHub's repository-rename redirect before downloading a replacement.
Waiting for another automatic check does not resolve this error.

Run the public installer once to migrate that installation:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.1.2 sh
```

This replaces the suite and restarts its managed daemon while preserving saved
data and settings, including disabled automatic updates. This migration has been
verified from a running 3.1.1 installation on Linux x64 and ARM64. It requires
this one-time command; the old updater cannot discover the renamed repository.

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
files are replaced. A competing updater is refused. See
[When installation fails](#when-installation-fails) for what happens when
replacement does not finish.

## When installation fails

Before the installer replaces a program or one of its companion files, it keeps
the previous file beside it as `<file>.goodvibes-previous`. If installation
fails or is interrupted with Ctrl-C or a termination signal after replacement
has begun, the installer puts the previous files back, removes the files it had
newly created, releases its transaction claims and prints the command to run
again. Running services are not touched by this recovery. The backups are
removed once replacement finishes. The browser driver, WebUI and native vector
library directories are published as whole directories and are not part of this
file-level recovery; a directory whose publication fails keeps or regains its
original content.

If the previous files cannot be put back, the claims and the
`.goodvibes-previous` backups stay in place. The installer prints one `mv`
command per file to restore, followed by the command that removes the claims.
Run those before installing again. An installer that is killed outright cannot
recover or print anything: its claims and backups also stay in place, and the
next installation is refused until the retained `*.update-transaction` files
have been inspected and resolved.

Other failure behavior:

- **Updating a directory.** When an update replaces a directory that an earlier
  installation published, such as the WebUI or browser driver, the previous
  directory is removed after the new one is in place. A failed update keeps it.
  A directory that already holds exactly the release's files is left untouched,
  so repeating an installation does not accumulate copies. A previous directory
  that differs from the new one (local additions, or a WebUI published for another
  release) is kept, never deleted.
- **Rollback copies.** When an installation replaces the programs with a different
  release, the daemon's older `<program>.previous` rollback copies are removed, so
  `/update rollback` and a crash-loop rollback report nothing to restore instead of
  restoring a release two versions back. Reinstalling the same release keeps them.
- **PATH.** The installer adds one marker-tagged `export PATH` line to your shell
  rc file for each install directory that is not on `PATH`; installing into a
  second directory adds a second line, and uninstalling removes only its own.
- **Processes started by hand.** When a daemon or agent running outside a
  service has to be restarted and its arguments contain spaces or wildcard
  characters, the process is left running and the installer prints a fully
  quoted command for starting the new program yourself.
- **macOS LaunchAgent.** If a LaunchAgent rewritten with new launch arguments
  cannot be loaded, the previous file is restored and loaded again. If that
  also fails, the installer prints the `launchctl bootstrap` command to run.
- **Uninstall.** An uninstall that stops during its service and process step,
  before any program file is removed, releases its claims and says what was
  already done. Every step can be repeated, so run the same uninstall command
  again. An uninstall that stops while removing programs keeps its claims for
  inspection.

## Automatic updates and rollback

Released native installations enable automatic updates by default. The daemon
checks shortly after startup and then hourly, deferring replacement while work
is active. The TUI and Agent also check at launch. An update selects one release
for installed sibling programs, their native companions, the browser driver and
the configured release WebUI. An update replaces the contents of the configured
WebUI directory in place (and rewrites its release marker), so after an update a
directory named for the installed release, such as `webui/3.3.0`, can hold a newer
release; the installer publishes each release it installs into a new directory and
never prunes older ones. Programs already running continue their original
build until restarted. Source and package-managed runs keep their own update
mechanism.

On macOS, an installed daemon running under launchd prepares a one-shot restart
helper before replacing files for an automatic update or crash-loop rollback.
The helper restarts the service after the old daemon drains its work and exits.
If the helper cannot be prepared, the daemon reports the problem before replacing
files or stopping its runtime. A standalone daemon without launchd supervision
requires the released installer for this update path. Terminal launch updates
use their separate restart path.

When a newly installed daemon build fails to finish starting three times within
ten minutes (the count is `update.rollbackAfterFailedStarts`, where `0` turns this
rollback off; the ten-minute window is fixed), the daemon restores the kept previous version and skips that
release until a newer one ships. It does not roll back a build that has already
started successfully on the same machine, because repeated failures of such a
build come from its environment, such as an occupied port, rather than from the
update. It also refuses to restore a kept copy that is not older than the
running build or is the release an earlier rollback rejected. Each refusal is
written to the daemon's stderr and receipts.

When an unsupervised daemon adopts the systemd user service (after an update,
a rollback or at boot), it first confirms the user manager answers, installs the
unit and reloads the manager, all while its runtime is still serving. A refusal
at that stage leaves a serving daemon, reported in a receipt; only the final
enable runs after the runtime stops. If the service manager does not accept the
restart after the daemon has already stopped its runtime for an update, rollback
or service adoption, the daemon exits with status 1, so a supervisor starts the
installed build. On Linux, a daemon that cannot reach the systemd user manager
does not attempt an unattended handover. When another install or update holds
the installation, the daemon retries the update later. When an earlier install
or update stopped partway, automatic updates pause, and the receipt lists the
retained files and says when they can be removed.

The daemon records which release it rolled away from before it exchanges any
files. If that record cannot be written, the rollback is refused and nothing is
changed, so the restored build cannot reinstall the release that just failed.

Several daemons can share one home (for example on different ports). The
lifecycle record belongs to the one that wrote it while that process is alive: a
second daemon's start attempts are not counted toward a crash-loop rollback, its
start is not reported as a crash, and its stop does not clear the owner's
record. A daemon whose previous shutdown finished in order but reported cleanup
errors says so at the next start instead of reporting a crash.

To disable all unattended updates, set both `update.auto` and
`update.autoUpdateAtLaunch` to `false` in settings. Setting only
`update.autoUpdateAtLaunch` to `false` disables terminal launch updates and their
periodic updater unless `update.auto` was explicitly enabled. A daemon uses
`update.auto` independently. Installation preserves these existing choices.

`/update rollback` restores the retained complete suite when its programs and
directory assets agree on a previous release and its readers support saved data.
A failed daemon startup can request the same complete-suite rollback. A missing,
mixed or incompatible previous cohort is refused; retained transaction recovery
files require inspection. A failed installation restores the previous programs
as described in [When installation fails](#when-installation-fails).

## Uninstall

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

This removes installer-managed programs, runtime companions, known native library
files and managed service files (including a unit the daemon's own `install-service`
wrote, which carries the product's description rather than the installer's marker),
keeping `~/.goodvibes` settings, sessions and memory.
Browser-driver, WebUI and retained directory backups are listed and preserved;
they may contain local additions or serve another deployment. Review those paths
before removing their contents. An active update, or one that left its claims
behind, must be resolved before uninstall can remove its programs. A saved installer can perform
this operation without release downloads. `scripts/uninstall.sh` also recognizes
receipt-owned installations made by the earlier checkout installer and invokes
their installed uninstaller. Their `--prefix` and `--purge` options remain available.
Without a receipt or a checkout, `uninstall.sh` runs the current installer script; set `GOODVIBES_VERSION=vX.Y.Z` to run that release's script instead.

## Explicit developer source installation

`./scripts/install-from-checkout.sh` is the separate developer build path. It
requires a clean checkout and the build toolchain. Its receipt-owned program/data
layout is distinct from release-binary installations. The curl installer does not
fall back to building source when a release asset is unavailable.

A checkout installation that fails, or is interrupted with Ctrl-C or a
termination signal or a hang-up (closing the terminal), restores the previously
installed version, restarts the service if it was running before, and releases
its locks. If the process is killed outright during an update, the next update or
uninstall restores the previous version first. After an update, earlier versions
are removed unless a terminal or agent is still running from them; they are
checked again on the next update. An existing `environment` file is never
overwritten: if `TYPESAFE_API_KEY` is exported but the file has no key, the
installer says so and names the file. Uninstall also completes when the data
directory has already been removed.

The installer and uninstaller take a lock directory beside each of the program
and data directories (`<directory>.lock`). The lock records the process that holds it. A lock left by a
process that is no longer running is reclaimed automatically; a lock held by a
running process is refused and names its pid. A lock with no owner record is
refused with the `rmdir` command that removes it once you have confirmed no
install or uninstall is running. `./scripts/uninstall.sh` can be run again after
a partial uninstall.

When a service is installed, the checkout installer also pairs the local TUI
with the daemon. If an earlier pairing attempt is recorded as unfinished, that
step is skipped: the installation still completes, the daemon keeps running,
and the installer prints how to clear the recorded attempt and the command that
pairs afterwards. Any other pairing failure fails the installation and restores
the previous version.
