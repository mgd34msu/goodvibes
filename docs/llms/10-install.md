# Installing, running as a service, updating and removing GoodVibes

This part covers everything from an empty machine to a working GoodVibes: the two installers and every option they take, what each one puts on disk, the daemon's background service on Linux and macOS, WSL2, updates, pinning and rolling back a release, uninstalling, every installer refusal with its fix, the `doctor` health checks, and the first-run setup screens of the terminal app and the Agent, one screen at a time.

Terms used here:

- The terminal app is the program `goodvibes`.
- The Agent is the program `goodvibes-agent`.
- The daemon is the program `goodvibes-daemon`.
- The web UI is the browser app that the daemon serves.
- The owner is the person whose installation it is.
- A provider is a model service (for example OpenRouter or Anthropic).
- The suite is the three programs plus the web UI bundle, the browser driver and the native libraries, all from one release. When a later step of an install fails, the replaced programs are put back and so is the browser driver the run had replaced, so the programs and the driver stay from one release.
- The install directory is the directory that holds the programs. It is `~/.local/bin` unless an option changes it.
- A release is a tagged GoodVibes version such as `v3.5.0`, published at `https://github.com/mgd34msu/goodvibes/releases`.

This part describes release {{release}}.

## Choosing an installation method

GoodVibes has two installers. They produce different layouts and must not be mixed in one install directory.

| Method | Command | Builds from source | Platforms | Data location | Service |
| --- | --- | --- | --- | --- | --- |
| Release installer | `curl -fsSL https://goodvibes.sh/install.sh \| sh` | No. It downloads prebuilt, checksum-verified programs. | Linux x64, Linux arm64, macOS x64, macOS arm64, and Windows through WSL2 | `~/.goodvibes` | systemd user unit on Linux, launchd user agent on macOS, written by the daemon itself |
| Checkout installer | `./scripts/install-from-checkout.sh` run inside a clone of the repository | Yes. It builds every program from the checked-out commit. | Linux x64 and Linux arm64 with glibc only | `~/.local/share/goodvibes-data/.goodvibes` | systemd user unit written by the installer |

Use the release installer unless the owner explicitly wants to run code built from a source checkout.

The release installer refuses to touch an install directory that the checkout installer owns (error `INSTALL_E114`). Remove the checkout installation first with its `goodvibes-uninstall` command; see [Building and installing from a source checkout](#building-and-installing-from-a-source-checkout).

## Supported systems and requirements

### Operating systems and processors

| `uname -s` | `uname -m` | Result |
| --- | --- | --- |
| `Linux` | `x86_64` or `amd64` | Installs the `linux-x64` release files. |
| `Linux` | `aarch64` or `arm64` | Installs the `linux-arm64` release files. |
| `Darwin` | `x86_64` or `amd64` | Installs the `macos-x64` release files. |
| `Darwin` | `aarch64` or `arm64` | Installs the `macos-arm64` release files. |
| `MINGW*`, `MSYS*`, `CYGWIN*`, `Windows_NT` | any | Refused with `INSTALL_E001`. Native Windows is not supported. Use WSL2 (see [Windows through WSL2](#windows-through-wsl2)). |
| anything else | any | Refused with `INSTALL_E002`. |
| `Linux` or `Darwin` | any other processor | Refused with `INSTALL_E003`. |

The Linux programs are built for glibc-based distributions. The release installer does not check the C library. On a musl distribution such as Alpine the downloaded programs cannot run, and the installer stops with `INSTALL_E017` or `INSTALL_E016` before it replaces anything.

### Tools the release installer needs

The release installer is a POSIX `sh` script. It needs no Bun, Node, Git, compiler or package manager.

| Tool | Why | When missing |
| --- | --- | --- |
| `curl` or `wget` | Downloads the release files. `curl` is preferred. Every redirect must stay on HTTPS with either: `wget` asks for each hop's headers first and refuses a hop that is not `https://` (`INSTALL_E131`). | `INSTALL_E004`, `INSTALL_E131` |
| `sha256sum` or `shasum` | Verifies every download against the release's `SHA256SUMS.txt`. | `INSTALL_E005` |
| `stat` | Holds the identity of the install directory and its claim files during the install. | `INSTALL_E029` |
| `tar`, `awk`, `sed`, `mktemp`, `cmp`, `diff`, `cksum`, `ps`, `pgrep`, `kill` | Unpacking, parsing, comparing and process checks. These are present on every supported system. | The install stops at the first command that fails. |
| `perl` | Runs `--version` on other copies of the commands found on `PATH`, with a 5-second limit. | Only matters when another copy of a command shadows the new one; that copy is then reported as unidentified and is never removed automatically (see [When another copy of a command is found on PATH](#when-another-copy-of-a-command-is-found-on-path)). |
| `systemctl` (Linux) or `launchctl` (macOS) | Registers and restarts the daemon's service. | The programs install, and the installer prints the command to start the daemon by hand. |

The installer also needs HTTPS access to `goodvibes.sh` (for the script), to `github.com` and to the GitHub download host that `github.com` redirects release downloads to, and write access to the install directory, to the shell startup file it edits, and to `$TMPDIR` (default `/tmp`). The downloaded programs run once from `$TMPDIR` for verification, so `$TMPDIR` must allow execution. When `/tmp` is mounted `noexec`, set `TMPDIR` to a directory under the home directory.

```sh
mkdir -p "$HOME/.cache/goodvibes-tmp"
curl -fsSL https://goodvibes.sh/install.sh | TMPDIR="$HOME/.cache/goodvibes-tmp" sh
```

Run the release installer as the owner's normal user. It does not use `sudo` and does not need root. It does not refuse to run as root, but it then installs into root's home directory and root's user service manager.

### Network access, proxies and machines without internet

Hosts each part contacts (besides the model providers and services the owner configures):

| Who | Address | When |
| --- | --- | --- |
| The one-line install | `https://goodvibes.sh/install.sh` | Fetching the script. |
| The release installer | `https://github.com/mgd34msu/goodvibes/releases/latest` (a `HEAD` request, for `latest` only) and `https://github.com/mgd34msu/goodvibes/releases/download/<tag>/<file>`, plus the GitHub download host those URLs redirect to | Every install. The repository is fixed in the script; no option changes it. |
| `goodvibes-daemon provision-wake-model` (run by the installer) and every daemon start while the model is missing | `https://github.com/mgd34msu/goodvibes/releases/download/voice-runtimes-v1/<file>`, falling back to `https://github.com/mgd34msu/goodvibes-sdk/releases/download/voice-runtimes-v1/<file>` | Until the wake-word model is present. |
| The daemon's update loop | `update.releasesUrl` (default `https://github.com/mgd34msu/goodvibes/releases/latest`) and the matching `.../releases/download/<tag>/` | First check about 30 seconds after start, then hourly, while `update.auto` is `true`. |
| Launch updates, the Agent's while-running updates and `/update` | `https://github.com/mgd34msu/goodvibes/releases/latest` and `.../releases/download/<tag>/`; fixed, `update.releasesUrl` does not change them | At an interactive start (results kept six hours), hourly in the Agent, on `/update check` and `/update apply`. |
| Browser tools | Playwright's own download servers, for the browser itself | `goodvibes-agent browser provision`, or the first use of a browser tool. |
| The checkout installer | `https://github.com/oven-sh/bun/releases/...` and `https://nodejs.org/dist/latest-v22.x/` when the local `bun` or `node` does not fit, and the npm registry for `bun install --frozen-lockfile` | Every run. |

Proxies:

- The release installer downloads with `curl` (or `wget` when `curl` is missing). Both read the standard proxy variables of their own: for `curl`, `https_proxy` (or `HTTPS_PROXY`), `all_proxy` and `no_proxy`; for `wget`, `https_proxy` and `no_proxy`. The installer also runs the downloaded `goodvibes-daemon` (the wake-word download, `webui enable`), which inherits the same environment. Give the first `curl` the proxy too:

  ```sh
  P=http://proxy.example:3128
  curl -x "$P" -fsSL https://goodvibes.sh/install.sh \
    | https_proxy="$P" HTTPS_PROXY="$P" http_proxy="$P" HTTP_PROXY="$P" sh
  ```

- The programs run on Bun, whose built-in `fetch` uses `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (Bun's own behaviour, either letter case). The update checks and downloads and provider requests go through the proxy. Requests to this machine never do: while a proxy variable is set, `goodvibes`, `goodvibes-agent` and `goodvibes-daemon` add `localhost`, `127.0.0.1`, `[::1]` and `::1` to `NO_PROXY` and `no_proxy` at start (keeping the entries already there; with `*` nothing is added), and any other loopback address a request names (another `127.x.x.x`, `0.0.0.0`) the first time one is used. So the terminal programs reach their own daemon at `http://127.0.0.1:3421` directly, the daemon's operator token never goes to the proxy, and a local model server such as Ollama is reached directly. Programs they start (a shell command, `curl`) inherit the same list. Add other addresses that must be reached directly (a daemon on the LAN, a model server on another machine) to `NO_PROXY` yourself. For example:

  ```sh
  export HTTPS_PROXY=http://proxy.example:3128 HTTP_PROXY=http://proxy.example:3128
  goodvibes
  ```

  For a daemon run as a systemd service, the variables must be in the service's environment, for example with a drop-in file `~/.config/systemd/user/goodvibes.service.d/proxy.conf` holding `[Service]`, `Environment=HTTPS_PROXY=http://proxy.example:3128` and `Environment=HTTP_PROXY=http://proxy.example:3128` lines, then `systemctl --user daemon-reload` and `goodvibes-daemon restart-service`. A drop-in survives `refresh-service`, which rewrites only the unit file itself; remove it by hand when uninstalling.
- Some daemon features connect only directly and refuse while any of `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (in any letter case) is set for the daemon: reading Slack and Discord inboxes over HTTP, reading the owner's mail, and source screening. On a network that reaches the internet only through a proxy, those features cannot work; the daemon needs the proxy variables for everything else it fetches (updates, providers, the decision model).

A machine with no route to GitHub installs from a directory holding a copy of the release: `sh install.sh --from-dir <dir>` (or `GOODVIBES_RELEASE_DIR=<dir>`) reads every file from that directory, checks each against the directory's `SHA256SUMS.txt` exactly as a download is checked, and makes no request to GitHub (see [What each option does](#what-each-option-does)). Also:

- A machine that reaches GitHub through a proxy: set the proxy variables as above.
- Turning off every later network update: add `--no-auto-update` (see [A fresh install with automatic updates off from the very first start](#a-fresh-install-with-automatic-updates-off-from-the-very-first-start)). `--from-dir` skips the wake-word model unless `GOODVIBES_WAKE_MODEL` is set; the daemon still tries that download at each start, and `GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1` in the daemon's environment stops that.
- For the daemon's own updates only, `update.releasesUrl` accepts a feed on the same machine: `http://127.0.0.1:<port>/<path>/releases/latest` (or `localhost`, `[::1]`). The feed must answer a `HEAD` request for that URL with a redirect to `<same origin>/<path>/releases/tag/vX.Y.Z`, and serve the release files, `SHA256SUMS.txt` among them, under `<same origin>/<path>/releases/download/vX.Y.Z/`. The terminal programs' updates and the installer cannot use such a feed.
- The checkout installer can run without internet only when the right `bun` and `node` are already on `PATH` and Bun's package cache already holds every dependency.

## Installing with the release installer

### The one-line install

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

On a new Linux x64 machine where `~/.local/bin` is not on `PATH`, the shell is bash and the user is `alex`, these are the lines the installer prints, in order. Words in angle brackets are filled in at run time.

```text
Installing GoodVibes v3.5.0 for linux-x64 into /home/alex/.local/bin

Installing goodvibes v3.5.0 ...
  installed  /home/alex/.local/bin/goodvibes

Installing goodvibes-daemon v3.5.0 ...
  installed  /home/alex/.local/bin/goodvibes-daemon
  running:   goodvibes-daemon 3.5.0

Added /home/alex/.local/bin to PATH in /home/alex/.bashrc (installer-managed; uninstall removes it).

Installed: goodvibes 3.5.0
  installed  /home/alex/.local/bin/lib/sqlite-vec-linux-x64/vec0.so

Installing the web UI v3.5.0 ...
  installed  /home/alex/.local/bin/webui/3.5.0
  installed  /home/alex/.local/bin/playwright-core

Installing goodvibes-agent v3.5.0 ...
  installed  /home/alex/.local/bin/goodvibes-agent
  running:   goodvibes-agent 3.5.0

Installing the wake-word model ...
  wake-word model: Wake-word model installed and verified: "hey goodvibes" <model version> (<size>). Turn it on with voice.wake.enabled, nothing further to download.
  web UI: served by the daemon from /home/alex/.local/bin/webui/3.5.0
    http://127.0.0.1:3421
    reachable from this machine only (the control-plane listener is bound to loopback).
    To reach it from another device on your network:  goodvibes-daemon webui enable --lan
    A running daemon applies this within about a second; no restart is needed.

Setting up the goodvibes daemon as a systemd user service ...
  installed the systemd service at /home/alex/.config/systemd/user/goodvibes.service
  service is enabled and running
  lingering: enabled for alex, the daemon starts at boot.

Done. Start with: /home/alex/.local/bin/goodvibes   (health check: /home/alex/.local/bin/goodvibes doctor)
PATH updated in /home/alex/.bashrc; open a new shell (or run: . /home/alex/.bashrc) to use the plain 'goodvibes' command from then on.
Personal agent:   goodvibes-agent
Web UI:           http://127.0.0.1:3421
```

When the install directory was already on `PATH`, the closing line is `Done. Start with: goodvibes   (health check: goodvibes doctor)` and there is no PATH line. Who can reach the web UI, and the command that changes it, is in the daemon's own `web UI:` lines above; the closing `Web UI:` line gives only the address.

When the daemon or the web UI is not running as asked, the closing lines start with `Installed.` instead of `Done.`, repeat each problem after the `NOTE:` that first reported it, end with `Installed, with the problems above.` and the installer exits `4`. The programs are installed either way. The problem lines are:

| Line | Meaning |
| --- | --- |
| `Web UI:           NOT configured (the daemon refused); serve it with: <dir>/goodvibes-daemon webui enable --bundle-dir <dir>` | `goodvibes-daemon webui enable` refused; the bundle is on disk. |
| `No-service choice: NOT saved; save it with: <dir>/goodvibes-daemon config set service.enabled false` | `--no-service` could not be recorded, so a daemon started by hand may install a service. |
| `Daemon service:   NOT set up; see the NOTE above. Then run: <dir>/goodvibes-daemon install-service` | `install-service` failed, or the daemon could not report on its service (user service manager unreachable). |
| `Daemon service:   installed but NOT running; inspect it with: <dir>/goodvibes-daemon service-status` | `install-service` exited `3`. |
| `Daemon restart:   NOT done; a daemon may still run the previous version, or none may be running. See the NOTE above.` | A service restart or reload failed, the daemon of a restarted systemd unit exited before it was serving, or a daemon started by hand exited before it was serving again. |

`Automatic updates: NOT turned off` and `Decision policy:  NOT saved` are printed the same way but do not change the exit status.

The `wake-word model:` line is one of these, depending on what happened:

| Outcome | Line after `wake-word model: ` |
| --- | --- |
| Downloaded | `Wake-word model installed and verified: "hey goodvibes" <model version> (<size>). Turn it on with voice.wake.enabled, nothing further to download.` (a sentence about the mobile tflite form is added when that form did not land; it affects nothing on this host) |
| Already present | `The wake-word model is already present and verified (<model version>); nothing was downloaded.` |
| Skipped by `GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD` | `The wake-word model was not downloaded because GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD is set. Wake-word detection reports not-provisioned until it is fetched; clear that variable and the next daemon start fetches it automatically.` |
| Download failed | `The wake-word model could not be downloaded (<reason>); installation continues. Wake-word detection reports not-provisioned until it is fetched, and the next daemon start fetches it automatically. Nothing needs doing by hand.` |
| Could not check | `The wake-word model could not be checked (<reason>); installation continues. Wake-word detection reports not-provisioned until it is fetched, and the next daemon start fetches it automatically.` |
| Home directory unusable | `skipped: <reason>` |

After a successful install:

1. Open a new terminal, or run the `. <file>` command the installer printed, so the plain command names work.
2. Run `goodvibes doctor` to check the installation (see [Checking an installation with doctor and status](#checking-an-installation-with-doctor-and-status)).
3. Run `goodvibes` in a project directory for the first-run setup (see [First run and onboarding](#first-run-and-onboarding)).

When `curl` itself cannot download the script (no network, DNS failure, proxy), `curl` prints its own error, such as `curl: (6) Could not resolve host: goodvibes.sh`, and `sh` receives an empty script and does nothing. Nothing is installed. Fix the network and run the command again.

### Passing options

Every option can be given as an environment variable on the `sh` side of the pipe:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.5.0 GOODVIBES_WEBUI=0 sh
```

Some options also exist as command-line flags. With `curl | sh`, flags follow `sh -s --`:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --version v3.5.0 --no-service
```

A downloaded copy of the script takes the same flags directly:

```sh
curl -fsSL https://goodvibes.sh/install.sh -o install.sh
sh install.sh --bin-dir "$HOME/bin" --decision-policy Hybrid
```

`sh install.sh --help` prints:

```text
Install released GoodVibes binaries, daemon, agent, browser driver and WebUI.
Usage: install.sh [--version VERSION] [--bin-dir DIR] [--from-dir DIR] [--no-service|--service] [--no-auto-update]
                  [--decision-policy POLICY] [--uninstall]
GOODVIBES_VERSION selects one monorepo release (default: latest). No source build is performed.

Options:
  --version VERSION     Install this release, such as v3.5.0, for every program (default: latest;
                        also GOODVIBES_VERSION).
  --bin-dir|--install-dir DIR  Put the commands in DIR (default: ~/.local/bin; also GOODVIBES_INSTALL_DIR).
  --from-dir DIR        Install from DIR, a directory holding the release files and their SHA256SUMS.txt,
                        with no request to GitHub; every file is checked against that list (also
                        GOODVIBES_RELEASE_DIR). The release is read from the file names unless --version names it.
  --no-service          Do not install the daemon as a service, and record that choice so a daemon started
                        by hand never installs one (also GOODVIBES_DAEMON_SERVICE=0).
  --service             Install the daemon as a service (the default), even when GOODVIBES_DAEMON_SERVICE=0.
  --no-auto-update      Keep the daemon, the terminal app and the Agent from updating themselves, from their
                        first launch (also GOODVIBES_AUTO_UPDATE=0). Update later by running this installer.
  --decision-policy POLICY  Save the decision model policy (the judgment.policy setting; the daemon refuses
                        a value it does not accept and names the allowed ones; see the current one with
                        goodvibes-daemon config get judgment.policy).
  --uninstall           Remove the installed programs and services; settings and data in ~/.goodvibes are kept.
  --help|-h             Print this help and exit.
```

A flag given on the command line wins over the matching environment variable. `--no-service` and `GOODVIBES_DAEMON_SERVICE=0` print the same `Daemon service setup skipped (--no-service); service.enabled records that this machine runs without one,` lines.

The complete list of installer options and environment variables, generated from the installer:

<!-- generated: installer-options -->

### What each option does

| Option | Values and default | Effect |
| --- | --- | --- |
| `GOODVIBES_VERSION` or `--version VERSION` | `latest` (default) or a release tag | Selects the release for every program. `latest` follows GitHub's "latest release" redirect for `mgd34msu/goodvibes`. A tag may be written `v3.5.0` or `3.5.0`; the installer adds the `v`. A tag must look like `vX.Y.Z`, optionally followed by `-` or `+` and letters, digits, dots or hyphens; anything else is `INSTALL_E009`. `--version` with no value is `INSTALL_E110`. Here `--version` selects a release; it does not print the installer's version. |
| `GOODVIBES_INSTALL_DIR` or `--bin-dir DIR` (alias `--install-dir DIR`) | `$HOME/.local/bin` | The directory that receives the programs and their support files. It is created when missing. A relative path or a symbolic link is resolved to its physical directory once at the start. The web UI goes to `<dir>/webui`, the browser driver to `<dir>/playwright-core`, native libraries to `<dir>/lib`. |
| `GOODVIBES_DAEMON_SERVICE=0` or `--no-service` | `1` (default) | Skips first-run service registration and, when no daemon service is installed, records the choice with `goodvibes-daemon config set service.enabled false`. `service.enabled` is a daemon setting, read by the daemon before it would install itself as a service at its first idle moment and by `goodvibes doctor`, so a daemon started by hand stays without a service and doctor does not ask for one. The installer then prints `Daemon service setup skipped (--no-service); ...` followed by the daemon's path. `--service` (or `GOODVIBES_DAEMON_SERVICE=1`) turns it back on. Any value other than `1` means skip. An already installed service is left installed, recorded as it is, and refreshed and restarted on upgrade. The installer starts no daemon. When neither the flag nor the variable is given and `service.enabled` is already `false` (for example after `goodvibes-daemon uninstall-service`), no service is set up: the installer prints `Daemon service: off by your choice (service.enabled is false), so none was set up.` and `goodvibes-daemon install-service` as the way to turn it on. |
| `GOODVIBES_AUTO_UPDATE=0` or `--no-auto-update` | `1` (default) | Runs `goodvibes-daemon config set update.auto false` and `goodvibes-daemon config set update.autoUpdateAtLaunch false` before any program starts. Both are daemon settings, kept in `~/.goodvibes/daemon/settings.json` and read by the daemon, the terminal app and the Agent, so none of the three updates itself, from its first launch. The closing lines say `Automatic updates: off for goodvibes, goodvibes-daemon and goodvibes-agent.` If the daemon refuses a write, the install still finishes and says how to turn them off. Update later by running the installer again. Any value other than `0` leaves updates on. |
| `GOODVIBES_RELEASE_DIR=DIR` or `--from-dir DIR` | unset (default) | Installs from a directory holding the release's files (the same names as the release assets) and its `SHA256SUMS.txt`, and makes no request to GitHub. Each file is copied from the directory and checked against `SHA256SUMS.txt` exactly as a download is (`INSTALL_E010`, `INSTALL_E011`); a file missing from the directory is `INSTALL_E125`. The release is the one the web UI bundle's name in `SHA256SUMS.txt` names; `--version` must match it (`INSTALL_E129`), and when the list names no bundle `--version` is required (`INSTALL_E128`). A directory without `SHA256SUMS.txt` is `INSTALL_E127`, a directory that does not exist `INSTALL_E130`. The wake-word model is downloaded by the daemon, not shipped with the release, so it is skipped unless `GOODVIBES_WAKE_MODEL` is set. |
| `--decision-policy POLICY` | a value of the `judgment.policy` setting (quote one that contains spaces) | After the programs are installed, runs `goodvibes-daemon config set judgment.policy POLICY`, which checks the value against the setting and, when it refuses, names the allowed ones. Without this flag the policy is not changed. If the daemon refuses the write, the install still finishes and the closing lines say `Decision policy:  NOT saved` with the command to run. What each policy means is in the permissions and decisions part of this file. |
| `GOODVIBES_AGENT=0` | `1` (default) | Skips downloading and installing `goodvibes-agent`. An Agent installed earlier stays at its earlier version. The automatic updates and `/update apply` update only the programs present beside the running one, so they never add an Agent that is absent; to add it later, run the install command again without `GOODVIBES_AGENT=0`. The browser driver is still installed, because the daemon and the terminal app use it too. Any value other than `1` means skip. |
| `GOODVIBES_WEBUI=0` | `1` (default) | Skips the web UI bundle and leaves the daemon's web UI settings untouched. The installer prints how to serve a bundle later. Any value other than `1` means skip. |
| `GOODVIBES_WAKE_MODEL=0` | `1` (default) | Skips `goodvibes-daemon provision-wake-model`, which downloads and checksum-verifies the "hey goodvibes" wake-word model into `~/.goodvibes/voice/wake/` (`models/` and `front-end/` below it). Use it on a machine without internet access to that host, or when the wake word is not wanted. A failed download never fails the install, and a running daemon retries at every start. `/voice wake-setup` fetches it later. The environment variable `GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1` (also `true` or `yes`) makes the daemon's own provisioning skip the download. |
| `GOODVIBES_RESTART_DAEMON=0` | `1` (default) | On an upgrade, leaves running daemon and Agent processes alone. They keep running the old programs until restarted. A refreshed service definition then takes effect only at the next `goodvibes-daemon restart-service`; the installer says so. |
| `GOODVIBES_SHADOW_REMOVE` | `ask` (default), `1`, `0` | What to do when another copy of `goodvibes`, `goodvibes-daemon` or `goodvibes-agent` appears earlier on `PATH`. `ask` prompts on the terminal (`/dev/tty`), `1` removes recognised copies without asking, `0` only reports. Any value other than `1` or `0` means `ask`. See [When another copy of a command is found on PATH](#when-another-copy-of-a-command-is-found-on-path). |
| `GOODVIBES_UNINSTALL=1` or `--uninstall` | `0` (default) | Uninstalls instead of installing. No release is downloaded. See [Uninstalling](#uninstalling). |
| `GOODVIBES_DAEMON_VERSION`, `GOODVIBES_AGENT_VERSION`, `GOODVIBES_WEBUI_VERSION` | default to `GOODVIBES_VERSION` | Kept only for compatibility. Every program comes from one release. If any of them differs from `GOODVIBES_VERSION`, the install stops with `INSTALL_E008`. Do not set them. |
| `TMPDIR` | `/tmp` | Where the installer downloads and verifies the release before it changes anything. It is deleted when the installer exits. |
| `SHELL` | the login shell | Decides which startup file receives the PATH line (see [How the installer handles PATH](#how-the-installer-handles-path)). |

`GOODVIBES_VECTOR` is not read by the installer. The native SQLite and vector libraries are always installed.

`GOODVIBES_INSTALL_SH_LIB=1` makes the script define its functions and exit without doing anything. It exists for the installer's own tests. Never set it for a real install.

### Installation recipes

Install the newest release with every default:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

Install one exact release:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.5.0 sh
```

Install into a different directory, for example `~/bin`:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_INSTALL_DIR="$HOME/bin" sh
```

Install without the background service, and keep it that way:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --no-service
```

The installer records the choice (`service.enabled` `false`, a daemon setting in `~/.goodvibes/daemon/settings.json`), so a daemon started by hand never installs the systemd service at its first idle moment (see [Running the daemon without a service](#running-the-daemon-without-a-service)) and `goodvibes doctor` reports no service finding. On an existing installation, `goodvibes-daemon config set service.enabled false` records the same choice.

Install with automatic updates off from the first launch:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --no-auto-update
```

Install on a machine with no route to GitHub: copy the release's assets, its `SHA256SUMS.txt` and `install.sh` into one directory (from another machine, `gh release download v3.5.0 -R mgd34msu/goodvibes -D goodvibes-v3.5.0`), then run the installer from that copy:

```sh
sh install.sh --from-dir ./goodvibes-v3.5.0 --no-auto-update
```

With no service, no daemon runs until one is started by hand (`cd ~ && nohup goodvibes-daemon >/dev/null 2>&1 &`). The terminal app and the Agent never start a daemon that has no service: at start they only start an installed service that is stopped, and otherwise say that no daemon answers.

Install only the terminal app and the daemon, without the Agent, the web UI or the wake-word model:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_AGENT=0 GOODVIBES_WEBUI=0 GOODVIBES_WAKE_MODEL=0 sh
```

Install unattended (CI, a provisioning script, no terminal). Older copies on `PATH` are then removed only when `GOODVIBES_SHADOW_REMOVE=1`; with the default, an unanswerable question leaves them in place and the install still succeeds:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.5.0 GOODVIBES_SHADOW_REMOVE=1 sh
```

Upgrade an existing installation to the newest release: run the same install command again. See [Updating](#updating).

### What the installer does, in order

1. Reads its options and checks the operating system and processor.
2. If the install directory holds commands that link into a checkout installation (a `.../commands/goodvibes` link with an `installation.json` beside it), stops with `INSTALL_E114`.
3. Resolves the release tag. For `latest` it asks GitHub for the latest release and requires a tag of the form `vX.Y.Z` (`INSTALL_E006`, `INSTALL_E007`, `INSTALL_E123`); with `--from-dir` it reads the tag from the directory's `SHA256SUMS.txt` instead.
4. Downloads `SHA256SUMS.txt` and every file the platform needs from `https://github.com/mgd34msu/goodvibes/releases/download/<tag>/` (with `--from-dir`, copies them from that directory) into a private directory under `$TMPDIR`, and checks each against exactly one checksum line (`INSTALL_E010`, `INSTALL_E011`). Unpacks the browser driver and the web UI there and checks their entry files (`INSTALL_E012` to `INSTALL_E015`). On Linux, runs the downloaded daemon's runtime once to confirm the daemon's release record (`INSTALL_E016`, `INSTALL_E017`). Nothing installed has changed yet.
5. Claims the install directory: creates `goodvibes-daemon.update-transaction`, `goodvibes.update-transaction` and `goodvibes-agent.update-transaction` in it, plus a private directory `.goodvibes-install-claim.<random>`. A claim held by a running install or update stops this install (`INSTALL_E118`). A claim left by a process that no longer runs is recovered first: an interrupted earlier install is undone or finished, and its claims are released (`recovered` or `released` lines). Once this run holds all three claims, any other `.goodvibes-install-claim.<random>` directory is the leftover of a run killed before it claimed or after it released its claims: it is removed (`removed    <dir> (a claim directory an earlier installation left without claims)`), unless it holds a non-empty swap journal, which is named with how to finish it and kept. Uninstall does the same.
6. Refuses when partial files from an interrupted update are still beside the programs (`INSTALL_E043` to `INSTALL_E045`), or when `lib` is a symbolic link (`INSTALL_E046`).
7. When `.goodvibes-reader-requirements.json` exists in the install directory, asks each downloaded program whether it can read the saved data. A release too old to read it is refused and nothing is replaced (`INSTALL_E057`, `INSTALL_E058`).
8. Refuses when backups from an interrupted earlier install remain (`INSTALL_E027`).
9. Replaces the programs. Each file is copied in as `<file>.incoming` and renamed over the old one, so running processes keep the program they started with. Before each rename the old file is kept as `<file>.goodvibes-previous`, and every replacement is recorded in a swap journal in the private claim directory. Order: `goodvibes`, then `goodvibes-daemon` (and on macOS its SQLite library), then a `goodvibes --version` check (`INSTALL_E115`), then the vector library, then the web UI directory, then the browser driver directory, then `goodvibes-agent`.
10. Marks the swap finished, deletes the `.goodvibes-previous` backups and releases the claims. If anything fails or the installer is interrupted before this point, the previous programs are put back automatically (see [When an installation fails or is interrupted](#when-an-installation-fails-or-is-interrupted)). Then writes the PATH line (see [How the installer handles PATH](#how-the-installer-handles-path)); a startup file it cannot write never fails or undoes the install.
11. Saves the decision policy when `--decision-policy` was given, and turns automatic updates off when `--no-auto-update` was given.
12. Runs `goodvibes-daemon provision-wake-model` unless `GOODVIBES_WAKE_MODEL=0`.
13. Runs `goodvibes-daemon webui enable --bundle-dir <dir>/webui/<version>` unless `GOODVIBES_WEBUI=0`. The daemon writes the web UI settings and prints the address. This never widens network exposure: a daemon bound to loopback keeps serving this machine only.
14. Asks the daemon about its service (`goodvibes-daemon service-status --json`, whose `productServices` lists every daemon service GoodVibes wrote for this user). With `--no-service` and no service installed, records `service.enabled` `false`. When a service definition that GoodVibes wrote exists, runs `goodvibes-daemon refresh-service` so the definition matches the new program.
15. Restarts every running GoodVibes daemon service of this user (the default one and any second daemon under its own `service.serviceName`), a daemon started by hand without a terminal, and Agent processes without a terminal, so they use the new programs (unless `GOODVIBES_RESTART_DAEMON=0`). A program attached to a terminal (an interactive `goodvibes-agent`, a daemon in the foreground) is never stopped: it keeps running the previous version and the installer names it and asks for it to be restarted there.
16. When no daemon is running and no service definition exists, runs `goodvibes-daemon install-service`, which writes the service, starts it and tries to enable lingering (unless `--no-service`, or, with no service choice given, `service.enabled` is `false`).
17. Checks that typing each command name runs the copy just installed, and handles shadowing copies.
18. Prints the closing lines, and exits `4` when the daemon or the web UI is not running as asked (see the closing lines above).

### What lands where

Paths below use the default install directory `~/.local/bin` and the `linux-x64` platform. Replace `linux-x64` with `linux-arm64`, `macos-x64` or `macos-arm64`, and the vector library platform with `linux-arm64`, `darwin-x64` or `darwin-arm64`.

| Path | What it is |
| --- | --- |
| `~/.local/bin/goodvibes` | The terminal app. |
| `~/.local/bin/goodvibes-daemon` | The daemon. |
| `~/.local/bin/goodvibes-agent` | The Agent. Absent with `GOODVIBES_AGENT=0` on a first install. |
| `~/.local/bin/<program>.bun`, `<program>.bun.json`, `<program>.bun.LICENSE.md` | Linux only. A pinned Bun runtime shipped beside each compiled program, with its description and licence. The program uses it for work it runs in a separate Bun process; the installer and the updates always replace it together with its program. |
| `~/.local/bin/<program>.readers.json` | The data formats this program can read, when the release publishes that record. On Linux the daemon has none; on macOS all three can have one. |
| `~/.local/bin/daemon-installation.json` | Linux only. The daemon's record of the release it was installed from. |
| `~/.local/bin/lib/sqlite-vec-linux-x64/vec0.so` | The vector-search extension (`vec0.dylib` under `sqlite-vec-darwin-<arch>` on macOS). All three programs load it from here. |
| `~/.local/bin/lib/sqlite-darwin-<arch>/libsqlite3.dylib` and `libsqlite3.dylib.json` | macOS only. The SQLite library the daemon uses, and its record. |
| `~/.local/bin/playwright-core/` | The browser driver used by browser tools. Browsers themselves are downloaded later into a separate cache when first needed (`goodvibes-agent browser provision`). Holds `.goodvibes-release.json` naming its release. |
| `~/.local/bin/webui/<version>/` | The web UI bundle for that release, for example `webui/3.5.0/`. Every release the installer installs gets its own directory; older ones are never deleted by the installer. Holds `.goodvibes-release.json`. |
| `~/.local/bin/.goodvibes-reader-requirements.json` | Written by the programs when saved data needs a minimum reader. The installer only reads it. Never delete it to force a downgrade. |
| `~/.local/bin/<program>.previous` and other `*.previous` files | Rollback copies kept by an automatic update or `/update apply`. See [Rolling back](#rolling-back). |
| `~/.config/systemd/user/goodvibes.service` | Linux. The daemon's service, written by `goodvibes-daemon install-service`. |
| `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` | macOS. The daemon's service, written by `goodvibes-daemon install-service`. |
| `~/.goodvibes/` | All settings, sessions, memory, keys and tokens. Created by the programs on first use. Kept by every uninstall. |
| `~/.goodvibes/voice/` | The managed voice files. The wake-word model is in `~/.goodvibes/voice/wake/` (`models/`, `front-end/`). |
| `~/.goodvibes/logs/activity.md` | The daemon's activity log when its working directory is the home directory (as for the release service). It is renamed to `activity.md.1` at 10 MB. Every program writes such a log under `<its working directory>/.goodvibes/logs/`. |
| `~/.goodvibes/daemon/service/` | The service's own state directory: the pid file and log of the `manual` platform. The log path the status reports here (`systemd.log`, `launchd.log`) is written only by the `manual` platform (see [Using the service manager directly](#using-the-service-manager-directly)). |
| One line pair in `~/.bashrc`, `~/.bash_profile`, `~/.zshrc`, `~/.config/fish/config.fish` or `~/.profile` | The PATH line, only when the install directory was not on `PATH`. |

During an install, these exist only temporarily: `<program>.update-transaction` (claims), `.goodvibes-install-claim.<random>/` (private claim directory with the swap journal), `<file>.incoming`, `<file>.goodvibes-previous`, `<dir>.directory-update.lock` and `.goodvibes-directory-install.<random>/`. If one remains after the installer has exited, an install was interrupted; see [Installer errors and their fixes](#installer-errors-and-their-fixes).

### Moved homes: `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` and `GOODVIBES_AGENT_HOME`

The release installer sets none of these; every path above assumes they are unset. Three environment variables move parts of the tree:

| Variable | Read by | What moves |
| --- | --- | --- |
| `GOODVIBES_HOME=<dir>` | the terminal app, the daemon and the Agent | The tree root: everything under `~/.goodvibes/` is used from `<dir>/.goodvibes/` instead (each program's settings, the daemon's own settings file `daemon-host/settings.json`, local users, device tokens, sessions, memory and the other stores under `tui/`, the voice tree, the secret stores), and the daemon home with it unless `GOODVIBES_DAEMON_HOME` is set. |
| `GOODVIBES_DAEMON_HOME=<dir>` (or the daemon's `--daemon-home <dir>`) | the daemon, and every client that reads the daemon's files | The daemon home, which holds exactly: `settings.json` (the daemon-owned settings), the daemon secret store (`secrets.enc` or `secrets.json`), `operator-tokens.json`, `owner-profile.md` and `daemon-settings.json`. Order: `--daemon-home`, then `GOODVIBES_DAEMON_HOME`, then `<tree root>/.goodvibes/daemon`. For the daemon itself a moved daemon home is also the tree root when `GOODVIBES_HOME` is not set, so everything else it keeps moves to `<dir>/.goodvibes/`; a client reads only the daemon's files there. |
| `GOODVIBES_AGENT_HOME=<dir>` | the Agent only | Moves the Agent alone, ahead of `GOODVIBES_HOME`: its settings, sessions, memory, skills, personas and routines move to `<dir>/.goodvibes/agent/`, its secret stores and `secrets.key` to `<dir>/.goodvibes/`, and the daemon files it reads to `<dir>/.goodvibes/daemon/` unless `GOODVIBES_DAEMON_HOME` is set. Without it the Agent's tree is `GOODVIBES_HOME`'s, else the login home's, the same as the terminal app's and the daemon's, so the three share one `secrets.key`. |

A moved daemon home isolates a daemon: with `--daemon-home <dir>` (or `GOODVIBES_DAEMON_HOME=<dir>`) and no `GOODVIBES_HOME`, local users and the bootstrap file, device tokens, sessions, memory, the daemon's other stores and its client-scoped settings live under `<dir>/.goodvibes/`, so two daemons with different daemon homes share none of them. To run a fully separate daemon (for testing, say), give it its own daemon home and its own port (`goodvibes-daemon --daemon-home <dir> config set controlPlane.port <n>`). `GOODVIBES_HOME=<dir>` does the same, with the daemon home at `<dir>/.goodvibes/daemon`.

A daemon started with any of `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` or `--daemon-home` set never updates itself and never promotes itself to the service. The service definition itself always stays under the login home (`~/.config/systemd/user`, `~/Library/LaunchAgents`), and so does the service's state directory `~/.goodvibes/daemon/service/`, whatever these variables say.

### How the installer handles PATH

When the install directory is already on `PATH`, the installer changes no startup file.

Otherwise it appends two lines to one startup file, chosen from `$SHELL`:

| `$SHELL` ends in | File | Line written after the marker comment |
| --- | --- | --- |
| `/zsh` | `~/.zshrc` | `export PATH="<dir>:$PATH"` |
| `/bash` | `~/.bashrc`, or `~/.bash_profile` when that exists and `~/.bashrc` does not | `export PATH="<dir>:$PATH"` |
| `/fish` | `~/.config/fish/config.fish` | `set -gx PATH <dir> $PATH` |
| anything else | `~/.profile` | `export PATH="<dir>:$PATH"` |

The marker comment is `# managed by goodvibes install.sh`. Running the installer again does not add a second line for the same directory. Installing into a second directory adds a second pair. Uninstalling removes only the pair for its own directory, writing the file back in place, so a startup file that is a symbolic link stays a link.

When the startup file cannot be written (a read-only file, a link into a read-only store), the install still completes: the installer prints `NOTE: could not write <file>; add this line to your shell startup file yourself:` followed by the line, and the closing lines name the programs by their full path. When uninstall cannot rewrite it, it prints `NOTE: could not rewrite <file>; delete these two lines from it yourself:` followed by the marker comment and the line, and does not list the PATH line as removed.

The current shell does not see the change. Open a new terminal or run `. ~/.bashrc` (with the file the installer named).

### When another copy of a command is found on PATH

After installing, the installer checks each of `goodvibes`, `goodvibes-daemon` and `goodvibes-agent`. It models the shell the owner is about to open: when it wrote (or finds) its PATH line, the install directory counts as first on `PATH`.

When the install directory is not on `PATH` at all and no PATH line exists, it prints:

```text
PROBLEM: /home/alex/bin/goodvibes is installed, but /home/alex/bin is not on your PATH,
         so typing "goodvibes" does not reach it.
         Add it to your PATH, or run it by full path: /home/alex/bin/goodvibes
```

When a directory earlier on `PATH` holds another `goodvibes`, it prints which copy wins and the version of each:

```text
PROBLEM: typing "goodvibes" does not run the copy this installer maintains.
         wins on PATH: /home/alex/.bun/bin/goodvibes (version 1.18.1)
         installed here: /home/alex/.local/bin/goodvibes (version 3.5.0)
```

Then, for each earlier copy:

- A copy that is the same file reached by another path is ignored.
- A copy the installer recognises as an earlier GoodVibes is offered for removal. It is recognised only when it is inside the home directory, answers `--version` with exactly `<command> <version>`, and is either a plain file this installer recorded writing (it lists every program it places in `${XDG_STATE_HOME:-~/.local/state}/goodvibes/installed-programs`; a file not listed there is reported and never removed) or a link from one of the old packages `@pellux/goodvibes-tui`, `@pellux/goodvibes-daemon` or `@pellux/goodvibes-agent` installed globally by `bun` or `npm`. The installer prints the exact removal command (`rm -- '<path>'`, `bun remove -g --ignore-scripts <package>` with that Bun's global directories, or `npm --prefix <prefix> rm -g --ignore-scripts <package>`) and asks `Remove it now? [y/N]` on the terminal. With `GOODVIBES_SHADOW_REMOVE=1` it removes without asking; with `0` it never removes.
- Any other copy is reported as `not something we can identify as one of our programs` and is never touched. Remove it yourself, or put the install directory earlier on `PATH`.

When no terminal is available to ask (a piped install with no controlling terminal), the copy is left in place, the installer says `(no terminal available to ask; leaving this copy in place for now; ...)`, and the install still succeeds.

When a shadowing copy remains for any other reason (declined, unidentified, removal failed, or the install directory is not on `PATH`), the installer ends with:

```text
Install FAILED to become reachable: another copy earlier on your PATH still
answers one or more of these commands. Until that is resolved, upgrading here
changes nothing you can run. Fix the copies named above, then re-run this
installer. To run this install directly in the meantime: /home/alex/.local/bin/goodvibes
```

and exits with status `3`. The programs are installed and the service is set up; only the command names are unresolved. Remove or rename the copies it named, or reorder `PATH`, then run the installer again.

### Exit status of the release installer

| Status | Meaning |
| --- | --- |
| `0` | Installed (or uninstalled) and every command name reaches the installed copy. Notes printed with `NOTE:` did not fail the install. |
| `1` | Refused or failed. The message ends with an id such as `(INSTALL_E036)`. If the failure came after programs began to be replaced, the previous programs were put back unless the message says otherwise. |
| `3` | Installed, but another copy earlier on `PATH` still answers a command name. |
| `129`, `130`, `143` | Interrupted by a hang-up, Ctrl-C or a termination signal. The installer first undid any partial replacement. |

Every refusal is printed to standard error as `install.sh: <sentence> (INSTALL_E###)`. The id never changes meaning between releases; look it up in [Installer errors and their fixes](#installer-errors-and-their-fixes).

### When an installation fails or is interrupted

Nothing installed changes until every file of the release has been downloaded and verified. A failure before the replacement step (bad network, wrong version, checksum mismatch, a refusal) leaves the existing installation exactly as it was.

Once replacement has begun, every replaced file is kept as `<file>.goodvibes-previous` and recorded in the swap journal. If the install then fails, or is stopped with Ctrl-C, a termination signal or a closed terminal, the installer:

1. puts every previous file back and deletes every file it had newly created;
2. releases its claims;
3. prints:

```text
install.sh: installation did not finish. The previous programs were restored and the installation claims were released; running services were not touched.
install.sh: to try again, re-run the installer: curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.5.0 sh
```

If the previous files cannot all be put back, the installer keeps the claims, the backups and the journal, and prints one command per file instead:

```text
install.sh: suite replacement did not finish and could not be undone automatically. Its claims (/home/alex/.local/bin/*.update-transaction) and journal (...) were kept.
install.sh: files this run replaced, with the command that puts each previous version back:
  restore: mv -f '/home/alex/.local/bin/goodvibes.goodvibes-previous' '/home/alex/.local/bin/goodvibes'
  new file, remove: rm -f '/home/alex/.local/bin/goodvibes-agent.readers.json'
install.sh: once those are done, remove the claims with: rm -f -- '/home/alex/.local/bin'/*.update-transaction '<claim dir>'/*; rmdir '<claim dir>'; then re-run the installer. Re-running the installer first retries this undo from the kept journal.
```

Running the installer again is the simplest fix: it retries the undo from the kept journal first.

An installer killed outright (SIGKILL, power loss, out of memory) cannot clean up. The next install or uninstall does it: when a `*.update-transaction` claim names a process that is no longer running, it undoes that run's partial replacement from its journal (or, when that run had already replaced every program, keeps the new programs and deletes its leftover backups), releases the claims and continues. It prints `recovered  an installation interrupted earlier (process <pid> is gone): <what it did>; its claims were released`. A claim left by an interrupted automatic update with no partial file beside the programs is released with `released   <claim> (process <pid> is gone and no partial file remains beside the program)`.

The web UI and browser driver directories are published as whole directories. A failed publication keeps (or restores) the directory that was there before and prints either `install.sh: the original directory was kept or restored; private staging was retained at <dir>.` or `install.sh: directory publication needs inspection; preserve <dir> and <lock> before retrying.` A directory that already holds exactly the release's files is left untouched, so repeating an install does not add copies.

A failure after the programs were replaced and committed (the policy write, the wake-word model, web UI configuration, the service step) never undoes the install. Each of those steps prints a `NOTE:` with the command to finish it by hand.

## The daemon's background service

### What the service is

The daemon is the long-running GoodVibes host. The terminal app, the Agent and the web UI connect to it. The release installer registers it as a user service so it starts at login (and at boot when lingering is enabled) and restarts after a crash.

The daemon writes and manages its own service definition. The installer only runs the daemon's service commands.

| | Linux | macOS |
| --- | --- | --- |
| Service manager | systemd, user instance (`systemctl --user`) | launchd, the user's GUI domain (`gui/<uid>`) |
| Service name | `goodvibes` (unit `goodvibes.service`) | label `sh.goodvibes.daemon` |
| Definition file | `~/.config/systemd/user/goodvibes.service` | `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` |
| Starts | at login; at boot when lingering is enabled | at login (launchd agents run only in a logged-in session) |
| Restarts after a crash | `Restart=on-failure`, 2 seconds apart, never giving up (`StartLimitIntervalSec=0`); on systemd 254 or newer the delay grows over 8 attempts up to 300 seconds | `KeepAlive` is true |

The setting `service.serviceName` replaces the name on both systems. Leave it empty unless two daemons must run as separate services. The setting `service.restartOnFailure` (default `true`) controls the restart lines. Saving it, or `service.logPath`, however it is saved, rewrites the definition (what `goodvibes-daemon refresh-service` does): the running daemon service does it at once, or at its next start when no daemon ran; a definition GoodVibes did not write is left alone and the owner is told. The change takes effect at the next daemon start; nothing is restarted. `goodvibes-daemon config set` says so: `the daemon service rewrites its service definition with it (at once when it runs, else at its next start); it takes effect at the next daemon start.`

The definition file is written with mode `600`. One builder produces it for every writer: `goodvibes-daemon install-service` and `refresh-service` (so the release installer's first install and every upgrade, and the checkout installer), `goodvibes service install` (which runs `goodvibes-daemon install-service`), the terminal app's settings screen, and a running daemon that installs the service itself (the Linux self-promotion of a hand-started daemon, the adoption of the service after an unsupervised daemon updated itself, and the service-install action of the daemon's API used by the web UI). Its contents:

| Field | Value |
| --- | --- |
| Description | `GoodVibes daemon (shared session broker + companion host)`. The service commands count a definition as written by GoodVibes when it carries this description. |
| `ExecStart` / `ProgramArguments` | The daemon program with no arguments (never the arguments a hand-started daemon was started with), plus `--daemon-home <dir>` only for a moved daemon home. For a checkout installation it is the installation's launcher, `<prefix>/commands/goodvibes-daemon`, which pins the release and loads the private environment file. |
| Environment | None, except `GOODVIBES_HOME=<dir>` when the tree root was moved. Never a token: `GOODVIBES_DAEMON_TOKEN` or `GOODVIBES_HTTP_TOKEN` set in the shell that ran the install is not written into the file; the daemon reads its operator token from its home at every start. |

Status output shows the value of any `Environment=` line (or plist `EnvironmentVariables` entry) as `<redacted>`, for a definition the owner edited.

A release-installed unit looks like this:

```ini
[Unit]
Description=GoodVibes daemon (shared session broker + companion host)
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/home/alex
ExecStart=/home/alex/.local/bin/goodvibes-daemon
Restart=on-failure
RestartSec=2
RestartSteps=8
RestartMaxDelaySec=300

[Install]
WantedBy=default.target
```

The unit carries no `--hostname` or `--port`: the daemon reads its address from settings at every start, so a changed `controlPlane.port` needs only a restart, not a new unit. It carries `--daemon-home <dir>` only when the daemon home was moved away from `<tree root>/.goodvibes/daemon`, and `Environment=GOODVIBES_HOME=<dir>` only when the tree root was moved (see [Moved homes: `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` and `GOODVIBES_AGENT_HOME`](#moved-homes-goodvibes_home-goodvibes_daemon_home-and-goodvibes_agent_home)). The working directory is the home directory unless the owner chose another.

The macOS plist has the keys `Label`, `GoodVibesManagedBy`, `ProgramArguments`, `WorkingDirectory`, `RunAtLoad` (true), `KeepAlive` and, when needed, `EnvironmentVariables`. The `GoodVibesManagedBy` key marks it as written by GoodVibes.

### Who wrote the definition

Every service command first reads the file at the definition path and classifies it:

| `definitionOwner` | Meaning | What the service commands do |
| --- | --- | --- |
| `product` | GoodVibes wrote it (it carries the GoodVibes description or `GoodVibesManagedBy` key). | Manage it normally. |
| `other` | Something else wrote it, or it is a symbolic link. | `install-service`, `refresh-service` and `uninstall-service` change nothing and exit `5`. |
| `absent` | No file. | `install-service` and `refresh-service` write one. |
| `unreadable` | The file could not be read. | The commands change nothing and exit `1`. |

To hand a hand-written definition back to GoodVibes, move it aside and write a fresh one:

```sh
mv ~/.config/systemd/user/goodvibes.service ~/goodvibes.service.mine
goodvibes-daemon refresh-service
goodvibes-daemon restart-service
```

A unit written by the checkout installer has the description `GoodVibes daemon and WebUI`, which the daemon's commands classify as `other`. Manage a checkout installation's service with that installation's own commands.

### Lingering (Linux)

A systemd user unit with `WantedBy=default.target` starts when the owner logs in. Lingering starts the owner's user manager at boot, so the daemon runs on a machine nobody has logged into. `goodvibes-daemon install-service` checks `loginctl show-user <user> --property=Linger`, runs `loginctl enable-linger <user>` when it is off, checks again, and prints one of:

```text
lingering: already enabled for alex, the daemon starts at boot.
lingering: enabled for alex, the daemon starts at boot.
lingering: could not be enabled (polkit may require an interactive session), the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger alex
lingering: could not determine the current user, the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger <user>
```

`refresh-service` never changes lingering. `uninstall-service` does not turn it off; turn it off with `loginctl disable-linger <user>` if nothing else needs it.

### The daemon's service commands

All of these run as the owner, with no `sudo`. They act on the user's own service manager.

| Command | What it does | Exit status |
| --- | --- | --- |
| `goodvibes-daemon install-service` | Writes the definition, registers it (`systemctl --user daemon-reload`), tries to enable lingering, then starts it (`systemctl --user enable --now goodvibes.service`, or `launchctl bootstrap gui/<uid> <plist>` / `launchctl kickstart`). Sets `service.enabled` to `true`. | `0` installed and running; `3` installed but not running (the receipt says why); `5` a definition GoodVibes did not write is there, nothing changed; `1` not installed. |
| `goodvibes-daemon refresh-service` | Rewrites a definition GoodVibes wrote earlier so it launches the current program (or writes one where none exists) and registers it. Starts and stops nothing. A definition that is already current is left untouched; current means the file matches and the service manager has taken it (on systemd, `systemctl --user show -p NeedDaemonReload -p LoadState` reports `no` and `loaded`; on Windows the logon task exists), so a `daemon-reload` that failed after an earlier write runs again instead of being reported current. A rewritten one is first copied to `<definition>.bak.<YYYYMMDDHHMMSS>`. The definition starts the daemon in the home: the daemon has no working folder, and one a 3.5.0 install wrote naming a project folder is rewritten to the home (the backup keeps it). | `0` current (rewritten, written or already so); `5` not written by GoodVibes, left as it is; `1` could not be read, backed up or written. |
| `goodvibes-daemon uninstall-service` | Stops and unregisters the service (`systemctl --user disable --now`, or `launchctl bootout gui/<uid>/<label>`), deletes the definition and reloads the manager. First sets `service.enabled` and `service.autostart` to `false`, so a daemon started by hand does not install the service again; when they cannot be saved it removes nothing and prints `service uninstall refused: <key> is locked by managed policy (<source>: <reason>), so nothing was removed.` or `... <key> could not be saved to <settings file> (<error>) ...`. When the removal then fails, the two settings are put back. | `0` removed; `4` nothing was installed; `5` not written by GoodVibes, left in place; `1` the settings could not be saved, removal failed, or the service still runs. |
| `goodvibes-daemon service-status` | Reports platform, whether installed, whether running, the definition path, the pid, and who wrote the definition. Queries systemd or launchd live. | `0` installed and running; `3` installed but not running; `4` not installed; `1` the service manager could not be asked. |
| `goodvibes-daemon service-status --json` | The same as one JSON document, plus `productServices`: the names of every daemon service GoodVibes wrote for this user (this one and any second daemon's). | The same codes. |
| `goodvibes-daemon start-service` | Starts the installed service (`systemctl --user enable --now`; on macOS `kickstart` when loaded, otherwise `bootstrap`). Never installs one. | `0` started and running; `3` installed but not running afterwards; `4` not installed; `1` the start failed. |
| `goodvibes-daemon stop-service` | Stops the service. The definition stays, so it starts again with `start-service`; on Linux at the next login (or at the next boot when lingering is on); on macOS at the next login only. Starting `goodvibes` or `goodvibes-agent` also starts a stopped, installed service. | `0` stopped; `4` not installed; `1` failed or still running. |
| `goodvibes-daemon restart-service` | Restarts the service. This is how a setting that is read only at startup takes effect. On macOS it boots the agent out and loads the plist again, so a rewritten plist takes effect. | `0` restarted and running; `3` installed but not running afterwards; `4` not installed; `1` failed. |

The global option `--daemon-home <dir>` also applies to these commands. The complete daemon command reference is in the daemon part of this file.

`install-service`, `refresh-service`, `start-service` and `restart-service` work only with an installed (compiled) daemon; any other copy refuses them with exit `2`.

Example: check the service from a script.

```sh
goodvibes-daemon service-status --json
case $? in
  0) echo "running" ;;
  3) echo "installed, stopped"; goodvibes-daemon start-service ;;
  4) echo "not installed"; goodvibes-daemon install-service ;;
  *) echo "service manager unreachable" ;;
esac
```

`service-status --json` prints:

```json
{
  "ok": true,
  "data": {
    "platform": "systemd",
    "serviceName": "goodvibes",
    "path": "/home/alex/.config/systemd/user/goodvibes.service",
    "definitionOwner": "product",
    "installed": true,
    "running": true,
    "autostart": false,
    "pid": 4182,
    "logPath": "/home/alex/.goodvibes/daemon/service/systemd.log",
    "suggestedCommands": [
      "systemctl --user daemon-reload",
      "systemctl --user enable --now goodvibes.service",
      "systemctl --user status goodvibes.service"
    ],
    "exitCode": 0
  }
}
```

`autostart` in this document is whether the installed service starts at login: on systemd and launchd it follows the `service.autostart` setting, which the daemon applies to the unit or LaunchAgent; a Windows logon task starts at login while installed. `platform` is one of `systemd`, `launchd`, `windows` or `manual` (the setting `service.platform`, default `auto`, picks systemd on Linux and launchd on macOS). When the service manager cannot be asked, the command prints prose even with `--json`, for example `service status failed: the systemd user manager could not be reached (no systemctl or no user session bus)`, and exits `1`.

The prose form of `service-status` prints these lines. `<platform>` is `systemd` or `launchd`; the label is `unit path:` on both.

```text
platform: <platform>
installed: true
running: true
unit path: <definition path>
pid: <pid>
definition: written by GoodVibes
```

The `pid:` line appears only while the service runs. When the service is installed but not running, a line `note: if this looks wrong, verify directly: systemctl --user status goodvibes.service` (on macOS `note: if this looks wrong, verify directly: launchctl print gui/<uid>/sh.goodvibes.daemon`) is added before the `definition:` line. The `definition:` line reads `written by GoodVibes`, `not written by GoodVibes (the service commands leave it as it is)` or `unreadable`, and is left out when nothing is installed.

`install-service` prints, on success (Linux; on macOS the first line is `installed the launchd service at /Users/alex/Library/LaunchAgents/sh.goodvibes.daemon.plist` and there is no lingering line):

```text
installed the systemd service at /home/alex/.config/systemd/user/goodvibes.service
service is enabled and running
lingering: enabled for alex, the daemon starts at boot.
```

and, when the daemon did not stay up, `suggested follow-ups if it did not start automatically:` followed by the manager's commands, and `could not start it automatically: <reason>`; the exit status is then `3`. When the service runs but is not set to start at login, the second line is `service is running; it does not start at login`. A service setting the install could not save (a managed-policy lock, or a daemon settings file that cannot be written) adds a line with the reason, for example `service.autostart is locked by managed policy (<source>: <reason>); the service will not start at login` or `service.enabled could not be saved to <file> (<error>); the daemon does not record that this machine has its service`; the exit status stays `0` when the service runs.

`start-service`, `stop-service` and `restart-service` print `<started|stopped|restarted> the <platform> service <name> (<definition path>)` and then `it is running` or `it is not running`; after a start or restart that left the service down, `suggested follow-ups:` and the manager's commands follow, and the command exits `3`. A stop that left the service running prints `service stop failed: the <platform> service <name> (<definition path>) is still running` and exits `1`. Examples: `stopped the systemd service goodvibes (/home/alex/.config/systemd/user/goodvibes.service)`, `stopped the launchd service sh.goodvibes.daemon (/Users/alex/Library/LaunchAgents/sh.goodvibes.daemon.plist)`. A refused or failed action prints `service <start|stop|restart> failed: <reason>` and exits `1`; on macOS a stop that launchd did not finish within 5 seconds gives the reason `launchd still held gui/<uid>/sh.goodvibes.daemon 5 seconds after it was booted out`. Aimed at a service that is not installed they print `no <platform> service is installed at <path>, so there is nothing to <start|stop|restart>.` and `install it first:  goodvibes-daemon install-service`, and exit `4`. `uninstall-service` prints `stopped and removed the <platform> service <name> (<path>)`.

The suggested commands are, for systemd: `systemctl --user daemon-reload`, `systemctl --user enable --now goodvibes.service`, `systemctl --user status goodvibes.service`; for launchd: `launchctl bootout gui/<uid>/sh.goodvibes.daemon || true`, `launchctl bootstrap gui/<uid> <plist>`, `launchctl print gui/<uid>/sh.goodvibes.daemon`.

### The terminal app's service commands

`goodvibes service` manages the same service with the same definition:

| Command | What it does | Exit status |
| --- | --- | --- |
| `goodvibes service` or `goodvibes service status` | Prints the service posture: settings, platform state, endpoints, log, and issues. | `0` |
| `goodvibes service check` | The same, and also tries a TCP connection to each enabled endpoint. | `1` when any issue is found, else `0` |
| `goodvibes service install`, `start`, `restart`, `stop`, `uninstall` | Runs `goodvibes-daemon install-service`, `start-service`, `restart-service`, `stop-service` or `uninstall-service` in the same shell environment and directory, prints its lines and the service summary, and exits with its exit status (see [The daemon's service commands](#the-daemons-service-commands)). After an install, start or restart that succeeded it also waits up to 10 seconds for the daemon to answer on its enabled endpoints and names one that does not. | the daemon command's when it is not `0`; `1` when the daemon command succeeded but the daemon never ran or answered; else `0` |

Add `--json` for a JSON result; its `ok` and `exitCode` are the exit status above. Any other word prints `Usage: goodvibes service [status|check|install|start|stop|restart|uninstall]` and exits `2`.

The two commands are one code path: the same definition, the same refusal of a definition GoodVibes did not write (exit `5`), the same start after an install, and the same record of the choice (`install-service` sets `service.enabled` to `true`, `uninstall-service` to `false`). The terminal app finds the daemon program beside itself; the environment variable `GOODVIBES_DAEMON_COMMAND` overrides that path for these commands.

The Agent has no service commands.

### Using the service manager directly

The daemon's commands are the supported way. These direct commands are equivalent for inspection.

On Linux:

```sh
systemctl --user status goodvibes.service
journalctl --user -u goodvibes.service -n 100 --no-pager   # the daemon's recent output
journalctl --user -u goodvibes.service -f                  # follow it live
systemctl --user restart goodvibes.service
```

On macOS:

```sh
launchctl print gui/$(id -u)/sh.goodvibes.daemon            # state, pid
launchctl kickstart -k gui/$(id -u)/sh.goodvibes.daemon     # restart
```

What the daemon's service commands do on macOS, in launchctl terms:

| Command | launchctl steps |
| --- | --- |
| `start-service` | `launchctl print gui/<uid>/sh.goodvibes.daemon`; when the job is loaded, `launchctl kickstart gui/<uid>/sh.goodvibes.daemon`; when it is not loaded, `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/sh.goodvibes.daemon.plist`. |
| `stop-service` | When loaded, `launchctl bootout gui/<uid>/sh.goodvibes.daemon`, then waits up to 5 seconds until launchd lets go of the job. Booting out unloads the job, so `KeepAlive` does not start it again. The plist stays in `~/Library/LaunchAgents`, so the job loads and starts again at the owner's next login (`RunAtLoad` is true), or with `start-service`. |
| `restart-service` | `bootout`, wait, then `bootstrap` of the plist, so a rewritten plist takes effect. |
| `uninstall-service` | `bootout`, wait, then delete the plist. |

On the `manual` platform (`service.platform manual`), `stop-service` sends the recorded process SIGTERM, waits up to 10 seconds, then sends SIGKILL and waits up to 2 seconds more. The pid file under `~/.goodvibes/daemon/service/` is removed only once the process is gone; when even SIGKILL does not end it, the stop fails with `the service process (pid <pid>) did not exit after SIGTERM and SIGKILL; its pid file is kept so status still finds it`, and `restart-service` starts no second process.

Where the daemon's output goes:

| Platform | Standard output and error | The daemon's activity log |
| --- | --- | --- |
| Linux (systemd) | The user journal: `journalctl --user -u goodvibes.service`. | `<working directory>/.goodvibes/logs/activity.md`; for the release service, whose working directory is the home directory, `~/.goodvibes/logs/activity.md`. |
| macOS (launchd) | Not kept. The plist names no `StandardOutPath` or `StandardErrorPath`, so launchd discards both. | `~/.goodvibes/logs/activity.md`, as on Linux. |
| `manual` platform | The file `service.logPath`, default `~/.goodvibes/daemon/service/manual.log`. | As above. |

`service-status` and `goodvibes doctor` always report a log path `~/.goodvibes/daemon/service/<platform>.log` (`systemd.log`, `launchd.log`). Only the `manual` platform writes that file; on systemd and launchd it never exists and `goodvibes doctor` shows it as `(not written yet)`.

The activity log is renamed to `activity.md.1` when it reaches 10 MB (one older copy is kept). `goodvibes-daemon status` shows what a running daemon is doing.

### Running the daemon without a service

When no service manager is available, or the service was skipped, start the daemon by hand:

```sh
goodvibes-daemon                       # serves in the foreground; Ctrl-C stops it
nohup goodvibes-daemon >/dev/null 2>&1 &   # serves in the background until logout or kill
```

Serving options such as `--port <n>` and `--hostname <host>` apply to that one run. To make a port permanent, set it with `goodvibes-daemon config set controlPlane.port <n>`.

On Linux, an installed daemon started by hand does not stay unsupervised when it can avoid it. At its first idle moment it installs the systemd user unit and hands over to the supervised instance, provided that a systemd user manager is reachable, `service.enabled` (a daemon setting, in `~/.goodvibes/daemon/settings.json`) is not `false`, and the daemon runs from the default home (no `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` or `--daemon-home` override). A daemon run from source never does this, and neither does one on macOS. To keep a hand-started daemon unsupervised, turn this off first (the release installer's `--no-service` does it for you):

```sh
goodvibes-daemon config set service.enabled false
```

To restart a daemon that runs without a service (after an update, a rollback or a setting read only at start):

```sh
goodvibes-daemon service-status     # exit 4 (not installed) confirms there is no service to restart
pgrep -a -f goodvibes-daemon        # find the daemon's pid: the line whose command is goodvibes-daemon or goodvibes-daemon serve
kill <pid>                          # SIGTERM: the daemon stops in order; wait until pgrep no longer lists it
cd ~ && nohup goodvibes-daemon >/dev/null 2>&1 &
```

Start it from the home directory, as the release installer does, so its working directory (and so its activity log and its project settings) is the home directory. When `service-status` exits `0` or `3` instead, a service exists (possibly installed by the daemon's own promotion); use `goodvibes-daemon restart-service`.

### A second daemon as its own service

The terminal app manages one daemon service per user: the one named by `service.serviceName` (default `goodvibes`, or `sh.goodvibes.daemon` on macOS). A second daemon can run as a service of its own, managed with the daemon's service commands, under systemd and launchd alike: both definitions carry the moved home (`Environment=GOODVIBES_HOME=...`, the plist's `EnvironmentVariables`). An installer upgrade restarts every daemon service GoodVibes wrote for this user, the second one included. A Windows scheduled task carries no environment, and the `manual` platform has no service manager, so there a daemon with a moved home is refused with exit `2` and a line saying so (`A daemon with a moved home (GOODVIBES_HOME, GOODVIBES_DAEMON_HOME or --daemon-home) cannot run as a Windows scheduled task: a task created by schtasks carries no environment variables, ...`).

A second daemon needs its own tree (`GOODVIBES_HOME`, or its own `--daemon-home`), its own port and its own service name (see [Moved homes: `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` and `GOODVIBES_AGENT_HOME`](#moved-homes-goodvibes_home-goodvibes_daemon_home-and-goodvibes_agent_home)). Steps, with `~/gv-second` as its tree and `~/gv-second/work` as its working directory:

```sh
mkdir -p ~/gv-second/work
cd ~/gv-second/work                                               # first: the daemon also reads <working dir>/.goodvibes/ as project settings
export GOODVIBES_HOME="$HOME/gv-second"
goodvibes-daemon config set controlPlane.port 3431                # its own port (the first daemon keeps 3421)
goodvibes-daemon config set service.serviceName goodvibes-second  # its own unit name
goodvibes-daemon install-service
```

Run these from the second daemon's working directory, never from the home directory: every daemon command also reads `<working directory>/.goodvibes/` as a project layer, and run from `~` that would be the first daemon's own files.

On Linux this writes `~/.config/systemd/user/goodvibes-second.service` (on macOS `~/Library/LaunchAgents/goodvibes-second.plist`) with `ExecStart=<install dir>/goodvibes-daemon`, `WorkingDirectory=` the directory it was run from, and `Environment=GOODVIBES_HOME=/home/<user>/gv-second`, and starts it. Manage it with the same `GOODVIBES_HOME` set and from the same working directory: `goodvibes-daemon service-status`, `stop-service`, `start-service`, `restart-service`, `uninstall-service`. With a moved home, `start-service` and `restart-service` first check that the installed definition matches this program, tree, daemon home and working directory, and otherwise refuse with `Service activation refused: the installed definition does not match the selected executable, tree, daemon home and workspace. No service was changed.`

What to know:

- The service state directory `~/.goodvibes/daemon/service/` is shared by both services; under systemd it holds nothing either needs.
- Both services run the same program file. An installer upgrade replaces it and restarts both (a stopped one stays stopped). An automatic update of the main daemon restarts only the main service, so restart the second afterwards (`GOODVIBES_HOME=~/gv-second goodvibes-daemon restart-service`).
- The second daemon never updates itself and never promotes itself to a service.
- Point the terminal app and the Agent at it with `GOODVIBES_HOME=~/gv-second goodvibes` and `GOODVIBES_HOME=~/gv-second goodvibes-agent`; the Agent then still needs to be paired with it (see [Pairing the Agent with the daemon](#pairing-the-agent-with-the-daemon)).
- Leave cluster settings and channel settings (`surfaces.*`) off in the second tree unless both daemons are meant to answer the same channels.

Without a service, run the second daemon by hand: `cd ~/gv-second/work && GOODVIBES_HOME=~/gv-second nohup goodvibes-daemon >/dev/null 2>&1 &`.

### Service settings

These settings control the service (type, default and description for each):

<!-- generated: settings:service -->

The `service.*` keys are daemon settings: one value for the machine, kept in the daemon's settings file `~/.goodvibes/daemon/settings.json` and read by the daemon, the terminal app, the Agent and the installers alike. A `service` key in a program's own file or a project's file is left out with a notice.

| Command | What it writes |
| --- | --- |
| `goodvibes-daemon config set service.<key> <value>` | the daemon's settings file |
| `/settings set service.<key> <value>` inside `goodvibes` | the same file (through the running daemon when one answers) |
| `goodvibes-daemon install-service` / `uninstall-service` (and `goodvibes service install` / `uninstall`) | `service.enabled` and `service.autostart` `true` / `false` |
| The release installer's `--no-service` (no service installed) and the checkout installer | `service.enabled` |
| A setup topic's Save (System, Setup) with a server-backed choice (browser, other devices, webhooks, chat apps) | `service.enabled`, `service.autostart` and `service.restartOnFailure` `true`; "Local TUI Only" leaves them as they are |

Editing a file by hand works too; each is plain JSON such as `{"service":{"enabled":false}}`. A program that is running notices a changed settings file within about a quarter of a second (it polls its own file, the project file, the shared file and the daemon's file every 250 ms) and applies the new values the way an in-app `set` does. Whether a value then changes behaviour at once depends on what reads it: the daemon's update loop reads its `update.*` keys once at start, launch updates read theirs at launch, and the `service.*` keys are read by the commands that use them each time they run. A program that is not running reads its file when it starts; the one-shot commands (`goodvibes doctor`, `goodvibes-daemon config`, ...) read the files each time they run.

Notes on how they behave:

- `service.enabled` (default `true`): whether this machine runs the daemon as a service. On, a hand-started daemon on Linux promotes itself to the service, and `goodvibes doctor` reports a missing or stopped service. Off (the installer's `--no-service`, `uninstall-service`), nothing installs one and doctor asks for none. It also decides whether the daemon's own service routes (used by the web UI and remote clients) are available. The command-line service commands work whatever its value.
- `service.autostart` (default `false`): whether the service starts on its own at login. The running daemon applies every change, however it was set (a settings screen, `/settings set` in either program, `goodvibes-daemon config set`, the API, or a hand edit of the daemon's settings file): on installs the service if it is not installed and enables it at login (systemd `enable`; a LaunchAgent with `RunAtLoad`); off disables it at login and leaves it installed and running (systemd `disable`; the LaunchAgent rewritten without `RunAtLoad`, restarted only after a failure). A value set while no daemon runs is applied when the daemon next starts, to an installed service. `install-service` turns it on and `uninstall-service` off; a hand-started daemon that promotes itself to the service turns it on. `goodvibes service start` enables the unit at login only when it is on. A Windows logon task starts at login while installed whatever its value, and the daemon says so when it is turned off. When the daemon could not apply a change, it tells you on the attached surfaces with the reason. At boot on Linux, lingering decides whether the daemon starts before anyone logs in. A daemon under an overridden home (`GOODVIBES_DAEMON_HOME`, `--daemon-home`) never changes the machine's service.
- `service.platform` (default `auto`) forces `systemd`, `launchd`, `windows` or `manual`. Leave it `auto`.
- `service.logPath` (default empty) names a log file for the `manual` platform. Empty uses `~/.goodvibes/daemon/service/<platform>.log`.

### Service problems and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Installer: `NOTE: goodvibes-daemon could not report on its service (is the user service manager reachable from this session?), so no service was set up.` | The installer ran where `systemctl --user` (or `launchctl print gui/<uid>`) cannot reach the user's manager: an SSH session without a user bus, `su`/`sudo -u` into the account, a container, or WSL2 without systemd. | Log in normally (desktop, or SSH with lingering enabled) and run `goodvibes-daemon install-service`. On WSL2, enable systemd first (see [Windows through WSL2](#windows-through-wsl2)). Or run the daemon by hand. |
| Installer: `No user service manager (systemd/launchd) is available to run the daemon automatically.` | `systemctl` or `launchctl` is not installed. | Run the daemon by hand (see [Running the daemon without a service](#running-the-daemon-without-a-service)). |
| `install-service` exit `3`, `service is ... not running` | The daemon started and exited, usually because its port is taken or a setting is invalid. | `journalctl --user -u goodvibes.service -n 50 --no-pager`, fix the cause, then `goodvibes-daemon start-service`. To use another port: `goodvibes-daemon config set controlPlane.port 3431` then `goodvibes-daemon restart-service`. |
| Exit `5` and `... is a systemd service definition GoodVibes did not write (or a link to one), so it was left as it is and nothing was written.` | The definition path holds a hand-written file or a link. | Move it aside and run the command again (see [Who wrote the definition](#who-wrote-the-definition)). |
| `service status failed: the systemd user manager could not be reached (no systemctl or no user session bus)` | No user bus in this session. | As the first row. |
| macOS: `launchd could not be asked about the gui/<uid> domain ...` | No one is logged in at the Mac's screen; a LaunchAgent runs only in a logged-in session. | Log in at the Mac (or with Screen Sharing) and run the command there. |
| The daemon stops when the owner logs out (Linux). | Lingering is off. | `loginctl enable-linger "$USER"`. When polkit refuses it outside a desktop session (`install-service` then printed `lingering: could not be enabled (polkit may require an interactive session)`), an administrator can run `sudo loginctl enable-linger <user>`. |
| `refresh-service` exit `1`: `could not be backed up ... so it was not rewritten` | The directory of the definition is not writable. | Fix the permissions of `~/.config/systemd/user` (or `~/Library/LaunchAgents`). |
| `goodvibes doctor` warns `service-not-installed` or `service-not-running`. | No service, or it is stopped. | `goodvibes-daemon install-service` or `goodvibes-daemon start-service`. For a machine that runs without a service on purpose: `goodvibes-daemon config set service.enabled false`. |

## Windows through WSL2

Native Windows is not supported. The installer refuses Git Bash, MSYS and Cygwin with `INSTALL_E001`, whose message gives the two steps below.

1. In an elevated PowerShell on Windows, install WSL2 and a Linux distribution: `wsl --install`.
2. Open the Linux distribution's terminal and run the normal installer there: `curl -fsSL https://goodvibes.sh/install.sh | sh`.

The installer sees Linux and installs the Linux programs. Run `goodvibes`, `goodvibes-agent` and `goodvibes-daemon` inside the distribution.

The background service needs a systemd user manager inside the distribution. This is a WSL setting, not a GoodVibes one: systemd runs in a WSL2 distribution when `/etc/wsl.conf` contains

```ini
[boot]
systemd=true
```

followed by `wsl --shutdown` in Windows and reopening the distribution. Without it, the installer installs the programs and prints the note that no service was set up. Then either enable systemd as above and run `goodvibes-daemon install-service`, or install with `--no-service` and start the daemon by hand when needed.

The web UI listens on the distribution's loopback address. Whether a Windows browser reaches `http://127.0.0.1:3421` depends on WSL's localhost forwarding, which WSL2 normally provides. If it does not, run `goodvibes-daemon webui enable --lan` and open the distribution's network address instead.

The daemon's commands mention a Scheduled Task on Windows; that path belongs to a native Windows daemon, which no release provides.

## macOS notes

- The installer installs the `macos-x64` or `macos-arm64` programs, plus the daemon's own SQLite library (`lib/sqlite-darwin-<arch>/libsqlite3.dylib`) and the vector extension (`lib/sqlite-vec-darwin-<arch>/vec0.dylib`).
- `shasum` (part of macOS) verifies downloads. `perl` (part of macOS) is used for the shadow check.
- The default shell is zsh, so the PATH line goes to `~/.zshrc`.
- The service is a LaunchAgent in the user's GUI domain. It loads and runs only while the owner is logged in at the Mac. Running the installer over SSH with no one logged in at the screen installs the programs, but the service cannot be started; the installer says so and names the command to run from a logged-in session.
- On an upgrade, when the plist was rewritten, the installer reloads the agent with `launchctl bootout` then `launchctl bootstrap gui/<uid> <plist>`. If the new plist will not load, it puts back the newest `<plist>.bak.<timestamp>` and loads that, so the daemon keeps running as before. Otherwise it restarts the agent with `launchctl kickstart -k`.
- An automatic update on macOS restarts the daemon through a one-time launchd helper job, prepared before any file is replaced.

## Updating

A release installation keeps itself current by default. Every update path installs one complete release: all installed programs, their native libraries, the browser driver and the configured release web UI come from the same tag. Programs that are already running keep running the version they started with until they restart.

There are four ways a release installation is updated:

| Path | Who starts it | When |
| --- | --- | --- |
| The daemon's update loop | The daemon, automatically | About 30 seconds after the daemon starts, then every hour. The swap waits until no work is in flight. |
| Launch update | `goodvibes` or `goodvibes-agent`, automatically | Each time the program starts. |
| The Agent's while-running update | `goodvibes-agent`, automatically | About 30 seconds after start, then every hour, at an idle moment. |
| By hand | The owner | `/update apply` in either terminal program, or running the install command again. |

Only a release ("binary") installation updates itself. A program run from source, or one installed inside a `node_modules` package, never replaces itself; `/update` then prints the command to use instead (see [Updating by hand](#updating-by-hand)). A daemon started with `--daemon-home`, `GOODVIBES_DAEMON_HOME` or `GOODVIBES_HOME` set never updates itself (see [Moved homes: `GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME` and `GOODVIBES_AGENT_HOME`](#moved-homes-goodvibes_home-goodvibes_daemon_home-and-goodvibes_agent_home)). A checkout installation is covered in [How the automatic updates treat a checkout installation](#how-the-automatic-updates-treat-a-checkout-installation).

### The daemon's update loop

1. The first check runs `update.firstCheckSeconds` (default 30) seconds after start, never later than one interval. Later checks run every `update.intervalMinutes` (default 60) minutes.
2. A check asks the release feed named by `update.releasesUrl` for the latest tag. When it is newer than the running daemon, the daemon downloads and checksum-verifies the release.
3. The daemon waits until no work is in flight, then replaces the files. Each replaced file is kept as `<file>.previous` for rollback. One previous version is kept for going back, about 830 MB for a linux-x64 suite with the web UI: the programs and their companion files as `<file>.previous` beside them in the install directory (`~/.local/bin` by default), the browser driver as `playwright-core.previous` there, and the web UI as `<webui directory>.previous` (for example `~/.local/bin/webui/3.5.0.previous`). The next update replaces that copy; nothing else it downloaded or unpacked is left behind. From that last idle check until it restarts, the daemon takes no new work: a request that would start or change something (any method other than `GET` or `HEAD`, and over the WebSocket any call whose method is not a read) is answered `503` with code `DAEMON_ADMISSION_CLOSED` and `Retry-After: 5`, and reads and status still answer. A channel message that arrives meanwhile (Telegram, Slack, Discord, Mattermost, ntfy including its remote-chat topic, Home Assistant chat, the generic webhook and the other chat channels) is accepted and saved but neither read nor started, and no notice is sent: it is answered once, after the restart (a Home Assistant reply arrives as its event). A message in a delegated Telegram review chat is not taken: it stays with Telegram and is read after the restart. A GitHub webhook event is answered `202` with `outcome: waiting-for-restart`, saved, and its agent started once after the restart. A "yes" to a work proposal is kept the same way, with any direction added to it, and its work starts after the restart. Scheduled automation jobs and check-ins, watcher runs, knowledge schedules, trigger actions, memory consolidation, the daily store snapshot and the timed retention sweeps start nothing either. What fell due runs after the restart: an automation occurrence once (within `automation.catchUpWindowMinutes`), a trigger's owed action once (a condition still true fires again), consolidation at its next idle or scheduled pass, and the store snapshot at the first hourly check. When the files are not replaced after all, or the service manager refuses the handover before the daemon stops, it takes work again at once and starts what it held.
4. The daemon stops in order, then the service manager starts the new version. Under systemd it asks for a service restart. When it was started by hand on Linux, it installs the systemd user unit and hands over to it. On macOS a one-time launchd helper restarts it after the old process exits; a daemon on macOS that launchd does not supervise is not updated this way, so update it with the installer or `/update apply`.
5. The daemon logs and records a receipt that begins `updated from 3.4.8 to 3.5.0 at <YYYY-MM-DD HH:MM>` and names the programs and directories it replaced. The time is in `daemon.timezone`, else the owner profile's zone, else the machine's own zone; the zone is named after the time (`<YYYY-MM-DD HH:MM> <zone>`) only when it is not the machine's.

No clock ends an update. The download runs until it finishes, the release server or the connection fails (the transport gives up on a transfer that receives nothing for 300 seconds), the daemon stops, or the loop is stopped; a slow connection only makes it take longer. Release files are written to a private directory beside the installation (`.update-fetch-<pid>-<random>`) as they arrive and copied into place from there, so the daemon holds one piece of a file in memory at a time; the directory is removed when the update ends, and one left by a daemon that was killed mid-download is removed by the next update.

It never installs a release that it rolled back from after a crash loop (see [Automatic rollback after failed starts](#automatic-rollback-after-failed-starts)); it moves on when a newer release ships. After `update.alertAfterFailedChecks` (default 3) failed checks in a row, it tells the owner through a channel that still works, at most once every 12 hours. When another install or update holds the installation, it retries later. When an earlier install or update stopped part way, the loop stays off until the kept files are dealt with, and `goodvibes-daemon update` lists them.

See what the loop is doing, from the command line:

```sh
goodvibes-daemon update
```

On a machine whose daemon runs, it prints (receipt lines vary):

```text
goodvibes daemon updates on this machine
  version:  3.5.0
  updates:  on, checking every 1h 0m
  receipts:
    2026-11-20T09:12:44.120Z  updated from 3.4.8 to 3.5.0 at 2026-11-20 10:12; installed suite: goodvibes, goodvibes-daemon, goodvibes-agent, browser/WebUI directories: <paths>; on disk; service handover is pending, already-running goodvibes clients keep their old build until restarted; once the new daemon answers, any client older than <version> stops taking shared-session work until it is restarted
```

The first line names `this machine`, or the daemon's address when `--host` points elsewhere. `version:` prints two lines, `<build> (the daemon build)` and `<platform version> (the platform package it reports on /status)`, when the two differ. `receipts:` reads `none written` when there are none, and `could not be read (<reason>)` when the receipts file is there but cannot be read or parsed; likewise `uptime:` reads `the lifecycle marker could not be read (<reason>)` when the marker file is there but cannot be read.

Inside `goodvibes` or `goodvibes-agent`, `/update daemon` shows the connected daemon's loop in another form:

```text
Daemon updates
  running:  3.5.0
  updates:  on, checking every 1h 0m
  next: /update daemon --check runs one check now
```

Both forms can contain these lines between `updates:` and the end:

| Line | Meaning |
| --- | --- |
| `  updates:  off: <reason>` | The loop is off; the reasons are listed in [Update settings](#update-settings). |
| `  failing:  <n> checks in a row failed: <error>` (`1 check in a row failed` for one) | Recent checks failed. |
| `  installing: <version>, downloading for <time>: <size> received (now <file>, <n> of <count>, <percent>% of <file size>)` | The release is downloading and installing now; `<size>` is how much of its files has arrived, `<file>` the release file receiving bytes, `<n> of <count>` which of the release's files that is (the daemon knows the list from its own update plan), and the percentage how much of that file has arrived (left out when the release server sent no size; the count and the percentage are left out when the daemon is older than 3.5.0). |
| `  pending:  <version> was found (waiting <time>); it downloads and installs when no work is in flight` | A newer release was found and waits for an idle moment. `(waiting <time>)` appears when the daemon knows since when. |
| `  pending:  <version> was found (waiting <time>); it downloads and installs when this work finishes: <id>, <id>` | The same, naming the work it waits behind. |
| `  rejected: <version> crash looped and was rolled back; the update loop will not install that version again` | A release rolled back after failed starts. |
| `  recovery: an interrupted <operation> stopped the update loop; it stays off until the kept files are dealt with` | An install, update or rollback stopped part way. One `            kept: <path>` line follows per kept file and one `            error: <text>` line per recovery error. |

`goodvibes-daemon update` adds `  rollback: an automatic rollback is in force; no fully-started boot has cleared it yet` while a crash-loop rollback has not yet been followed by a complete start, and ends with the receipts.

Run one check now (it never forces an install while work is in flight): `goodvibes-daemon update --check`, or `/update daemon --check` in a terminal program. The check adds one line: `  check:    ran now; the lines above are its result`, `  check:    another check was already running, so none was started; the lines above are as of now`, or `  check:    not run, the update loop is off: <reason>`. When the check finds a release and the daemon has reserved the handover to it, the answer comes at once instead of after the install: `  check:    found <version>; the daemon is installing it now and will restart into it`, followed by `            run this command again to see how much has downloaded; it stops answering for a short while when it restarts, then shows the new version` from `goodvibes-daemon update --check` and when a model runs `/update daemon`. Typed by a person in `goodvibes` or `goodvibes-agent`, `/update daemon` (with or without `--check`) instead stays while a release is installing: the second line is `            the download is followed here until the daemon has restarted into it`, it asks the daemon again every two seconds and shows the download on one line, `  downloading <file> (<n> of <count>): <percent>%`, updated in place as it grows (which of the release's files is downloading, of how many, and how much of that file has arrived; how much of the file has arrived (`12.0 MB received`) in place of the percentage when the release server sends no size; from a daemon older than 3.5.0, which says neither, `  downloading: <size> received (now <file>)`; where the output cannot update a line in place, such as a command run by a model, a new line is printed only when that percentage has moved by 5 points or a file finished), `  restarting: the daemon is not answering while it restarts into <version>` while it restarts, and ends with `  running:  <new version> (updated from <old version>)`; it waits for a slow download however long it takes. An install that fails or is rolled back ends it with `  running:  <version> (not updated)` and the update lines. `/update daemon check` leaves out the `next:` line.

`goodvibes-daemon update` takes `--json`, and `--host <name>`, `--port <n>`, `--token <t>` to ask another machine's daemon. When the daemon on this machine does not answer, it exits `1` and prints the failure and its fix, an empty line, `what this machine's files say about the daemon:` and lines read from the daemon's local records: `  uptime:   <time>` (or `  uptime:   not recorded yet on this host`, or `  uptime:   the last daemon on this host shut down cleanly; this is a fresh start or none`, or `  uptime:   the lifecycle marker could not be read (<reason>)`), `  starts:   <n> consecutive start attempts did not finish starting`, the `rejected:` and `rollback:` lines, and the receipts. With no operator token yet it prints `no operator token was found for this machine` and `  start the daemon once so it creates its operator token, or pass --token`, and exits `1`. When the daemon answers but the update question fails, it prints `the daemon answered, but update.status failed: <error>` (or `update.check`) with its fix and exits `1`.

When the terminal program is not connected to a daemon, `/update daemon` prints `Daemon updates`, `  unavailable: <reason>` and `  next: connect this app to a daemon, then check again on the Updates tab of System`. When the daemon does not answer the question, it prints `  the daemon did not answer update.status: <error>` and `  next: check that the daemon is running and this app is connected to it, then retry`.

### Launch updates and the Agent's while-running updates

When `goodvibes` or `goodvibes-agent` starts its interactive screen from a release installation, it first checks for a newer release. Only the interactive start does this: `goodvibes run`, `goodvibes doctor`, `goodvibes status`, `goodvibes-agent status` and the other commands never update.

- It waits at most `update.launchCheckTimeoutMs` (default 2500 ms) for the answer.
- A successful lookup is remembered for six hours, so a start within that time asks no server.
- It installs when a newer release exists, or when the latest release has the same version but the installed files do not all match it (a repair).
- Both programs wait at most `update.applyTimeoutMs` (default 45000 ms, range 5000 to 300000) for the download, verification and swap before starting the installed version. Past it the update is not cancelled: it keeps downloading and installing in the background and prints its own outcome when it settles. No clock cancels an update; it ends when it finishes, the connection fails, or the program exits.

The lines each outcome prints (`<new>` and `<current>` are versions such as `v3.3.2` and `v3.3.1`):

| Outcome | Terminal app | Agent |
| --- | --- | --- |
| No answer in time | `update check skipped: the release host did not answer within <n>s` | same |
| The release host failed | `update check skipped: <error>` | same |
| Installing | `downloading <new>…`, then `Update available: <new> (running <current>). Downloading and verifying...` (or `Repairing the installed GoodVibes suite at <new>. Downloading and verifying...`) | the `Update available` or `Repairing` line only |
| Installed | `auto-update: <new> installed; restarting onto the new version`; the program replaces itself with the new one, same arguments | `auto-update: <new> installed, restarting onto the new version` |
| First lines of the restarted program | `auto-update: updated from <current> to <new> at launch` | same |
| Wait reached while the release was still downloading | `update still downloading in background; restart to use <new> once it completes`, then the same later lines as the next row | not applicable |
| Wait reached while files were being replaced | `update still finishing in background; restart to use <new> once it completes`, later `background update finished: <new without v> is installed; restart to use it`, or `background update failed: <reason>; the installed version may be unchanged, check with `goodvibes status``, or `background update requires recovery: <reason>; restart `goodvibes` to run the recovery before using this install` | not applicable |
| Failed, nothing changed | `auto-update failed: <reason>; starting the current version <current>`; the current version starts | `auto-update failed: <reason>, starting the current version <current>` |
| Failed part way, files need recovery | `auto-update requires recovery: <reason>; startup stopped before loading installed companions`; the program stops | `auto-update requires recovery: <reason>; startup stopped`; the program stops |
| Run from a package (`node_modules`) installation | nothing | `auto-update skipped: package-managed install, update with: curl -fsSL https://goodvibes.sh/install.sh \| sh` |
| Run from the repository's source folder | `This copy of GoodVibes runs from its source folder, so it does not update itself. To update it, get the latest source in that folder and rebuild it there: bun run --filter @goodvibes/tui build` (a notice) | `This copy of GoodVibes Agent …` with `@goodvibes/agent` |

After `requires recovery`, run the install command again: it recovers a transaction whose process is gone, or stops with `INSTALL_E120` and names the files to put back (see [Installer errors and their fixes](#installer-errors-and-their-fixes)).

A running Agent also checks while it runs, on the daemon's schedule (`update.firstCheckSeconds`, then `update.intervalMinutes`). It replaces itself only at an idle moment: nothing typed in the composer, no open dialog, no turn, helper or background process running, no channel message in flight and no approval waiting. Then it says `updated to v3.5.0, restarting onto the new version`, exits in order and restarts with `--resume <session>` for the conversation on screen. The terminal app has no while-running updater.

A launch or Agent update replaces the daemon program on disk too, but the running daemon keeps its version until it restarts. Restart it with `goodvibes-daemon restart-service`.

### Update settings

<!-- generated: settings:update -->

`update.auto` and `update.autoUpdateAtLaunch`, the two switches that let an installation replace its own programs, are daemon settings: one value for the machine's installation, kept in the daemon's settings file `~/.goodvibes/daemon/settings.json` and read by the daemon, the terminal app and the Agent alike. An update replaces the whole suite, so this is one choice, made once (by the installer's `--no-auto-update`, `goodvibes-daemon config set`, `/settings set` in either terminal program). A copy in a program's own file or in a project's `.goodvibes/` settings file is left out with a notice, so a repository's settings file cannot turn updates back on. The other `update.*` keys are each program's own, read from its own file.

The Agent writes why its while-running updater is off to its activity log (`<working directory>/.goodvibes/logs/activity.md`): `agent periodic update: off, update.auto is false; this agent will not update itself while running`, `agent periodic update: off, update.autoUpdateAtLaunch is false, so this install does not replace its own binary unattended; set update.auto to true to keep only the while-running updates`, or `agent periodic update: off, only a compiled release binary can be swapped in place`. When it is on, it writes `agent periodic update: armed`.

| Program | Settings file | Keys it uses | When a change takes effect |
| --- | --- | --- | --- |
| All three | `~/.goodvibes/daemon/settings.json` (the daemon's settings) | `update.auto`, `update.autoUpdateAtLaunch` | The daemon's loop at its next start; launch updates at the next launch; the Agent's while-running updater at its next launch. |
| The daemon | `~/.goodvibes/daemon-host/settings.json` | `update.releasesUrl`, `update.intervalMinutes`, `update.firstCheckSeconds`, `update.alertAfterFailedChecks`, `update.rollbackAfterFailedStarts` | `update.releasesUrl` is read before every check, so a change applies at the next check (`goodvibes-daemon update --check` makes one now), and a loop that was off because it was empty starts when it is set. The other loop keys are read once, when the daemon has finished starting, so a change applies at the next `goodvibes-daemon restart-service`. `update.rollbackAfterFailedStarts` is read at every start. |
| The terminal app | `~/.goodvibes/tui/settings.json` | `update.launchCheckTimeoutMs`, `update.applyTimeoutMs` | The next launch. |
| The Agent | `~/.goodvibes/agent/settings.json` | `update.launchCheckTimeoutMs`, `update.applyTimeoutMs`, `update.intervalMinutes`, `update.firstCheckSeconds` | The next launch. |

When the daemon's file `~/.goodvibes/daemon-host/settings.json` does not exist yet, the first `goodvibes-daemon` command that opens its settings for writing creates it as a copy of `~/.goodvibes/tui/settings.json` (when that exists); from then on the two files are separate. The commands that do this are every daemon command except `version`, `help`, `completion`, `check-install-reader`, `provision-wake-model`, `mcp` and `webui ... --json`; serving makes the copy at the moment the daemon activates. The same copy is made inside the daemon's working directory (`<working dir>/.goodvibes/daemon-host/settings.json` from `<working dir>/.goodvibes/tui/settings.json`). On a release install, the installer's own `goodvibes-daemon webui enable` (and `config set judgment.policy`, `service-status --json`) is the first such command, so the copy is made during the install from whatever `~/.goodvibes/tui/settings.json` holds at that moment.

The terminal app and the Agent always look for releases at the GoodVibes repository's latest release; `update.releasesUrl` changes only the daemon.

What decides each automatic update:

| Update | On when |
| --- | --- |
| Daemon loop | `update.auto` is `true` (the default), `update.releasesUrl` is not empty, and the daemon is a release installation running from the default home. |
| Terminal app launch update | `update.autoUpdateAtLaunch` is `true` (the default). `update.auto` plays no part. |
| Agent launch update | `update.autoUpdateAtLaunch` is `true` (the default). |
| Agent while-running update | When `update.auto` is written in the daemon's settings file, that value decides. When it is not written there, the update is on unless `update.autoUpdateAtLaunch` is `false`. |

When the daemon loop is off, `goodvibes-daemon update` prints the reason on its `updates:  off:` line. When the daemon finishes starting it checks, in this order, and the first that fails is the reason shown: `update.auto is not true, so this daemon will not update itself`; `this host manages its own updates: no artifact identity was provided, and the platform package version is never assumed to be the shipped one` (the daemon runs from source, from a moved home, or from a checkout installation); `update.releasesUrl is empty, so there is nowhere to resolve release tags from`. Other reasons describe the daemon's state: `the daemon has not finished starting`, `the daemon is stopped or stopping`, and a recovery or rollback reason.

`update.releasesUrl` accepts only a release URL of the GoodVibes repository (`https://github.com/mgd34msu/goodvibes/releases/...`) or a plain `http` URL on `127.0.0.1`, `localhost` or `[::1]`, with no user name or password. Any other value is refused when written, for example:

```text
config: could not write update.releasesUrl: expected string (https://github.com/mgd34msu/goodvibes/releases/... (or http on 127.0.0.1, localhost or [::1]) without credentials, or empty to turn the update loop off).
```

An empty value turns the daemon's update loop off.

How to set an update setting for each program:

| Program | Command | File written |
| --- | --- | --- |
| Any (`update.auto`, `update.autoUpdateAtLaunch`) | `goodvibes-daemon config set update.auto false`, `/settings set update.autoUpdateAtLaunch false` inside `goodvibes`, or `/settings set ...` inside `goodvibes-agent` | `~/.goodvibes/daemon/settings.json`, the one file all three read |
| The daemon (its other `update.*` keys) | `goodvibes-daemon config set update.intervalMinutes 120` | `~/.goodvibes/daemon-host/settings.json` |
| The terminal app (its other `update.*` keys) | `/settings set update.launchCheckTimeoutMs 5000` inside `goodvibes`, or the settings screen (`/settings update`) | `~/.goodvibes/tui/settings.json` |
| The Agent (its other `update.*` keys) | `/settings set update.intervalMinutes 120` inside `goodvibes-agent` | `~/.goodvibes/agent/settings.json` |

`goodvibes-daemon config get update.auto` prints the daemon's current value. `goodvibes-daemon config set` prints `update.auto = false` and `written to disk.`; restart the daemon for an `update.*` change to apply.

### Updating by hand

Updating by hand is the daemon's: it holds the install, one suite on this machine. In either terminal program it is the Updates tab of the System place (`/update` typed opens it there; `Ctrl+G` then `m` reaches it from the menu); a model, an outside agent or a script runs the same capabilities (`update.check`, `update.apply`, `update.rollback`, `update.daemon`, `update.review`, `update.save-review`, `update.read-review`; `goodvibes do update.review`). Installing and going back are the owner's own: a press asks first (they replace the programs you are running), and a model is refused. They work whatever the `update.*` settings say; those settings only control the automatic updates.

| On the Updates tab | Capability | What it does |
| --- | --- | --- |
| The "GoodVibes on this computer" row | `update.review` | The installed version, the newest release and whether a copy of the version before is kept, read when the tab opens and again whenever the daemon's update state changes. `v` shows the whole review: the release channel, the install kind, the subscription providers and the sandbox profile. |
| `c` check again | `update.check` | Asks the release page for the newest release: `Already current: v3.3.1 is installed (the latest release is v3.3.1).` or `A newer release is out: v3.3.2 (v3.3.1 is installed).`; a failed read is refused with `Could not check for updates: <error>.` |
| `i` install it (when a newer release is out) | `update.apply` | With the daemon's update loop on, the daemon's own update path installs it and restarts into it. Otherwise the daemon downloads, verifies and installs it for every program here, keeping the version replaced, and prints `Updated GoodVibes 3.3.2: goodvibes, goodvibes-daemon, goodvibes-agent.` with `The programs use it from their next start; the daemon starts it the next time it restarts.` |
| `b` go back (when a copy is kept) | `update.rollback` | Restores the kept previous release for every program (see [Rolling back](#rolling-back)). |
| `c` check now, on the daemon's own row | `update.daemon` | The daemon's own update loop, as `goodvibes-daemon update` prints it, after one check. |
| `s` save it as a file, `o` read a saved one | `update.save-review`, `update.read-review` | The review as JSON in a file (an existing file is kept unless you choose to write over it), and a saved one read back. A record for support, not an update. |

On an installation that is not installed release files (run from source, or a bun or npm package), installing and going back are refused: `This install is running from source, not installed release files, so it is not updated here; nothing was changed. Update it the way it was installed.`

### Upgrading with the installer

Running the install command again upgrades to the newest release (or to `GOODVIBES_VERSION`). Settings, sessions and data in `~/.goodvibes` are never touched. Besides replacing the programs, an upgrade:

- Installs the new web UI into its own directory (`webui/<new version>/`) and points the daemon at it. Older `webui/<version>/` directories stay; delete them by hand when no daemon serves them.
- Deletes stale rollback copies: when the new daemon differs from the old one, the `*.previous` files left by an earlier automatic update are removed (`removed <path> (a rollback copy of a release older than the one just replaced)`), so `/update rollback` reports nothing to restore instead of restoring a release two versions back. Reinstalling the same release keeps them.
- Refreshes the daemon's service definition when GoodVibes wrote it. Nothing is printed when it was already current. When it was rewritten, the installer prints `Refreshing the daemon service goodvibes.service ...` and the daemon's lines, and the old file is kept as `<definition>.bak.<timestamp>`. A definition GoodVibes did not write is left as it is, with a `NOTE:` naming the command to hand it back.
- Restarts what runs from this install directory, unless `GOODVIBES_RESTART_DAEMON=0`:
  - an active systemd service: `systemctl --user restart goodvibes.service` (`Restarting the running goodvibes (systemd user service) ...` then `restarted  goodvibes.service` once the runtime record in the daemon home that unit's process runs with (`detached-daemon.json`, written after its listener is bound) names the unit's new main pid; when that process exits first, `NOTE: goodvibes.service was restarted but its daemon exited before it was serving (the unit is <state>). See why with:` followed by `systemctl --user status goodvibes.service` and `journalctl --user -u goodvibes.service`);
  - a loaded launchd agent: `launchctl kickstart -k`, or a full reload when the plist changed. A reload boots the agent out and waits until its process has exited and launchd no longer lists it, then loads the new plist; only when that load fails is the previous plist put back and loaded;
  - a daemon started by hand without a terminal: stopped with SIGTERM, waited for until it has exited (the daemon ends itself at its shutdown deadline), and started again as the bare program from the home directory. `restarted  pid <pid>` is printed once the new daemon's runtime record (`detached-daemon.json` in the daemon home, written after its listener is bound) names it; when it exits first, `NOTE: the new daemon (pid <pid>) exited before it was serving.` and the command to run it in a terminal;
  - every other daemon service GoodVibes wrote for this user (a second daemon under its own `service.serviceName`) that is running, the same way;
  - a program attached to a terminal (an interactive `goodvibes-agent`, a daemon in the foreground) is never stopped: it keeps the previous version, and the installer prints `Leaving <program> (pid <pid>) running: it is attached to terminal <tty> and still runs the previous version.` and `Quit it and start it again in that terminal to use <version>.`;
  - Agent processes without a terminal (`goodvibes-agent` with no subcommand, or `goodvibes-agent tui`): stopped and started again in the background with their original arguments. One whose arguments contain spaces, wildcards or newlines is left running, with the exact command to restart it printed;
  - a process supervised by a service manager is never killed by hand (`Skipping pid <pid>: it is supervised by a service manager; its unit owns the restart.`); a process whose supervision cannot be determined is left alone too;
  - a process running from a different install directory is named and left alone (`Leaving goodvibes-daemon (pid <pid>) alone; it belongs to a different install:`).
- Does not install a service when a definition already exists but is stopped. It prints `A daemon service definition already exists at <path>; leaving it as is.` and `Start it yourself if it is not running:` with `goodvibes-daemon start-service`.

The terminal app (`goodvibes`) is not restarted by the installer. Close and reopen it to use the new version.

### Moving an installation to another directory

There is no move command. The supported way is to uninstall from the old directory and install into the new one; settings, sessions and all data in `~/.goodvibes` are not touched by either step. Do it in this order: installing into the new directory first would rewrite the existing service to the new program, and the later uninstall of the old directory would then remove that service.

With `OLD` the current directory (for example `~/.local/bin`) and `NEW` the target (for example `~/opt/goodvibes/bin`):

1. Quit every `goodvibes` and `goodvibes-agent`, and note the version: `goodvibes --version`. If a second daemon service runs from the same program (see [A second daemon as its own service](#a-second-daemon-as-its-own-service)), remove it now, from its working directory and with its `GOODVIBES_HOME`: `cd <its working directory> && GOODVIBES_HOME=<its tree> goodvibes-daemon uninstall-service`. The uninstaller knows only the default service, so a second service would otherwise keep pointing at the deleted `$OLD/goodvibes-daemon` and fail at every login.
2. Carry over the saved-data reader record, so the new directory keeps the same protection against installing a release too old for the data: `mkdir -p "$NEW" && cp -p "$OLD/.goodvibes-reader-requirements.json" "$NEW/"` (skip when the file does not exist).
3. Uninstall from the old directory. This removes the GoodVibes service, stops hand-started processes, deletes the programs and removes the old PATH line: `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_INSTALL_DIR="$OLD" GOODVIBES_UNINSTALL=1 sh`.
4. Install the same version into the new directory: `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v<version> GOODVIBES_INSTALL_DIR="$NEW" sh` (for an installation without a service: `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v<version> GOODVIBES_INSTALL_DIR="$NEW" sh -s -- --no-service`). The installer writes a new service that runs `$NEW/goodvibes-daemon`, points the daemon at `$NEW/webui/<version>` and adds a PATH line for `$NEW`.
5. Remove what the uninstall kept in the old directory: `rm -rf -- "$OLD/webui" "$OLD/playwright-core" "$OLD/playwright-core.previous"` and `rm -f -- "$OLD/.goodvibes-reader-requirements.json"`; remove `$OLD` itself when it is empty and was used only for GoodVibes.
6. Open a new shell and check: `command -v goodvibes` names `$NEW/goodvibes`, `goodvibes-daemon service-status` shows the service running, and `goodvibes-daemon webui status` names `$NEW/webui/<version>`.
7. Install a removed second daemon service again, the same way as before: `cd <its working directory> && GOODVIBES_HOME=<its tree> goodvibes-daemon install-service`. Its settings in `<its tree>/.goodvibes/` (port, `service.serviceName`) were not touched, so it comes back under the same name, now running `$NEW/goodvibes-daemon`.

What does not carry over: the `*.previous` rollback copies (so `/update rollback` has nothing to restore until the next update), and anything the owner added to the old `webui` or `playwright-core` directories.

### Pinning a release

To stay on one release and stop every automatic update:

1. Turn off every automatic update: `goodvibes-daemon config set update.auto false` and `goodvibes-daemon config set update.autoUpdateAtLaunch false` (one setting file read by all three programs).
2. Install the release to stay on: `curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --version v3.5.0 --no-auto-update` (`--no-auto-update` does step 1 for you). The installer restarts the daemon, which then reads `update.auto false`.
3. Check: `goodvibes-daemon update` shows `updates:  off: update.auto is not true, so this daemon will not update itself`.

To resume updates, set the same keys back to `true` (or run `goodvibes-daemon config unset update.auto`) and restart the programs.

Installing an older release over a newer one works only when the older programs can read the data the newer ones saved. When they cannot, the installer refuses with `INSTALL_E057` and changes nothing. Never delete `.goodvibes-reader-requirements.json` to get around this; the older programs could then misread the saved data.

### A fresh install with automatic updates off from the very first start

Install with `--no-auto-update` (or `GOODVIBES_AUTO_UPDATE=0`):

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --version v3.5.0 --no-auto-update
```

Before any program starts, the installer writes `update.auto` and `update.autoUpdateAtLaunch` as `false` in the daemon's settings file, which the daemon, the terminal app and the Agent all read, so none of them updates itself from its first launch. Combine it with the other options, for example `--no-service`, `--bin-dir` or `--from-dir`. Behind a proxy, add the variables shown in [Network access, proxies and machines without internet](#network-access-proxies-and-machines-without-internet).

Check after the install:

```sh
goodvibes-daemon config get update.auto      # prints false
goodvibes-daemon update                      # with a running daemon: updates:  off: update.auto is not true, so this daemon will not update itself
```

For a single start of a terminal program, `-c update.autoUpdateAtLaunch=false` has the same effect without writing anything: `goodvibes -c update.autoUpdateAtLaunch=false` or `goodvibes-agent -c update.autoUpdateAtLaunch=false`. The commands `goodvibes run`, `doctor`, `status` and the other non-interactive commands never update, so they are safe before the settings exist.

### Rolling back

`/update rollback` (in the terminal app or the Agent) restores the previous release that the last automatic update or `/update apply` kept beside the programs: each program file and its companions as `<file>.previous`, the browser driver as `playwright-core.previous`, and the configured web UI directory as `<webui directory>.previous`. It restores every program and directory of that release together, and only when they all belong to the same previous release and that release can read the saved data. Anything else is refused before any file is renamed, and the programs stay as they are.

What `/update rollback` prints:

| Outcome | Lines printed |
| --- | --- |
| Restored | `Restored GoodVibes <version>: <programs>.` (for example `goodvibes, goodvibes-daemon, goodvibes-agent`), one `  restored directory: <path>` line per directory, one `  retained earlier backup: <path>` line per older backup kept aside, then `Restart the running GoodVibes programs to use the restored release.` On Linux, in both apps, when the daemon was among the restored programs and its systemd service is active, a last line `Daemon restart: systemctl --user restart goodvibes.service`. |
| No previous browser driver kept (a fresh install, or any installation never updated by an automatic update or `/update apply`) | `Rollback failed: Native directory rollback requires live and previous trees` |
| Previous directories kept but some previous program files missing (for example after an upgrade with the installer, which deletes the stale `*.previous` program files and leaves directory copies) | `Rollback failed: Previous native cohort is incomplete; refusing partial rollback` |
| The kept programs come from different releases | `Rollback failed: Previous suite products have different release versions; refusing a mixed rollback` |
| The kept directories come from another release than the kept programs | `Rollback failed: Previous suite directory assets do not confirm the same release as its programs` |
| Linux: the kept daemon set is incomplete | `Rollback failed: The complete previous daemon is unavailable` |
| An update of a directory is running or was interrupted | `Rollback failed: Another native directory update owns this target` |
| The configured web UI directory is outside `<install dir>/webui/` | `Rollback failed: The configured WebUI (<dir>, from controlPlane.webui.bundleDir or web.staticAssetsDir) is separately managed and is not updated with the suite. Update its deployment explicitly, or clear that setting, then update the suite again.` |
| The rollback was interrupted after files began to move | `Rollback failed: The suite update requires recovery. Inspect its retained files and transaction claims before retrying.` The program then exits. Running the install command again releases the transaction when no partial file remains, or stops with `INSTALL_E120` and names the files to put back. |
| Not a release installation (package installation) | `This install is not a self-updatable binary install (detected: bun/npm package install), so there is no kept previous binary to roll back to.` and `Install a specific version with your package manager instead, e.g.: curl -fsSL https://goodvibes.sh/install.sh \| sh` |
| Run from a source workspace | The workspace rebuild guidance (see [Updating by hand](#updating-by-hand)). |

After a successful rollback, restart the programs; for the daemon run `goodvibes-daemon restart-service`.

Running `/update rollback` a second time, right after a successful one, also succeeds: it exchanges the live and kept copies again, so the newer release is live once more and the older one is the `.previous` copy, and it prints `Restored GoodVibes <newer version>: ...`. The command does not compare versions; each run swaps the two sets, provided they still form one complete release each and the release being made live can read the saved data.

`/update review` in either program shows `rollback copy: kept beside this program; /update rollback restores it` when `<program>.previous` exists beside the running program, and `rollback copy: none kept (/update apply keeps one)` otherwise.

After an upgrade with the installer, no complete rollback set is kept. To go back to an earlier release then, install it by tag: `curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.3.0 sh`, subject to the data-reader check above. Then pin it (see [Pinning a release](#pinning-a-release)), or the update loop installs the newest release again within the hour.

### What is on disk after each upgrade and rollback

The example starts from a release install of v3.3.1 in `~/.local/bin`, whose web UI is configured at `~/.local/bin/webui/3.3.1`, and moves to v3.3.2.

| After | Programs and companions | Browser driver | Web UI | What the daemon serves |
| --- | --- | --- | --- | --- |
| The install of v3.3.1 | v3.3.1 files; no `.previous` copies | `playwright-core/` (v3.3.1) | `webui/3.3.1/` (v3.3.1) | `webui/3.3.1/` |
| `/update apply`, a launch update or the daemon's update loop to v3.3.2 | v3.3.2 files in place; every replaced file kept as `<file>.previous` (v3.3.1) | `playwright-core/` holds v3.3.2; `playwright-core.previous/` holds v3.3.1 | The configured directory is updated in place: `webui/3.3.1/` now holds v3.3.2 (its `.goodvibes-release.json` says `3.3.2`); `webui/3.3.1.previous/` holds v3.3.1 | The same configured path, `webui/3.3.1/`, now v3.3.2 after the daemon restarts |
| `/update rollback` from there | Live and kept copies are exchanged: v3.3.1 files in place, the v3.3.2 files become the `<file>.previous` copies | `playwright-core/` v3.3.1, `playwright-core.previous/` v3.3.2 | `webui/3.3.1/` v3.3.1, `webui/3.3.1.previous/` v3.3.2 | `webui/3.3.1/`, v3.3.1 after the daemon restarts |
| Running the installer for v3.3.2 instead (from the v3.3.1 install) | v3.3.2 files; no `.previous` copies (program `*.previous` copies from earlier updates are deleted when the new daemon differs from the old one; directory `.previous` copies are left alone) | `playwright-core/` v3.3.2; the replaced v3.3.1 tree is deleted when the install finishes | A new `webui/3.3.2/`; `webui/3.3.1/` stays untouched | The installer runs `goodvibes-daemon webui enable --bundle-dir ~/.local/bin/webui/3.3.2`, so `webui/3.3.2/` after the restart |
| `/update apply` to v3.3.2 (second row), then the installer for v3.3.3 | v3.3.3 files; the program `*.previous` copies are deleted because the new daemon differs from the old one (reinstalling the same release keeps them) | `playwright-core/` v3.3.3; the replaced v3.3.2 tree is deleted when the install finishes; `playwright-core.previous/` (v3.3.1) stays | A new `webui/3.3.3/`; `webui/3.3.1/` (holding v3.3.2) and `webui/3.3.1.previous/` (v3.3.1) stay | `webui/3.3.3/` |
| Running the installer for v3.3.1 again after that (a downgrade by tag) | v3.3.1 files; no `.previous` copies | `playwright-core/` v3.3.1 | `webui/3.3.1/` is reused (left untouched when it already holds exactly the v3.3.1 files, otherwise replaced); `webui/3.3.2/` stays | `webui/3.3.1/` |

Each automatic update or `/update apply` keeps one generation of directory backups: an older `.previous` tree that carries a GoodVibes release marker is deleted, and one without a marker (local additions) is set aside and reported as `retained earlier backup: <path>`.

Programs keep running the version they started with until they restart:

- the terminal app and the Agent: quit and start them again;
- the daemon with a service: `goodvibes-daemon restart-service`;
- the daemon without a service: stop it and start it again by hand (see [Running the daemon without a service](#running-the-daemon-without-a-service)). The installer does this itself for a hand-started daemon; `/update apply` and `/update rollback` do not.

`/update rollback` does not change the version the daemon's update loop has recorded as rejected after a crash loop, and it does not turn the update loop off: with automatic updates on, the loop installs the newest release again at its next check. Pin first when the rollback must stay.

### Automatic rollback after failed starts

When a newly updated daemon fails to finish starting `update.rollbackAfterFailedStarts` times (default 3) within ten minutes, the daemon restores the kept previous release and restarts onto it. It then records the rejected version, so the update loop never installs that version again and resumes with the next newer release. Setting `update.rollbackAfterFailedStarts` to `0` turns this off. It does not roll back a build that has already started successfully on the same machine, because repeated failures of such a build come from the machine (an occupied port, for example). It refuses to restore a kept copy that is not older than the running build or is a release an earlier rollback rejected; each refusal is written to the daemon's output and receipts. It never rolls back twice in a row: after one automatic rollback, the next one waits until a start has completed. With no kept previous copy on disk it restores nothing and keeps starting the current build. `goodvibes-daemon update` shows a rejected release on its `rejected:` line.

### When a program is older than the daemon requires

Every program in the suite carries the same version. A daemon accepts programs of its own release line (the same major and minor version, such as 3.5) and newer; it announces that line on its status answer, and each program compares itself every time it reads the status. A program that was already running when the daemon updated keeps its older build; it says so once and stops taking part in the work the daemon shares between your programs until it restarts:

| Program | What the person sees |
| --- | --- |
| The terminal app and the Agent | One notice: `This process is running build 3.4.8; the daemon requires 3.5.0 or newer. It has stopped taking shared-session work, restart it to rejoin.` |
| The web app | **Reload to update** in the header, described by `This tab is running build 3.4.8; the daemon requires 3.5.0 or newer. It has stopped taking shared-session work, reload the page to pick up the current build.` The page reloads by itself as soon as nothing would be lost (no unsent text, no reply streaming, nothing open over the page), once per answer; if the reloaded page still hears the same answer, the button stays. |
| A program that reports no version | `This build does not report a version, so it cannot be checked against the daemon's floor of 3.5.0. Restart it from the current install to be sure it is current.` |

The other way round, a program does not use a daemon older than it needs: the terminal app and the Agent need 3.3.2 or newer, the web app 3.1.2. This happens when it is paired with a daemon on another machine that has not updated:

| Program | What the person sees |
| --- | --- |
| The terminal app | A notice, `The daemon at http://server.lan:3421 is running build 3.2.0; this client requires 3.3.2 or newer, update the daemon.`, said once; that daemon is not used. It is read again when it comes back online, so an updated daemon is taken up without a restart. |
| The web app | The same sentence in a warning banner. |
| The Agent | Each request to that daemon is refused with `the GoodVibes host at http://server.lan:3421 is older than this Agent build needs` and the next step `update GoodVibes on the host (goodvibes-daemon) to this Agent's version, then retry`. |
| Any of them, for a daemon that reports no version | `The daemon at http://server.lan:3421 did not report a version, so this client is not using it. Check that the address points at a GoodVibes daemon, and update the daemon to 3.3.2 or newer.` |

## Uninstalling

### Uninstalling a release installation

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

or

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh -s -- --uninstall
```

Add `GOODVIBES_INSTALL_DIR=<dir>` for an installation in another directory. Uninstalling downloads nothing.

The uninstaller:

1. Asks the daemon about its service, then claims the install directory like an install does (a running install or update is refused; a claim of a process that is gone is released first).
2. Refuses when partial files from an interrupted update remain (`INSTALL_E100` to `INSTALL_E103`); each message names the file and the exact command to put back or delete it.
3. Removes the daemon's service when GoodVibes wrote it (systemd: `systemctl --user disable --now goodvibes.service`, delete the unit, `daemon-reload`; macOS: `launchctl bootout`, wait until launchd has let go of the job, delete the plist). A definition GoodVibes did not write is stopped and kept (`KEPT       <path> was not written by GoodVibes ...`) with the command to remove it; when it starts a program in this install directory, it is also disabled so it does not fail at every login. When the daemon cannot report its service (the user service manager is not reachable from this session), nothing is removed: the uninstaller prints `NOTE: goodvibes-daemon could not report its service ...` with the commands to disable and remove it from a logged-in session, and the summary lists it under what was kept.
4. Stops daemon and Agent processes started by hand from this install directory with SIGTERM. A daemon is waited for until it has exited (it ends itself at its shutdown deadline); an Agent gets 10 seconds (`NOTE: pid <pid> did not exit within 10s; stop it yourself: kill <pid>` otherwise). Processes of other installations are named and left alone.
5. Deletes `goodvibes`, `goodvibes-daemon`, `goodvibes-agent`, their `.bun`, `.bun.json`, `.bun.LICENSE.md` and `.readers.json` files, every `.previous` copy of those, `daemon-installation.json` and its `.previous` copy, files named `goodvibes-daemon-<platform>` with their `.bun`, `.bun.json` and `.bun.LICENSE.md` files (the names older releases used) and their `.previous` copies, and the vector and SQLite libraries under `lib/` with their `.previous` copies. It then removes each emptied `lib/<name>/` directory and `lib/` itself when empty. A library path that is a symbolic link is kept and not followed.
6. Removes the PATH line pair it added for this directory.
7. Prints a summary.

These are the lines it prints, in order, for a default Linux install with a GoodVibes service (no hand-started process):

```text
Uninstalling GoodVibes (installer-managed files) from /home/alex/.local/bin

Stopping and removing goodvibes.service (written by GoodVibes) ...
  removed    /home/alex/.config/systemd/user/goodvibes.service
  removed    /home/alex/.local/bin/goodvibes
  removed    /home/alex/.local/bin/goodvibes-daemon
  removed    /home/alex/.local/bin/goodvibes-agent
  removed    PATH line from /home/alex/.bashrc
```

followed by the summary below. With hand-started processes, `Stopping goodvibes-daemon (pid <pid>) ...` and `  stopped    goodvibes-daemon (pid <pid>)` lines (and the same for `goodvibes-agent`) come before the `removed` lines; a `<program>.previous` file adds `  removed    <dir>/<program>.previous`. On macOS the service lines are `Stopping launchd user agent sh.goodvibes.daemon ...` and `  removed    /Users/alex/Library/LaunchAgents/sh.goodvibes.daemon.plist`. The companion and library files are listed only in the summary. When the directory held none of the installer's files, the summary says `Removed: nothing; no installer-managed files were found in <dir>.`

It never deletes `~/.goodvibes`, any project's `.goodvibes/` directory, the browser driver directories `playwright-core`, `playwright-core.previous` and `playwright-core.incoming`, the `webui` directory, leftover `.goodvibes-directory-install.*` and `.playwright-core.update-*` directories, `.goodvibes-reader-requirements.json`, or the `.bak.<timestamp>` copies of the service definition. Those directories may hold local additions or be served by another daemon, so they are listed as kept for the owner to review.

On Linux x64 the summary looks like this (a `.readers.json` line appears for each program that has one):

```text
Uninstall summary
-----------------
Removed:
  /home/alex/.config/systemd/user/goodvibes.service (GoodVibes service unit)
  /home/alex/.local/bin/goodvibes.bun
  /home/alex/.local/bin/goodvibes.bun.json
  /home/alex/.local/bin/goodvibes.bun.LICENSE.md
  /home/alex/.local/bin/goodvibes
  /home/alex/.local/bin/goodvibes-daemon.bun
  /home/alex/.local/bin/goodvibes-daemon.bun.json
  /home/alex/.local/bin/goodvibes-daemon.bun.LICENSE.md
  /home/alex/.local/bin/goodvibes-daemon
  /home/alex/.local/bin/goodvibes-agent.bun
  /home/alex/.local/bin/goodvibes-agent.bun.json
  /home/alex/.local/bin/goodvibes-agent.bun.LICENSE.md
  /home/alex/.local/bin/goodvibes-agent
  /home/alex/.local/bin/lib/sqlite-vec-linux-x64/vec0.so
  /home/alex/.local/bin/daemon-installation.json
  PATH line in /home/alex/.bashrc (installer-managed)

Preserved:
  /home/alex/.goodvibes (your GoodVibes data: settings, sessions, memory) is left untouched.
  /home/alex/.local/bin/playwright-core (directory/deployment contents cannot be attributed safely; not followed or recursively deleted)
  /home/alex/.local/bin/webui (directory/deployment contents cannot be attributed safely; not followed or recursively deleted)
  Review the retained directory paths and any other running deployments before removing their contents manually.

To also erase all GoodVibes user data, remove it yourself:
  rm -rf -- '/home/alex/.goodvibes'
```

When the uninstall stops during its service and process step, before any program file was removed, it releases its claims and says so; run the same command again to finish. Every step can be repeated. When it stops while removing programs, it keeps its claims and prints `install.sh: uninstall did not finish; inspect retained transaction files in <dir> and remaining programs before retrying.`

When the install directory holds commands of a checkout installation, the release uninstaller runs that installation's own uninstaller instead.

### Removing everything

After the uninstall above, the following remain. Remove them only when the owner wants all GoodVibes data gone; nothing can recover it. The commands use the default install directory `~/.local/bin`; replace it with the directory that was used.

| What remains | Where | Command |
| --- | --- | --- |
| Web UI bundles, including any `<version>.previous` copies | `~/.local/bin/webui/` | `rm -rf -- "$HOME/.local/bin/webui"` |
| The browser driver and its kept copy | `~/.local/bin/playwright-core/`, `~/.local/bin/playwright-core.previous/` | `rm -rf -- "$HOME/.local/bin/playwright-core" "$HOME/.local/bin/playwright-core.previous"` |
| The saved-data reader record | `~/.local/bin/.goodvibes-reader-requirements.json` | `rm -f -- "$HOME/.local/bin/.goodvibes-reader-requirements.json"` |
| Staging directories left by an interrupted install or update | `~/.local/bin/.goodvibes-directory-install.<random>/`, `~/.local/bin/.playwright-core.update-<random>/`, `~/.local/bin/webui/.<version>.update-<random>/` | `ls -a ~/.local/bin` to see them, then `rm -rf -- '<each full path>'` |
| Service definition backups written by `refresh-service` (neither uninstall removes them) | Linux: `~/.config/systemd/user/goodvibes.service.bak.<YYYYMMDDHHMMSS>`; macOS: `~/Library/LaunchAgents/sh.goodvibes.daemon.plist.bak.<YYYYMMDDHHMMSS>` | `ls ~/.config/systemd/user/` (or `ls ~/Library/LaunchAgents/`), then `rm -f -- '<each full path>'` |
| All settings, sessions, memory, stored credentials (`secrets.enc` files), operator tokens, the daemon's state, logs and the wake-word model | `~/.goodvibes/` | `rm -rf -- "$HOME/.goodvibes"` |
| Per-project state of every directory a GoodVibes program ran in: project settings, project credentials (`secrets.enc`), the activity log and the other per-project files listed in the overview part of this file | `<project>/.goodvibes/` in each such directory (the terminal app also added a `.goodvibes/` line to that project's `.gitignore`) | `find "$HOME" -name .goodvibes -type d -prune -not -path "$HOME/.goodvibes" -print` to list them, review the list, then `rm -rf -- '<each full path>'` |
| Browsers the browser tools downloaded | `$PLAYWRIGHT_BROWSERS_PATH` when set; otherwise `~/.cache/ms-playwright/` on Linux and `~/Library/Caches/ms-playwright/` on macOS | This is Playwright's standard cache and other programs on the machine may use it. Remove it only when nothing else does: `rm -rf -- "$HOME/.cache/ms-playwright"` (Linux) or `rm -rf -- "$HOME/Library/Caches/ms-playwright"` (macOS). |
| A systemd drop-in directory created by hand (for example for proxy variables) | `~/.config/systemd/user/goodvibes.service.d/` | `rm -rf -- "$HOME/.config/systemd/user/goodvibes.service.d"` |
| Lingering (Linux) | systemd-logind | `loginctl disable-linger "$USER"`, only when it was enabled for GoodVibes alone. |
| An empty install directory chosen only for GoodVibes | for example `~/opt/goodvibes/bin` | `rmdir -- "$HOME/opt/goodvibes/bin"` |

Things outside the machine (chat bots registered with Slack or Telegram, OAuth clients created in a Google console, a Cloudflare account's resources, a relay) are not removed by any of this; remove them where they were created.

### `scripts/uninstall.sh` from a checkout

A clone of the repository has `scripts/uninstall.sh`, which removes either kind of installation:

```sh
./scripts/uninstall.sh [--prefix DIR] [--purge]
```

`./scripts/uninstall.sh --help` prints:

```text
Usage: uninstall.sh [--prefix DIR] [--purge]
Removes managed programs/services and preserves user data. --purge applies to receipt-owned installations.

Options:
  --prefix DIR   The checkout installation to remove (default: $HOME/.local/share/goodvibes).
  --purge        Also remove that installation data directory (receipt-owned installations only).
  --help|-h      Print this help and exit.
```

Any other option prints `Unknown option: <option>` and exits `1`; `--prefix` without a value prints `--prefix needs a directory.` and exits `1`.

| Situation | What it does |
| --- | --- |
| `<prefix>/installation.json` exists (a checkout installation; default prefix `~/.local/share/goodvibes`) | Runs that installation's own uninstaller with `--prefix` and, when given, `--purge`. If the installed uninstaller is missing or damaged, runs the checkout's `scripts/uninstall.ts` with any `bun` on `PATH` or one left in another release of that installation. With no Bun at all it prints the `bun <checkout>/scripts/uninstall.ts --prefix <dir>` command to run once Bun is installed, and exits `1`. |
| `--prefix` was given and holds no `installation.json` | Prints `No receipt-owned installation at <prefix>. User data remains untouched.` and exits `0`. |
| No checkout installation, with `--purge` | Refuses: `Release installs preserve ~/.goodvibes data; --purge requires a receipt-owned installation.` |
| No checkout installation | Runs the checkout's own `scripts/install.sh` in uninstall mode (a release uninstall of `GOODVIBES_INSTALL_DIR` or `~/.local/bin`). Without a checkout beside it, it downloads `install.sh` from the repository's `main` branch (or from the tag in `GOODVIBES_VERSION`, which must look like `v3.2.0`) and runs that in uninstall mode. |

`./scripts/install-from-checkout.sh --uninstall [--prefix DIR] [--purge]` does the same.

## Building and installing from a source checkout

`scripts/install-from-checkout.sh` builds every program from a clone of the repository and installs the result with its own layout, its own private data directory and its own systemd unit. It is a separate installation method from the release installer; the two must not share an install directory.

### Requirements

- Linux, x64 or arm64, with glibc. macOS and musl (Alpine) are not supported by this method.
- The owner's normal user. Root is refused.
- `git`, `curl`, `tar`, `unzip` and `sha256sum` on `PATH`.
- A clone of the repository (`git clone https://github.com/mgd34msu/goodvibes.git`), at an exact commit, with no changes to tracked files. Untracked files do not matter.
- Bun and Node are not required. When the `bun` on `PATH` is not exactly the version in the checkout's `package.json` (`engines.bun`, 1.3.14 for this release), the script downloads that Bun from `github.com/oven-sh/bun` and checks it against Bun's checksum list. When no `node` of version 22 or newer is on `PATH`, it downloads the latest Node 22 from `nodejs.org` and checks it the same way. Both are used only to build, and a private copy of each is kept with the installed release.
- A free port for the daemon (default 3421) and, with the service, a reachable systemd user manager.

### Options

`./scripts/install-from-checkout.sh --help` prints:

```text
Usage: ./scripts/install-from-checkout.sh [--prefix DIR] [--bin-dir DIR] [--data-dir DIR] [--workspace DIR]
                    [--port PORT] [--no-service|--service] [--decision-policy POLICY]
       ./scripts/install-from-checkout.sh --uninstall [--prefix DIR] [--purge]

Options:
  --prefix DIR          Where the programs are installed (default: $HOME/.local/share/goodvibes).
  --bin-dir DIR         Where the commands are linked (default: $HOME/.local/bin, or the previous install's).
  --data-dir DIR        The data directory: GOODVIBES_HOME for every installed command
                        (default: $HOME/.local/share/goodvibes-data, or the previous install's).
  --workspace DIR       The project directory the daemon service works in (default: this checkout,
                        or the previous install's).
  --port PORT           The daemon and WebUI port (default: 3421, or the daemon's current port;
                        an update without --port keeps controlPlane.port as it is).
  --no-service          Do not run the daemon as a systemd user service (recorded in
                        service.enabled, so a daemon started by hand installs none).
  --service             Run the daemon as a systemd user service (the default on a first
                        install; an update without either flag keeps service.enabled as it is).
  --decision-policy POLICY  Save the decision model policy (the judgment.policy setting; see the
                        current one with: goodvibes-daemon config get judgment.policy).
  --uninstall           Run ./scripts/uninstall.sh with the remaining options instead of installing.
  --help|-h             Print this help and exit.

Build and install the daemon, terminal UI, agent and WebUI from this checkout.
Linux x64/arm64 with glibc is supported. Run as your regular user, without sudo.
Bun and Node are supplied privately when needed. Git, curl, tar, unzip and
sha256sum must be available. By default a systemd user service is enabled.

Defaults:
  Programs: $HOME/.local/share/goodvibes
  Commands: $HOME/.local/bin
  Data:     $HOME/.local/share/goodvibes-data
  WebUI:    http://127.0.0.1:3421

Export TYPESAFE_API_KEY before installation or put it in the installed
private environment file afterward. Jev uses jev-latest.
Re-run to update from the current checkout. Use ./scripts/uninstall.sh to remove.
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--prefix DIR` | `~/.local/share/goodvibes` | Where the built programs live. Holds `installation.json` (the receipt), `current` (a link to the active release), `releases/<commit>-<id>/` and `commands/`. |
| `--bin-dir DIR` | `~/.local/bin` | Where the four command links go: `goodvibes`, `goodvibes-agent`, `goodvibes-daemon`, `goodvibes-uninstall`. |
| `--data-dir DIR` | `~/.local/share/goodvibes-data` | This installation's data. The programs use `<data-dir>/.goodvibes` instead of `~/.goodvibes`. |
| `--workspace DIR` | the checkout directory | The project the installer pairs the terminal app in (the daemon's service starts in the home: the daemon has no working folder). Must be an existing directory, not the home directory, not `/`, and not inside the program or data directory. |
| `--port PORT` | `3421`; on an update, the daemon's current `controlPlane.port` | The daemon's port (`controlPlane.port`), 1024 to 65535. |
| `--no-service` / `--service` | `--service`; on an update, the daemon's current `service.enabled` | Whether to install and start the daemon's systemd user unit (`goodvibes.service`, or the name set in `service.serviceName`). |
| `--decision-policy POLICY` | unchanged | `Hybrid` or `Decision Model Only` (the "If Jev can't answer" choices Ask me and Refuse the action), saved as `judgment.policy`. |
| `--uninstall [--prefix DIR] [--purge]` | | Must be the first argument. Runs `scripts/uninstall.sh` with the remaining arguments. |
| `--help`, `-h` | | Prints the help. Must be the first argument. |

`--prefix`, `--bin-dir` and `--data-dir` must be three separate directories inside the home directory that do not contain each other, must not be symbolic links (nor have one anywhere in their path), and must not contain `~/.config/systemd/user`. Programs and data must be outside the checkout. A value that starts with `--` is not accepted as an option's value.

On a later run, `--bin-dir`, `--data-dir` and `--workspace` keep the values from the receipt when not given. The port and the service choice come from the daemon's own settings (`goodvibes-daemon config get controlPlane.port --json` and `config get service.enabled --json`, through the installed command), so a later `goodvibes-daemon webui enable --lan`, another `controlPlane.port` or `goodvibes-daemon uninstall-service` is kept by an update; the receipt only records what the installer wrote. An update writes `controlPlane.port` and `service.enabled` only when `--port` or `--service`/`--no-service` is given, and runs `webui enable` without `--loopback`, so the web UI's reach is unchanged. `--bin-dir` and `--data-dir` cannot change on an update (`Keep existing command/data paths when updating, or uninstall first.`); `--port`, `--workspace` and `--service`/`--no-service` can. Before the service unit is written or removed, the receipt records that a service change is under way; a run stopped part way (killed, power lost) is put back by the next run, which restores the unit the receipt records (or removes the one the stopped run wrote) and then proceeds, instead of refusing with `Service has been modified or is not owned`. Before an update's first settings write, the receipt likewise records each setting it is about to change with its previous value; the next run sets back each one that still holds what the stopped run wrote (`An earlier update was stopped after it changed daemon settings; put back <keys>.`) and leaves one changed since alone.

Set the Jev key (the hosted decision model's key) before the first install so it lands in the private environment file:

```sh
export TYPESAFE_API_KEY='<your-typesafe-api-key>'
./scripts/install-from-checkout.sh
```

### What it does, in order

1. Checks the system, the tools and that it runs from a clone. Downloads Bun and Node when needed.
2. Takes a lock beside the program directory and the data directory (`<dir>.writer.sqlite`). A second install or uninstall started meanwhile is refused at once and changes nothing. The operating system releases the lock when the process ends for any reason.
3. Recovers an update that was killed earlier (it puts the previous release back), or deletes the unfinished release copy a first install left when it was killed while copying: exactly the release named in the `installing.json` record that first install wrote before copying, and nothing else in the program directory.
4. Checks the layout, the ownership of existing files, the systemd user manager and the port, all before building.
5. Requires that tracked files match the commit, then builds: `bun install --frozen-lockfile`, the engine build, the daemon, terminal app, Agent and web UI builds. Checks again that the commit did not change and the build changed no tracked file.
6. Checks everything again (a long build may have given time for changes), then copies the build into a new `releases/<commit>-<random id>/` directory: `daemon/`, `tui/`, `agent/` (each with its program, Bun runtime files, native libraries and a `playwright-core` copy), `webui/`, `runtime/bun`, `runtime/node` and `uninstall.js`. Runs each program's `--version`.
7. Stops the old service when one runs (an update), and checks the port again.
8. Writes `<data-dir>/.goodvibes-owner.json` (data ownership) and, only when it does not exist yet, `<data-dir>/environment`: `TYPESAFE_API_KEY='<value>'` when the variable is exported, otherwise a commented placeholder line. An existing environment file is never changed; when `TYPESAFE_API_KEY` is exported but the file has no key, the script says so.
9. Points `current` at the new release and writes the four command wrappers into `<prefix>/commands/`, with links to them from the bin directory.
10. Saves `judgment.policy` when `--decision-policy` was given. On a first install, sets `controlPlane.port` and `service.enabled` and runs `goodvibes-daemon webui enable --loopback --bundle-dir <prefix>/current/webui`; on an update, sets `controlPlane.port` and `service.enabled` only when `--port` or `--service`/`--no-service` was given and runs `webui enable --bundle-dir <prefix>/current/webui` without a posture flag.
11. Checks the Jev connection (see below). A failure only prints a warning.
12. With the service: the daemon writes its unit (`goodvibes-daemon refresh-service`), named by `service.serviceName` (default `goodvibes`, so `~/.config/systemd/user/goodvibes.service`); the installer asks it which unit it wrote (`goodvibes-daemon service-status --json`), records that name in the receipt so update, recovery and uninstall act on the same unit, runs `systemctl --user daemon-reload`, `enable` and `restart`, then waits up to 90 seconds until the unit is active, `http://127.0.0.1:<port>/` returns this release's web UI and `/api/health` reports the control plane ready. Then pairs the local terminal app with the daemon.
13. Without the service on an update that had one: disables and deletes the unit.
14. Writes the receipt, then deletes earlier releases that no running program uses (`A previous release is retained for a running terminal or agent. Reopen it to use the update.` for one still in use; `Update succeeded; an unused previous release remains at <path>.` when one could not be deleted, which can then be removed by hand).

A successful run ends with:

```text
Installed GoodVibes (3f2a9c1d0b7e). Commands: /home/alex/.local/bin
Workspace: /home/alex/src/goodvibes
WebUI: http://127.0.0.1:3421
Service: systemctl --user status goodvibes.service
Credentials: /home/alex/.local/share/goodvibes-data/environment
Uninstall: /home/alex/.local/bin/goodvibes-uninstall (add --purge to remove data)
For startup before login and after logout: loginctl enable-linger "$USER"
```

The `WebUI:` line is the address `goodvibes-daemon webui enable` reported. Without the service, the `Workspace:` line and the closing lingering line are left out, and the `Service:` line is replaced by `Start the daemon: <bin-dir>/goodvibes-daemon serve`. When the bin directory is not on `PATH`, a line `Add commands to your shell PATH: export PATH='<bin-dir>':"$PATH"` is added; this installer does not edit shell startup files. It does not enable lingering itself.

If any step fails, or the run is interrupted with Ctrl-C, a termination signal or a closed terminal, the script restores the previously installed release, its wrappers, settings and unit, restarts the old service if it was running, and exits with the error (status `1`, or `130`, `143`, `129` for the signals). A first install that fails is removed completely. If even that recovery fails, it prints `Install failed and automatic recovery was incomplete. Files retained at <prefix>; inspect goodvibes.service before retrying.`

### What a checkout installation looks like

Each command in the bin directory is a link to a small wrapper script in `<prefix>/commands/`. The wrapper for `goodvibes`, `goodvibes-agent` and `goodvibes-daemon`:

1. reads `<data-dir>/environment` with every variable exported, when the file exists;
2. pins the release `current` points at, so an update during a running session does not swap files under it;
3. sets `GOODVIBES_HOME=<data-dir>`, `GOODVIBES_DAEMON_HOME=<data-dir>/.goodvibes/daemon` and `GOODVIBES_SUITE_RUNTIME=<release>/runtime`. The terminal app, the Agent and the daemon therefore keep their whole tree under `<data-dir>/.goodvibes/`, with one `secrets.key`, so a secret one of them stores the others can read (`GOODVIBES_AGENT_HOME`, when set, still moves the Agent alone);
4. runs the program from that release. `PATH` is left as the owner's, so project commands use the owner's own `bun`, `node` and `npm`.

The `goodvibes-uninstall` wrapper runs `<release>/runtime/bun <release>/uninstall.js --prefix <prefix>`.

The unit is written by the daemon itself (`goodvibes-daemon refresh-service`, run by the installer through the wrapper), so it is the same definition every other path writes (see [What the service is](#what-the-service-is)): it runs the launcher `<prefix>/commands/goodvibes-daemon` with no arguments (the daemon reads its port, set with `config set controlPlane.port`, and its loopback address from settings) in the home directory (the daemon has no working folder; each program names its project), with `Environment=GOODVIBES_HOME=<data-dir>`, restarts on failure, and carries the GoodVibes description. The daemon's service commands (`goodvibes-daemon service-status`, `restart-service`, ...) and `goodvibes doctor` recognise it as GoodVibes's own. The installer records `service.enabled` as `true` with the service and `false` with `--no-service`.

Put credentials for this installation in `<data-dir>/environment`, one `NAME='value'` per line, for example `TYPESAFE_API_KEY='<your-typesafe-api-key>'`. Every command reads it at start, so a change takes effect at the next start of each program; restart the daemon with `systemctl --user restart goodvibes.service`.

### The Jev connection check

After installing, the script asks the configured decision model one question, using the environment file. It prints `Decision-model connection verified.`, or `No decision model selected; no decision-model connection is required or certified.` when `judgment.policy` is `No Decision Model` or no decision model is set (no endpoint, model, key or fallback). A set model that fails is reported, never taken for an unset one: `Jev setup failed: Decision model <model> failed: <what failed>. <next step>` names the model, what failed (for example `its endpoint could not be reached`) and what to do. Any other failure prints `Jev setup failed: <reason>.` with either `Add credits or update billing for the TypeSafe account at https://console.typesafe.ai/settings/billing.` (the service answered "payment required") or `Check the Jev endpoint and TYPESAFE_API_KEY in the installation environment file.`, followed by `Jev connection check failed; continuing software installation. Resolve the account or connection problem reported above to use Jev.` The installation still completes.

### Pairing the terminal app

With the service, the script pairs the installed terminal app with the new daemon. When an earlier pairing attempt is recorded as unfinished, it cannot pair again until the owner clears it; the script then finishes the install anyway and prints `TUI pairing was skipped (it needs the owner's attention, see above); the installation itself is complete and the daemon is running.` with the command that pairs afterwards. Any other pairing failure fails the install and restores the previous version.

### How the automatic updates treat a checkout installation

A checkout installation is recognised in three ways:

- The installers recognise it by a command in the bin directory that is a link to `<prefix>/commands/<name>` with `<prefix>/installation.json` beside it.
- The daemon recognises it by the environment its wrapper sets: with `GOODVIBES_HOME` or `GOODVIBES_DAEMON_HOME` set, it treats itself as running from a moved home.
- The terminal app and the Agent do not tell it apart from a release installation. They run as compiled programs outside any `node_modules` directory, so they count as release ("binary") installations.

What each update path then does:

| Path | On a checkout installation |
| --- | --- |
| The daemon's update loop | Off. A daemon with a moved home never updates itself. `goodvibes-daemon update` shows `updates:  off: this host manages its own updates: no artifact identity was provided, and the platform package version is never assumed to be the shipped one`, or, when the daemon's `update.auto` is `false`, the `update.auto is not true` reason, which is checked first. The daemon also never promotes itself to a service and never repairs its suite at startup. |
| Launch update of the terminal app and the Agent | Runs its check. When the latest release is newer than the build, or has the same version (a checkout build lacks the release's reader records, so it always counts as needing repair), it tries to install and stops before downloading any program, because the checkout installer points the web UI at `<prefix>/current/webui`, which is outside the program's own directory. It prints `downloading <tag>…`, then `Update available: <tag> (running v<version>). Downloading and verifying...` or `Repairing the installed GoodVibes suite at <tag>. Downloading and verifying...`, then `auto-update failed: The configured WebUI (<prefix>/current/webui, from controlPlane.webui.bundleDir or web.staticAssetsDir) is separately managed and is not updated with the suite. Update its deployment explicitly, or clear that setting, then update the suite again.; starting the current version v<version>`. Nothing is changed. When the build is newer than the latest release, it does nothing. |
| The Agent's while-running update | Tries in the same way at each check and fails with the same reason, changing nothing. |
| `/update apply` | Prints the same reason as `Update failed: The configured WebUI (...) ...`. Nothing is changed. |
| `/update check` | Works: it reports the latest release, or `The installed programs need repair at <tag>. Align them: /update apply` when the versions are equal. |
| `/update rollback` | `Rollback failed:` with the same web UI reason. |

To keep the terminal app and the Agent from trying at every start, turn their launch updates off: `goodvibes-daemon config set update.autoUpdateAtLaunch false`. With a checkout installation this writes `<data-dir>/.goodvibes/daemon/settings.json`, which both read.

### Updating and removing a checkout installation

Update: bring the checkout to the wanted commit, then run the script again from it.

```sh
git -C ~/src/goodvibes pull
~/src/goodvibes/scripts/install-from-checkout.sh
```

Remove the programs and the service, keeping the data and the environment file:

```sh
goodvibes-uninstall
```

It prints `GoodVibes uninstalled. Data and credentials preserved at <data-dir>`. Add `--purge` to delete the data directory too (`GoodVibes uninstalled, including its data.`). It must run as the user who installed it (`Run uninstall as the user who owns this installation.`). An uninstall that stopped part way can be run again. When the installed uninstaller itself is damaged, use `./scripts/uninstall.sh --prefix <prefix>` from a checkout (see [`scripts/uninstall.sh` from a checkout](#scriptsuninstallsh-from-a-checkout)).

To move from a checkout installation to the release installer while keeping sessions and settings, merge the checkout's data tree into `~/.goodvibes`. Paths below use the default data directory `~/.local/share/goodvibes-data`.

1. Quit every `goodvibes` and `goodvibes-agent`, then remove the checkout installation (it keeps the data): `goodvibes-uninstall`.
2. Look at both trees:

   ```sh
   ls -A "$HOME/.local/share/goodvibes-data/.goodvibes"
   ls -A "$HOME/.goodvibes"
   ```

   `~/.goodvibes` exists already when GoodVibes was used on this machine before the checkout installation.
3. When `~/.goodvibes` does not exist, move the whole tree in one step: `mv -- "$HOME/.local/share/goodvibes-data/.goodvibes" "$HOME/.goodvibes"`. When it does exist, never run that command: `mv` would put the tree inside it as `~/.goodvibes/.goodvibes`, where nothing reads it. Move the entries one at a time instead. For each name the first listing shows and the second does not, run `mv -- "$HOME/.local/share/goodvibes-data/.goodvibes/<name>" "$HOME/.goodvibes/<name>"` (typically `tui`, `daemon`, `daemon-host`, `voice`, `logs`).
4. Names in both listings need a choice:
   - `secrets.key`: the key that encrypts every `secrets.enc` of its tree. Keep `~/.goodvibes/secrets.key` and do not move the other one. The `secrets.enc` files you moved in step 3 (for example `tui/secrets.enc`, `daemon/secrets.enc`) were encrypted with the checkout tree's key and cannot be read with this one: delete those moved files (`rm -f -- "$HOME/.goodvibes/tui/secrets.enc" "$HOME/.goodvibes/daemon/secrets.enc"`, naming each one that exists) and store those credentials again after the install. When only the checkout tree has a `secrets.key`, move it with the rest.
   - `shared`: move each file inside it that `~/.goodvibes/shared/` lacks. For `subscriptions.json` present in both, keep one; the other side's subscription sign-ins must be repeated.
   - Anything else: keep the copy you want and move or delete the other by its full path.
5. Install: `curl -fsSL https://goodvibes.sh/install.sh | sh`.
6. Set again the credentials that lived only in `<data-dir>/environment` (for example `TYPESAFE_API_KEY`); the release installation has no such file. Then remove the old data directory when nothing in it is needed: `rm -rf -- "$HOME/.local/share/goodvibes-data"`.

### Checkout installer messages and fixes

| Message | Cause | Fix |
| --- | --- | --- |
| `The installer currently supports Linux only.` / `Supported hosts: Linux x64/arm64.` | Not Linux, or another processor. | Use the release installer. |
| `Run as your regular user, without sudo.` | Run as root. | Run as the owner. |
| `Supported architectures: x64 and arm64.` | Another processor. | Not supported. |
| `Install the prerequisite: <tool>` | `git`, `curl`, `tar`, `unzip` or `sha256sum` missing. | Install it with the system package manager. |
| `A glibc Linux distribution is required (musl/Alpine is not supported).` | musl system. | Not supported. |
| `Run install-from-checkout.sh from a clone of the GoodVibes repository (released binaries install with scripts/install.sh).` | The script was copied out of a clone. | Run it inside a full clone. |
| `Cannot read engines.bun from <root>/package.json; ...` | `package.json` was edited or damaged. | Restore it from the repository. |
| `Missing or ambiguous checksum: <file>` / `Cannot identify a Node runtime.` | The Bun or Node download listing was unexpected. | Retry later, or put the matching `bun` (1.3.14) and a `node` 22+ on `PATH`. |
| `Unknown or incomplete option: <flag>` | Unknown flag, or a flag without its value. | Check the options table. |
| `Expected a normalized absolute path: <path>` / `Refusing symlink path: <path>` | A directory option is relative after resolving, contains control characters, or passes through a symbolic link. | Use plain directories with no links in their path. |
| `Installation, commands and data must be separate directories below your home.` / `Installation, command and data directories must not overlap.` / `Installation paths must not contain the systemd unit directory.` | Bad `--prefix`, `--bin-dir` or `--data-dir`. | Choose three separate directories inside the home directory. |
| `--workspace must name a project directory.` / `--workspace must name a project directory outside installation data.` | Bad `--workspace`. | Name an existing project directory. |
| `--port must be an integer between 1024 and 65535.` | Bad `--port`. | Use a port in range. |
| `Keep existing command/data paths when updating, or uninstall first.` | `--bin-dir` or `--data-dir` differs from the receipt. | Leave them out, or uninstall first. |
| `Install programs and data outside the source checkout.` | A directory is inside the clone, or the clone inside the program directory. | Move it. |
| `Program directory <prefix> is not empty and has no GoodVibes installation receipt, so this installer does not own it; ...` | `--prefix` holds other files. | Choose another `--prefix`, or delete it if nothing there is needed (the message prints the command). |
| `Command already exists: <path>; nothing was changed. ...` | The bin directory already has a `goodvibes*` command, usually from the release installer. | Uninstall the release installation first, or choose `--bin-dir`. |
| `A service definition this installer does not own already exists at <path>; ...` | `goodvibes.service` exists, usually from the release installer. | Uninstall that installation, or install with `--no-service`. |
| `Data directory is not empty and is not owned by the GoodVibes installer. Choose --data-dir.` | The data directory holds other files. | Choose another `--data-dir`. |
| `Data directory is in use by another installation: <prefix>` | Another checkout installation owns that data. | Choose another `--data-dir`. |
| `No systemd user service manager is reachable from this session (<reason>); nothing was changed. ...` | No user bus (SSH without a session, container, WSL without systemd). | Log in to a normal session, or use `--no-service`. |
| `Another goodvibes.service is already loaded.` / `Systemd loaded a different goodvibes.service; refusing to manage it.` | A `goodvibes.service` from elsewhere is loaded. | Stop and remove that unit first. |
| `Port <port> is already in use. Choose --port; no other service will be stopped.` | Something listens on the port. | Free it or pass `--port`. |
| `Another install or uninstall is running for <dir>; nothing was changed. ...` | A second run is in progress. | Wait, then retry. |
| `Install from a Git checkout with an exact commit.` | Not a git checkout. | Clone the repository. |
| `Tracked files differ from commit <commit> before the build, ... Commit or stash tracked changes, then re-run the installer.` | Local edits to tracked files. | `git stash` or commit, then retry. |
| `Tracked files differ from commit <commit> after the build, ...` / `Checkout changed during the build; re-run installation.` | A build step rewrote a tracked file, or the checkout moved during the build. | `git status`; restore the file with `git checkout -- <file>`; retry. |
| `WebUI build did not produce index.html.` | The web UI build failed silently. | Run `bun run --cwd products/webui build` to see the error. |
| `TYPESAFE_API_KEY must be a single line.` | The exported key contains a line break. | Export the key without line breaks. |
| `Refusing to replace or remove another installation: <link>` / `Managed command has been modified: <wrapper>` / `Service has been modified or is not owned: <unit>` / `Installation current link has changed.` / `User data does not belong to this installation.` | A file the receipt owns was edited or replaced. | Restore or remove the edited file, then retry. |
| `Invalid GoodVibes installation receipt.` / `Invalid GoodVibes data ownership marker.` | `installation.json` or `.goodvibes-owner.json` is damaged. | Restore it, or remove the installation by hand. |
| `Invalid command ownership receipt.` | `installation.json` parses, but its `wrappers` record lacks the text of one of the four commands (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`, `goodvibes-uninstall`). | The receipt was edited or cut short. Restore `installation.json` from a backup; otherwise remove the installation by hand (stop and remove `goodvibes.service`, delete the four links in the bin directory and the program directory), then install again. |
| `Legacy data ownership cannot be established. Update the owning installation before moving its data.` | The data directory's `.goodvibes-owner.json` names no program directory (an older format), and the installation at the program directory being used does not carry the same id. | Run the installer again with the `--prefix` of the installation that created that data, so it rewrites the marker; or choose another `--data-dir`. |
| `An earlier update was interrupted and the previous release <dir> is gone, ...` | An update was killed and the old release was deleted. | Run `./scripts/uninstall.sh --prefix <prefix>` from the checkout (data is kept), then install again. |
| `Daemon stopped during startup. Inspect: journalctl --user -u goodvibes.service` / `Daemon/WebUI did not become ready in 90 seconds. Inspect: ...` | The new daemon failed to start or answer. The previous version was restored. | Read the journal, fix, retry. |
| `The daemon has not stopped; keeping the installation intact.` / `Replacement service did not stop.` | systemd could not stop the service. | `systemctl --user stop goodvibes.service`, then retry. |
| `` A GoodVibes program from <prefix> is still running (a daemon started with `goodvibes-daemon serve`, a terminal or an agent); quit it, then run the uninstall again. `` | Uninstall found a process of this user running a program from the installation after its service was stopped. Nothing was removed; the service stays stopped and disabled. | Quit that program, then run the uninstall again. |
| `<command> failed (<status>): <output>` / `<command> could not be started (ENOENT)` | A build or system command failed. | Read its output, fix, retry. |

## Installer errors and their fixes

Every refusal of the release installer ends with its id in parentheses, for example `install.sh: need curl or wget (INSTALL_E004)`. The exit status is `1`.

Many ids guard against something changing the install directory, a claim file or a staging directory while the installer runs. They have one shared fix, called "retry" in the table: make sure no other GoodVibes install, uninstall, `/update` or daemon update is running and that no other tool (a sync client, a backup restore, a second shell) is changing the install directory, then run the installer again. A retry first recovers anything a previous run left.

| Id | Message (shortened) | Cause | Fix |
| --- | --- | --- | --- |
| `INSTALL_E001` | native Windows is not supported yet | Run in Git Bash, MSYS or Cygwin. | Install WSL2 (`wsl --install`) and run the installer inside the Linux distribution. |
| `INSTALL_E002` | unsupported operating system: `<os>` | Not Linux or macOS. | Not supported. |
| `INSTALL_E003` | unsupported architecture: `<arch>` | Not x64 or arm64. | Not supported. |
| `INSTALL_E004` | need curl or wget | Neither is installed. | Install `curl`. |
| `INSTALL_E005` | need sha256sum or shasum to verify downloads | Neither is installed. | Install coreutils (Linux) or use the system `shasum` (macOS). |
| `INSTALL_E006` | could not resolve the latest release tag for mgd34msu/goodvibes | `curl` could not reach GitHub. | Check the network and proxy, or set `GOODVIBES_VERSION=vX.Y.Z`. |
| `INSTALL_E007` | could not resolve the latest release tag | GitHub gave no tag (with `wget`, or an empty redirect). | As `INSTALL_E006`. |
| `INSTALL_E008` | All products use GOODVIBES_VERSION; remove conflicting per-product version overrides. | `GOODVIBES_DAEMON_VERSION`, `GOODVIBES_AGENT_VERSION` or `GOODVIBES_WEBUI_VERSION` differs from `GOODVIBES_VERSION`. | `unset GOODVIBES_DAEMON_VERSION GOODVIBES_AGENT_VERSION GOODVIBES_WEBUI_VERSION`. |
| `INSTALL_E009` | Invalid release version: `<v>` | The tag is not `vX.Y.Z[-suffix]`. | Use a tag from the releases page, for example `v3.5.0`. |
| `INSTALL_E010` | Missing or ambiguous checksum: `<file>`. Release `<v>` is incomplete; no source build will be attempted. | The release's checksum list has no line (or more than one line) for a file this platform needs. | Choose another release with `GOODVIBES_VERSION`. |
| `INSTALL_E011` | Checksum mismatch: `<file>` | The download was corrupted or altered (often a proxy). | Retry; if it persists, check the network path. |
| `INSTALL_E012` | Could not extract the verified browser driver. | `tar` failed (disk full, `$TMPDIR` problem). | Free space or set `TMPDIR`; retry. |
| `INSTALL_E013` | The verified browser driver is missing playwright-core/`<file>`. | The release archive is incomplete. | Use another release. |
| `INSTALL_E014` | Could not extract the verified WebUI. | As `INSTALL_E012`. | As `INSTALL_E012`, or install with `GOODVIBES_WEBUI=0`. |
| `INSTALL_E015` | The verified WebUI is missing goodvibes-webui/index.html. | The release archive is incomplete. | Use another release, or `GOODVIBES_WEBUI=0`. |
| `INSTALL_E016` | The verified daemon did not confirm its compiled readers. No installed program was replaced. | The downloaded daemon could not run from `$TMPDIR`: a `noexec` `/tmp`, a musl system, or the wrong platform. | Set `TMPDIR` to an executable directory under the home directory; on musl use a glibc system. |
| `INSTALL_E017` | The verified daemon release metadata could not be confirmed. No installed program was replaced. | Linux only. The downloaded daemon runtime could not run (same causes as `INSTALL_E016`), or the release record did not match. | As `INSTALL_E016`; otherwise use another release. |
| `INSTALL_E018` | The complete suite installation claims are not retained. | Internal consistency check of the claims. | Retry. |
| `INSTALL_E019` | The original installation or private claim directory changed; no further program replacement is allowed. | The install directory or claim directory was replaced or moved during the install. | Retry. |
| `INSTALL_E020` | Original installation claim identity is unavailable. | Internal consistency check of the claims. | Retry. |
| `INSTALL_E021` | Original installation claim ownership changed; no further program replacement is allowed. | A claim file was replaced during the install. | Retry. |
| `INSTALL_E022` | The installer swap journal is not available. | Internal consistency check. | Retry. |
| `INSTALL_E023` | A previous-program backup appeared at `<file>.goodvibes-previous` during this install; nothing more was replaced. | Something created a backup file while the installer ran. | Check that `<file>` runs, delete the backup, retry. |
| `INSTALL_E024` | Could not back up `<file>` before replacing it. | Disk full or no permission in the install directory. | Free space, fix permissions, retry. |
| `INSTALL_E025`, `INSTALL_E026` | Could not record the swap journal. | Disk full or no permission. | Free space, fix permissions, retry. |
| `INSTALL_E027` | Leftover previous-program backups from an interrupted earlier install were found; nothing was changed. | `*.goodvibes-previous` files remain from an earlier install that was killed and could not be recovered. They are never restored automatically. | Check that the installed programs run (`goodvibes --version`). Then delete the listed files with the `rm -f -- ...` command the message prints, and retry. If a program is broken, first put its backup back: `mv -f <file>.goodvibes-previous <file>`. |
| `INSTALL_E028` | Unknown suite claim purpose. | Internal error. | Retry; report it if it repeats. |
| `INSTALL_E029` | The native stat utility is required to retain original installation ownership. | `stat` is missing. | Install coreutils. |
| `INSTALL_E030` | The original uninstall directory changed before exclusion. | Uninstall: the directory changed. | Retry the uninstall. |
| `INSTALL_E031` | Could not retain the installation directory. | The install directory cannot be entered. | Fix its permissions; retry. |
| `INSTALL_E032` | Could not retain the selected installation directory. | The install directory changed while it was being opened. | Retry. |
| `INSTALL_E033` | The original uninstall directory changed before claiming. | Uninstall: the directory changed. | Retry the uninstall. |
| `INSTALL_E034` | The private installation claim directory changed. | The new claim directory became a link. | Retry. |
| `INSTALL_E035` | Could not retain the original private claim directory. | As `INSTALL_E034`. | Retry. |
| `INSTALL_E036`, `INSTALL_E037` | Another goodvibes update or install claimed `<path>` while this run started; nothing was changed. | Another installer or an automatic update started at the same moment. | Wait for it to finish (`goodvibes-daemon update` shows a daemon update), then retry. |
| `INSTALL_E038` to `INSTALL_E042` | The original installation claim changed during capture / Could not retain ... / changed during observation / could not retain its transaction ownership / changed before retention. | A claim file changed while it was being created. | Retry. For `INSTALL_E041`, first look at the `*.update-transaction` files in the install directory. |
| `INSTALL_E043` | An interrupted update left the partial program file `<path>`; nothing was changed. | A `.update-download`, `.update-previous`, `.rollback-exchange` or `.incoming` file of a program remains, and no update holds it. | If the installed programs run, delete the named file and retry. If `<program>` itself is missing and the file is its `.update-previous` copy, rename it back first. |
| `INSTALL_E044` | An interrupted update left the partial companion file `<path>`; nothing was changed. | As `INSTALL_E043`, for `daemon-installation.json` or the vector library. | As `INSTALL_E043`. |
| `INSTALL_E045` | An interrupted update left the partial SQLite runtime file `<path>`; nothing was changed. | macOS, as `INSTALL_E043`, for the SQLite library. | As `INSTALL_E043`. |
| `INSTALL_E046` | The native library directory `<dir>` is a symbolic link, and the installer does not replace programs through one. | `lib` or `lib/<name>` is a link. | Replace the link with a plain directory (or delete it), retry. |
| `INSTALL_E047` | An installed native library parent is not a directory. | `lib` or `lib/<name>` is a file. | Delete or rename that file, retry. |
| `INSTALL_E048` | An interrupted run left the staged library `<file>.incoming`; nothing was changed. | A killed earlier install. | Run the `rm -rf -- ...` command the message prints, retry. |
| `INSTALL_E049` | Could not record the swap journal. | Disk full or no permission. | Free space, retry. |
| `INSTALL_E050` | Could not exclusively stage the native library. | A `.incoming` file appeared, or the disk is full. | Retry. |
| `INSTALL_E051` | The selected `<program>` release has no reader evidence. The installed programs were kept. | Saved data needs a reader check, and this (older) release cannot prove it can read the data. | Install the current or a newer release. |
| `INSTALL_E052` | Unsupported native reader evidence. | Internal error. | Retry; report it if it repeats. |
| `INSTALL_E053` | The selected `<program>` reader evidence does not name this release and platform. | The release's reader record does not match. | Use another release. |
| `INSTALL_E054` to `INSTALL_E056` | Reader evidence has a missing or ambiguous program pin / names an unavailable release member / does not match the selected released program bytes. | The release's reader record does not match its files. | Use another release. |
| `INSTALL_E057` | The selected `<program>` release cannot read the saved data. The installed programs were kept; choose a compatible newer release. | A downgrade to a release older than the saved data allows. | Install the current or a newer release. Do not delete `.goodvibes-reader-requirements.json`. |
| `INSTALL_E058` | The selected `<program>` did not confirm its matching compiled readers. | The downloaded program's answer did not match. | Use another release. |
| `INSTALL_E059` to `INSTALL_E062` | Could not record the swap journal. | Disk full or no permission. | Free space, retry. The previous programs were put back. |
| `INSTALL_E063` | the installed goodvibes-daemon binary failed to run ('goodvibes-daemon --version') | The new daemon cannot run here (missing system library, musl, wrong platform). The previous programs were put back. | Run `~/.local/bin/goodvibes-daemon --version` after a retry to see the error; use a glibc Linux or supported macOS. |
| `INSTALL_E064` | the installed goodvibes-agent binary failed to run ('goodvibes-agent --version') | As `INSTALL_E063`, for the Agent. | As `INSTALL_E063`, or install with `GOODVIBES_AGENT=0`. |
| `INSTALL_E065` | The WebUI directory is an alias; its existing deployment was preserved. | `<dir>/webui` is a symbolic link. | Replace it with a plain directory, or install with `GOODVIBES_WEBUI=0`. |
| `INSTALL_E066` | Could not exclusively create the WebUI directory. | `<dir>/webui` appeared meanwhile, or no permission. | Retry. |
| `INSTALL_E067` | Released directories must belong to this original suite installation. | Internal check of the target directory. | Retry. |
| `INSTALL_E068` to `INSTALL_E071` | The original directory publication parent is unavailable / Could not retain ... / Verified directory staging is unavailable / changed. | The install directory or `$TMPDIR` staging changed. | Retry. |
| `INSTALL_E072` | An interrupted run left the staged directory `<dir>.incoming`; it was preserved and nothing was changed. | A killed earlier install. | If no install or update runs, run the `rm -rf -- ...` command the message prints, retry. |
| `INSTALL_E073` | The existing directory target is a custom file or alias; it was preserved. | `playwright-core` or `webui/<version>` is a file or a link. | Move it away, retry. |
| `INSTALL_E074` to `INSTALL_E076` | Could not retain the original installed directory / reserve private directory staging / Original directory staging changed. | No permission, disk full, or a change during the install. | Retry. |
| `INSTALL_E077` | Another directory update or interrupted publication owns this target. | `<dir>.directory-update.lock` exists. | If no install or update runs, delete the lock file named in the install directory (`playwright-core.directory-update.lock` or `webui/<version>.directory-update.lock`), retry. |
| `INSTALL_E078` to `INSTALL_E095` | Could not claim the original directory target / retain the directory claim / ... changed ... / Could not copy / set permissions / park / publish / The directory rename result is unknown. | The web UI or browser driver directory changed, disk full, or no permission, while being published. The previous directory was kept or restored. | Retry. When the message also says `directory publication needs inspection; preserve <dir> and <lock> before retrying`, look at those paths first. |
| `INSTALL_E096` to `INSTALL_E099` | Released directory staging is unavailable / The release archive collides with local directory bookkeeping / Could not record the selected directory release / Could not set directory release metadata permissions. | Staging under `$TMPDIR` failed, or the archive already contains `.goodvibes-release.json`. | Retry; if `INSTALL_E097` repeats, use another release. |
| `INSTALL_E100`, `INSTALL_E101` | An interrupted update left `<path>`; nothing was removed. | Uninstall found a partial update file. | Follow the message: put the `.update-previous` copy back with the printed `mv` command when the program is missing, otherwise delete the file with the printed `rm` command, then run the uninstall again. |
| `INSTALL_E102` | A browser-driver update holds `<dir>/playwright-core.directory-update.lock`; nothing was removed. | Uninstall during, or after an interrupted, browser driver update. | If no update runs, delete the lock (printed command), uninstall again. |
| `INSTALL_E103` | A WebUI update holds `<lock>`; nothing was removed. | As `INSTALL_E102`, for the web UI. | As `INSTALL_E102`. |
| `INSTALL_E104` to `INSTALL_E106` | The selected uninstall directory is unavailable / Could not retain / changed. | Uninstall: the install directory is not a directory, or changed. | Check `GOODVIBES_INSTALL_DIR`, retry. |
| `INSTALL_E107` to `INSTALL_E109` | An original native library directory changed during uninstall / The original native library root changed. | Uninstall: `lib` changed while files were removed. Remaining files were kept. | Retry the uninstall. |
| `INSTALL_E110` | `<flag>` needs a value | `--version`, `--bin-dir`, `--install-dir` or `--decision-policy` without a value. | Give the value. |
| `INSTALL_E112` | Unknown option: `<flag>`. Use --help for released-version installation; source builds use scripts/install-from-checkout.sh. | An unknown flag. | See `--help`. Source builds use `scripts/install-from-checkout.sh`. |
| `INSTALL_E113` | The installed uninstaller of `<prefix>` is missing; nothing was removed. | Uninstall of a checkout installation whose `uninstall.js` is gone, run with no checkout beside the script. | From a clone: `./scripts/uninstall.sh --prefix <prefix>`. |
| `INSTALL_E114` | A checkout installation owns `<path>`; nothing was changed. | The install directory holds a checkout installation's commands. | Run `<prefix>/commands/goodvibes-uninstall`, move the data if wanted (the message prints the `mv` command), then retry. |
| `INSTALL_E115` | the installed binary failed to run ('goodvibes --version'); the download may not match this platform | As `INSTALL_E063`, for the terminal app. The previous programs were put back. | As `INSTALL_E063`. |
| `INSTALL_E116` | Suite files were installed, but this run's transaction claims in `<dir>` changed, so services were not started. | A claim changed after the programs were in place. The new programs are installed. | Retry once nothing else runs; the retry releases stale claims and finishes the service steps. |
| `INSTALL_E117` | The installation claim `<path>` cannot be read (or could not be released), so its owner is unknown; nothing was changed. | A damaged `*.update-transaction` file. | If no install or update runs, run the printed `rm -rf -- <path>`, retry. |
| `INSTALL_E118` (1) | Another goodvibes update or install (process `<pid>`) is replacing programs in `<dir>` and holds `<claim>`; nothing was changed. Wait for it to finish, then re-run the installer. | A running process holds a `*.update-transaction` claim: another installer or uninstaller, `/update apply` or `/update rollback`, a launch update, the Agent's while-running update, or the daemon's update loop while it replaces files. The installer judges the owner alive only when that pid exists and started no later than the claim was written (a few seconds of slack); a pid reused by another program after the owner died counts as gone, and such a claim is recovered automatically. | See which process it is: `ps -o pid,lstart,args -p <pid>`. When it is an install, `/update` or a launch update, wait until it exits, then run the install command again. A daemon update holds the claim only while it writes and renames the new files, after the download; a `pending:` line in `goodvibes-daemon update` means a release waits for an idle moment and holds no claim yet. When the holder is a daemon that does not finish (the claim stays for minutes), stop that daemon (`goodvibes-daemon stop-service`, or `kill <pid>` for a hand-started one, then `kill -9 <pid>` only if it does not exit) and run the install command again: the claim of a process that is gone is recovered. When `ps` shows a program that is not GoodVibes, run the install command again; if the refusal repeats, the claim has no start time and was left behind: once no GoodVibes install or update runs, `rm -f -- '<claim>'` and run it again. |
| `INSTALL_E118` (2) | Another goodvibes update or install (process `<pid>`) claimed `<claim>` while this run was releasing a claim left by a process that is gone; its claim was left in place and nothing was changed. Wait for it to finish, then re-run the installer. | While this run released a dead process's claim, a live install or update took the same claim. `<pid>` is `unknown` when that claim could not be read. | As (1). |
| `INSTALL_E118` (3) | Another goodvibes update or install (process `<pid>`) claimed `<claim>` while this run was releasing a claim left by a process that is gone, and a third claim took the path before its claim could be put back; nothing was changed. Its claim is at `<taken claim>`: once no goodvibes install or update is running, remove it and re-run the installer. | Three runs raced for the same claim. The second run's claim was moved into this run's private claim directory and could not be put back. | Wait until no GoodVibes install or update runs (no installer or uninstaller runs in another terminal, no `/update apply` or `/update rollback` is in progress, and `goodvibes-daemon update` shows no `pending:` line), then `rm -f -- '<taken claim>'` with the path from the message, and run the install command again. |
| `INSTALL_E119` | An installation interrupted earlier (process `<pid>`, no longer running) could not be undone automatically; nothing else was changed. | Recovery of a killed install failed. | Read its journal (`R<file>` lines: put `<file>.goodvibes-previous` back; `N<file>` lines: delete `<file>`), then run the printed `rm -rf -- ...` command and retry. |
| `INSTALL_E120` | An update or install that is no longer running (process `<pid>`) left `<claim>` with partial files beside the program; nothing was changed. | A killed automatic update. | If `<program>` is missing, put its `.update-previous` copy back with `mv -f`; then delete the listed partial files and the claim, retry. |
| `INSTALL_E121` | Could not create the swap journal in `<dir>`; nothing was replaced. | Disk full or no permission. | Free space, fix permissions, retry. |
| `INSTALL_E122` | The installed uninstaller of `<prefix>` is missing and no Bun was found to run this checkout's copy; nothing was removed. | As `INSTALL_E113`, with a checkout but no Bun. | Install Bun, then run the printed `bun <checkout>/scripts/uninstall.ts --prefix <prefix>`. |
| `INSTALL_E123` | the latest release of mgd34msu/goodvibes is `<tag>`, which is not a suite release; set GOODVIBES_VERSION=vX.Y.Z | The newest release on GitHub is not a suite release. | Set `GOODVIBES_VERSION` to the newest `vX.Y.Z` tag. |
| `INSTALL_E124` | Every program was replaced, but the swap journal in `<dir>` could not be marked finished, so the previous programs are being put back. | Disk full or no permission at the last step. | Free space, retry. |
| `INSTALL_E131` | a download was redirected to `<url>`, which is not https; nothing more was downloaded | With only `wget` installed, a download redirected to a plain-http address (or more than 10 times). | Install `curl`, or copy the release files over https into a directory and run the installer with `--from-dir`. |

Messages without an id:

| Message | Meaning | Fix |
| --- | --- | --- |
| `install.sh: this run's installation claims in <dir> changed while it ran, so they were left in place. ...` | The install finished or stopped, but its claims could not be released safely. | Retry once nothing else runs; claims of finished processes are released automatically. |
| `install.sh: original uninstall claims changed; inspect retained transaction files in <dir> before retrying.` | The same, for an uninstall. | Look at the `*.update-transaction` files, then retry. |
| `PROBLEM: ...` and `Install FAILED to become reachable: ...` | See [When another copy of a command is found on PATH](#when-another-copy-of-a-command-is-found-on-path). Exit `3`. | As described there. |
| `NOTE: the installed ... failed`, `NOTE: restart failed; restart it yourself with: ...` and other `NOTE:` lines | A late step did not finish. The install succeeded. | Run the command the note prints. |
| `curl: (22) The requested URL returned error: 404` (or another `curl:`/`wget:` error) with no id | A download failed: most often the tag in `GOODVIBES_VERSION` does not exist, or the network dropped. Nothing installed was changed. | Check the tag on `https://github.com/mgd34msu/goodvibes/releases` and the network, then retry. |
| `mkdir: cannot create directory ...` or `mktemp: ...` with no id | The install directory or `$TMPDIR` is not writable. | Choose a writable `GOODVIBES_INSTALL_DIR` or `TMPDIR`. |

## Checking an installation with doctor and status

### `goodvibes doctor`

`goodvibes doctor` prints the terminal app's view of the whole installation, then a list of findings. It changes nothing, and it never updates the program.

```sh
goodvibes doctor            # report; exit 1 only when a risk finding exists
goodvibes doctor --json     # the same as JSON
goodvibes doctor --strict   # exit 1 when any finding exists, warnings included (for CI)
```

Every finding has a severity. `warning` is advisory: the installation works, and the finding is a note. `risk` is must-fix: the product's help and messages call such a finding a "must-fix finding". The exit status is `0` when no `risk` finding exists, `1` when one does, and with `--strict` `1` when any finding exists.

Sections, in order:

| Section | What it shows |
| --- | --- |
| header | `workingDir` and `homeDir`. |
| `Provider:` | The provider, the model (`provider:model`), the reasoning effort and what this model supports, the sign-in in use (for example `API key (OPENROUTER_API_KEY)`), and where the model list comes from. |
| `Decision model:` | The "If Jev can't answer" choice (`judgment.policy`) and whether a decision model is in use. |
| `Auth:` | The permission mode with its meaning, `behavior.autoApprove`, the secret storage policy, and whether the local user store, the bootstrap credential and the operator token file exist (with their paths). |
| `Service:` | `service.enabled`, `service.autostart`, `service.restartOnFailure`, the platform, whether the service is installed and running, its pid, the definition path and the log path. |
| `Surfaces:` | Whether the control plane, the HTTP listener and the web surface are on, with their addresses (defaults `127.0.0.1:3421`, `127.0.0.1:3422`, `127.0.0.1:3423`), and whether other machines are served (`controlPlane.enabled`). The web UI itself is served on the control plane's address. |
| `Onboarding:` | Whether the first-run marker exists, its scope and time. |
| `Crashes:` | Recorded crashes, from `~/.goodvibes/tui/crashes.jsonl`. |
| `Workspace:` | Trust level (`trusted`, `restricted` or `undecided`), whether the workspace is registered for checkpoints, and its root. |
| `Exec sandbox:` | Whether the command sandbox is active and available (bubblewrap on Linux) and whether network isolation is confirmed. |
| `Relay:` | Relay settings. |
| `Exposure (report only: no changes made):` | For each surface: on or off, local or network, address, how it authenticates, and its browser origin policy. |
| `Warnings:` | One block per finding: `[<severity>:<area>:<id>] <summary>`, then `cause:`, `impact:` and `action:` lines. A service or endpoint finding is one record with one remedy: `goodvibes service status` and `service check` print the same summary with that remedy under it as `Fix: <action>`, and `goodvibes-agent doctor` prints the same record for an endpoint or log finding. |

All service findings use the terminal app's own `service.*` values, from `~/.goodvibes/tui/settings.json` (see [Service settings](#service-settings)). A command that writes the daemon's file (`goodvibes-daemon config set service.<key> ...`) changes what the daemon does, not what `goodvibes doctor` reports. The auth findings use the terminal app's files `~/.goodvibes/tui/auth-users.json` and `~/.goodvibes/tui/auth-bootstrap.txt`. `<endpoint>` is one of `controlPlane`, `httpListener` and `web`. The `<area>` in each `[<severity>:<area>:<id>]` line is `service` (the `service-*`, `endpoint-*` and `unrecognized-host-mode-*` findings), `onboarding`, `auth` (the two `network-surface-*` findings), `security` (`auto-approve-enabled`, `allow-all-permissions`), `secrets`, `network` (`network-http-listener-enabled`, `control-plane-cors-wildcard-origin`), `install` and `sandbox`. The table lists every finding `goodvibes doctor` can show; the Provider, Decision model, Crashes, Workspace and Relay sections only report and add no findings. The control plane is "on" whenever the daemon is enabled (`daemon.enabled`, default `true`); it "serves other machines" when `controlPlane.enabled` is also `true`. A surface is network-reachable when it is on and its host mode is not `local` and its host is not a loopback address.

| Finding id | Severity | Reported exactly when | What clears it |
| --- | --- | --- | --- |
| `onboarding-incomplete` | warning | The first-run marker `~/.goodvibes/tui/onboarding-checked.json` does not exist. | Start `goodvibes` and finish first run, or open System, Setup in the menu and choose `Run first-run again`. |
| `service-not-installed` | warning | `service.enabled` is `true`, the daemon (or a server-backed endpoint) is on, and the service manager reports no daemon service installed. | `goodvibes-daemon install-service`. For a machine that runs without a service: `goodvibes-daemon config set service.enabled false` (the release installer's `--no-service` does this). |
| `service-not-running` | warning | A daemon service is installed and the service manager reports it stopped. | `goodvibes-daemon start-service` (read `goodvibes-daemon service-status` and `journalctl --user -u goodvibes.service` if it stops again). |
| `service-manager-error` | warning | `service.enabled` is `true` and systemd or launchd could not be asked; the summary carries the reason. The other service findings wait for an answer. | Run doctor from a logged-in session with a user service manager (see [Service problems and fixes](#service-problems-and-fixes)), or record a machine without a service: `goodvibes-daemon config set service.enabled false`. |
| `service-autostart-disabled` | warning | A daemon service is installed and the service manager reports it not enabled to start at login (systemd's unit file state). A fresh release install, whose `install-service` enables the unit, does not show it. | `goodvibes-daemon install-service` (it enables the unit again). |
| `service-restart-disabled` | warning | A daemon service is installed and `service.restartOnFailure` is `false`. | `goodvibes-daemon config set service.restartOnFailure true`, then `goodvibes-daemon refresh-service`. |
| `service-log-unreadable` | warning | The reported service log file exists but cannot be read. | Fix its permissions. |
| `endpoint-unreachable-<endpoint>` | warning | Only in `goodvibes service check` and after `goodvibes service start` or `restart`, never in `goodvibes doctor`: an enabled endpoint did not accept a TCP connection. | `goodvibes-daemon start-service`; its log says why a bind failed (`goodvibes-daemon service-status`). |
| `endpoint-conflict-<a>-<b>` | warning | Two enabled endpoints have the same port and either the same host or one of them bound to `0.0.0.0` or `::`. | `goodvibes-daemon config set <b>.port <port>` (give one of them another port). |
| `unrecognized-host-mode-<endpoint>` | warning | `<endpoint>.hostMode` is not `local`, `network` or `custom` (checked whether or not the endpoint is on). The daemon cannot start that endpoint. | Set it to one of the three. |
| `install-missing-vendor-binaries` | warning | Only for a terminal app installed as a `bun`/`npm` package: its `vendor/` directory lacks the app or daemon program. | Run the command the finding names. |
| `install-broken-daemon-path` | warning | Not for a run from source. The terminal app found no daemon program: none at `GOODVIBES_DAEMON_COMMAND`, none in its own package directories, none beside its own executable (`goodvibes-daemon` or `goodvibes-daemon-<platform>`), and none on `PATH`; or `GOODVIBES_DAEMON_COMMAND` names an absolute path that does not exist. | Run the install command again. The finding prints `curl -fsSL https://goodvibes.sh/install.sh \| sh`, which installs into `~/.local/bin`; for another directory add `GOODVIBES_INSTALL_DIR=<dir>`. Or unset a wrong `GOODVIBES_DAEMON_COMMAND`. |
| `exec-sandbox-unavailable` | warning | `sandbox.enabled` is `true`, the `exec-sandbox` feature is on, and no sandbox is available on this host. | Install bubblewrap (`bwrap`) on Linux, or set `sandbox.enabled` to `false`. |
| `network-http-listener-enabled` | warning | `danger.httpListener` is `true` and the listener is network-reachable. | Keep secrets or signature checks on every webhook surface, or bind it to loopback. |
| `network-surface-without-local-users` | risk | At least one surface is network-reachable (the control plane counts only when it serves other machines) and `~/.goodvibes/tui/auth-users.json` does not exist. | Create a local admin user (Devices and network, Addresses and ports, `a`), or make the control plane and web surface local again with `goodvibes-daemon webui enable --loopback` (the HTTP listener has its own `httpListener.hostMode`). |
| `network-surface-with-bootstrap-credential` | risk | At least one surface is network-reachable and `~/.goodvibes/tui/auth-bootstrap.txt` exists. | Replace the bootstrap credential with a named admin user (Devices and network, Addresses and ports, `a`, which then removes the file). |
| `auto-approve-enabled` | risk | `behavior.autoApprove` is `true`. | `/settings set behavior.autoApprove false` inside `goodvibes`. |
| `allow-all-permissions` | risk | `permissions.mode` is `yolo` (or the older name `allow-all`). | Choose `ask-me`, `jev-decides` or `just-vibes` in `/settings`, unless `yolo` is intended. |
| `plaintext-secrets-allowed` | risk | `storage.secretPolicy` is `plaintext_allowed`. | `/settings set storage.secretPolicy preferred_secure` (or `require_secure`). |
| `control-plane-cors-wildcard-origin` | risk | The control plane serves other machines and is network-reachable, `controlPlane.cors.enabled` is `true`, and `controlPlane.cors.allowedOrigins` contains `*`. | List the exact trusted origins instead of `*`. |

`goodvibes doctor` reads what the service manager reports, not the service settings, so it is clean both on a fresh release install with its service running and on an installation made without a service on purpose (`--no-service`, which records `service.enabled` `false`): with `service.enabled` `false` doctor reports no service finding at all.

`goodvibes doctor explain <tool|command>`, `goodvibes doctor routing` and `goodvibes doctor hooks` are covered in the terminal app part of this file.

### `goodvibes-agent doctor`

`goodvibes-agent doctor` prints the Agent's view: provider, decision model, auth, the connected daemon ("connected host": its address, whether it answers, whether it is compatible, whether the Agent has an access token), the host's relay settings, the Agent's role, onboarding, crashes (`~/.goodvibes/agent/crashes.jsonl`), checkpoints and readiness checks, then warnings. It takes `--json` and `--strict`. It never updates the program.

The daemon address the Agent uses, here and everywhere else, is the origin in `daemon.connectedHost.url` when it is set, scheme included; otherwise the daemon on this machine, at the address derived from `controlPlane.hostMode`, `controlPlane.host`, `controlPlane.port` and `controlPlane.tls.mode` (a host of `0.0.0.0` or `::` is dialled as loopback, and TLS on means `https`). The `controlPlane.*` settings are daemon-owned, read from the daemon's own file `~/.goodvibes/daemon/settings.json`, so the Agent follows a port changed with `goodvibes-daemon config set controlPlane.port <n>`. With nothing set, the address is `http://127.0.0.1:3421`. A `controlPlane.host` that is another machine is not dialled without a stated origin: the Agent names the `daemon.connectedHost.url` value to set. The global option `--runtime-url <url>` (or the environment variable `GOODVIBES_AGENT_RUNTIME_URL`, older name `GOODVIBES_AGENT_BASE_URL`) sets that origin for one run.

Severity `note` describes the arrangement and never fails. `risk` is must-fix. The areas are `runtime` (the `external-runtime-*`, `agent-knowledge-*`, `runtime-*` findings), `auth` (`external-runtime-token-missing`), `onboarding`, `security` and `secrets`. The exit status is `1` when a `risk` finding exists, and with `--strict` when any `warning` or `risk` exists; otherwise `0`.

| Finding id | Severity | Reported exactly when | What clears it |
| --- | --- | --- | --- |
| `external-runtime-unreachable` | warning | The daemon does not answer at the address. | Start the daemon (`goodvibes-daemon start-service`, or by hand), then `goodvibes-agent status`. |
| `external-runtime-incompatible` | warning | The daemon answers, but its Agent routes are unavailable or incompatible, or they could not be checked because the Agent has no operator token or the daemon refused its status request. A reachable daemon with no token therefore shows this together with `external-runtime-token-missing`. | Pair first (next row); if it remains, update the daemon to the same release. |
| `external-runtime-token-missing` | warning | None of the four credential sources gave a token (see [Pairing the Agent with the daemon](#pairing-the-agent-with-the-daemon) for the order): no token variable, no pairing record for the address, and no `operator-tokens.json` in the daemon home. Reported whether or not the daemon answers. | Pair: `goodvibes-agent setup pair --apply` (see [Pairing the Agent with the daemon](#pairing-the-agent-with-the-daemon)). |
| `agent-knowledge-route-not-ready` | warning | The daemon answers, the Agent has a token, the routes were checked, and the Agent Knowledge route is not ready. | Update the daemon; check `goodvibes-agent compat`. |
| `runtime-connection-<slug>` | warning | An issue the Agent's service check reported (the slug is made from its text). | Follow its action line. |
| `runtime-posture-<slug>` | note | An advisory about the arrangement. | None, unless it is not what was intended. |
| `onboarding-incomplete` | warning | The Agent's setup completion marker does not exist (`Agent setup has not been applied for this user.`). It is written by **Apply & close** in the setup workspace. | Open `goodvibes-agent`, finish setup and choose **Apply & close**. |
| `auto-approve-enabled` | risk | The Agent's `behavior.autoApprove` is `true`. | `/settings set behavior.autoApprove false` inside `goodvibes-agent`. |
| `allow-all-permissions` | risk | The Agent's permission mode is `yolo`. | Choose another mode in the Agent's settings. |
| `plaintext-secrets-allowed` | risk | The Agent's `storage.secretPolicy` is `plaintext_allowed`. | `/settings set storage.secretPolicy preferred_secure`. |

### Status commands

| Command | Prints |
| --- | --- |
| `goodvibes status` (`--json`) | The terminal app's configuration, provider, auth, service, surfaces and onboarding state, without the findings. Exit `0`. |
| `goodvibes setup status` | `checked: yes|no`, `scope`, `source`, `mode`, `updatedAt` and `workingDir` of the first-run marker. |
| `goodvibes-agent status` (`--json`) | The Agent's configuration, provider, auth, connected daemon and setup state. Exit `0`. |
| `goodvibes-agent setup status` | The selected daemon address, whether the Agent holds an accepted credential for it, and the setup marker (`checked`, `scope`, `origin`, `mode`, `updated`). |
| `goodvibes-daemon status` | What a running daemon is doing (described in the daemon part of this file). |
| `goodvibes-daemon service-status` | The service state (see [The daemon's service commands](#the-daemons-service-commands)). |

## First run and onboarding

### Before the first start

A release install leaves the daemon running as a service, the web UI served at `http://127.0.0.1:3421`, and no model provider configured. The default model is `openrouter:openrouter/free`, which needs an OpenRouter API key in `OPENROUTER_API_KEY`. Any other provider works too; providers and sign-ins are described in the terminal app part of this file.

The quickest path to a working first session, when the owner has an OpenRouter key:

```sh
export OPENROUTER_API_KEY='<your-openrouter-api-key>'
cd ~/code/my-project
goodvibes
```

With a key for a provider present, the first start asks nothing about the model: the conversation opens with one line saying which provider and model it uses and where the key came from (below), and the first-run marker is written.

### First run: three steps, the same in the terminal app and the Agent

`goodvibes` and `goodvibes-agent` run the same first run. It opens exactly when the model the session will use is not ready (its provider has no key or sign-in and is not keyless); a ready model opens the conversation directly and writes the first-run marker (`~/.goodvibes/tui/onboarding-checked.json`, the Agent's under `~/.goodvibes/agent/`). Leaving at any step and starting again picks up from the facts: a provider chosen in settings but not signed in opens step 2 for it; otherwise step 1.

**A provider key already there is used; nothing is asked about the model.** When a provider is usable through a key in the environment (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …), a key in the secret store or a sign-in, first run asks no "which model" question: it uses that provider with its own default model and goes straight to the conversation. This holds on a first launch whose model is ready only as the product's default (`provider.model` not set by you) too. With more than one usable, it takes the first in the order step 1 lists them (ChatGPT subscription, Anthropic, OpenRouter, then the others by name); a provider that needs no key and a model server on this computer are not taken this way. The choice is said in one line under the splash, never asked: `Using Anthropic (claude-sonnet-4-5) from ANTHROPIC_API_KEY; change it with the model control.` (`from your stored key`, `from your sign-in`). The steps below show only when nothing usable is found.

**Step 1, `Welcome to GoodVibes` (`1 of 3`, `1 of 4` when "Who decides" follows): `Which model should answer you?`** One row per offer, then `Another provider…` with the count of the other providers the full provider picker lists (the providers that have a model, the internal decision router left out; the picker shows the same list):

| Row | How | Shown with |
| --- | --- | --- |
| `ChatGPT subscription` | `sign in with your browser` | OpenAI's subscription sign-in. |
| `Anthropic` | `paste an API key` | |
| `OpenRouter` | `paste an API key` | `has a free model` when its model list has a free model. |
| `A model on this computer` | | `found <server> with <n> models` (green) once the scan of this computer found a model server (Ollama, LM Studio, llama.cpp and the like); `looking for models on this computer…` while it runs; `none found` after it found none. |

The terminal app starts that scan of this computer (never the network) when first run opens; the Agent's start-up already scans this computer. Keys: Up and Down move, Enter chooses, Esc is "set up later". Choosing `Another provider…` opens the full provider picker; choosing a ready model there finishes first run.

**Step 2 (`2 of 3`)** depends on the row:

- A key: `Sign in to <name>`, `Paste your <name> API key.`, a masked field (no character of the key is shown) and `It is stored in secure storage, never shown again.` (`the settings file` when `storage.secretPolicy` is `plaintext_allowed`). Enter stores the key for this user (as `goodvibes secrets set <VARIABLE> --user` does) and checks it with one model-list request to the provider. A refused key is removed again and the step says `That key was refused by <name> (401). Check it and paste it again.`; an unreachable provider `GoodVibes couldn't reach <name>. Check your connection and try again.` Esc or Shift+Tab goes back to step 1, as the key row says (`esc / shift+tab back`).
- The browser: `GoodVibes opened your browser to sign in.`, then `If it didn't open, go to:` and the whole sign-in address, and `Waiting for you to finish in the browser…` while the sign-in page's answer is awaited. When the browser could not be opened, or the provider's sign-in ends on a code, `Paste the code the page shows:` takes the code (or the address the browser ended on). `c` copies the address, Enter continues, Esc or Shift+Tab goes back. A sign-in the provider refused says `<provider> refused the sign-in: <its error>. Press ⏎ to start again.`; one that came back but could not be finished (the code exchange or storing the sign-in failed) says `The sign-in came back but <provider> did not complete it: <reason>. Press ⏎ to start again.`; when the wait for the browser ended (for example it timed out) the line is `The sign-in could not wait for the browser: <reason>. Press ⏎ to start again.` After any of them the code the page shows can still be pasted, or Enter starts again.
- A model on this computer: `Which model on this computer?` and the models found, each with its server, its size where the server reports one in the model list it already gives (Ollama's parameter size, LM Studio's `params_string`) and its context window; Enter chooses one. With none found, it says so and Enter looks again.

**Who decides is never asked by first run.** A fresh home starts usable at once, nothing opened over the composer, and a first message typed straight away goes to the conversation. The mode in force is the one GoodVibes can support: `Jev decides` (the default) while a decision model answers (first run takes one from a provider key in the environment), otherwise GoodVibes asks you, which is Ask me in force. One line under the splash says which, as the status line does, and where to change it: `Ask me is in force for now, so GoodVibes asks you before anything risky (Jev decides: no decision model set). To choose who decides: System, Setup, Who decides.` (or `Jev decides is in force: the decision model decides; you are asked only about destroying data and weakening safety. ...` once a decision model answers). Where the splash leaves no row for it (the terminal app at 80x24), the status line says it for a few seconds instead (`Ask me is in force for now · who decides: System, Setup`). On the Setup list in the System place, "Who decides" is `not chosen yet: <the mode in force>` until you choose there (or set the mode yourself in Settings); then it is done. Enter on that row opens the step below, alone, whatever is in force; `Jev decides` there with a decision model that already answers is chosen at once, with no key asked.

**Who decides (`3 of 4`), in a first run you asked for, when the model is chosen and no decision model can be asked, and from the Setup list.** With the permission mode `jev-decides` or `just-vibes` (the default is `jev-decides`) and no usable decision model key (none in the environment, the secret store or a fallback target, and "No Decision Model" not chosen), System, Setup's `Run first-run again` follows the model with one more step: `Who decides when GoodVibes would otherwise stop and ask you?` with `Jev decides` (`TypeSafe's decision model, with your key`), `Ask me` (`GoodVibes stops and asks you`) and `Another decision model…` (`Cloudflare and others, in Settings`), and `Change it any time here: System, Setup, Who decides.` `Jev decides` (with no decision model that answers yet) opens `Paste your TypeSafe key.` with a masked field and `A key comes from your TypeSafe account at console.typesafe.ai. It is kept in the secret store and checked with one request.`; Enter stores it as `TYPESAFE_API_KEY` in the secret store (`judgment.keySource` `secret`) and sends the one request; a refusal shows the decision model's own sentence (for example `jev-latest: its endpoint could not be reached. ...`) and the key can be pasted again. `Ask me` sets `permissions.mode` to `ask-me`. `Another decision model…` opens Settings on the decision model (Cloudflare Workers AI, Laya and the other backends decisions can use, with their endpoint and credential); once one set there is usable, first run goes on by itself. A decision model picked here (the TypeSafe key accepted, or one set through `Another decision model…`) records `jev-decides` as your own choice in `permissions.mode`, so it is in force at once with that model, measured or not, and the status bar reads `Permissions: Jev decides`. Either way the status bar then reads the mode alone (`Permissions: Jev decides`, `Permissions: Ask me`). Esc puts it off: that is recorded in the daemon's one setup record and the Setup list says `put off at first run`. The status bar keeps saying what is in force and why (`Permissions: asking you, for now · Jev decides: no decision model set`), and a click on that segment opens the same step, alone; when a decision model can be asked, the segment opens `/permissions` as before. When a usable key is already present, nothing is asked and first run has three steps.

**Step 3 is the conversation (`4 of 4` after "Who decides").** The splash (the logo, its lines, the hint and the version) is drawn exactly as on every start, at the same place; under it, on the first run only and only in the rows left free above the composer, GoodVibes adds:

1. `You're set.  Answering with <model> · signed in` (`no sign-in needed` for a model on this computer) and `3 of 3` (`4 of 4`).
2. The mode in force and where to choose who decides (above).
3. What GoodVibes asks before, for the permission mode in force (for example `GoodVibes asks before it runs commands or changes things outside this folder.`), that Shift+Tab changes when GoodVibes asks, and the command that opens the remaining setup, wrapped to the screen's width so it takes as few rows as its words need.

The two parts follow each other with no blank row between them; rows left over become blank rows (first one under the splash, then one above the composer). At 120x36 both show in both programs. When the free rows are too few for both, the sentence is left out first, whole (the logo always keeps its place); on an 80x24 terminal the terminal app has no free rows under its splash, so nothing is added there. Notices are never drawn over these screens: they are counted on the status bar (`ctrl+n` opens them). Nothing of first run is written into the conversation.

Esc on step 1 ("set up later") marks nothing and writes nothing; the conversation then says `Not set up yet.  Choose a model with /model, or set up the rest in menu › System › Setup.` The next start opens first run again.

The Setup tab of the System place (the menu: `Ctrl+G` then `m`, then System) lists the setup topics at any time in both programs (below), and `goodvibes setup` (`goodvibes-agent setup` in the Agent) starts the program on that tab. Its row `Run first-run again` opens the three steps again. No command is typed for any of it: there is no `/setup`.

The first time GoodVibes wants to write or run something in a folder, it asks whether to trust that folder. Trust levels are covered in the permissions part of this file.

### System, Setup: one form per topic

The Setup tab of the System place lists the setup topics: first the checklist ("Who decides", then the model, when it asks, safety and saved chats, each done, not done or skipped for now; `s` skips one for now or brings it back), then every other topic. Enter on a row opens that topic's form (each topic is also the capability `setup.<topic>`, which find and run reach); in the terminal app the form fills the screen, titled `Setup` and the topic, with the topic's sentence, its rows and **Save** as the last row. There is no list of other screens and no step count: another topic is another row of the tab. A topic of another group is also a key in that group's place (chat apps `s` on the Channels tab of Mail, calendar and channels; memory settings `g` in Memory and knowledge; automation settings `o` in Automation). Each form holds the rows of the former wizard screens listed below for its topic.

| Key | Action |
| --- | --- |
| Up, Down | Move between rows. |
| Page Up, Page Down, Home, End | Move by a page, or to the first or last row. |
| Enter or Space | Change the selected row: tick a checkbox, pick the next option of a choice, open the model picker, run an action, or start editing a text field. |
| Typing a character on a text field | Starts editing it with that character. |
| Enter (while editing) | Saves the text. |
| Esc (while editing) | Cancels the edit. |
| Backspace / Delete or Ctrl+U | Deletes one character / clears the field. |
| Esc | Close the form without saving. |

Nothing is saved until **Save**; a form closed with Esc keeps nothing of what was chosen in it. While the form loads current settings it shows **Loading current settings**, with every row locked. If loading fails it shows **Current settings unavailable** with the reason; press Enter to try again or Esc to close.

Which topic holds which former screen: `Only this computer`, `Use it in a browser`, `Other devices`, `Receive webhooks` and `Who can sign in here` have no form: each opens Addresses and ports of Devices and network, the one control for those settings in the terminal app and the Agent (each listener on or off, its address, port and encryption, Enter on a row to change it; `a` makes the account that signs in from a browser or another device, an administrator, or gives an administrator of that name a new password, and then retires the first-run sign-in: the first-run user, when it has another name, and the first-run sign-in file); `Chat apps and services` holds its capability row, Choose external surfaces, one block per chosen surface and, when it opens the computer to the network, "The account that signs in", whose Enter opens that same Addresses and ports; `Use Cloudflare` holds its capability row and Cloudflare batch setup; `Provider sign-in` holds AI provider access without the keys, and the subscription acknowledgement; `Store a password or key` holds the provider keys and the secret storage policy; `Choose a model` holds Default model; `When it asks` holds Shell experience; and the seven feature topics hold Safety, Context, Telemetry, Automation, Devices, Runtime and Advanced.

### Setup form rows: Choose GoodVibes capabilities

The `Chat apps and services` and `Use Cloudflare` forms start with their own capability row:

| Checkbox | Default | What choosing it means |
| --- | --- | --- |
| Connect GoodVibes to external apps and services | | Adds the Services screen, where chat apps and other surfaces are chosen. |
| Use Cloudflare for batch or remote daemon work | | Adds the Cloudflare screen. |

Ticking one saves `service.enabled`, `service.autostart`, `service.restartOnFailure` and `controlPlane.enabled` as `true`. The form itself does not install anything; the running daemon applies `service.autostart` (installing and enabling the service when it is not), and with no daemon running, the next daemon start applies it to an installed service, or run `goodvibes-daemon install-service`.

### Setup form rows: A daemon elsewhere

| Field | Options and default | Effect |
| --- | --- | --- |
| GoodVibes daemon source | **Start a new daemon** (default) or **Connect to an existing running daemon** | Which daemon this terminal app talks to. Connecting saves `daemon.connectedHost.url`; starting clears it. |
| Existing daemon host, port, token (connect only) | `127.0.0.1`, `3421`, empty | The address and bearer token of the existing daemon. The token is saved in `~/.goodvibes/tui/connected-daemons.json` (under `GOODVIBES_HOME` when that is set), keyed by the daemon's address; this machine's own daemon's `operator-tokens.json` is never written, so the local daemon and its other clients keep their token. The address is saved as `daemon.connectedHost.url`. |
| Connect to this daemon now (connect only) | action | Applies the host, port and token at once and checks the connection; the result prints below. |

Where each listener listens (its host mode, address, port and encryption) and whether it is on are rows of Addresses and ports in Devices and network, changed through the daemon (`settings.set`; a change that loosens a protection asks first). When a listener reachable from the network has encryption off, the terminal app's Security notice at start names "Daemon encryption" or "Webhooks encryption" there.

### Setup form rows: the account that signs in (`Chat apps and services` when it opens the computer to the network)

| Field | Effect |
| --- | --- |
| The account that signs in | Enter opens Devices and network, Addresses and ports, over the form: `a` there makes the account that signs in from a browser or another device (or gives an administrator of that name a new password) and retires the first-run sign-in. No setup form makes the account itself. Esc comes back to the form. |
| Confirm stored subscription state (`Provider sign-in`) | Acknowledgement, required when the form opens over stored sign-ins that need review. |

### Setup form rows: Choose external surfaces (only with "Connect GoodVibes to external apps and services")

One checkbox per surface: Slack, Discord, Telegram, ntfy, Outbound webhook, Home Assistant, Google Chat, Signal, WhatsApp, iMessage, Microsoft Teams, BlueBubbles, Mattermost, Telephony, Matrix. Each ticked surface adds its own setup screen. **Select all external surfaces** and **Clear all external surfaces** are actions.

**Secret storage policy** sets `storage.secretPolicy`:

| Option | Value |
| --- | --- |
| Use secure storage when available (default) | `preferred_secure` |
| Require secure storage | `require_secure` |
| Allow plaintext storage | `plaintext_allowed` (reported as a risk by `goodvibes doctor`) |

### Setup form rows: one setup screen per chosen surface

Each starts with **Auto-start this surface**: **Yes** saves `surfaces.<surface>.enabled` as `true`, so it starts with the daemon; **No** saves the values but leaves it off until Settings > Surfaces turns it on. The fields below it are that surface's settings (`surfaces.<surface>.<key>`). Fields marked recommended never block saving. Secret fields (tokens, passwords, signing secrets) are stored in the secret store and the setting keeps a `goodvibes://` reference. What each field means, and the full setup of each surface from start to first message, is in the automation and services part of this file.

| Surface | Fields |
| --- | --- |
| Slack | bot token, app token (Socket Mode), signing secret, workspace ID, default channel |
| Discord | bot token, public key, application ID, guild ID, default channel ID |
| Telegram | bot token, webhook secret, default chat ID, bot username, delivery mode (Webhook or Polling) |
| ntfy | base URL, chat topic, agent topic, daemon-only remote topic, default delivery topic, token, default priority (1 to 5) |
| Outbound webhook | default target, signing secret, timeout in ms (1000 to 60000) |
| Home Assistant | URL, access token, webhook secret, default conversation ID, remote session idle TTL in ms, device ID, device name, event type |
| Google Chat | webhook URL, verification token, app ID, space ID |
| Signal | bridge URL, account, bridge token, default recipient |
| WhatsApp | provider (Meta Cloud or Bridge), access token, verify token, signing secret, phone number ID, business account ID, default recipient |
| iMessage | bridge URL, account, bridge token, default chat ID |
| Microsoft Teams | app ID, app password, tenant ID, service URL, bot ID, default conversation ID, default channel ID |
| BlueBubbles | server URL, password, account, default chat GUID |
| Mattermost | base URL, bot token, team ID, default channel ID |
| Telephony | provider (`twilio` or `bridge`), mode (`sms`, `voice` or `bridge`), Twilio account SID, Twilio auth token, from number, default recipient, bridge URL, bridge token, webhook secret |
| Matrix | homeserver URL, access token, user ID, default room ID |

### Setup form rows: Cloudflare batch setup (with the Cloudflare capability, or when Cloudflare is already configured)

**Enable Cloudflare integration** turns on the Cloudflare settings. When on, the screen shows: **Batch mode** (`Off`, `Explicit batch only`, `Eligible requests by default`), **Free-tier guardrails** (Yes by default: queues carry only signals and job bodies go to R2), one checkbox per component (Workers and Queues ticked by default; Zero Trust Tunnel, Zero Trust Access, DNS hostname, KV, Durable Objects, Secrets Store, R2 artifacts marked advanced), **Cloudflare token setup path** (`Save settings only`, `Paste temporary bootstrap token`, `Read bootstrap token from environment` with default variable `GOODVIBES_CLOUDFLARE_BOOTSTRAP_TOKEN`, `Paste final operational token`, `Use final token from environment` with default variable `CLOUDFLARE_API_TOKEN`), the account, zone, worker, queue, tunnel, Access, KV, Durable Object, R2 and Secrets Store names and ids for the chosen components, worker cron, maximum queue operations per day, **Provision Cloudflare on final apply**, and the actions **Show token requirements**, **Create operational token from bootstrap token**, **Discover accounts, zones, and resources**, **Validate Cloudflare token**, **Provision and verify now**, **Verify Worker now** and **Disable Cloudflare integration**. A bootstrap token is used once and never saved. Cloudflare work is described in the daemon part of this file.

### Setup form rows: AI provider access

| Field | Effect |
| --- | --- |
| Subscription status rows | One per provider that supports subscription sign-in, saying whether a session is active or pending. |
| Provider API keys | How many of the providers that accept an API key (every registered provider that declares a key variable) already have one. |
| One masked key field per provider that accepts an API key | A key typed here is stored in the secret store (in the daemon's tier, so every program uses it) and the provider becomes usable at once. |
| Start OpenAI subscription sign-in (Restart when pending) | Opens the ChatGPT subscription sign-in in the browser and records a pending sign-in. Subscription sign-ins are kept in `~/.goodvibes/shared/subscriptions.json`, which the daemon, the terminal app and the Agent all read, so a sign-in made here also serves the Agent (on a checkout installation the Agent's tree differs, so it does not). |
| OpenAI authorization URL | Shown while pending, for when the browser did not open. |
| OpenAI callback code or URL | Paste the code or the redirected URL after signing in. Hidden. |
| Finish OpenAI subscription sign-in | Completes the sign-in with that code. |
| Confirm provider access review | Acknowledgement, required when reopening over existing state that needs review. |

### Setup form rows: Default model

| Field | Options and default | Setting |
| --- | --- | --- |
| Default provider + model | Enter opens the model picker. | `provider.model` |
| Reasoning effort | Instant, Low, Medium (default), High | `provider.reasoningEffort` |

### Setup form rows: Shell experience

| Field | Options and default | Setting |
| --- | --- | --- |
| Human-in-the-Loop (HITL) mode | Quiet (only important attention requests), Balanced (default), Operator (keep operational activity visible) | `behavior.hitlMode` |
| Guidance verbosity | Minimal (default), Guided, Off | `behavior.guidanceMode` |
| When GoodVibes asks | Ask me, Jev decides (default), Just vibes, YOLO | `permissions.mode` (`ask-me`, `jev-decides`, `just-vibes`, `yolo`) |

The permission modes are explained in the permissions part of this file. YOLO is reported as a risk by `goodvibes doctor`.

### Setup form rows: Safety, Context, Telemetry, Automation, Devices, Runtime, Advanced

Seven screens list optional features, each as a checkbox that starts at its current state (or its default), sometimes with sub-options. Leaving a screen untouched changes nothing. Every feature is also in `/settings`.

| Screen | Features (sub-options in parentheses) |
| --- | --- |
| Safety and sandboxing | Per-command exec sandbox (also sets `sandbox.enabled`); Sandbox model-judgment tier (`sandbox.judgment`: `off`, `annotate` default, `auto-approve`); Fetch response sanitization (`fetch.sanitizeMode`: `none`, `safe-text` default, `strict`); Token scope and rotation audit (`security.tokenAudit.managed`, default No); Permissions policy engine; Divergence dashboard and enforce gate; Policy-as-code (`policy.bundleSource`: `none` default, `file`); Shell AST command analysis (on by default) |
| Memory and context | Structured session compaction (`behavior.compactionStrategy`: `structured` default, `distiller`); Fresh-context distiller compaction; Agent context-window awareness (on by default); Passive knowledge injection (on by default); Passive code injection; Local provider context ingestion (on by default) |
| Telemetry and observability | OpenTelemetry foundation; OTLP remote export (turns the foundation on, sets `telemetry.decisionOtlpEnabled`, collector endpoint `telemetry.decisionOtlpEndpoint`); Output schema fingerprints; Tool result reconciliation (on by default) |
| Automation and initiative | Automation domain (sets `automation.enabled`); Watcher framework (sets `watchers.enabled`); Trigger family (sets `watchers.triggers.enabled`); Integration delivery SLO (on by default); Adaptive execution planner (changes nothing today); Daemon auto-update (on by default); Outbound zero-knowledge relay (sets `relay.enabled`, relay URL `relay.url`) |
| Paired devices and voice input | Paired phone capabilities (`device.capabilities.mode`: `off`, `ask-every-time`, `honor-grants` default); Wake-word detection (off by default; turning it on opens a microphone on this terminal) |
| Provider and runtime behavior | Provider optimizer (sub-option `provider.optimizerMode`: `manual`, `auto` or `pinned`, with `manual` preselected when the box is ticked; the setting's own default is `off`, the optimizer inactive); Runtime budget enforcement; Overflow spill backends (`tools.overflowSpillBackend`: `file`, `ledger` default, `diagnostics`); Adaptive notification suppression |
| Advanced runtime toggles | Unified RuntimeTask; Plugin lifecycle; MCP lifecycle; Permissions simulation mode; Policy bundle signing |

### Saving a form

**Save** applies only what changed on the form: a setting whose value equals what the form read is not written, an acknowledgement is recorded only by a form that shows it, and the sign-in account only by a form that shows its rows. While a row on the form is missing, refused (a confirmation that does not match, a bad port) or a required acknowledgement is unticked, **Save** shows `Blocked` instead of `Ready` and its detail lists what to finish. **Save** writes the changes, then reads each value back. A daemon-owned setting is sent to the running daemon; when no daemon is listening on its address, it is written to the daemon's settings file for the next daemon start. On success the form closes and prints a summary of the checks. When some checks fail it says `Setup saved your settings, but <n> check(s) of them failed; ...` and lists them. When the save itself fails, the form stays open with **Apply did not complete** and the reasons at its top; fix them and save again.

### The Agent's first run

The Agent's first start runs the same three-step first run as the terminal app (above), which marks setup done. `goodvibes-agent setup` (or `goodvibes-agent onboarding`) starts the Agent on the Setup tab of the System place, whose topics are listed in the Agent part; each topic opens what sets it up: a tab of a place (Addresses and ports of Devices and network for the four network topics, as in the terminal app; the Secrets tab of Permissions and safety; Models and providers), the model picker, or the settings screen at that topic's settings. Every setting the Agent has is a row of the settings screen (`/settings`, or `S` in System), and the controls (channels, notifications, memory, notes, personas, routines, knowledge) are keys in their places (the menu, `Ctrl+G` then `m`).

### Pairing the Agent with the daemon

The Agent needs its own credential for the daemon (`goodvibes-agent doctor` reports `external-runtime-token-missing` until it has one). Pair it on the machine where the daemon runs:

```sh
goodvibes-agent setup pair                 # preview: what would be paired, nothing changes
goodvibes-agent setup pair --apply         # asks you to type a confirmation word, then pairs
goodvibes-agent setup pair --name laptop --apply   # names the device (default "GoodVibes Agent")
goodvibes-agent setup unpair               # forgets the stored credential for the selected daemon
```

`--apply` needs an interactive terminal and a typed confirmation; it cannot be scripted (`--yes` is refused) and refuses `--json` output. Usage errors exit `2`. The daemon address is `daemon.connectedHost.url`, else this machine's daemon (default `http://127.0.0.1:3421`); `--runtime-url <url>` selects another for one run. Pairing other devices and remote daemons is covered in the daemon part of this file.

The Agent picks the credential it sends to the daemon in this order; the first step that applies decides:

1. The environment variable `GOODVIBES_CONNECTED_HOST_TOKEN`, when set and not empty.
2. The environment variable `GOODVIBES_DAEMON_TOKEN`, when set and not empty.
3. The Agent's stored pairing for that daemon address (written by `goodvibes-agent setup pair --apply`). When a pairing record exists but its token cannot be used, the search stops here with the reason: a lost pairing reply (`goodvibes-agent setup pair` repeats the request) or an unreadable pairing store.
4. The `token` field of `operator-tokens.json` in the daemon home (`~/.goodvibes/daemon/operator-tokens.json`, or the directory `GOODVIBES_DAEMON_HOME` names, or `<GOODVIBES_AGENT_HOME>/.goodvibes/daemon/`). This file exists on the machine where the daemon runs, and is used only when the daemon address is this machine (a loopback address or one of its own interface addresses); it is never sent to a daemon elsewhere.

`goodvibes-agent doctor` shows the source on its `access token:` line (`env:GOODVIBES_CONNECTED_HOST_TOKEN`, `env:GOODVIBES_DAEMON_TOKEN`, `Agent host-bound pairing store` or the file path). A token from step 1 or 2 hides a stored pairing; unset both variables to use the pairing.

### Settings, models and providers after setup

- A row of System, Setup opens one topic's form with the current settings loaded.
- `/model` changes the model; `/settings` opens every setting; `/settings set <key> <value>` sets one in the terminal app.
- `/settings set <key> <value>` sets one in the Agent.
- `goodvibes-daemon config set <key> <value>` sets one for the daemon.

These are described in full in the terminal app, Agent and daemon parts of this file.

## Troubleshooting index

| Symptom | Section |
| --- | --- |
| `install.sh: ... (INSTALL_E###)` | [Installer errors and their fixes](#installer-errors-and-their-fixes) |
| `goodvibes: command not found` after installing | [How the installer handles PATH](#how-the-installer-handles-path): open a new terminal or source the startup file. |
| `goodvibes --version` shows an old version after an install | [When another copy of a command is found on PATH](#when-another-copy-of-a-command-is-found-on-path) |
| Installer exit status `3` | [When another copy of a command is found on PATH](#when-another-copy-of-a-command-is-found-on-path) |
| No service was set up | [Service problems and fixes](#service-problems-and-fixes) |
| The daemon is not running | `goodvibes-daemon service-status`, then [Service problems and fixes](#service-problems-and-fixes) |
| The web UI does not open | `goodvibes-daemon webui status`; the daemon part of this file |
| The Agent cannot reach the daemon | [Pairing the Agent with the daemon](#pairing-the-agent-with-the-daemon) |
| An update did not happen | `goodvibes-daemon update`; [Updating](#updating) |
| A new release broke something | [Rolling back](#rolling-back) |
| Stop automatic updates | [Pinning a release](#pinning-a-release) |
| Remove GoodVibes | [Uninstalling](#uninstalling) |
| Windows | [Windows through WSL2](#windows-through-wsl2) |
