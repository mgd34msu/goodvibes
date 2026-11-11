#!/bin/sh
# GoodVibes release installer — https://goodvibes.sh/install.sh
# Installs prebuilt, checksum-verified release assets from one monorepo tag.
# No Git checkout, package-manager install, compiler, Bun or Node is required.
#
# curl -fsSL https://goodvibes.sh/install.sh | sh
# GOODVIBES_VERSION=v3.1.2 selects a release (default: latest).
# GOODVIBES_INSTALL_DIR changes ~/.local/bin. GOODVIBES_AGENT/WEBUI/
# WAKE_MODEL/DAEMON_SERVICE/RESTART_DAEMON=0 disable their respective steps.
# Native SQLite/vector companions are required on every supported platform;
# the former GOODVIBES_VECTOR opt-out no longer skips those runtime files.
# GOODVIBES_SHADOW_REMOVE=ask|0|1 controls existing command shadow removal.
# GOODVIBES_UNINSTALL=1 removes installed programs/services, preserving data.
# Upgrade, service ownership/migration, PATH and uninstall behavior is retained
# from goodvibes-tui/scripts/install.sh at e492721d58cf9986407fe63a07bd6da9bbf970ec.

set -eu

REPO="mgd34msu/goodvibes"
INSTALL_DIR="${GOODVIBES_INSTALL_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${GOODVIBES_VERSION:-latest}"
REQUESTED_DAEMON_VERSION="${GOODVIBES_DAEMON_VERSION:-$REQUESTED_VERSION}"
REQUESTED_AGENT_VERSION="${GOODVIBES_AGENT_VERSION:-$REQUESTED_VERSION}"
REQUESTED_WEBUI_VERSION="${GOODVIBES_WEBUI_VERSION:-$REQUESTED_VERSION}"
WITH_AGENT="${GOODVIBES_AGENT:-1}"
WITH_WEBUI="${GOODVIBES_WEBUI:-1}"
RESTART_DAEMON="${GOODVIBES_RESTART_DAEMON:-1}"
WITH_WAKE_MODEL="${GOODVIBES_WAKE_MODEL:-1}"
DAEMON_SERVICE="${GOODVIBES_DAEMON_SERVICE:-1}"
UNINSTALL="${GOODVIBES_UNINSTALL:-0}"

# Where the unpacked web UI bundles live: one versioned directory per installed
# version under the install tree, beside the binaries that serve them. Versioned
# because the daemon is configured to serve one directory by absolute path, and
# unpacking a new version over a running daemon's directory would swap files
# under it mid-request. A new version lands in its own directory, the daemon is
# pointed at it, and previous/custom bundles stay available to running readers
# and explicit rollback. Their directory names do not prove they can be deleted.
WEBUI_ROOT="$INSTALL_DIR/webui"

# Set by install_webui() once the daemon has actually been configured to serve
# the bundle, so the closing lines can name the web UI without claiming an
# install that did not finish. WEBUI_URL is lifted from the daemon's own
# receipt, never rebuilt here.
WEBUI_INSTALLED=0
WEBUI_URL=""

# The daemon native publisher checks the same executable transaction slots.
# Keep private hardlink references until the whole suite has landed;
# a failed partial replacement retains the claims for explicit recovery.
INSTALL_CLAIM_OWNER=""
INSTALL_CLAIM_DIR=""
INSTALL_CLAIM_COUNT=0
INSTALL_SWAP_BEGUN=0
INSTALL_SWAP_FINISHED=0
INSTALL_DAEMON_CLAIM_ID=""
INSTALL_TUI_CLAIM_ID=""
INSTALL_AGENT_CLAIM_ID=""

# The marker string written into every installer-created service unit/plist.
# The uninstall path keys on it to tell an installer-managed unit (safe to
# remove) apart from a hand-written one (never deleted, only reported). The
# systemd unit carries it as a `# managed by goodvibes install.sh` comment; the
# launchd plist carries it both as an XML comment and a GoodVibesManagedBy key —
# a plain substring grep for this string matches either form.
INSTALLER_MARKER="managed by goodvibes install.sh"

# Service unit / LaunchAgent identities. The systemd unit name is the SAME one
# the product's own service setup manages (src/daemon/service-commands.ts ->
# buildManagedDaemonServiceManager writes `goodvibes.service` with an
# args-driven ExecStart). Installer create/restart/uninstall all target this
# single canonical name so a curl install and the in-app `install-service`
# command never fight over two different units.
SYSTEMD_DAEMON_UNIT="goodvibes.service"
LAUNCHD_DAEMON_LABEL="sh.goodvibes.daemon"

# The prior generation of this installer created the daemon unit under the name
# `goodvibes-daemon.service` with a bare `ExecStart=<bin>` (no args). That unit
# name is retired: the upgrade path (migrate_legacy_installer_unit) disables and
# removes an installer-MARKER-managed one after the canonical unit is in place,
# and uninstall removes it too. A hand-written goodvibes-daemon.service (no
# marker) is always left alone and only reported.
LEGACY_SYSTEMD_DAEMON_UNIT="goodvibes-daemon.service"

# Managed services use the daemon's default home and configured endpoint.
# Explicit --daemon-home overrides mark a host as externally managed and disable
# native automatic updates, so the ordinary installed service omits that flag.

# Verify settle used by the supervised transfer: seconds between the two
# post-start probes (a Type=simple unit reports 'active' from fork onward, so a
# single instant is-active proves nothing). Overridable so tests run fast.
VERIFY_SETTLE_SECS="${GOODVIBES_INSTALL_VERIFY_SETTLE_SECS:-1}"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Release-platform selectors can be overridden by callers of this shell
# library. Descriptor observations must use the actual host's filesystem API.
_INSTALLER_NATIVE_FILE_HOST=''
installer_native_file_host() {
  if [ -z "${_INSTALLER_NATIVE_FILE_HOST:-}" ]; then
    _INSTALLER_NATIVE_FILE_HOST=$(command uname -s) || return 1
  fi
}

# Darwin's /dev/fd entries do not reliably stat as the object held by the
# descriptor. The system stat utility calls fstat(2) on stdin when given no
# pathname, so redirect the retained descriptor without resolving /dev/fd.
# Linux retains its existing -ef check. Follow the selected pathname just as
# -ef does: callers reject symlinks where required, while shadow cleanup may
# deliberately hold a package-manager symlink's target. Mode includes type.
installer_open_file_matches() {
  case "$1" in [0-9]) : ;; *) return 1 ;; esac
  installer_native_file_host || return 1
  case "$_INSTALLER_NATIVE_FILE_HOST" in
    Darwin)
      _installer_held_identity=$(/usr/bin/stat -f '%d:%i:%u:%g:%p' <&"$1") || return 1
      _installer_current_identity=$(/usr/bin/stat -L -f '%d:%i:%u:%g:%p' -- "$2") || return 1
      [ "$_installer_held_identity" = "$_installer_current_identity" ] ;;
    Linux) [ "$2" -ef "/dev/fd/$1" ] ;;
    *) return 1 ;;
  esac
}

# Paths depend on $HOME; recomputed via functions so an overridden HOME (tests)
# is always honored.
systemd_daemon_unit_path() { printf '%s' "$HOME/.config/systemd/user/$SYSTEMD_DAEMON_UNIT"; }
launchd_daemon_plist_path() { printf '%s' "$HOME/Library/LaunchAgents/$LAUNCHD_DAEMON_LABEL.plist"; }
# Generic form of the above for any systemd user unit name (daemon or agent) —
# used by the restart path to find and back up a broken unit file on disk.
systemd_unit_path() { printf '%s' "$HOME/.config/systemd/user/$1"; }

# First line of `systemctl --version` is "systemd NNN (...)"; prints NNN, or
# nothing when systemctl is absent or the output is unrecognized.
detect_systemd_major_version() {
  systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p'
}

# RestartSteps=/RestartMaxDelaySec= (escalating restart delays) landed in
# systemd 254. On older systemd — or when the version cannot be read — the
# unit degrades to the flat RestartSec retry, which StartLimitIntervalSec=0
# already keeps retrying forever instead of tombstoning.
systemd_supports_restart_steps() {
  _sysd_major="$1"
  [ -n "$_sysd_major" ] && [ "$_sysd_major" -ge 254 ] 2>/dev/null
}

# Whether lingering is enabled for the current user — the readback that makes
# "starts at boot" an observed fact rather than a hope. `loginctl enable-linger`
# can exit 0 without taking effect in some polkit setups, so the show-user
# property is the source of truth, checked before and after enabling.
linger_enabled() {
  loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q '^Linger=yes'
}

# A user unit with WantedBy=default.target only starts when its user logs in.
# Lingering starts the user's systemd instance at boot, so the daemon comes up
# on a machine nobody has logged into (the always-on-box case). Returns 0 only
# when lingering is VERIFIED on; on any failure it prints exactly one honest
# instruction naming the command to run once, and returns 1 so the caller's
# closing copy says "on login" instead of "at boot".
ensure_linger() {
  if ! command -v loginctl >/dev/null 2>&1; then
    say "  NOTE: loginctl not found; could not enable lingering, so the daemon starts"
    say "  at login rather than at boot. Enable it once yourself with:"
    say "    loginctl enable-linger $(id -un)"
    return 1
  fi
  if linger_enabled; then
    say "  lingering  already enabled for $(id -un)"
    return 0
  fi
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  if linger_enabled; then
    say "  lingering  enabled for $(id -un)"
    return 0
  fi
  say "  NOTE: could not enable lingering (polkit may require an interactive session),"
  say "  so the daemon starts at login rather than at boot. Enable it once yourself with:"
  say "    loginctl enable-linger $(id -un)"
  return 1
}

# --- PATH line (installer-managed, same marker discipline as service units) ---
#
# "Start with: goodvibes" must not be a false promise. When
# $INSTALL_DIR is not on PATH, the installer used to print a session-local
# `export PATH=...` line the user had to copy-paste themselves — and still
# ended with "Start with: goodvibes" regardless, which was false on a fresh
# shell. Instead the installer now writes an idempotent, marker-tagged PATH
# line into the user's actual shell rc itself (uninstall removes it, same as
# it does for service units), and the final line states a command that works
# RIGHT NOW in the current shell (the absolute path), never a promise that
# depends on a shell restart the user hasn't done yet.

# Resolve the rc file for the user's actual login shell ($SHELL — set by the
# environment regardless of this script's own #!/bin/sh execution), not a
# guess. Falls back to .profile for anything unrecognized.
resolve_shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    */fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    */bash)
      # bash reads .bashrc for the interactive non-login shells most
      # terminal emulators start; fall back to .bash_profile only when that
      # already exists and .bashrc does not.
      if [ -f "$HOME/.bashrc" ] || [ ! -f "$HOME/.bash_profile" ]; then
        printf '%s' "$HOME/.bashrc"
      else
        printf '%s' "$HOME/.bash_profile"
      fi
      ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# The PATH-export line itself, in the syntax the target shell understands.
path_export_line() {
  case "${SHELL:-}" in
    */fish) printf 'set -gx PATH %s $PATH' "$INSTALL_DIR" ;;
    *) printf 'export PATH="%s:$PATH"' "$INSTALL_DIR" ;;
  esac
}

# Set by ensure_path_on_shell_rc() so main() can print an honest final line.
PATH_LINE_ADDED=0
RC_FILE_USED=""

# Idempotent: does nothing if $INSTALL_DIR is already on PATH, or if a prior
# run already added the marker-tagged line (this shell just hasn't re-sourced
# its rc file yet). Otherwise appends the marker comment + export line.
ensure_path_on_shell_rc() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  rc_file=$(resolve_shell_rc)
  if [ -f "$rc_file" ] && grep -qF "$INSTALLER_MARKER" "$rc_file" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true
  printf '\n# %s\n%s\n' "$INSTALLER_MARKER" "$(path_export_line)" >> "$rc_file"
  PATH_LINE_ADDED=1
  RC_FILE_USED="$rc_file"
  say ""
  say "Added $INSTALL_DIR to PATH in $rc_file (installer-managed; uninstall removes it)."
}

# Uninstall-side removal of the PATH line: only the marker comment line and
# the one export/set line immediately after it — the exact two lines
# ensure_path_on_shell_rc() appended — never anything else in the file.
uninstall_shell_rc_path_line() {
  rc_file=$(resolve_shell_rc)
  [ -f "$rc_file" ] || return 0
  grep -qF "$INSTALLER_MARKER" "$rc_file" 2>/dev/null || return 0
  tmp_file="$rc_file.goodvibes-uninstall-tmp"
  awk -v marker="$INSTALLER_MARKER" '
    index($0, marker) > 0 { skip = 1; next }
    skip > 0 { skip--; next }
    { print }
  ' "$rc_file" > "$tmp_file" && mv "$tmp_file" "$rc_file"
  say "  removed    PATH line from $rc_file"
  record_removed "PATH line in $rc_file (installer-managed)"
}

# --- platform detection (release asset naming: goodvibes[-daemon]-{linux|macos}-{x64|arm64}) ---
resolve_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_tag="linux" ;;
    Darwin) os_tag="macos" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      fail "native Windows is not supported yet. Install WSL2 and run GoodVibes inside it (the Linux binaries apply unchanged):
    1. In an elevated PowerShell:  wsl --install
    2. Open your WSL2 distribution, then re-run:  curl -fsSL https://goodvibes.sh/install.sh | sh
  WSL2 setup and native-Windows status: https://github.com/$REPO/blob/main/docs/windows.md" ;;
    *) fail "unsupported operating system: $os (Windows: use WSL2; see https://github.com/$REPO/blob/main/docs/windows.md)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_tag="x64" ;;
    aarch64|arm64) arch_tag="arm64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
  PLATFORM_SUFFIX="${os_tag}-${arch_tag}"
  # The sqlite-vec addon uses the Node-style platform tag (linux|darwin) and the
  # shared-library suffix the platform's loader resolves — distinct from the release
  # binaries' os_tag (linux|macos).
  case "$os_tag" in
    linux) VEC_OS="linux"; VEC_SUFFIX="so" ;;
    macos) VEC_OS="darwin"; VEC_SUFFIX="dylib" ;;
  esac
}

# --- tooling: curl or wget, and a sha256 command ---
fetch() {
  # fetch <url> <dest>; reuse only this run's private verified staging.
  [ ! -f "$2" ] || return 0
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "need curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "need sha256sum or shasum to verify downloads"
  fi
}

# --- resolve a release tag for a repo ---
resolve_tag() {
  # resolve_tag <repo> <requested> — prints the tag (vX.Y.Z)
  tag_repo="$1"
  tag_requested="$2"
  if [ "$tag_requested" = "latest" ]; then
    # GitHub serves the tag in the redirect Location for /releases/latest.
    if command -v curl >/dev/null 2>&1; then
      redirect=$(curl -fsSI -o /dev/null -w '%{redirect_url}' "https://github.com/$tag_repo/releases/latest") ||
        fail "could not resolve the latest release tag for $tag_repo"
      tag="${redirect##*/}"
    else
      redirect=$(wget -q --max-redirect=0 --server-response "https://github.com/$tag_repo/releases/latest" 2>&1 |
        awk '/Location:/ {print $2}' | tr -d '\r' | head -1)
      tag="${redirect##*/}"
    fi
    [ -n "$tag" ] || fail "could not resolve the latest release tag for $tag_repo"
  else
    tag="$tag_requested"
  fi
  case "$tag" in v*) : ;; *) tag="v$tag" ;; esac
  printf '%s' "$tag"
}

resolve_version() {
  # Resolve once. A suite cannot mix versions from former product repositories.
  for requested in "$REQUESTED_DAEMON_VERSION" "$REQUESTED_AGENT_VERSION" "$REQUESTED_WEBUI_VERSION"; do
    [ "${requested#v}" = "${REQUESTED_VERSION#v}" ] || fail "All products use GOODVIBES_VERSION; remove conflicting per-product version overrides."
  done
  VERSION=$(resolve_tag "$REPO" "$REQUESTED_VERSION")
  printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' || fail "Invalid release version: $VERSION"
}

# Require exactly one valid checksum; duplicate/ambiguous entries are errors.
release_checksum() {
  awk -v name="$1" '
    $2 == name || $2 == "*"name { count++; hash=$1; if (NF != 2) bad=1 }
    END { if (count != 1 || bad || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1; print tolower(hash) }
  ' "$WORKDIR/SHA256SUMS.txt"
}
fetch_release_asset() {
  _release_asset=$1
  _release_expected=$(release_checksum "$_release_asset") || fail "Missing or ambiguous checksum: $_release_asset. Release $VERSION is incomplete; no source build will be attempted."
  fetch "$BASE_URL/$_release_asset" "$WORKDIR/$_release_asset"
  _release_actual=$(sha256_of "$WORKDIR/$_release_asset")
  [ "$_release_actual" = "$_release_expected" ] || fail "Checksum mismatch: $_release_asset"
}
prepare_release() {
  fetch "$BASE_URL/SHA256SUMS.txt" "$WORKDIR/SHA256SUMS.txt"
  for _product in goodvibes goodvibes-daemon goodvibes-agent; do
    [ "$_product" != goodvibes-agent ] || [ "$WITH_AGENT" = 1 ] || continue
    fetch_release_asset "$_product-$PLATFORM_SUFFIX"
    if [ "$os_tag" = linux ]; then
      for _suffix in .bun .bun.json .bun.LICENSE.md; do
        fetch_release_asset "$_product-$PLATFORM_SUFFIX$_suffix"
      done
    fi
    if [ "$_product" != goodvibes-daemon ] || [ "$os_tag" = macos ]; then
      _client_reader="$_product-$PLATFORM_SUFFIX.reader-ci-artifact.json"
      if awk -v name="$_client_reader" '$2 == name || $2 == "*"name { found=1 } END { exit !found }' "$WORKDIR/SHA256SUMS.txt"; then
        fetch_release_asset "$_client_reader"
      fi
    fi
  done
  for _prepared_terminal in goodvibes goodvibes-agent goodvibes-daemon; do
    [ "$_prepared_terminal" != goodvibes-agent ] || [ "$WITH_AGENT" = 1 ] || continue
    [ "$_prepared_terminal" != goodvibes-daemon ] || [ "$os_tag" = macos ] || continue
    if [ -f "$WORKDIR/$_prepared_terminal-$PLATFORM_SUFFIX.reader-ci-artifact.json" ]; then
      require_client_reader_evidence "$_prepared_terminal"
    fi
  done
  if [ "$os_tag" = linux ]; then fetch_release_asset "goodvibes-daemon-$PLATFORM_SUFFIX.ci-artifact.json"; fi
  fetch_release_asset "sqlite-vec-$VEC_OS-$arch_tag.$VEC_SUFFIX"
  if [ "$os_tag" = macos ]; then
    fetch_release_asset "sqlite-darwin-$arch_tag.dylib"
    fetch_release_asset "sqlite-darwin-$arch_tag.dylib.json"
  fi
  fetch_release_asset browser-driver.tar.gz
  if [ "$WITH_WEBUI" = 1 ]; then fetch_release_asset "goodvibes-webui-bundle-${VERSION#v}.tar.gz"; fi
  # Validate required archive contents before any installed program is changed.
  mkdir -p "$WORKDIR/browser-driver-staging"
  tar -xzf "$WORKDIR/browser-driver.tar.gz" -C "$WORKDIR/browser-driver-staging" || fail 'Could not extract the verified browser driver.'
  for _driver_entry in package.json index.js cli.js; do
    [ -f "$WORKDIR/browser-driver-staging/playwright-core/$_driver_entry" ] || fail "The verified browser driver is missing playwright-core/$_driver_entry."
  done
  if [ "$WITH_WEBUI" = 1 ]; then
    mkdir -p "$WORKDIR/webui-staging"
    tar -xzf "$WORKDIR/goodvibes-webui-bundle-${VERSION#v}.tar.gz" -C "$WORKDIR/webui-staging" || fail 'Could not extract the verified WebUI.'
    [ -f "$WORKDIR/webui-staging/goodvibes-webui/index.html" ] || fail 'The verified WebUI is missing goodvibes-webui/index.html.'
  fi
  if [ "$os_tag" = linux ]; then prepare_daemon_receipt; fi
}

prepare_daemon_receipt() {
  _receipt_asset="goodvibes-daemon-$PLATFORM_SUFFIX"
  _reader_asset="$_receipt_asset.reader-ci-artifact.json"
  _reader_source=""
  _compiled_readers=null
  chmod 755 "$WORKDIR/$_receipt_asset.bun"
  if awk -v name="$_reader_asset" '$2 == name || $2 == "*"name { found=1 } END { exit !found }' "$WORKDIR/SHA256SUMS.txt"; then
    fetch_release_asset "$_reader_asset"
    _reader_source="$WORKDIR/$_reader_asset"
    chmod 755 "$WORKDIR/$_receipt_asset"
    _compiled_readers=$("$WORKDIR/$_receipt_asset" check-install-reader --describe) || fail 'The verified daemon did not confirm its compiled readers. No installed program was replaced.'
  fi
  # The ordinary released Bun prepares metadata in private staging. Older
  # updaters still consume the original descriptor; richer evidence must name
  # precisely the same source and payloads and match the actual staged reader.
  "$WORKDIR/$_receipt_asset.bun" -e '
    try {
      const [primaryFile, readerFile, compiledJson, version, output] = process.argv.slice(1);
      const primary = JSON.parse(await Bun.file(primaryFile).text());
      const binary = primaryFile.slice(primaryFile.lastIndexOf("/")+1).replace(/\.ci-artifact\.json$/,""), target = binary.slice("goodvibes-daemon-".length);
      const exact = (a, keys) => a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).length === keys.length && keys.every(k => Object.hasOwn(a,k));
      const paths = [binary,binary+".bun",binary+".bun.LICENSE.md",binary+".bun.json",`lib/sqlite-vec-${target}/vec0.so`];
      const validate = (a, schema) => {
        const keys = ["schema","sourceCommit","sourceTree","headCommit","target","files",...(schema === 2 ? ["readers"] : [])];
        if (!exact(a,keys) || a.schema !== schema || a.target !== target || !Array.isArray(a.files) || a.files.length !== paths.length
          || [a.sourceCommit,a.sourceTree,a.headCommit].some(v => typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v))) throw new Error();
        a.files.forEach((f,i) => {
          if (!exact(f,["path","sha256","mode","size"]) || f.path !== paths[i] || f.mode !== (i < 2 ? 0o755 : 0o644)
            || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0) throw new Error();
        });
      };
      validate(primary,1);
      const identity = a => [a.sourceCommit,a.sourceTree,a.headCommit,a.target,a.files.map(f => [f.path,f.sha256,f.mode,f.size])];
      let artifact = primary;
      if (readerFile) {
        const candidate = JSON.parse(await Bun.file(readerFile).text());
        const compiled = JSON.parse(compiledJson);
        validate(candidate,2);
        const profile = r => [r.schema,r.version,r.formats];
        if (!exact(candidate.readers,["schema","version","formats"]) || !exact(compiled,["schema","version","formats"])
          || JSON.stringify(identity(candidate)) !== JSON.stringify(identity(primary))
          || candidate.readers.schema !== 1 || candidate.readers.version !== version
          || !Array.isArray(candidate.readers.formats) || candidate.readers.formats.length > 256
          || candidate.readers.formats.some(v => typeof v !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(v))
          || new Set(candidate.readers.formats).size !== candidate.readers.formats.length
          || JSON.stringify(profile(candidate.readers)) !== JSON.stringify(profile(compiled))) throw new Error();
        artifact = candidate;
      }
      await Bun.write(output, JSON.stringify({schema:1,packageName:"@goodvibes-jev/daemon",version,artifact},null,2)+"\n");
    } catch { process.exitCode = 1; }
  ' "$WORKDIR/$_receipt_asset.ci-artifact.json" "$_reader_source" "$_compiled_readers" "${VERSION#v}" "$WORKDIR/daemon-installation.json" || fail 'The verified daemon release metadata could not be confirmed. No installed program was replaced.'
}

# A claim's payload is diagnostic, never an authority key. Retain its actual
# native inode/device/owner/mode across both public and private hardlink names.
# Root descriptors5/6/7 retain all original claim inodes until final release,
# preventing inode reuse even when a publication subshell reuses its inherited
# descriptor numbers. Link count/ctime change during our own unlink sequence.
install_claim_file_identity() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  # The filesystem tool belongs to the actual host, independently of an
  # injected release-platform selector. GNU and BSD expose different flags.
  stat -c '%d:%i:%u:%g:%f' "$1" 2>/dev/null || stat -f '%d:%i:%u:%g:%p' "$1"
}
expected_install_claim_identity() {
  case "$1" in
    goodvibes-daemon) printf '%s' "$INSTALL_DAEMON_CLAIM_ID" ;;
    goodvibes) printf '%s' "$INSTALL_TUI_CLAIM_ID" ;;
    goodvibes-agent) printf '%s' "$INSTALL_AGENT_CLAIM_ID" ;;
    *) return 1 ;;
  esac
}

install_claim_directories_current() {
  if [ "${_claim_purpose:-install}" = uninstall ]; then
    installer_open_file_matches 0 "$INSTALL_CLAIM_DIR" || return 1
  fi
  [ ! -L "$INSTALL_CLAIM_DIR" ] && installer_open_file_matches 9 "$INSTALL_CLAIM_DIR" || return 1
  [ ! -L "$INSTALL_CLAIM_OWNER" ] && installer_open_file_matches 8 "$INSTALL_CLAIM_OWNER" || return 1
}

release_install_claims() {
  [ -n "$INSTALL_CLAIM_OWNER" ] || return 0
  install_claim_directories_current || return 1
  _claim_index=0
  for _claim_product in goodvibes-daemon goodvibes goodvibes-agent; do
    _claim_index=$((_claim_index + 1))
    [ "$_claim_index" -le "$INSTALL_CLAIM_COUNT" ] || break
    _claim_path="$INSTALL_CLAIM_DIR/$_claim_product.update-transaction"
    _claim_reference="$INSTALL_CLAIM_OWNER/$_claim_product"
    _claim_expected=$(expected_install_claim_identity "$_claim_product") || return 1
    [ -n "$_claim_expected" ] || return 1
    install_claim_directories_current || return 1
    [ -f "$_claim_reference" ] && [ ! -L "$_claim_reference" ] || return 1
    exec 3< "$_claim_reference"
    if ! install_claim_directories_current || [ -L "$_claim_path" ] || ! installer_open_file_matches 3 "$_claim_path" \
      || [ -L "$_claim_reference" ] || ! installer_open_file_matches 3 "$_claim_reference" \
      || [ "$(install_claim_file_identity "$_claim_path")" != "$_claim_expected" ] \
      || [ "$(install_claim_file_identity "$_claim_reference")" != "$_claim_expected" ]; then
      exec 3<&-
      return 1
    fi
    if ! rm -f "$_claim_path"; then exec 3<&-; return 1; fi
    # The first unlink is an effect boundary. Never use its success to adopt
    # a replacement private reference or delete a reappeared foreign claim.
    if ! install_claim_directories_current || [ -e "$_claim_path" ] || [ -L "$_claim_path" ] \
      || [ -L "$_claim_reference" ] || ! installer_open_file_matches 3 "$_claim_reference" \
      || [ "$(install_claim_file_identity "$_claim_reference")" != "$_claim_expected" ]; then
      exec 3<&-
      return 1
    fi
    if ! rm -f "$_claim_reference"; then exec 3<&-; return 1; fi
    exec 3<&-
    install_claim_directories_current || return 1
    [ ! -e "$_claim_reference" ] && [ ! -L "$_claim_reference" ] || return 1
  done
  install_claim_directories_current || return 1
  rmdir "$INSTALL_CLAIM_OWNER" || return 1
  [ ! -e "$INSTALL_CLAIM_OWNER" ] && [ ! -L "$INSTALL_CLAIM_OWNER" ] || return 1
  INSTALL_CLAIM_OWNER=""
  INSTALL_CLAIM_COUNT=0
  exec 5<&-
  exec 6<&-
  exec 7<&-
  exec 8<&-
  exec 9<&-
}

assert_install_claims() {
  [ "$INSTALL_CLAIM_COUNT" = 3 ] || fail 'The complete suite installation claims are not retained.'
  install_claim_directories_current || fail 'The original installation or private claim directory changed; no further program replacement is allowed.'
  for _assert_product in goodvibes-daemon goodvibes goodvibes-agent; do
    _assert_claim="$INSTALL_CLAIM_DIR/$_assert_product.update-transaction"
    _assert_expected=$(expected_install_claim_identity "$_assert_product") || fail 'Original installation claim identity is unavailable.'
    [ -n "$_assert_expected" ] && [ ! -L "$_assert_claim" ] && [ ! -L "$INSTALL_CLAIM_OWNER/$_assert_product" ] \
      && [ "$_assert_claim" -ef "$INSTALL_CLAIM_OWNER/$_assert_product" ] \
      && [ "$(install_claim_file_identity "$_assert_claim")" = "$_assert_expected" ] \
      && [ "$(install_claim_file_identity "$INSTALL_CLAIM_OWNER/$_assert_product")" = "$_assert_expected" ] \
      || fail 'Original installation claim ownership changed; no further program replacement is allowed.'
  done
}

cleanup_release_install() {
  _install_exit=$?
  trap - EXIT INT TERM
  if [ -n "$INSTALL_CLAIM_OWNER" ]; then
    if [ "$INSTALL_SWAP_BEGUN" = 0 ] || [ "$INSTALL_SWAP_FINISHED" = 1 ]; then
      if ! release_install_claims; then
        say 'install.sh: installation claims changed; retained ownership evidence requires inspection.' >&2
        _install_exit=1
      fi
    else
      say "install.sh: suite replacement did not finish. Inspect retained *.update-transaction files in $INSTALL_CLAIM_DIR before recovery; do not remove them and retry blindly." >&2
      _install_exit=1
    fi
  fi
  rm -rf "$WORKDIR"
  exit "$_install_exit"
}

claim_release_install() {
  _claim_purpose=${1:-install}
  case "$_claim_purpose" in install|uninstall) : ;; *) fail 'Unknown suite claim purpose.' ;; esac
  command -v stat >/dev/null 2>&1 || fail 'The native stat utility is required to retain original installation ownership.'
  if [ "$_claim_purpose" = uninstall ]; then
    [ -d "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ] && installer_open_file_matches 0 "$INSTALL_DIR" || fail 'The original uninstall directory changed before exclusion.'
  else mkdir -p "$INSTALL_DIR"
  fi
  INSTALL_CLAIM_DIR=$(CDPATH= cd -- "$INSTALL_DIR" && pwd -P) || fail 'Could not retain the installation directory.'
  # Publish only to the selected directory, even when the original option was
  # a relative path or symlink. The open descriptor detects its replacement.
  exec 9< "$INSTALL_CLAIM_DIR"
  installer_open_file_matches 9 "$INSTALL_CLAIM_DIR" || fail 'Could not retain the selected installation directory.'
  if [ "$_claim_purpose" = uninstall ]; then
    installer_open_file_matches 0 "$INSTALL_CLAIM_DIR" || fail 'The original uninstall directory changed before claiming.'
  fi
  INSTALL_DIR=$INSTALL_CLAIM_DIR
  WEBUI_ROOT="$INSTALL_DIR/webui"
  INSTALL_CLAIM_OWNER=$(mktemp -d "$INSTALL_CLAIM_DIR/.goodvibes-install-claim.XXXXXX")
  [ ! -L "$INSTALL_CLAIM_OWNER" ] || fail 'The private installation claim directory changed.'
  exec 8< "$INSTALL_CLAIM_OWNER"
  install_claim_directories_current || fail 'Could not retain the original private claim directory.'
  for _claim_product in goodvibes-daemon goodvibes goodvibes-agent; do
    # Occupied native transaction slots never grant execution, even while
    # their owner writes the receipt. Noclobber creates exclusively without
    # following a symlink or treating an existing directory as a destination.
    _claim_path="$INSTALL_CLAIM_DIR/$_claim_product.update-transaction"
    [ ! -e "$_claim_path" ] && [ ! -L "$_claim_path" ] || fail 'Another update or interrupted installation owns this directory. Inspect its retained transaction files first.'
    (umask 077; set -C; printf 'GoodVibes suite installation %s\nInterrupted replacement: inspect installed programs and retained claims before recovery.\n' "$VERSION" > "$_claim_path") || fail 'Another update or interrupted installation owns this directory. Inspect its retained transaction files first.'
    INSTALL_CLAIM_COUNT=$((INSTALL_CLAIM_COUNT + 1))
    case "$_claim_product" in
      goodvibes-daemon) exec 5< "$_claim_path"; _created_claim_fd=5 ;;
      goodvibes) exec 6< "$_claim_path"; _created_claim_fd=6 ;;
      goodvibes-agent) exec 7< "$_claim_path"; _created_claim_fd=7 ;;
    esac
    [ ! -L "$_claim_path" ] && installer_open_file_matches "$_created_claim_fd" "$_claim_path" || fail 'The original installation claim changed during capture.'
    _created_claim_id=$(install_claim_file_identity "$_claim_path") || fail 'Could not retain the original native installation claim.'
    [ ! -L "$_claim_path" ] && installer_open_file_matches "$_created_claim_fd" "$_claim_path" || fail 'The native installation claim changed during observation.'
    case "$_claim_product" in
      goodvibes-daemon) INSTALL_DAEMON_CLAIM_ID=$_created_claim_id ;;
      goodvibes) INSTALL_TUI_CLAIM_ID=$_created_claim_id ;;
      goodvibes-agent) INSTALL_AGENT_CLAIM_ID=$_created_claim_id ;;
    esac
    ln "$_claim_path" "$INSTALL_CLAIM_OWNER/$_claim_product" || fail 'The installer could not retain its transaction ownership. Inspect the retained claim before retrying.'
    [ ! -L "$_claim_path" ] && [ ! -L "$INSTALL_CLAIM_OWNER/$_claim_product" ] \
      && installer_open_file_matches "$_created_claim_fd" "$_claim_path" && installer_open_file_matches "$_created_claim_fd" "$INSTALL_CLAIM_OWNER/$_claim_product" \
      || fail 'The original installation claim changed before retention.'
  done
  if [ "$_claim_purpose" = uninstall ]; then assert_install_claims; return 0; fi
  # An interrupted updater may have retained a companion slot even when its
  # primary claim is missing. Never overwrite that recovery evidence.
  for _idle_product in goodvibes-daemon goodvibes goodvibes-agent; do
    for _idle_companion in '' .bun .bun.json .bun.LICENSE.md .readers.json; do
      for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
        [ -n "$_idle_companion" ] || [ "$_idle_tail" != .update-transaction ] || continue
        _idle_path="$INSTALL_CLAIM_DIR/$_idle_product$_idle_companion$_idle_tail"
        [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail 'Retained program transaction files require inspection before installation.'
      done
    done
  done
  for _idle_file in daemon-installation.json "lib/sqlite-vec-${VEC_OS}-${arch_tag}/vec0.${VEC_SUFFIX}"; do
    for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
      _idle_path="$INSTALL_CLAIM_DIR/$_idle_file$_idle_tail"
      [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail 'Retained companion transaction files require inspection before installation.'
    done
  done
  if [ "$os_tag" = macos ]; then
    for _sqlite_tail in '' .json; do
      for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
        _idle_path="$INSTALL_CLAIM_DIR/lib/sqlite-darwin-$arch_tag/libsqlite3.dylib$_sqlite_tail$_idle_tail"
        [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail 'Retained SQLite runtime transaction files require inspection before installation.'
      done
    done
  fi
  assert_install_library_directory "sqlite-vec-${VEC_OS}-${arch_tag}"
  if [ "$os_tag" = macos ]; then assert_install_library_directory "sqlite-darwin-$arch_tag"; fi
}

assert_install_library_directory() {
  for _library_parent in "$INSTALL_DIR/lib" "$INSTALL_DIR/lib/$1"; do
    [ ! -L "$_library_parent" ] || fail 'An installed native library directory is an alias; inspect it before replacing programs.'
    [ ! -e "$_library_parent" ] || [ -d "$_library_parent" ] || fail 'An installed native library parent is not a directory.'
  done
}

install_release_library_file() {
  _library_asset=$1
  _library_directory=$2
  _library_name=$3
  assert_install_claims
  assert_install_library_directory "$_library_directory"
  mkdir -p "$INSTALL_DIR/lib/$_library_directory"
  assert_install_library_directory "$_library_directory"
  _library_target="$INSTALL_DIR/lib/$_library_directory/$_library_name"
  [ ! -e "$_library_target.incoming" ] && [ ! -L "$_library_target.incoming" ] || fail 'A retained native library stage requires inspection.'
  (set -C; cat "$WORKDIR/$_library_asset" > "$_library_target.incoming") || fail 'Could not exclusively stage the native library.'
  chmod 644 "$_library_target.incoming"
  assert_install_claims
  assert_install_library_directory "$_library_directory"
  mv -f "$_library_target.incoming" "$_library_target"
}

# Reader descriptors are canonical JSON emitted by the native publisher after
# its compiled metadata check. Both descriptor and cohort are independently
# pinned by the same release checksum manifest. Require the exact program pin
# before invoking its known metadata command; never probe an old binary whose
# release did not publish affirmative reader evidence.
require_client_reader_evidence() {
  _evidence_product=$1
  _evidence_asset="$_evidence_product-$PLATFORM_SUFFIX"
  _evidence_file="$WORKDIR/$_evidence_asset.reader-ci-artifact.json"
  [ -f "$_evidence_file" ] && [ ! -L "$_evidence_file" ] || fail "The selected $_evidence_product release has no reader evidence. The installed programs were kept."
  case "$_evidence_product" in goodvibes) _evidence_package='@goodvibes-jev/tui' ;; goodvibes-agent) _evidence_package='@goodvibes-jev/agent' ;; goodvibes-daemon) _evidence_package='@goodvibes-jev/daemon' ;; *) fail 'Unsupported native reader evidence.' ;; esac
  _evidence_target="$VEC_OS-$arch_tag"
  awk -v package="$_evidence_package" -v version="${VERSION#v}" -v target="$_evidence_target" '
    /^  "schema": 1,$/ { schema++ }
    /^  "packageName": / { if ($0 == "  \"packageName\": \"" package "\",") name++ }
    /^  "version": / { if ($0 == "  \"version\": \"" version "\",") release++ }
    /^  "target": / { if ($0 == "  \"target\": \"" target "\",") host++ }
    /^  "readers": \{$/ { readers++ }
    END { exit !(schema==1 && name==1 && release==1 && host==1 && readers==1) }
  ' "$_evidence_file" || fail "The selected $_evidence_product reader evidence does not name this release and platform. The installed programs were kept."
  _evidence_members=''
  if [ "$os_tag" = linux ]; then _evidence_members='.bun .bun.LICENSE.md .bun.json'; fi
  for _evidence_suffix in '' $_evidence_members; do
    _evidence_member="$_evidence_asset$_evidence_suffix"
    _evidence_pin=$(awk -v wanted="$_evidence_member" '
      /"path": / { name=$0; sub(/^.*"path": "/,"",name); sub(/",? *$/,"",name); selected=(name==wanted); next }
      selected && /"sha256": / { pin=$0; sub(/^.*"sha256": "/,"",pin); sub(/",? *$/,"",pin); print pin; count++; selected=0 }
      END { if (count != 1) exit 1 }
    ' "$_evidence_file") || fail 'Reader evidence has a missing or ambiguous program pin.'
    _evidence_expected=$(release_checksum "$_evidence_member") || fail 'Reader evidence names an unavailable release member.'
    [ "$_evidence_pin" = "$_evidence_expected" ] || fail 'Reader evidence does not match the selected released program bytes. No installed program was replaced.'
  done
}

check_release_reader() {
  assert_install_claims
  _reader_floor="$INSTALL_CLAIM_DIR/.goodvibes-reader-requirements.json"
  [ -e "$_reader_floor" ] || [ -L "$_reader_floor" ] || return 0
  # Every selected writer must confirm its own compiled reader support before
  # the first suite replacement. A sibling daemon cannot attest another binary.
  _reader_products="goodvibes goodvibes-daemon"
  if [ "$WITH_AGENT" = 1 ]; then _reader_products="$_reader_products goodvibes-agent"; fi
  _reader_expected="{\"schema\":\"goodvibes.install.reader-check\",\"schemaVersion\":1,\"readerVersion\":\"${VERSION#v}\"}"
  for _reader_product in $_reader_products; do
    if [ "$_reader_product" != goodvibes-daemon ] || [ "$os_tag" = macos ]; then require_client_reader_evidence "$_reader_product"; fi
    _reader_binary="$WORKDIR/$_reader_product-$PLATFORM_SUFFIX"
    chmod 755 "$_reader_binary"
    if [ "$os_tag" = linux ]; then chmod 755 "$_reader_binary.bun"; fi
    _reader_receipt=$("$_reader_binary" check-install-reader "$INSTALL_CLAIM_DIR/$_reader_product") || fail "The selected $_reader_product release cannot read the saved data. The installed programs were kept; choose a compatible newer release."
    assert_install_claims
    [ "$_reader_receipt" = "$_reader_expected" ] || fail "The selected $_reader_product did not confirm its matching compiled readers. The installed programs were kept."
  done
}

install_release_binary() {
  assert_install_claims
  _binary=$1
  _binary_asset="$_binary-$PLATFORM_SUFFIX"
  _installed_binary=$_binary
  # Linux compiled entrypoints require their adjacent, released ordinary Bun.
  # Keep the filename relationship when installing under the command name.
  if [ "$os_tag" = linux ]; then
    for _binary_suffix in .bun .bun.json .bun.LICENSE.md; do
      cp "$WORKDIR/$_binary_asset$_binary_suffix" "$INSTALL_DIR/$_installed_binary$_binary_suffix.incoming"
      case "$_binary_suffix" in .bun) chmod 755 "$INSTALL_DIR/$_installed_binary$_binary_suffix.incoming" ;; *) chmod 644 "$INSTALL_DIR/$_installed_binary$_binary_suffix.incoming" ;; esac
      assert_install_claims
      mv -f "$INSTALL_DIR/$_installed_binary$_binary_suffix.incoming" "$INSTALL_DIR/$_installed_binary$_binary_suffix"
    done
  fi
  cp "$WORKDIR/$_binary_asset" "$INSTALL_DIR/$_installed_binary.incoming"
  chmod 755 "$INSTALL_DIR/$_installed_binary.incoming"
  assert_install_claims
  mv -f "$INSTALL_DIR/$_installed_binary.incoming" "$INSTALL_DIR/$_installed_binary"
  if [ "$_binary" != goodvibes-daemon ] || [ "$os_tag" = macos ]; then
    _installed_readers="$INSTALL_DIR/$_installed_binary.readers.json"
    if [ -f "$WORKDIR/$_binary_asset.reader-ci-artifact.json" ]; then
      require_client_reader_evidence "$_binary"
      cp "$WORKDIR/$_binary_asset.reader-ci-artifact.json" "$_installed_readers.incoming"
      chmod 644 "$_installed_readers.incoming"
      assert_install_claims
      mv -f "$_installed_readers.incoming" "$_installed_readers"
    elif [ -e "$_installed_readers" ] || [ -L "$_installed_readers" ]; then
      # No old descriptor may describe a different newly installed executable.
      assert_install_claims
      rm -f "$_installed_readers"
    fi
  fi
  if [ "$_binary" = goodvibes-daemon ] && [ "$os_tag" = linux ]; then
    cp "$WORKDIR/daemon-installation.json" "$INSTALL_DIR/daemon-installation.json.incoming"
    chmod 644 "$INSTALL_DIR/daemon-installation.json.incoming"
    assert_install_claims
    mv -f "$INSTALL_DIR/daemon-installation.json.incoming" "$INSTALL_DIR/daemon-installation.json"
  fi
  if [ "$_binary" = goodvibes-daemon ] && [ "$os_tag" = macos ]; then
    install_release_library_file "sqlite-darwin-$arch_tag.dylib" "sqlite-darwin-$arch_tag" libsqlite3.dylib
    install_release_library_file "sqlite-darwin-$arch_tag.dylib.json" "sqlite-darwin-$arch_tag" libsqlite3.dylib.json
  fi
}

# --- restart on upgrade ---
# The curl one-liner doubles as the upgrade path. Replacing a binary on disk
# does not affect a running process (it keeps executing the old inode), so an
# already-running daemon/agent must be restarted for the upgrade to take
# effect. systemd-managed services are restarted through their unit; bare
# processes are stopped and relaunched with their original arguments.
#
# A unit or bare process is only a valid restart target when it can actually
# run the new binary. Before restarting a unit, its ExecStart binary is
# resolved and checked; before relaunching a bare process, its real
# executable (/proc/<pid>/exe) must live under $INSTALL_DIR. Either check
# failing means the old install is treated as gone, not restarted — this is
# exactly the case left behind by `bun remove -g @pellux/goodvibes-tui
# @pellux/goodvibes-agent`, which deletes the binaries but can leave the
# bun-era systemd user unit, and even its still-running process, behind.
# Falling through in that case lets first-run service setup below bring up a
# working daemon instead of silently doing nothing.

# proc_belongs_to_install_dir <pid> — true only when the process's executable
# lives under $INSTALL_DIR, so acting on one install never touches a
# daemon/agent launched from a different install dir (bun's global bin dir,
# a different $GOODVIBES_INSTALL_DIR elsewhere on the host, etc.). Shared by
# the restart path (skip relaunching a foreign process) and uninstall (only
# stop processes this install actually owns).
# proc_exe_path <pid> — the executable behind a pid, or empty when it cannot
# be determined. Printed to the operator when a foreign process is left alone,
# so "something else owns this" names WHICH something else.
proc_exe_path() {
  _pid="$1"
  if [ -r "/proc/$_pid/exe" ]; then
    _resolved=$(readlink -f "/proc/$_pid/exe" 2>/dev/null || true)
    if [ -n "$_resolved" ] && [ -e "$_resolved" ]; then
      printf '%s' "$_resolved"
      return 0
    fi
    # An upgrade that REPLACES the binary leaves the running process pointing
    # at a deleted inode, which `readlink -f` cannot resolve. The raw link
    # still records the path it was launched from, so this install's own
    # daemon stays attributable to it across exactly the upgrade this script
    # performs — without it, the process the restart path exists to restart
    # would look foreign and be skipped.
    _raw=$(readlink "/proc/$_pid/exe" 2>/dev/null || true)
    _raw=${_raw% (deleted)}
    if [ -n "$_raw" ]; then
      printf '%s' "$_raw"
      return 0
    fi
  fi
  ps -o args= -p "$_pid" 2>/dev/null | sed 's/ .*$//'
}

proc_belongs_to_install_dir() {
  _exe=$(proc_exe_path "$1")
  case "$_exe" in
    "$INSTALL_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# pids_owned_by_install <pgrep-pattern> — pids matching the pattern whose
# executable resolves under $INSTALL_DIR.
#
# `pgrep -f` matches on a COMMAND LINE, which is a host-global namespace: it
# cannot tell this install's daemon from one belonging to another checkout, a
# worktree, a dev copy, or another user's tree. Every site that acts on the
# result must filter first — a machine deliberately running more than one
# goodvibes node is the case the clustering work exists to support, and an
# installer that kills the other nodes defeats it.
pids_owned_by_install() {
  _matched=$(pgrep -f "$1" 2>/dev/null || true)
  [ -n "$_matched" ] || return 0
  for _p in $_matched; do
    if proc_belongs_to_install_dir "$_p"; then
      printf '%s\n' "$_p"
    fi
  done
}

# report_foreign_processes <pgrep-pattern> <label> — name the processes this
# script matched but will NOT touch, so an operator who expected the installer
# to restart something can see why it did not.
report_foreign_processes() {
  _matched=$(pgrep -f "$1" 2>/dev/null || true)
  [ -n "$_matched" ] || return 0
  for _p in $_matched; do
    proc_belongs_to_install_dir "$_p" && continue
    _foreign_exe=$(proc_exe_path "$_p")
    # `pgrep -f` matches command lines, so anything that merely MENTIONS the
    # binary — this script, a shell running it, an editor, a log tail — also
    # matches. Reporting those as "a different install" would be false. Only
    # a process whose executable is actually named like the one being managed
    # is worth telling the operator about; the rest are skipped in silence
    # because they were never candidates.
    [ -n "$_foreign_exe" ] || continue
    [ "${_foreign_exe##*/}" = "$2" ] || continue
    say ""
    say "Leaving $2 (pid $_p) alone; it belongs to a different install:"
    say "  $_foreign_exe"
    say "  This install manages only $INSTALL_DIR. Restart that one yourself if you meant to."
  done
}

# Extract the ExecStart binary path systemd reports for a unit, out of the
# structured `{ path=... ; argv[]=... ; ... }` that
# `systemctl show -p ExecStart --value` prints. Empty when it cannot be
# determined (missing unit, no systemd, unrecognized format) — callers must
# treat that as "unknown", never as "broken".
systemd_unit_exec_binary() {
  _raw=$(systemctl --user show -p ExecStart --value "$1" 2>/dev/null || true)
  printf '%s' "$_raw" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1
}

# The MainPID systemd reports for a user unit, or nothing when unknown.
systemd_unit_main_pid() {
  _mp=$(systemctl --user show -p MainPID --value "$1" 2>/dev/null || true)
  case "$_mp" in
    ''|0) : ;;
    *[!0-9]*) : ;;
    *) printf '%s' "$_mp" ;;
  esac
}

# Tri-state activity of a systemd user unit — prints one of:
#   active    is-active exited 0
#   inactive  is-active exited 3 AND printed a recognized final state
#   unknown   anything else: no systemctl, bus unreachable (exit 1), timeout,
#             unparseable output
# The distinction is load-bearing: 'cannot ask systemd' must never be read as
# 'nothing is running'. Every destructive/demoting decision below requires an
# AFFIRMATIVE answer; unknown always refuses.
unit_active_state() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi
  # The assignment is an AND-OR list so a non-zero is-active (expected!) never
  # trips `set -e`.
  _rc=0
  _out=$(systemctl --user is-active "$1" 2>/dev/null) || _rc=$?
  if [ "$_rc" -eq 0 ]; then
    printf 'active'
    return 0
  fi
  # LSB exit 4 = "no such unit": modern systemd (verified on this repo's own
  # deployment host, systemd 260: prints 'inactive', rc 4) answers it for any
  # unit with NO unit file. That is an AFFIRMATIVE answer — nothing exists to
  # be running — and must never be read as "cannot ask systemd": mapping it to
  # unknown made every fail-safe branch refuse the primary upgrade path on
  # modern systemd. Old systemd answers rc 3 'inactive' for missing units,
  # which the inactive case below already covers.
  if [ "$_rc" -eq 4 ]; then
    printf 'absent'
    return 0
  fi
  if [ "$_rc" -eq 3 ]; then
    case "$_out" in
      inactive|failed|dead) printf 'inactive'; return 0 ;;
      # Transitional states: the unit exists and has (or is acquiring/releasing)
      # processes — treat as active so nothing destructive happens around it,
      # and never as a false "service manager unreachable".
      activating|deactivating|reloading|refreshing) printf 'active'; return 0 ;;
    esac
  fi
  printf 'unknown'
}

# True only when a unit is AFFIRMATIVELY serving: reports active AND its
# MainPID resolves to a live process. A Type=simple unit reports 'active' from
# fork onward — including the pre-bind window of a crash-looping daemon — so
# bare is-active is never used to justify retiring another unit.
unit_serving() {
  [ "$(unit_active_state "$1")" = "active" ] || return 1
  _sp=$(systemd_unit_main_pid "$1")
  [ -n "$_sp" ] || return 1
  kill -0 "$_sp" 2>/dev/null
}

# Tri-state supervision of a PID — prints one of:
#   supervised  a service manager owns this process (systemd .service unit, or
#               one of our launchd labels reports it)
#   free        affirmatively NOT service-managed (systemd resolves it to a
#               session/app scope, or no unit at all)
#   unknown     supervision cannot be determined (no manager reachable)
# Uses `systemctl status <pid>` (unit lookup by pid — covers ANY unit name, not
# a hardcoded list) in the user scope, then the system scope. The bare-process
# kill/relaunch fallback runs ONLY on 'free': SIGTERM + nohup on a supervised
# process demotes it to an unsupervised one with its still-enabled unit left
# behind — the exact two-daemon state at the next login this installer exists
# to prevent. Unknown is treated exactly like supervised.
pid_supervision() {
  _q="$1"
  if [ "$os_tag" = "macos" ]; then
    if command -v launchctl >/dev/null 2>&1; then
      # Tri-state like the systemd branch: a print failure is NOT the same as
      # "label not loaded". launchctl exits 113 for could-not-find-service
      # (affirmatively not loaded); any other failure (e.g. the gui domain
      # unreachable from an ssh session — 'Bad request') means the manager
      # could not be ASKED, and cannot-ask is never read as free-to-kill.
      _saw_print_failure=0
      for _label in "$LAUNCHD_DAEMON_LABEL" goodvibes sh.goodvibes.agent; do
        _lrc=0
        _lout=$(launchctl print "gui/$(id -u)/$_label" 2>/dev/null) || _lrc=$?
        if [ "$_lrc" -eq 0 ]; then
          if printf '%s\n' "$_lout" | grep -q "pid = $_q"; then
            printf 'supervised'
            return 0
          fi
        elif [ "$_lrc" -ne 113 ]; then
          _saw_print_failure=1
        fi
      done
      if [ "$_saw_print_failure" = "1" ]; then
        printf 'unknown'
        return 0
      fi
      # Our labels affirmatively do not own it. launchd supervision under a
      # foreign label is not cheaply enumerable; the practical supervision
      # surface for the goodvibes binaries is our own labels.
      printf 'free'
      return 0
    fi
    printf 'unknown'
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi
  _rc=0
  _out=$(systemctl --user status "$_q" 2>/dev/null) || _rc=$?
  if [ "$_rc" -eq 0 ] || [ "$_rc" -eq 3 ]; then
    if printf '%s\n' "$_out" | head -1 | grep -q '\.service'; then
      printf 'supervised'
    else
      printf 'free'
    fi
    return 0
  fi
  if [ "$_rc" -eq 4 ]; then
    # The user manager does not know the pid — it may belong to a SYSTEM unit.
    _rc=0
    _out=$(systemctl status "$_q" 2>/dev/null) || _rc=$?
    if [ "$_rc" -eq 0 ] || [ "$_rc" -eq 3 ]; then
      if printf '%s\n' "$_out" | head -1 | grep -q '\.service'; then
        printf 'supervised'
      else
        printf 'free'
      fi
      return 0
    fi
    if [ "$_rc" -eq 4 ]; then
      printf 'free'
      return 0
    fi
  fi
  printf 'unknown'
}

# Tri-state enablement of a systemd user unit — prints yes | no | unknown.
# Used by the transfer rollback so it can RESTORE the pre-run enablement state
# instead of blanket-disabling a unit the user had enabled before this run.
unit_enabled_state() {
  command -v systemctl >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  _erc=0
  _eout=$(systemctl --user is-enabled "$1" 2>/dev/null) || _erc=$?
  [ "$_erc" -eq 0 ] && { printf 'yes'; return 0; }
  case "$_eout" in
    disabled|not-found|masked|static) printf 'no'; return 0 ;;
  esac
  printf 'unknown'
}

# Whether the legacy unit file is installer-marker-managed. Prints one of:
# managed | hand-written | unreadable | absent.
legacy_unit_provenance() {
  _lp=$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")
  [ -f "$_lp" ] || { printf 'absent'; return 0; }
  [ -r "$_lp" ] || { printf 'unreadable'; return 0; }
  if grep -q "$INSTALLER_MARKER" "$_lp" 2>/dev/null; then
    printf 'managed'
  else
    printf 'hand-written'
  fi
}

# The exact Description the product's own unit writer emits (see
# MANAGED_SERVICE_DESCRIPTION in src/runtime/legacy-daemon-migration.ts) — the
# fingerprint that identifies a unit written by the in-app install-service /
# onboarding, which carry no installer marker but are just as platform-owned
# (the product overwrites its own units freely whenever install-service runs).
PRODUCT_UNIT_FINGERPRINT='GoodVibes daemon (shared session broker + companion host)'

# Provenance of a CANONICAL unit/plist file:
# managed (installer marker OR the product writer's fingerprint) |
# hand-written | unreadable | absent.
canonical_unit_provenance() {
  _cp="$1"
  [ -f "$_cp" ] || { printf 'absent'; return 0; }
  [ -r "$_cp" ] || { printf 'unreadable'; return 0; }
  if grep -q "$INSTALLER_MARKER" "$_cp" 2>/dev/null ||
     grep -q "$PRODUCT_UNIT_FINGERPRINT" "$_cp" 2>/dev/null; then
    printf 'managed'
  else
    printf 'hand-written'
  fi
}

# True when a unit/plist file bakes the endpoint flags this generation no
# longer uses. Released v1.14.0-v1.18.0 in-app installs (and one unreleased
# installer generation) pinned '--hostname <host> --port <port>' into the
# launch, snapshotting config-at-install-time — those pins override the
# controlPlane settings on every boot until the file is re-derived.
unit_is_endpoint_pinned() {
  grep -qe '--hostname' -e '--port' "$1" 2>/dev/null
}

# The --daemon-home value a unit/plist launches with, quotes stripped; empty
# when the flag is absent. Handles the systemd token form
# (--daemon-home "/path" on the ExecStart line) and the launchd form (the
# <string> element after <string>--daemon-home</string>).
unit_daemon_home_value() {
  _uv=$(sed -n 's/.*--daemon-home[= ][= ]*"\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$1" 2>/dev/null | head -1)
  if [ -z "$_uv" ]; then
    _uv=$(awk '/<string>--daemon-home<\/string>/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$1" 2>/dev/null)
  fi
  printf '%s' "$_uv"
}

# The installed daemon owns its normal home without an explicit override.
# Older managed units are regenerated to this form so native updates can run.
unit_daemon_home_is_canonical() {
  [ -z "$(unit_daemon_home_value "$1")" ]
}

# One-line reason a unit's launch arguments are stale, or nothing when they
# are current. Both writers below derive everything else from settings at
# boot, so staleness is exactly: pinned endpoint flags, or a --daemon-home
# that is absent or names the wrong directory.
unit_launch_stale_reason() {
  if unit_is_endpoint_pinned "$1"; then
    printf 'pins endpoint flags (--hostname/--port) from an older release, which override the controlPlane settings on every boot'
    return 0
  fi
  if ! unit_daemon_home_is_canonical "$1"; then
    _sr=$(unit_daemon_home_value "$1")
    if [ "$_sr" = "$HOME/.goodvibes/daemon" ]; then
      printf 'passes an explicit home override, disabling installed-native automatic updates'
    else
      printf 'overrides the normal daemon state directory with %s' "$_sr"
    fi
    return 0
  fi
  return 0
}

# Timestamped backup of a unit/plist file about to be regenerated, with a
# receipt naming it. Fingerprint/structural provenance is only PROBABLY
# platform-owned — a user may have customized a product-written unit in place
# (extra Environment lines, a different binary path) while keeping its
# recognizable shape — so a regeneration must never destroy the prior
# content: recovery is one mv away.
backup_unit_file() {
  _bf="$1"
  _bak="$_bf.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$_bf" "$_bak" 2>/dev/null || cp "$_bf" "$_bak"
  say "  backed up  $_bf -> $_bak"
}

# Upgrade-time content currency for the CANONICAL unit (Linux): a
# platform-managed unit whose launch arguments are stale — pinned endpoint
# flags, or a --daemon-home that is absent or names the wrong directory — is
# regenerated to the current shape (file + daemon-reload only — the ordinary
# restart path right after this applies it to a running daemon). A
# hand-written unit is never rewritten: honest notice naming the problem
# only. Runs BEFORE restart_running_daemon so the restart picks up the new
# content in the same run.
refresh_stale_canonical_unit() {
  [ "$os_tag" = "linux" ] || return 0
  _rp=$(systemd_daemon_unit_path)
  [ -f "$_rp" ] || return 0
  _reason=$(unit_launch_stale_reason "$_rp")
  [ -n "$_reason" ] || return 0
  case "$(canonical_unit_provenance "$_rp")" in
    managed)
      say ""
      say "Regenerating $SYSTEMD_DAEMON_UNIT: it $_reason."
      backup_unit_file "$_rp"
      write_systemd_unit "$_rp"
      command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
      say "  rewrote    $_rp (config-derived launch, --daemon-home $HOME/.goodvibes/daemon)"
      if [ "$RESTART_DAEMON" != "1" ]; then
        say "  NOTE: GOODVIBES_RESTART_DAEMON=0; the running daemon keeps the old launch arguments until restarted."
      fi
      ;;
    hand-written)
      say ""
      say "NOTE: $SYSTEMD_DAEMON_UNIT at $_rp $_reason,"
      say "  and the unit is not recognizably platform-managed, so it was left untouched."
      say "  Fix the launch arguments yourself so the daemon runs with its own state directory:"
      say "    --daemon-home $HOME/.goodvibes/daemon"
      ;;
  esac
}

restart_systemd_unit() {
  # restart_systemd_unit <unit> <expected-binary> [replace-broken] — returns 0
  # if it handled a running unit (restarted, replaced, or reported), 1 if no
  # active unit exists, or its unit was just replaced because it could no
  # longer run — either way the caller should fall through to bare-process
  # handling and then first-run service setup. The optional third argument
  # (default 1) gates the broken-ExecStart replacement branch: callers that
  # have classified the unit as HAND-WRITTEN pass 0, because this tool never
  # disables, renames, or rewrites a hand-written unit — not even a broken one.
  unit="$1"
  expected_bin="$2"
  replace_broken="${3:-1}"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$unit" 2>/dev/null || return 1

  # A unit whose ExecStart binary no longer exists cannot be brought back by
  # restarting it — that only "restarts" a corpse. Stop it, back up its unit
  # file (never silently destroyed), and let the caller fall through so
  # first-run setup replaces it with a working, installer-managed unit. A
  # unit whose ExecStart is a DIFFERENT but still-existing binary (a
  # genuinely hand-written working unit) is untouched by this check — it
  # keeps the ordinary restart-and-note-the-mismatch behavior below.
  exec_bin=$(systemd_unit_exec_binary "$unit")
  if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
    if [ "$replace_broken" != "1" ]; then
      # Hand-written unit in the corpse state: the running daemon may be
      # executing a deleted inode. Touch NOTHING — restarting would kill the
      # daemon with no binary to relaunch, and disabling/renaming is exactly
      # the never-touch violation this gate exists to prevent. Say so.
      say ""
      say "NOTE: ${unit} points at $exec_bin, which no longer exists, and the unit is not one this"
      say "  tool may replace; leaving it (and its running daemon, which may be executing a deleted"
      say "  binary) untouched."
      say "  Fix the unit's ExecStart yourself, then: systemctl --user restart $unit"
      return 0
    fi
    say ""
    say "${unit} points at $exec_bin, which no longer exists; replacing it."
    systemctl --user disable --now "$unit" 2>/dev/null ||
      systemctl --user stop "$unit" 2>/dev/null || true
    unit_path=$(systemd_unit_path "$unit")
    if [ -f "$unit_path" ]; then
      backup="$unit_path.bak.$(date +%Y%m%d%H%M%S)"
      mv -f "$unit_path" "$backup"
      say "  moved      $unit_path -> $backup"
    fi
    systemctl --user daemon-reload 2>/dev/null || true
    return 1
  fi

  say ""
  say "Restarting the running ${unit%.service} (systemd user service) ..."
  if systemctl --user restart "$unit" 2>/dev/null; then
    say "  restarted  $unit"
    case "$exec_bin" in
      ""|*"$expected_bin"*) : ;;
      *)
        say "  NOTE: the service does not exec $expected_bin, so it may still be"
        say "  running a different (older) install. Inspect it with:"
        say "    systemctl --user cat $unit"
        ;;
    esac
  else
    say "  NOTE: restart failed; restart it yourself with:"
    say "    systemctl --user restart $unit"
  fi
  return 0
}

restart_bare_processes() {
  # restart_bare_processes <pgrep-pattern> <new-binary>
  #
  # The RELAUNCH INVOCATION is canonical for goodvibes-daemon, never read off
  # the process being replaced. An earlier version captured the outgoing
  # process's raw /proc/<pid>/cmdline and replayed it verbatim on relaunch —
  # so ANY process merely matching the pgrep pattern (a manually launched
  # diagnostic copy, a bun-compiled binary whose cmdline carries its own
  # internal argv[1], leftover --hostname/--port flags from an old pinned
  # unit) had its exact argv, and — via plain `nohup` — this shell's own
  # current working directory, relaunched as if it were this install's real
  # daemon. Live incident: a stray goodvibes-daemon process running from a
  # scratch directory got killed and relaunched with its own captured
  # `/$bunfs/root/goodvibes-daemon-linux-x64 --daemon-home ./fresh-home
  # --port 3499`, in whatever directory the installer happened to be run
  # from. write_systemd_unit's canonical shape
  # ("$INSTALL_DIR/goodvibes-daemon" --daemon-home "$HOME/.goodvibes/daemon")
  # is used instead
  # for the daemon: it resolves everything else (host/port, etc.) from
  # settings at startup, so nothing is lost by not replaying old flags, and
  # the relaunch runs from $HOME rather than the installer's own (possibly
  # scratch/temp) cwd. goodvibes-agent has no canonical invocation known to
  # this installer (it is not a unit this script writes), so its original
  # arguments are still recovered from the process being replaced.
  pattern="$1"
  new_bin="$2"
  _is_daemon=0
  [ "${new_bin##*/}" = "goodvibes-daemon" ] && _is_daemon=1
  # Only ever this install's own processes; anything else is named and left
  # running. See pids_owned_by_install.
  report_foreign_processes "$pattern" "${new_bin##*/}"
  pids=$(pids_owned_by_install "$pattern")
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    # A service-managed process is NEVER killed/relaunched here: its unit owns
    # the restart, and a SIGTERM + nohup relaunch would demote it to an
    # unsupervised process with its enabled unit left behind. When supervision
    # CANNOT be determined (no reachable service manager), the process is
    # treated as supervised — 'cannot ask' is never read as 'safe to kill'.
    _supervision=$(pid_supervision "$pid")
    if [ "$_supervision" = "supervised" ]; then
      say ""
      say "Skipping pid $pid: it is supervised by a service manager; its unit owns the restart."
      continue
    fi
    if [ "$_supervision" = "unknown" ]; then
      say ""
      say "Skipping pid $pid: cannot determine whether it is service-managed (service manager unreachable)."
      say "  Nothing was touched. Restart it yourself after the upgrade if needed."
      continue
    fi
    # Belt and braces: `pids` already came from pids_owned_by_install, so a
    # process that is not this install's cannot reach here. It is re-checked
    # rather than assumed because everything below this line signals a pid,
    # and the previous version of this block SIGTERMed exactly the processes
    # it had just identified as belonging to somebody else.
    if ! proc_belongs_to_install_dir "$pid"; then
      continue
    fi

    if [ "$_is_daemon" = "1" ]; then
      # Canonical only — never derived from the process being replaced.
      # display_args is for the human-readable notices below only.
      display_args=""
    else
      # No canonical shape known for this binary — recover the original
      # arguments so flags survive.
      if [ -r "/proc/$pid/cmdline" ]; then
        args=$(tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2 | tr '\n' ' ')
      else
        args=$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[^ ]* *//')
      fi
      args=$(printf '%s' "${args:-}" | sed 's/[[:space:]]*$//')
      display_args="${args:-}"
    fi

    say ""
    say "Restarting running ${new_bin##*/} (pid $pid) ..."
    kill "$pid" 2>/dev/null || continue
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "  NOTE: pid $pid did not exit within 10s; not starting a second instance."
      say "  Stop it, then start the new one: $new_bin ${display_args:-}"
      continue
    fi

    if [ "$_is_daemon" = "1" ]; then
      # Canonical relaunch: fixed binary + the daemon's own state directory,
      # matching write_systemd_unit's ExecStart exactly, run from $HOME —
      # never the installer's own (possibly scratch/temp) cwd, and never any
      # argv carried over from the process just stopped. The state directory
      # ($HOME/.goodvibes/daemon) is what --daemon-home names; $HOME stays the
      # working directory, which is what the unit gets from systemd by default.
      (
        cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true
        exec nohup "$new_bin" >/dev/null 2>&1
      ) &
      newpid=$!
    else
      # shellcheck disable=SC2086  # args is intentionally word-split
      nohup "$new_bin" ${args:-} >/dev/null 2>&1 &
      newpid=$!
    fi
    sleep 1
    if kill -0 "$newpid" 2>/dev/null; then
      say "  restarted  pid $newpid${display_args:+ (args: $display_args)}"
    else
      say "  NOTE: the new process did not stay up; start it yourself and check its output:"
      say "    $new_bin ${display_args:-}"
    fi
  done
}

# Restart a loaded launchd agent in place (`kickstart -k`), so a binary swap
# takes effect WITHOUT SIGTERM + nohup demoting a launchd-supervised process
# to an unsupervised one that then fights the KeepAlive respawn for the port.
# Returns 0 when it handled a loaded agent, 1 when the label is not loaded
# (caller falls through to the guarded bare-process path).
restart_launchd_agent() {
  _label="$1"
  command -v launchctl >/dev/null 2>&1 || return 1
  # Tri-state the load probe: exit 113 = could-not-find-service (affirmatively
  # not loaded — the caller may use the guarded bare-process path); any other
  # failure means launchd could not be ASKED (gui domain unreachable from this
  # session) — refuse with an honest note and report handled, so the caller
  # never falls through to kill/nohup on a guess.
  _prc=0
  launchctl print "gui/$(id -u)/$_label" >/dev/null 2>&1 || _prc=$?
  if [ "$_prc" -ne 0 ]; then
    [ "$_prc" -eq 113 ] && return 1
    say ""
    say "NOTE: cannot determine the $_label agent state (launchctl print failed, is the GUI session"
    say "  reachable from this session?). No process was touched; restart the agent yourself from a"
    say "  logged-in session:  launchctl kickstart -k gui/$(id -u)/$_label"
    return 0
  fi
  say ""
  say "Restarting the running $_label (launchd user agent) ..."
  if launchctl kickstart -k "gui/$(id -u)/$_label" 2>/dev/null; then
    say "  restarted  $_label"
  else
    say "  NOTE: restart failed; restart it yourself with:"
    say "    launchctl kickstart -k gui/$(id -u)/$_label"
  fi
  return 0
}

restart_running_daemon() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  if [ "$os_tag" = "macos" ]; then
    restart_launchd_agent "$LAUNCHD_DAEMON_LABEL" && return 0
    # The in-app install-service registers the daemon under the PRODUCT label
    # 'goodvibes' (~/Library/LaunchAgents/goodvibes.plist) — a loaded agent
    # there is the same daemon and gets the same in-place restart.
    restart_launchd_agent goodvibes && return 0
    restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
    return 0
  fi
  # The broken-ExecStart replacement branch is provenance-gated at EVERY
  # call site: only a provably platform-managed canonical unit may be
  # replaced; a hand-written (or unreadable/absent-file) one is never
  # disabled, renamed, or rewritten — not even in the corpse state.
  _canon_replace=0
  [ "$(canonical_unit_provenance "$(systemd_daemon_unit_path)")" = "managed" ] && _canon_replace=1
  restart_systemd_unit "$SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" "$_canon_replace" && return 0
  case "$(unit_active_state "$LEGACY_SYSTEMD_DAEMON_UNIT")" in
    active)
      # The daemon is supervised by the LEGACY goodvibes-daemon.service unit.
      # Never fall through to the bare-process kill/nohup path (that would
      # SIGTERM a supervised daemon and relaunch it outside systemd). What
      # happens next depends on the unit's provenance — the printed line must
      # only promise what a later step actually does:
      #   managed      the migration step transfers supervision to the
      #                canonical unit (write/stop/start/verify/retire).
      #   hand-written the migration step never touches it, so restart the
      #                unit HERE (non-destructive `systemctl --user restart`)
      #                so the swapped binary actually starts serving.
      case "$(legacy_unit_provenance)" in
        managed)
          say ""
          say "The daemon is running under the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT unit; the migration step below transfers it to $SYSTEMD_DAEMON_UNIT."
          ;;
        *)
          # Hand-written or unreadable: this tool won't modify the unit, but
          # the upgrade must still take effect — restart it in place. The
          # third argument gates the broken-ExecStart replacement branch OFF:
          # a hand-written unit is never disabled, renamed, or rewritten,
          # corpse state included.
          restart_systemd_unit "$LEGACY_SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" 0 || {
            say ""
            say "NOTE: could not restart $LEGACY_SYSTEMD_DAEMON_UNIT; restart it yourself so the upgraded binary takes effect:"
            say "    systemctl --user restart $LEGACY_SYSTEMD_DAEMON_UNIT"
          }
          ;;
      esac
      return 0
      ;;
    unknown)
      # Cannot ask systemd (no user bus in this session?). Touching processes
      # on a guess replays the demotion incident — refuse, and say how to
      # finish the restart by hand.
      say ""
      say "NOTE: cannot determine the daemon service state (user service manager unreachable from this session)."
      say "  No process was touched. After the upgrade, restart the service yourself from a logged-in session:"
      say "    systemctl --user restart $SYSTEMD_DAEMON_UNIT   (or $LEGACY_SYSTEMD_DAEMON_UNIT if that is the unit in use)"
      return 0
      ;;
  esac
  restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
}

restart_running_agent() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  if [ "$os_tag" = "macos" ]; then
    restart_launchd_agent sh.goodvibes.agent && return 0
    restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
    return 0
  fi
  # The installer never writes a goodvibes-agent.service unit, so any agent
  # unit on disk is product- or hand-written: the replacement branch is
  # always gated off here.
  restart_systemd_unit goodvibes-agent.service "$INSTALL_DIR/goodvibes-agent" 0 && return 0
  restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
}

# --- daemon liveness detection (shared by first-run setup and uninstall) ---
# A systemd user unit reported active, OR a bare goodvibes-daemon process.

daemon_systemd_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$SYSTEMD_DAEMON_UNIT" 2>/dev/null
}

daemon_bare_process_running() {
  # Scoped to THIS install. Answering "yes" for a daemon belonging to another
  # checkout made first-run setup decide a daemon was already running and skip
  # registering the service — so a fresh install silently ended up with no
  # daemon of its own on any machine that already ran one.
  [ -n "$(pids_owned_by_install '[g]oodvibes-daemon')" ]
}

daemon_running() {
  daemon_systemd_active && return 0
  daemon_bare_process_running
}

# --- first-run daemon service setup ---
# A brand-new install gets binaries but nothing running. When no daemon is
# running AND no service unit exists yet, register the daemon as a user service
# so it comes up now and on every login. Never overwrites an existing unit
# (installer-managed or hand-written) — the upgrade-restart path owns an
# already-running service. Every outcome is stated plainly; success is never
# faked.

write_systemd_unit() {
  # write_systemd_unit <path> [systemd-major-version] — writes the
  # installer-managed unit text only, no activation. Split out so tests can
  # validate the generated text without touching the host's systemd; the
  # optional version argument lets tests pin the systemd feature level instead
  # of inheriting whatever the host runs.
  #
  # Restart posture: StartLimitIntervalSec=0 disables the start-rate limiter,
  # so a crashing daemon keeps retrying (spaced by the delays below) instead
  # of landing in the permanent "start-limit-hit" failed state that only a
  # manual reset-failed clears. On systemd >= 254 the retry delay escalates
  # from RestartSec up to RestartMaxDelaySec across RestartSteps attempts; on
  # older systemd those two directives are omitted (they would be ignored with
  # a warning) and the flat RestartSec applies to every retry.
  _unit_path="$1"
  _sysd_version="${2:-$(detect_systemd_major_version)}"
  _restart_escalation=""
  if systemd_supports_restart_steps "$_sysd_version"; then
    _restart_escalation="
RestartSteps=8
RestartMaxDelaySec=300"
  fi
  mkdir -p "$(dirname "$_unit_path")"
  cat > "$_unit_path" <<EOF
# $INSTALLER_MARKER
# The uninstall path (GOODVIBES_UNINSTALL=1) keys on the marker line above to
# know this unit is installer-managed and safe to remove. Delete that line and
# the installer treats this unit as hand-written and never touches it.
[Unit]
Description=GoodVibes daemon (shared session broker + companion host)
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart="$INSTALL_DIR/goodvibes-daemon"
Restart=on-failure
RestartSec=2$_restart_escalation

[Install]
WantedBy=default.target
EOF
}

plist_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_launchd_plist() {
  # write_launchd_plist <path> [label] [working-directory] — writes the installer-managed
  # LaunchAgent text only, no activation. The GoodVibesManagedBy key and the
  # XML comment both carry the marker string the uninstall path greps for.
  # The label defaults to the installer's own; regenerating the product's
  # goodvibes.plist passes 'goodvibes' so label/path correspondence survives.
  # Migration passes an existing chosen workspace; a new service uses HOME.
  _plist_path="$1"
  _plist_label="${2:-$LAUNCHD_DAEMON_LABEL}"
  _plist_label_xml=$(plist_xml_escape "$_plist_label")
  _plist_program_xml=$(plist_xml_escape "$INSTALL_DIR/goodvibes-daemon")
  # Match the systemd user-service default: startup has a writable workspace
  # even when launchd would otherwise inherit the root directory.
  _plist_working_directory_xml=$(plist_xml_escape "${3-$HOME}")
  _plist_marker_xml=$(plist_xml_escape "$INSTALLER_MARKER")
  mkdir -p "$(dirname "$_plist_path")"
  cat > "$_plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- $INSTALLER_MARKER -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$_plist_label_xml</string>
  <key>GoodVibesManagedBy</key>
  <string>$_plist_marker_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$_plist_program_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$_plist_working_directory_xml</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
EOF
}

setup_daemon_service_systemd() {
  unit_path=$(systemd_daemon_unit_path)
  if [ -f "$unit_path" ]; then
    say "A ${SYSTEMD_DAEMON_UNIT} unit already exists at $unit_path; leaving it as is."
    say "  Start it yourself if it is not running:"
    say "    systemctl --user start $SYSTEMD_DAEMON_UNIT"
    return 0
  fi

  say "Setting up the goodvibes daemon as a systemd user service ..."
  write_systemd_unit "$unit_path"
  say "  wrote      $unit_path"

  if ! systemctl --user daemon-reload 2>/dev/null; then
    say "  NOTE: 'systemctl --user daemon-reload' failed; a user systemd instance"
    say "  may not be running for this session. Enable it yourself later with:"
    say "    systemctl --user enable --now $SYSTEMD_DAEMON_UNIT"
    return 0
  fi

  if systemctl --user enable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
    # Lingering decides whether "enabled" means boot or merely login, so the
    # closing line below states whichever one was actually verified.
    if ensure_linger; then
      _daemon_starts="at boot"
    else
      _daemon_starts="on login"
    fi
    if systemctl --user is-active --quiet "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      say "  started    $SYSTEMD_DAEMON_UNIT (active)"
      say "  The daemon starts $_daemon_starts and restarts on failure."
    else
      say "  NOTE: enabled $SYSTEMD_DAEMON_UNIT but it is not active yet. Inspect it with:"
      say "    systemctl --user status $SYSTEMD_DAEMON_UNIT"
    fi
  else
    say "  NOTE: 'systemctl --user enable --now $SYSTEMD_DAEMON_UNIT' failed. Enable it yourself with:"
    say "    systemctl --user enable --now $SYSTEMD_DAEMON_UNIT"
  fi
}

setup_daemon_service_launchd() {
  plist_path=$(launchd_daemon_plist_path)
  if [ -f "$plist_path" ]; then
    say "A LaunchAgent already exists at $plist_path; leaving it as is."
    say "  Load it yourself if it is not running:"
    say "    launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi

  say "Setting up the goodvibes daemon as a launchd user agent ..."
  write_launchd_plist "$plist_path"
  say "  wrote      $plist_path"

  uid=$(id -u)
  # Prefer the modern bootstrap; fall back to legacy load on older macOS.
  if launchctl bootstrap "gui/$uid" "$plist_path" 2>/dev/null ||
     launchctl load "$plist_path" 2>/dev/null; then
    if launchctl print "gui/$uid/$LAUNCHD_DAEMON_LABEL" >/dev/null 2>&1 ||
       launchctl list "$LAUNCHD_DAEMON_LABEL" >/dev/null 2>&1; then
      say "  started    $LAUNCHD_DAEMON_LABEL (loaded)"
      say "  The daemon starts on login and restarts on failure."
    else
      say "  NOTE: loaded the agent but could not confirm it is running. Inspect it with:"
      say "    launchctl print gui/$uid/$LAUNCHD_DAEMON_LABEL"
    fi
  else
    say "  NOTE: could not load the LaunchAgent automatically. Load it yourself with:"
    say "    launchctl bootstrap gui/$uid $plist_path"
  fi
}

setup_daemon_service() {
  if [ "$DAEMON_SERVICE" != "1" ]; then
    say ""
    say "Daemon service setup skipped (GOODVIBES_DAEMON_SERVICE=0). Run it yourself with:"
    say "  $INSTALL_DIR/goodvibes-daemon"
    return 0
  fi

  # New-user only: if a daemon is already running, the upgrade-restart path
  # (restart_running_daemon) already handled it — do not also set up a service.
  daemon_running && return 0

  say ""
  case "$os_tag" in
    linux)
      if command -v systemctl >/dev/null 2>&1; then
        setup_daemon_service_systemd
        return 0
      fi
      ;;
    macos)
      if command -v launchctl >/dev/null 2>&1; then
        setup_daemon_service_launchd
        return 0
      fi
      ;;
  esac

  # No supported user service manager available (or the tool is missing).
  say "No user service manager (systemd/launchd) is available to run the daemon"
  say "automatically. Start it yourself with:"
  say "  $INSTALL_DIR/goodvibes-daemon"
}

# --- upgrade path: retire the legacy `goodvibes-daemon.service` unit name ---
# The prior installer created the daemon unit as `goodvibes-daemon.service`
# with a bare `ExecStart=<bin>` (no args). This installer now unifies on
# `goodvibes.service` (the same name the in-app install-service manages).
# The migration handles every upgrade state honestly:
#   - legacy ACTIVE and canonical not: supervised transfer — write the
#     canonical unit, stop legacy, start canonical, VERIFY it is active, and
#     only then retire the legacy unit. A canonical unit that fails to come up
#     rolls back (legacy restarted, nothing removed).
#   - canonical VERIFIED ACTIVE: the legacy unit is redundant — disable+remove
#     it (checking every exit status; the unit file is only removed after a
#     SUCCESSFUL disable, so a busless run never leaves a dangling enablement
#     symlink behind a false "disabled + removed" receipt).
#   - neither active: retire the inactive legacy unit only when a canonical
#     unit file exists, and state the canonical unit's real (inactive) state.
# Marker-gated throughout: a hand-written goodvibes-daemon.service is never
# touched, and an UNREADABLE unit file is reported as unreadable, never
# misdiagnosed as hand-written. GOODVIBES_RESTART_DAEMON=0 documents "leave
# running daemon untouched" — with it set, an ACTIVE legacy unit is never
# stopped (a notice explains how to migrate later).
migrate_legacy_installer_unit() {
  case "$os_tag" in
    linux) migrate_legacy_systemd_unit ;;
    macos) migrate_legacy_launchd_plist ;;
  esac
}

migrate_legacy_systemd_unit() {
  legacy_path=$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")
  [ -f "$legacy_path" ] || return 0

  case "$(legacy_unit_provenance)" in
    unreadable)
      say ""
      say "NOTE: a $LEGACY_SYSTEMD_DAEMON_UNIT unit exists at $legacy_path but could not be read"
      say "  (permissions?). Leaving it untouched. Inspect it yourself; if it is redundant:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      return 0
      ;;
    hand-written)
      # Hand-written legacy unit: never touched, only reported.
      say ""
      say "A hand-written $LEGACY_SYSTEMD_DAEMON_UNIT (no installer marker) exists at $legacy_path."
      say "  This installer now manages $SYSTEMD_DAEMON_UNIT instead; your unit is left in place."
      say "  If it is redundant, retire it yourself:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      return 0
      ;;
  esac

  if ! command -v systemctl >/dev/null 2>&1; then
    say ""
    say "NOTE: found the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT at $legacy_path but systemctl is not"
    say "  available; nothing was changed. Retire it yourself once systemd is reachable:"
    say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
    return 0
  fi

  legacy_state=$(unit_active_state "$LEGACY_SYSTEMD_DAEMON_UNIT")
  canonical_state=$(unit_active_state "$SYSTEMD_DAEMON_UNIT")
  canonical_path=$(systemd_daemon_unit_path)

  # FAIL-SAFE ON UNKNOWN: if either unit's state cannot be read (no user bus
  # in this session, timeout), every branch below would be acting on a guess —
  # a stop/disable could take down the only running daemon. Refuse.
  if [ "$legacy_state" = "unknown" ] || [ "$canonical_state" = "unknown" ]; then
    say ""
    say "NOTE: cannot determine the daemon units' state (user service manager unreachable from this"
    say "  session?). Nothing was changed. Re-run the installer from a logged-in session, or migrate"
    say "  deliberately with: goodvibes-daemon migrate-service"
    return 0
  fi

  # GOODVIBES_RESTART_DAEMON=0 means "leave running daemon/agent untouched" —
  # that contract covers the migration's stop/disable of an ACTIVE unit too.
  if [ "$legacy_state" = "active" ] && [ "$RESTART_DAEMON" != "1" ]; then
    say ""
    say "NOTE: $LEGACY_SYSTEMD_DAEMON_UNIT is running and GOODVIBES_RESTART_DAEMON=0; leaving it untouched."
    say "  Re-run the installer without GOODVIBES_RESTART_DAEMON=0 to migrate it to $SYSTEMD_DAEMON_UNIT."
    return 0
  fi

  if [ "$canonical_state" = "active" ] && unit_serving "$SYSTEMD_DAEMON_UNIT"; then
    if [ "$legacy_state" = "active" ]; then
      # BOTH units are running their own daemon (a port fight, or the legacy
      # daemon serving a configured endpoint the canonical one does not).
      # Stopping either automatically could take down the endpoint clients
      # actually use — refuse, and point at the consented migration.
      say ""
      say "NOTE: both $SYSTEMD_DAEMON_UNIT and $LEGACY_SYSTEMD_DAEMON_UNIT are currently running."
      say "  Stopping either one automatically could take down the endpoint your clients use, so"
      say "  nothing was changed. Migrate deliberately with: goodvibes-daemon migrate-service"
      return 0
    fi
    # The canonical unit is serving (active with a live main process) and the
    # legacy unit is NOT running: the legacy unit is redundant.
    say ""
    say "Retiring the redundant installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT ($SYSTEMD_DAEMON_UNIT is serving) ..."
    if systemctl --user disable --now "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      rm -f "$legacy_path"
      systemctl --user daemon-reload 2>/dev/null || true
      say "  disabled + removed $legacy_path"
      say "  the canonical $SYSTEMD_DAEMON_UNIT keeps running (verified: active with a live main process)."
    else
      say "  NOTE: could not disable $LEGACY_SYSTEMD_DAEMON_UNIT (is the user service manager reachable?)."
      say "  Its unit file was left in place; this tool removed nothing. Retire it yourself:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
    fi
    return 0
  fi

  if [ "$legacy_state" = "active" ]; then
    # Dominant upgrade state: the legacy unit is the ONLY serving unit.
    # Supervised transfer: canonical unit written first, then stop-legacy /
    # start-canonical / VERIFY (settled: active with the SAME live main
    # process across two probes — a Type=simple unit reports 'active' from
    # fork onward, so a single instant is-active proves nothing), and only
    # then retire the legacy unit.
    say ""
    say "Transferring daemon supervision from $LEGACY_SYSTEMD_DAEMON_UNIT to $SYSTEMD_DAEMON_UNIT ..."
    # A pre-existing canonical unit with stale launch arguments — pinned
    # endpoint flags, or a wrong/absent --daemon-home — would make the
    # transfer start a daemon on the WRONG endpoint or against the WRONG
    # state directory, and retire the legacy unit that was serving the
    # configured one — behind a receipt that only verifies liveness.
    # Platform-managed stale units are re-derived first; a hand-written
    # stale unit refuses the transfer honestly.
    transfer_stale_reason=''
    [ -f "$canonical_path" ] && transfer_stale_reason=$(unit_launch_stale_reason "$canonical_path")
    if [ -n "$transfer_stale_reason" ]; then
      case "$(canonical_unit_provenance "$canonical_path")" in
        managed)
          backup_unit_file "$canonical_path"
          write_systemd_unit "$canonical_path"
          say "  rewrote    $canonical_path (it $transfer_stale_reason)"
          ;;
        *)
          say "  NOTE: the existing $SYSTEMD_DAEMON_UNIT $transfer_stale_reason and is not"
          say "  recognizably platform-managed; transferring supervision onto it could run the daemon wrong."
          say "  The units were not changed; fix the launch arguments yourself (the daemon's own state directory"
          say "  is --daemon-home $HOME/.goodvibes/daemon), or migrate deliberately with:"
          say "    goodvibes-daemon migrate-service"
          # The restart path deferred the in-place restart to this transfer
          # ('the migration step below transfers it') — the promise must not
          # die with the refusal: restart the legacy unit here so the swapped
          # binary actually starts serving.
          if systemctl --user restart "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
            say "  restarted  $LEGACY_SYSTEMD_DAEMON_UNIT; the daemon keeps running there, now on the upgraded binary."
          else
            say "  NOTE: could not restart $LEGACY_SYSTEMD_DAEMON_UNIT; the running daemon is still the previous"
            say "  binary; restart it yourself:  systemctl --user restart $LEGACY_SYSTEMD_DAEMON_UNIT"
          fi
          return 0
          ;;
      esac
    fi
    wrote_canonical=0
    if [ ! -f "$canonical_path" ]; then
      write_systemd_unit "$canonical_path"
      wrote_canonical=1
      say "  wrote      $canonical_path"
    fi
    # Record the canonical unit's PRE-RUN enablement so a rollback can restore
    # it exactly — never blanket-disable a unit the user had enabled before.
    canonical_pre_enabled=$(unit_enabled_state "$SYSTEMD_DAEMON_UNIT")
    systemctl --user daemon-reload 2>/dev/null || true
    if ! systemctl --user stop "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      say "  NOTE: could not stop $LEGACY_SYSTEMD_DAEMON_UNIT: nothing was changed; the daemon keeps"
      say "  running under the legacy unit. Migrate later with: goodvibes-daemon migrate-service"
      [ "$wrote_canonical" = "1" ] && rm -f "$canonical_path"
      return 0
    fi

    transfer_verified=0
    if systemctl --user enable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      sleep "$VERIFY_SETTLE_SECS"
      _pid1=$(systemd_unit_main_pid "$SYSTEMD_DAEMON_UNIT")
      if [ "$(unit_active_state "$SYSTEMD_DAEMON_UNIT")" = "active" ] &&
         [ -n "$_pid1" ] && kill -0 "$_pid1" 2>/dev/null; then
        sleep "$VERIFY_SETTLE_SECS"
        sleep "$VERIFY_SETTLE_SECS"
        _pid2=$(systemd_unit_main_pid "$SYSTEMD_DAEMON_UNIT")
        if [ "$(unit_active_state "$SYSTEMD_DAEMON_UNIT")" = "active" ] &&
           [ "$_pid2" = "$_pid1" ] && kill -0 "$_pid2" 2>/dev/null; then
          transfer_verified=1
        fi
      fi
    fi

    if [ "$transfer_verified" = "1" ]; then
      say "  started    $SYSTEMD_DAEMON_UNIT (verified: active with a stable live main process)"
      if systemctl --user disable "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
        rm -f "$legacy_path"
        say "  retired    $LEGACY_SYSTEMD_DAEMON_UNIT (disabled, unit file removed)"
      else
        say "  NOTE: $SYSTEMD_DAEMON_UNIT is active, but $LEGACY_SYSTEMD_DAEMON_UNIT could not be disabled;"
        say "  its unit file was left in place. Retire it yourself:"
        say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      fi
      systemctl --user daemon-reload 2>/dev/null || true
    else
      # Rollback: the canonical unit did not come up healthy. Restore the
      # PRE-RUN state: remove only what this run wrote, restore the canonical
      # unit's prior enablement, and restart the legacy unit. Never leave the
      # host with no supervised daemon, and never leave the canonical unit
      # disabled when it was enabled before this run.
      say "  NOTE: $SYSTEMD_DAEMON_UNIT did not come up healthy; rolling back."
      if [ "$wrote_canonical" = "1" ]; then
        systemctl --user disable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        rm -f "$canonical_path"
        say "  removed    $canonical_path (written by this run)"
      else
        systemctl --user stop "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        if [ "$canonical_pre_enabled" = "no" ]; then
          # This run's enable created the enablement — undo it.
          systemctl --user disable "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        fi
        # Pre-enabled (or unknown): the enablement is the user's — left as found.
      fi
      systemctl --user daemon-reload 2>/dev/null || true
      if systemctl --user start "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
        say "  restarted  $LEGACY_SYSTEMD_DAEMON_UNIT; the daemon keeps running under the legacy unit."
      else
        say "  NOTE: the legacy unit could not be restarted either; start it yourself:"
        say "    systemctl --user start $LEGACY_SYSTEMD_DAEMON_UNIT"
      fi
    fi
    return 0
  fi

  # Neither unit is running a daemon. Retire the inactive legacy unit only
  # when a canonical unit file exists — never remove the only daemon unit.
  if [ ! -f "$canonical_path" ]; then
    say ""
    say "Found the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT (inactive) but no $SYSTEMD_DAEMON_UNIT unit;"
    say "  leaving it alone so the host is never left without a daemon unit."
    return 0
  fi
  say ""
  say "Retiring the inactive installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT (superseded by $SYSTEMD_DAEMON_UNIT) ..."
  if systemctl --user disable --now "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
    rm -f "$legacy_path"
    systemctl --user daemon-reload 2>/dev/null || true
    say "  disabled + removed $legacy_path"
    if [ "$canonical_state" = "active" ]; then
      # 'active' but not serving (no confirmed live main process): say so
      # rather than claiming health.
      say "  NOTE: $SYSTEMD_DAEMON_UNIT reports active but its main process could not be confirmed;"
      say "  check it with: systemctl --user status $SYSTEMD_DAEMON_UNIT"
    else
      say "  NOTE: $SYSTEMD_DAEMON_UNIT is present but not active; start it with:"
      say "    systemctl --user start $SYSTEMD_DAEMON_UNIT"
    fi
  else
    say "  NOTE: could not disable $LEGACY_SYSTEMD_DAEMON_UNIT (is the user service manager reachable?)."
    say "  Its unit file was left in place; this tool removed nothing. Retire it yourself:"
    say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
  fi
}

# macOS analog: the launchd label never changed, but the OLD installer's plist
# carried a bare ProgramArguments (binary only). The marker proves the plist is
# installer-owned and safe to regenerate, so an upgrade rewrites it to the
# current launch form. A hand-written plist (no marker) is never touched.
# Run-state discipline mirrors the systemd side exactly:
#   - a LOADED agent is reloaded (bootout + bootstrap), gated on
#     GOODVIBES_RESTART_DAEMON — with it off, the file is updated and the
#     running agent honestly keeps the old arguments until reloaded;
#   - an agent the user has booted out (NOT loaded) is never started by a
#     migration: the file is updated, the agent stays stopped, and the load
#     command is printed. Rewriting a file must never override a user's stop.
# The PRODUCT's in-app LaunchAgent identity: the platform writes
# ~/Library/LaunchAgents/<serviceName>.plist with serviceName 'goodvibes' —
# a different path AND label from the installer's sh.goodvibes.daemon. Both
# are platform-owned upgrade targets.
launchd_product_plist_path() { printf '%s' "$HOME/Library/LaunchAgents/goodvibes.plist"; }

migrate_legacy_launchd_plist() {
  migrate_one_launchd_plist "$(launchd_daemon_plist_path)" "$LAUNCHD_DAEMON_LABEL"
  migrate_one_launchd_plist "$(launchd_product_plist_path)" goodvibes
}

migrate_one_launchd_plist() {
  plist_path="$1"
  plist_label="$2"
  [ -f "$plist_path" ] || return 0
  # Already the current launch form — nothing to migrate. Current means the
  # CANONICAL --daemon-home value, no pinned endpoint flags, and an explicit
  # working directory. Without it launchd inherits '/', while daemon startup
  # opens project resources beneath its cwd. Preserve an existing chosen cwd.
  # The middle generation carried --daemon-home PLUS --hostname/--port, and keying the
  # gate on --daemon-home's mere presence declared those pinned plists — and
  # any plist pointing the daemon's identity at the wrong directory —
  # current forever.
  if unit_daemon_home_is_canonical "$plist_path" &&
     ! unit_is_endpoint_pinned "$plist_path" &&
     grep -q '<key>WorkingDirectory</key>' "$plist_path" 2>/dev/null; then
    return 0
  fi

  # Provenance: the installer marker is proof of platform ownership. Without
  # it, ProgramArguments[0] naming the goodvibes-managed binary inside
  # $INSTALL_DIR is strong structural evidence of a product-installed plist —
  # the platform's plist writer emits no marker and structurally CANNOT carry the
  # product Description fingerprint (renderLaunchdPlist drops the definition
  # description; an platform-owned gap, reported upstream). Anything else is
  # indeterminable: an honest notice when pinned, never silence.
  plist_managed=0
  if grep -q "$INSTALLER_MARKER" "$plist_path" 2>/dev/null; then
    plist_managed=1
  elif grep -qF "<string>$(plist_xml_escape "$INSTALL_DIR/goodvibes-daemon")</string>" "$plist_path" 2>/dev/null ||
       grep -qF "<string>$INSTALL_DIR/goodvibes-daemon</string>" "$plist_path" 2>/dev/null; then
    plist_managed=1
  fi

  if [ "$plist_managed" != "1" ]; then
    _plr=$(unit_launch_stale_reason "$plist_path")
    if [ -n "$_plr" ]; then
      say ""
      say "NOTE: the LaunchAgent at $plist_path $_plr,"
      say "  and it is not recognizably platform-managed, so it was left untouched."
      say "  Fix the launch arguments yourself so the daemon follows your settings and runs with its own"
      say "  state directory: --daemon-home $HOME/.goodvibes/daemon"
    fi
    return 0
  fi

  # A migration of old launch flags must retain the existing project context.
  # Native plutil decodes XML entities and verifies the value is a string;
  # older plutil versions without raw extraction leave the file untouched.
  # -n suppresses plutil's added newline, while the sentinel keeps shell
  # command substitution from discarding newlines belonging to the value.
  _migration_working_directory="$HOME"
  if grep -q 'WorkingDirectory' "$plist_path" 2>/dev/null; then
    if _migration_directory_result=$(plutil -extract WorkingDirectory raw -expect string -n -o - -- "$plist_path" 2>/dev/null && printf '.'); then
      _migration_working_directory=${_migration_directory_result%.}
    else
      say "  NOTE: the LaunchAgent working directory could not be decoded safely; leaving the file untouched."
      return 0
    fi
    # The shell/XML writer does not support control characters in paths.
    # Refuse them before backup, rewrite, or service-manager operations.
    if [ -z "$_migration_working_directory" ] ||
       [ "$(printf '%s' "$_migration_working_directory" | LC_ALL=C tr -d '[:cntrl:]'; printf '.')" != "$_migration_working_directory." ]; then
      say "  NOTE: the LaunchAgent working directory is empty or contains unsupported characters; leaving the file untouched."
      return 0
    fi
  fi

  # Record the agent's CURRENT load state BEFORE touching anything.
  agent_loaded=0
  if command -v launchctl >/dev/null 2>&1 &&
     launchctl print "gui/$(id -u)/$plist_label" >/dev/null 2>&1; then
    agent_loaded=1
  fi

  say ""
  say "Upgrading the platform-managed LaunchAgent ($plist_label) to the current launch form ..."
  backup_unit_file "$plist_path"
  write_launchd_plist "$plist_path" "$plist_label" "$_migration_working_directory"
  say "  rewrote    $plist_path"

  if [ "$agent_loaded" != "1" ]; then
    say "  NOTE: the agent is not currently loaded; leaving it stopped (matching its current state)."
    say "  Load it yourself when ready:"
    say "    launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  if [ "$RESTART_DAEMON" != "1" ]; then
    say "  NOTE: GOODVIBES_RESTART_DAEMON=0; the running agent keeps its old arguments until you reload it:"
    say "    launchctl bootout gui/$(id -u)/$plist_label ; launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  uid=$(id -u)
  launchctl bootout "gui/$uid/$plist_label" 2>/dev/null ||
    launchctl unload "$plist_path" 2>/dev/null || true
  if launchctl bootstrap "gui/$uid" "$plist_path" 2>/dev/null ||
     launchctl load "$plist_path" 2>/dev/null; then
    say "  reloaded   $plist_label with the new launch arguments"
  else
    say "  NOTE: could not reload the LaunchAgent; load it yourself:"
    say "    launchctl bootstrap gui/$uid $plist_path"
  fi
}

# --- the daemon: compiled binary from the same monorepo release ---
# All products use the one release and staged assets from prepare_release.
# This runs before the addon and optional wake-model provision. Each program
# file is renamed atomically while the installer retains the suite claims.
install_daemon() {
  say ""
  DAEMON_VERSION=$VERSION
  say "Installing goodvibes-daemon $DAEMON_VERSION ..."

  install_release_binary goodvibes-daemon
  say "  installed  $INSTALL_DIR/goodvibes-daemon"

  if daemon_version_out=$("$INSTALL_DIR/goodvibes-daemon" --version 2>/dev/null); then
    say "  running:   $daemon_version_out"
  else
    fail "the installed goodvibes-daemon binary failed to run ('goodvibes-daemon --version')"
  fi
}

# --- sqlite-vec native addon: restores semantic vector search ---
# The platform resolves the addon at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>
# next to the running binary, so one copy in $INSTALL_DIR/lib serves goodvibes,
# goodvibes-daemon, and goodvibes-agent (they share $INSTALL_DIR). It is verified
# against the suite's SHA256SUMS.txt, alongside the daemon binary it
# is built and released with — a missing manifest entry is a hard failure, never
# a skip. Placed with an atomic rename so a running process never dlopen()s a
# half-written file.
install_sqlite_vec() {
  addon_asset="sqlite-vec-${VEC_OS}-${arch_tag}.${VEC_SUFFIX}"

  # Selected addons were required and verified before any program changed.
  addon_dir="$INSTALL_DIR/lib/sqlite-vec-${VEC_OS}-${arch_tag}"
  addon_target="$addon_dir/vec0.${VEC_SUFFIX}"

  install_release_library_file "$addon_asset" "sqlite-vec-${VEC_OS}-${arch_tag}" "vec0.${VEC_SUFFIX}"
  say "  installed  $addon_target"
}

# --- wake-word model: makes "hey goodvibes" work on a fresh machine ---
#
# Everything needed to detect the phrase already shipped inside the binary, and
# the model itself was reachable only by typing `/voice wake setup` — so the
# ordinary outcome of installing goodvibes was a wake word that could not start,
# waiting on a download nobody had been told about.
#
# This runs the daemon binary that was just installed and verified, rather than
# fetching the artifacts here, for one reason: the pinned URLs, byte counts and
# checksums live in the platform's wake-word manifest, and a second copy of a pin in
# shell would drift silently the first time the model is retrained. The binary
# reaches the one manifest. (This is also why there is no SHA256SUMS entry to
# look up: these artifacts are hosted on the platform's own append-only release tag,
# not this repository's release.)
#
# NEVER FATAL. A wake-word model is not a reason to fail installing a coding
# tool, and an installer that aborts half-way is worse than one that finishes
# without a wake word. The subcommand exits 0 whatever happens and prints one
# plain line; if it is missing entirely (an older binary than this installer) the
# `|| true` covers that too. A running daemon retries at every boot, and
# `/voice wake setup` fetches it on demand.
#
# GOODVIBES_WAKE_MODEL=0 skips it, for an air-gapped host or a user who does not
# want the feature.
install_wake_word_model() {
  [ "$WITH_WAKE_MODEL" = "1" ] || {
    say ""
    say "  note: skipping the wake-word model (GOODVIBES_WAKE_MODEL=0). Wake-word"
    say "  detection will report not-provisioned until you run: goodvibes /voice wake setup"
    return 0
  }

  say ""
  say "Installing the wake-word model ..."
  wake_output=$("$INSTALL_DIR/goodvibes-daemon" provision-wake-model 2>&1) || true
  if [ -n "$wake_output" ]; then
    printf '%s\n' "$wake_output" | while IFS= read -r wake_line; do
      say "  $wake_line"
    done
  else
    say "  note: this build has no provision-wake-model command; wake-word detection"
    say "  will fetch its model at the next daemon start, or run: goodvibes /voice wake setup"
  fi
}

# --- goodvibes-agent: compiled binary from the same monorepo release ---
install_agent() {
  say ""
  AGENT_VERSION=$VERSION
  say "Installing goodvibes-agent $AGENT_VERSION ..."

  install_release_binary goodvibes-agent
  say "  installed  $INSTALL_DIR/goodvibes-agent"

  if agent_version_out=$("$INSTALL_DIR/goodvibes-agent" --version 2>/dev/null); then
    say "  running:   $agent_version_out"
  else
    fail "the installed goodvibes-agent binary failed to run ('goodvibes-agent --version')"
  fi

}

# --- browser driver: makes goodvibes-agent able to drive a browser at all ---
# The agent is a compiled binary and carries no node_modules, so
# require('playwright-core') resolves nothing inside it and the driver cannot be
# bundled either (it reads browsers.json and its own files by path at runtime).
# It therefore ships as its own release asset and is extracted beside the binary,
# at $INSTALL_DIR/playwright-core — the first location the agent's driver search
# looks. Release 1.18.1 shipped no such asset and every installed binary reported
# browser control as unavailable, which is what this exists to prevent.
#
# One archive serves every platform (the driver is plain JavaScript; the browser
# binaries it drives are downloaded separately into the agent's managed cache).
# The suite verification pass requires the asset and its checksum, extracts it
# privately and checks the entrypoints before any installed program is changed.
# Publish an already checksum-verified directory without deleting any installed
# tree. The native suite updater uses this same per-directory claim pathname.
# Descriptor checks bind each rename/compensation to its original physical root;
# a changed or ambiguous source is retained with its claim for inspection.
publish_release_directory() (
  _directory_source=$1
  _directory_target=$2
  _directory_parent=${_directory_target%/*}
  umask 077
  assert_install_claims
  case "$_directory_parent" in
    "$INSTALL_DIR") : ;;
    "$INSTALL_DIR/webui")
      [ ! -L "$_directory_parent" ] || fail 'The WebUI directory is an alias; its existing deployment was preserved.'
      if [ ! -e "$_directory_parent" ]; then
        assert_install_claims
        # The scoped umask makes this new original level mode700.
        mkdir "$_directory_parent" || fail 'Could not exclusively create the WebUI directory.'
      fi ;;
    *) fail 'Released directories must belong to this original suite installation.' ;;
  esac
  [ -d "$_directory_parent" ] && [ ! -L "$_directory_parent" ] || fail 'The original directory publication parent is unavailable.'
  exec 0< "$_directory_parent"
  installer_open_file_matches 0 "$_directory_parent" || fail 'Could not retain the original directory publication parent.'
  [ -d "$_directory_source" ] && [ ! -L "$_directory_source" ] || fail 'Verified directory staging is unavailable.'
  exec 7< "$_directory_source"
  installer_open_file_matches 7 "$_directory_source" || fail 'Verified directory staging changed.'
  [ ! -e "$_directory_target.incoming" ] && [ ! -L "$_directory_target.incoming" ] || fail 'An existing incoming directory requires inspection; it was preserved.'
  _directory_had_old=0
  if [ -e "$_directory_target" ] || [ -L "$_directory_target" ]; then
    [ -d "$_directory_target" ] && [ ! -L "$_directory_target" ] || fail 'The existing directory target is a custom file or alias; it was preserved.'
    exec 6< "$_directory_target"
    installer_open_file_matches 6 "$_directory_target" || fail 'Could not retain the original installed directory.'
    _directory_had_old=1
  fi
  _directory_work=$(mktemp -d "$_directory_parent/.goodvibes-directory-install.XXXXXX") || fail 'Could not reserve private directory staging.'
  exec 5< "$_directory_work"
  _directory_incoming="$_directory_work/incoming"
  _directory_outgoing="$_directory_work/outgoing"
  _directory_claim="$_directory_target.directory-update.lock"
  _directory_claim_owned=0
  _directory_incoming_owned=0
  _directory_done=0

  _directory_base_current() {
    (assert_install_claims) || return 1
    [ ! -L "$_directory_parent" ] && installer_open_file_matches 0 "$_directory_parent" || return 1
    [ ! -L "$_directory_work" ] && installer_open_file_matches 5 "$_directory_work" || return 1
  }
  _directory_claim_current() {
    _directory_base_current || return 1
    [ "$_directory_claim_owned" = 1 ] || return 1
    [ ! -L "$_directory_claim" ] && installer_open_file_matches 3 "$_directory_claim" || return 1
    [ ! -L "$_directory_work/claim" ] && installer_open_file_matches 3 "$_directory_work/claim" || return 1
  }
  _directory_original_current() {
    _directory_claim_current || return 1
    [ ! -L "$_directory_source" ] && installer_open_file_matches 7 "$_directory_source" || return 1
    [ ! -L "$_directory_incoming" ] && installer_open_file_matches 4 "$_directory_incoming" || return 1
    if [ "$_directory_had_old" = 1 ]; then
      [ ! -L "$_directory_target" ] && installer_open_file_matches 6 "$_directory_target" || return 1
    else
      [ ! -e "$_directory_target" ] && [ ! -L "$_directory_target" ] || return 1
    fi
  }
  _directory_release_claim() {
    _directory_claim_current || return 1
    rm -f "$_directory_claim" || return 1
    _directory_base_current || return 1
    [ ! -e "$_directory_claim" ] && [ ! -L "$_directory_claim" ] || return 1
    [ ! -L "$_directory_work/claim" ] && installer_open_file_matches 3 "$_directory_work/claim" || return 1
    rm -f "$_directory_work/claim" || return 1
    _directory_base_current || return 1
    [ ! -e "$_directory_work/claim" ] && [ ! -L "$_directory_work/claim" ] || return 1
    _directory_claim_owned=0
  }
  _directory_compensate() {
    _directory_claim_current || return 1
    # A throwing rename may already have completed. Inspect the exact retained
    # descriptors instead of treating an exit status as proof of rollback.
    if [ "$_directory_incoming_owned" = 1 ] && [ ! -L "$_directory_target" ] && installer_open_file_matches 4 "$_directory_target"; then
      [ ! -e "$_directory_incoming" ] && [ ! -L "$_directory_incoming" ] || return 1
      mv "$_directory_target" "$_directory_incoming" || :
      _directory_claim_current || return 1
      [ ! -L "$_directory_incoming" ] && installer_open_file_matches 4 "$_directory_incoming" || return 1
    fi
    if [ "$_directory_had_old" = 1 ]; then
      if [ ! -e "$_directory_target" ] && [ ! -L "$_directory_target" ]; then
        [ ! -L "$_directory_outgoing" ] && installer_open_file_matches 6 "$_directory_outgoing" || return 1
        mv "$_directory_outgoing" "$_directory_target" || :
      fi
      _directory_claim_current || return 1
      [ ! -L "$_directory_target" ] && installer_open_file_matches 6 "$_directory_target" || return 1
    else
      [ ! -e "$_directory_target" ] && [ ! -L "$_directory_target" ] || return 1
    fi
  }
  _directory_finish() {
    _directory_exit=$?
    trap - EXIT INT TERM
    if [ "$_directory_done" != 1 ]; then
      if [ "$_directory_claim_owned" = 1 ] && _directory_compensate && _directory_release_claim; then
        say "install.sh: the original directory was kept or restored; private staging was retained at $_directory_work." >&2
      else
        say "install.sh: directory publication needs inspection; preserve $_directory_work and $_directory_claim before retrying." >&2
      fi
      [ "$_directory_exit" != 0 ] || _directory_exit=1
    elif ! _directory_release_claim; then
      say "install.sh: the directory is published, but its changed ownership claim requires inspection at $_directory_work and $_directory_claim." >&2
      _directory_exit=1
    else
      # Empty removal cannot delete unknown children. Existing trees and any
      # unexpected siblings remain in their original owned private directory.
      if _directory_base_current && rmdir "$_directory_work" 2>/dev/null; then :
      else say "  retained   $_directory_work (previous directory or additional files)"
      fi
    fi
    exit "$_directory_exit"
  }
  trap _directory_finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  _directory_base_current || fail 'Original directory staging changed.'
  [ ! -e "$_directory_claim" ] && [ ! -L "$_directory_claim" ] || fail 'Another directory update or interrupted publication owns this target.'
  (set -C; printf 'GoodVibes directory installation %s\n' "$VERSION" > "$_directory_claim") || fail 'Could not claim the original directory target.'
  ln "$_directory_claim" "$_directory_work/claim" || fail 'Could not retain the directory claim; inspect it before retrying.'
  exec 3< "$_directory_work/claim"
  _directory_claim_owned=1
  _directory_claim_current || fail 'The directory claim changed before staging.'
  mkdir "$_directory_incoming" || fail 'Could not exclusively create incoming directory staging.'
  exec 4< "$_directory_incoming"
  _directory_incoming_owned=1
  _directory_original_current || fail 'Original directory sources changed before copying.'
  cp -Rp "$_directory_source/." "$_directory_incoming/" || fail 'Could not copy the verified directory into its private publication stage.'
  _directory_original_current || fail 'Original directory sources changed while copying.'
  chmod 755 "$_directory_incoming" || fail 'Could not set incoming directory permissions.'
  _directory_original_current || fail 'Original directory sources changed before publication.'
  if [ "$_directory_had_old" = 1 ]; then
    [ ! -e "$_directory_outgoing" ] && [ ! -L "$_directory_outgoing" ] || fail 'An unknown outgoing directory slot appeared.'
    mv "$_directory_target" "$_directory_outgoing" || fail 'Could not park the original directory.'
    _directory_claim_current || fail 'Original directory ownership changed after parking.'
    [ ! -L "$_directory_outgoing" ] && installer_open_file_matches 6 "$_directory_outgoing" || fail 'The parked original directory changed.'
  fi
  [ ! -e "$_directory_target" ] && [ ! -L "$_directory_target" ] || fail 'A foreign live directory appeared; it was preserved.'
  [ ! -L "$_directory_incoming" ] && installer_open_file_matches 4 "$_directory_incoming" || fail 'The original incoming directory changed.'
  mv "$_directory_incoming" "$_directory_target" || fail 'Could not publish the retained incoming directory.'
  _directory_claim_current || fail 'Original directory ownership changed after publication.'
  [ ! -L "$_directory_target" ] && installer_open_file_matches 4 "$_directory_target" || fail 'The directory rename result is unknown.'
  _directory_done=1
)

install_browser_driver() {
  driver_staging="$WORKDIR/browser-driver-staging"
  assert_install_claims
  # Local release bookkeeping is not an integrity pin or a deletion receipt.
  write_directory_release_marker "$driver_staging/playwright-core"
  driver_target="$INSTALL_DIR/playwright-core"
  publish_release_directory "$driver_staging/playwright-core" "$driver_target"
  say "  installed  $driver_target"
}

# --- the browser operator surface: a bundle the daemon serves ---
#
# The web UI is static files, so it is not a fourth binary and it does not get a
# fourth service unit. The daemon already serves a bundle directory on its own
# listener, same origin as its API — which is exactly what makes the browser's
# same-origin policy a non-issue and means no CORS allowlist has to be widened
# for the app to talk to the daemon it was served by.
#
# When selected, the bundle and checksum are required by the same suite
# verification pass. Its index is checked in private staging before program
# replacement, then the complete bundle is moved into its versioned directory.
#
# Each version unpacks into its OWN directory ($INSTALL_DIR/webui/<version>) and
# the daemon is pointed at it afterwards. Unpacking over the directory a running
# daemon is serving would swap files under it mid-request; this way the running
# daemon keeps serving the old directory until it is restarted onto the new one.
# Older versioned and custom directories remain available to running readers
# and explicit recovery. A version name does not prove ownership or inactivity.
#
# CONFIGURATION IS DONE BY THE DAEMON BINARY, not by writing settings from
# shell: `goodvibes-daemon webui enable --bundle-dir <dir>` owns the key names,
# the settings-tier routing and the "which listener actually serves this"
# question. Same reason `provision-wake-model` exists. It never widens network
# exposure — a daemon bound to loopback keeps serving to this machine only, and
# the receipt says so along with the one command that changes it.
install_webui() {
  [ "$WITH_WEBUI" = "1" ] || {
    say ""
    say "  note: skipping the web UI (GOODVIBES_WEBUI=0). Install it later with the"
    say "  same command, or serve a bundle you built yourself:"
    say "    goodvibes-daemon webui enable --bundle-dir <dir>"
    return 0
  }

  say ""
  WEBUI_VERSION=$VERSION
  webui_plain_version="${WEBUI_VERSION#v}"
  say "Installing the web UI $WEBUI_VERSION ..."
  webui_staging="$WORKDIR/webui-staging"
  assert_install_claims
  write_directory_release_marker "$webui_staging/goodvibes-webui"
  webui_target="$WEBUI_ROOT/$webui_plain_version"
  publish_release_directory "$webui_staging/goodvibes-webui" "$webui_target"
  say "  installed  $webui_target"
}

# Configuration is a real native data write. Run only after all suite files
# are settled and our executable transaction claims have been released; the
# installed writer correctly refuses to publish while those claims exist.
configure_webui() {
  [ "$WITH_WEBUI" = "1" ] || return 0

  # Point the daemon at it. The binary owns the settings; this reads its receipt
  # and prints it, so the install's own output states the URL and the posture.
  # Not fatal: an unconfigured bundle on disk is a working install of everything
  # else plus one command to run, whereas an aborted install is neither.
  webui_output=$("$INSTALL_DIR/goodvibes-daemon" webui enable --bundle-dir "$webui_target" 2>&1) && webui_ok=1 || webui_ok=0
  if [ -n "$webui_output" ]; then
    printf '%s\n' "$webui_output" | while IFS= read -r webui_line; do
      say "  $webui_line"
    done
  fi
  if [ "$webui_ok" != "1" ]; then
    say "  NOTE: the bundle is on disk but the daemon was not configured to serve it. Run:"
    say "    goodvibes-daemon webui enable --bundle-dir $webui_target"
    return 0
  fi

  # The URL the daemon reported, lifted out of its own receipt rather than
  # rebuilt here from config: the command that wrote the settings is the one
  # that knows which listener serves the bundle and on what port, and a second
  # derivation in shell is how a printed URL starts disagreeing with the daemon.
  WEBUI_URL=$(printf '%s\n' "$webui_output" | awk '/^[[:space:]]*https?:\/\//{print $1; exit}')

  WEBUI_INSTALLED=1
}

write_directory_release_marker() {
  _marker_root=$1
  _marker_path="$_marker_root/.goodvibes-release.json"
  [ -d "$_marker_root" ] && [ ! -L "$_marker_root" ] || fail 'Released directory staging is unavailable.'
  [ ! -e "$_marker_path" ] && [ ! -L "$_marker_path" ] || fail 'The release archive collides with local directory bookkeeping.'
  (umask 022; set -C; printf '{"schema":1,"version":"%s"}\n' "${VERSION#v}" > "$_marker_path") || fail 'Could not record the selected directory release.'
  chmod 644 "$_marker_path" || fail 'Could not set directory release metadata permissions.'
}

# Previous/custom WebUI directories are deliberately retained. The directory
# name and release marker do not identify all contents or tell us whether an
# existing daemon still serves them, so installation never prunes them.

# --- PATH shadowing: is the install we just wrote the one the shell runs? ---
#
# Installing a file is not the same as making it reachable. If any directory
# EARLIER on PATH than $INSTALL_DIR also provides `goodvibes`,
# `goodvibes-daemon`, or `goodvibes-agent`, then typing the bare command runs
# that other copy, and this installer — and the auto-updater after it — keeps
# maintaining a file the user never reaches. That is exactly how a leftover
# `~/.bun/bin/goodvibes-agent` (a `bun add -g` link, 1.18.1) at PATH position 2
# beat `~/.local/bin/goodvibes-agent` (1.21.0) at position 21: two successful
# installs in a row, an old build answering, and a version number that
# reported itself current the whole time.
#
# So after installing, enumerate every copy on PATH, name the one that wins and
# what version each is, and offer to remove the shadowing one when it is
# recognisably ours. An install that cannot be reached is a failed install, so
# an unresolved shadow exits non-zero.
#
# The same rules live in the platform as platform/runtime/path-shadow for the
# clients' startup check; this is their POSIX sh statement, because an
# installer cannot import TypeScript.
#
#   GOODVIBES_SHADOW_REMOVE=ask   prompt on a terminal (default)
#   GOODVIBES_SHADOW_REMOVE=1     remove recognised copies without asking
#   GOODVIBES_SHADOW_REMOVE=0     never remove; report only
SHADOW_REMOVE="${GOODVIBES_SHADOW_REMOVE:-ask}"

# Set to 1 by shadow_confirm() when it could not ask (no controlling
# terminal) rather than being genuinely declined — see shadow_confirm and
# check_command_shadowing's use of it below.
SHADOW_HEADLESS_UNCONFIRMED=0

# Set to 1 when a shadow was found and is still in place at the end of main().
PATH_SHADOW_UNRESOLVED=0

# The PATH the check reasons about. Defaults to this process's PATH and is
# recomputed by shadow_effective_path() before the scan; the tests set it
# directly to drive a scenario without touching the real environment.
SHADOW_PATH="${PATH:-}"

# The PATH the user will actually have, which is not always this process's.
#
# When $INSTALL_DIR is missing from PATH, the installer writes a PATH line into
# the user's shell rc that PREPENDS it (ensure_path_on_shell_rc). That line is
# appended to the end of the rc file, so it runs after anything else in there
# and $INSTALL_DIR ends up first — nothing can shadow it once a new shell
# starts. Checking this process's PATH instead would report "not on your PATH"
# for the very install that just fixed that, which is a false alarm on a fresh
# machine. So model the shell the user is about to open: prepend $INSTALL_DIR
# whenever the rc file carries our line, whether this run wrote it or an
# earlier one did.
shadow_effective_path() {
  shadow_effective_dir=$(shadow_trim_dir "$INSTALL_DIR")
  case ":${PATH:-}:" in
    *":$shadow_effective_dir:"*)
      printf '%s' "${PATH:-}"
      return 0
      ;;
  esac
  if [ "$PATH_LINE_ADDED" = "1" ]; then
    printf '%s:%s' "$shadow_effective_dir" "${PATH:-}"
    return 0
  fi
  shadow_effective_rc=$(resolve_shell_rc)
  if [ -f "$shadow_effective_rc" ] && grep -qF "$INSTALLER_MARKER" "$shadow_effective_rc" 2>/dev/null; then
    printf '%s:%s' "$shadow_effective_dir" "${PATH:-}"
    return 0
  fi
  printf '%s' "${PATH:-}"
}

# Every PATH directory in search order: NORMALIZED (see shadow_normalize_dir
# below — trailing slashes trimmed, '.'/'..' segments collapsed, symlinks
# resolved where the directory exists), empty entries dropped (an empty PATH
# element means the current directory, which is not a stable install anyone
# can reason about), duplicates collapsed to their first occurrence — the
# only position that can ever win.
#
# Normalizing here (not just trimming trailing slashes) matters: without it,
# "$HOME/.local/share/../bin" and "$HOME/.local/bin" — the SAME directory,
# reached two different ways — compared as two DIFFERENT PATH entries. If the
# '..' spelling happened to sit earlier on PATH than the plain one, the real
# install looked shadowed by itself, and the recognizably-ours removal advice
# would have deleted the very binary it just installed.
shadow_path_entries() {
  _spe_seen=''
  _spe_old_ifs=$IFS
  IFS=:
  set -f
  # shellcheck disable=SC2086  # intentional IFS=: word-splitting
  set -- ${SHADOW_PATH:-}
  set +f
  IFS=$_spe_old_ifs
  for _spe_raw in "$@"; do
    [ -n "$_spe_raw" ] || continue
    _spe_norm=$(shadow_normalize_dir "$_spe_raw")
    [ -n "$_spe_norm" ] || continue
    case "$_spe_seen" in
      *"
$_spe_norm
"*)
        continue
        ;;
    esac
    _spe_seen="$_spe_seen
$_spe_norm
"
    printf '%s\n' "$_spe_norm"
  done
}

# Trailing slashes trimmed the same way, so "$HOME/.local/bin/" and
# "$HOME/.local/bin" are one directory on both sides of every comparison.
shadow_trim_dir() {
  printf '%s' "$1" | awk '{
    d = $0
    while (length(d) > 1 && substr(d, length(d), 1) == "/") d = substr(d, 1, length(d) - 1)
    print d
  }'
}

# Follows a symlink chain to the file it really names. Uses readlink -f where
# it exists (GNU and modern BSD), and otherwise chases up to 16 links by hand
# so macOS without coreutils gets the same answer. Prints the input unchanged
# when it is not a link or cannot be resolved.
shadow_real_path() {
  if readlink -f "$1" 2>/dev/null; then
    return 0
  fi
  current=$1
  hops=0
  while [ -L "$current" ] && [ "$hops" -lt 16 ]; do
    target=$(readlink "$current" 2>/dev/null) || break
    case "$target" in
      /*) current=$target ;;
      *) current="$(dirname "$current")/$target" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s\n' "$current"
}

# Lexically collapses '.' and '..' path segments in an ABSOLUTE path —
# realpath -m style: pure string manipulation, no filesystem access, so it
# works whether or not the directory exists yet. A leading '..' cannot climb
# above '/'. Only ever applied to absolute paths (every PATH entry and
# $INSTALL_DIR are); a relative input is printed back unchanged.
shadow_collapse_dots() {
  case "$1" in
    /*) : ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  printf '%s\n' "$1" | awk -F/ '
    {
      n = 0
      for (i = 1; i <= NF; i++) {
        part = $i
        if (part == "" && i == 1) { out[++n] = ""; continue }
        if (part == "" || part == ".") continue
        if (part == "..") {
          if (n > 1) n--
          continue
        }
        out[++n] = part
      }
      result = out[1]
      for (i = 2; i <= n; i++) result = result "/" out[i]
      if (result == "") result = "/"
      print result
    }'
}

# Canonicalizes a directory to the same string every equivalent spelling
# resolves to, so "$HOME/.local/share/../bin" and "$HOME/.local/bin" compare
# equal: trims trailing slashes, lexically collapses '.'/'..' segments (works
# even when the directory does not exist), and — when the directory DOES
# exist — additionally resolves any symlinks in it via shadow_real_path. Falls
# back to the trimmed-and-collapsed literal when it cannot be resolved further
# (does not exist, permission denied) rather than erroring: a PATH may
# legitimately name a directory that isn't there yet.
shadow_normalize_dir() {
  _nd=$(shadow_trim_dir "$1")
  [ -n "$_nd" ] || { printf '%s' ''; return 0; }
  case "$_nd" in
    /*) _nd=$(shadow_collapse_dots "$_nd") ;;
  esac
  if [ -d "$_nd" ]; then
    _nd_real=$(shadow_real_path "$_nd")
    [ -n "$_nd_real" ] && _nd=$(shadow_trim_dir "$_nd_real")
  fi
  printf '%s' "$_nd"
}

# The innermost actual package selector, including an unrelated publisher.
# This is a locator only; it never authorizes removal on its own.
shadow_package_owner() {
  printf '%s\n' "$1" | awk -F/ '{
    pkg = ""
    for (i = 1; i <= NF; i++) {
      if ($i != "node_modules") continue
      if ($(i + 1) ~ /^@/ && $(i + 2) != "") pkg = $(i + 1) "/" $(i + 2)
      else pkg = $(i + 1)
    }
    print pkg
  }'
}

# Exact historical product/command pairs, used only to clean up an identified
# existing package install. Current @goodvibes-jev products are private workspace
# packages; the published-shaped engine exposes other toolchain/contract bins.
# No currently supported published product package is inferred from that scope.
shadow_owning_package() {
  shadow_owner=$(shadow_package_owner "$1")
  case "${2:-}:$shadow_owner" in
    goodvibes:@pellux/goodvibes-tui|goodvibes-daemon:@pellux/goodvibes-daemon|goodvibes-agent:@pellux/goodvibes-agent)
      printf '%s\n' "$shadow_owner" ;;
  esac
}

# What `<path> --version` reports, but ONLY when the output is the exact shape
# every goodvibes command prints: "<command> <dotted numbers>". An unrelated
# program that happens to share the name, a wrapper script, or a --version that
# errors all yield nothing, which keeps that copy unidentified and therefore
# never a removal candidate.
shadow_version_of() {
  shadow_version_line=$(shadow_run_version "$1") || return 0
  printf '%s\n' "$shadow_version_line" | awk -v cmd="$2" '
    NF == 2 && $1 == cmd {
      v = $2
      sub(/^v/, "", v)
      if (v ~ /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/) print v
    }'
}

# Runs the candidate with --version through the bounded capture below, so
# a hung, verbose or interactive binary cannot stall the install. This runs the same
# file the user's very next bare command would run, with the most harmless
# argument there is.
shadow_run_version() {
  # Capture status before selecting a line. Discovery must not inherit a
  # candidate's terminal or allow a successful `head` to mask its failure.
  shadow_probe_output=$(shadow_manager_output "$1" --version) || return 1
  printf '%s\n' "$shadow_probe_output" | head -1
}

# Read-only manager facts, never a guess from a `.bun` path segment. The npm
# prefix and root must agree; the Bun global project and bin are the selected
# manager's own reported context (bun pm ls/bin -g).
shadow_manager_output() {
  # Perl is present on supported stock macOS and many Linux hosts. Its core
  # pipe/fork/wait facilities bound BOTH output and elapsed time without
  # background watchdogs or guessing/reusing process IDs. If unavailable,
  # optional cleanup remains advisory; suite installation still proceeds.
  command -v perl >/dev/null 2>&1 || return 1
  perl -e '
    use strict; use warnings; use POSIX qw(WNOHANG);
    pipe(my $reader, my $writer) or exit 1;
    my $pid = fork(); defined($pid) or exit 1;
    if (!$pid) {
      close $reader;
      open STDIN, "<", "/dev/null" or exit 1;
      open STDERR, ">", "/dev/null" or exit 1;
      open STDOUT, ">&", $writer or exit 1;
      close $writer;
      exec @ARGV; exit 127;
    }
    close $writer;
    my $stop = sub {
      # WNOHANG reaps an exited child; a still-owned live/zombie child cannot
      # have its PID reused before our wait. Never signal an unrelated PID.
      my $done = waitpid($pid, WNOHANG);
      if ($done == 0) { kill 9, $pid; waitpid($pid, 0); }
    };
    $SIG{ALRM} = sub { $stop->(); exit 124; };
    alarm 5;
    my $output = "";
    while (1) {
      my $count = sysread($reader, my $chunk, 4096);
      if (!defined $count) { $stop->(); exit 1; }
      last if !$count;
      $output .= $chunk;
      if (length($output) > 65536) { $stop->(); exit 1; }
    }
    waitpid($pid, 0);
    my $status = $?;
    alarm 0;
    exit 1 if $status != 0;
    print $output;
  ' -- "$@" 2>/dev/null
}

shadow_global_owner() {
  shadow_global_package=$1
  shadow_global_target=$2
  shadow_global_package_root="${shadow_global_target%/node_modules/*}/node_modules/$shadow_global_package"
  shadow_npm_root=$(shadow_manager_output npm root --global) || shadow_npm_root=''
  shadow_npm_prefix=$(shadow_manager_output npm prefix --global) || shadow_npm_prefix=''
  if [ -d "$shadow_npm_root" ] && [ -d "$shadow_npm_prefix" ]; then
    shadow_npm_root=$(CDPATH='' cd -P "$shadow_npm_root" && pwd -P) || return 0
    shadow_npm_prefix=$(CDPATH='' cd -P "$shadow_npm_prefix" && pwd -P) || return 0
    shadow_npm_expected=$(CDPATH='' cd -P "$shadow_npm_prefix/lib/node_modules" && pwd -P) || shadow_npm_expected=''
    if [ "$shadow_npm_root" = "$shadow_npm_expected" ]; then
      if [ "$shadow_global_package_root" = "$shadow_npm_root/$shadow_global_package" ]; then
        printf 'npm\t%s\t-\n' "$shadow_npm_prefix"; return 0
      fi
    fi
  fi
  shadow_bun_listing=$(NO_COLOR=1 FORCE_COLOR=0 shadow_manager_output bun pm ls -g) || shadow_bun_listing=''
  shadow_bun_project=$(printf '%s\n' "$shadow_bun_listing" | head -1 | sed -n 's/ node_modules ([0-9][0-9]* installed)$//p')
  shadow_bun_bin=$(shadow_manager_output bun pm bin -g) || shadow_bun_bin=''
  if [ -d "$shadow_bun_project" ] && [ -d "$shadow_bun_bin" ]; then
    shadow_bun_project=$(CDPATH='' cd -P "$shadow_bun_project" && pwd -P) || return 0
    shadow_bun_bin=$(CDPATH='' cd -P "$shadow_bun_bin" && pwd -P) || return 0
    if [ "$shadow_global_package_root" = "$shadow_bun_project/node_modules/$shadow_global_package" ]; then
      printf 'bun\t%s\t%s\n' "$shadow_bun_project" "$shadow_bun_bin"
    fi
  fi
}

# Display only. The executor below always uses structured, quoted argv.
shadow_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Existing physical target only. A failed/dangling resolution is never evidence
# for removal; resolve parent aliases as well on hosts without readlink -f.
shadow_existing_path() (
  shadow_existing=$(shadow_real_path "$1") || return 1
  [ -f "$shadow_existing" ] || return 1
  shadow_existing_parent=$(CDPATH='' cd -P "$(dirname "$shadow_existing")" && pwd -P) || return 1
  printf '%s/%s\n' "$shadow_existing_parent" "$(basename "$shadow_existing")"
)

# Keep both Darwin observations in the system BSD format, even when PATH
# selects a GNU stat. The target is fstat of the held descriptor; the entry is
# lstat of the selected pathname, preserving detection of symlink replacement.
shadow_target_stamp() {
  installer_native_file_host || return 1
  case "$_INSTALLER_NATIVE_FILE_HOST" in
    Darwin) /usr/bin/stat -f '%d:%i:%u:%g:%p:%z:%m:%c' <&3 ;;
    Linux) stat -L -c '%d:%i:%u:%g:%f:%s:%y:%z' /dev/fd/3 ;;
    *) return 1 ;;
  esac
}

shadow_entry_stamp() {
  installer_native_file_host || return 1
  case "$_INSTALLER_NATIVE_FILE_HOST" in
    Darwin) /usr/bin/stat -f '%d:%i:%u:%g:%p:%z:%m:%c' -- "$1" ;;
    Linux) stat -c '%d:%i:%u:%g:%f:%s:%y:%z' "$1" ;;
    *) return 1 ;;
  esac
}

# Hold the original selected file and parent through the user's prompt. Only
# this original entry can be removed; a prompt callback/reconnect/replacement
# does not mint a new cleanup target. Exit20 means the headless safe default.
confirm_shadow_removal() (
  shadow_confirm_plan=$1
  shadow_confirm_copy=$2
  shadow_confirm_command=$3
  shadow_confirm_real=$4
  exec 3< "$shadow_confirm_copy" || return 1
  exec 4< "$(dirname "$shadow_confirm_copy")" || return 1
  shadow_confirm_stamp=$(shadow_entry_stamp "$shadow_confirm_copy") || return 1
  shadow_confirm_target_stamp=$(shadow_target_stamp) || return 1
  if shadow_confirm '  Remove it now?'; then
    installer_open_file_matches 3 "$shadow_confirm_copy" || return 1
    installer_open_file_matches 4 "$(dirname "$shadow_confirm_copy")" || return 1
    [ "$(shadow_entry_stamp "$shadow_confirm_copy")" = "$shadow_confirm_stamp" ] || return 1
    run_shadow_removal "$shadow_confirm_plan" "$shadow_confirm_copy" "$shadow_confirm_command" "$shadow_confirm_real"
  elif [ "$SHADOW_HEADLESS_UNCONFIRMED" = 1 ]; then return 20
  else return 10; fi
)

# True when $1 is inside $2 (or is $2 itself). Nothing outside the user's own
# home is ever a removal candidate, however confidently we recognise it.
shadow_is_within() {
  shadow_within_root=$(shadow_trim_dir "$2")
  [ -n "$shadow_within_root" ] || return 1
  shadow_within_path=$(shadow_trim_dir "$1")
  [ "$shadow_within_path" = "$shadow_within_root" ] && return 0
  case "$shadow_within_path" in
    "$shadow_within_root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The removal plan for a shadowing copy, as "<kind>\t<detail>", or nothing when
# the copy is not recognisably one of our programs. Two recognised kinds:
#   package <pkg>   a known exact historical product package, matched to its
#                   command/version and actual bun/npm global root only
#   file <path>     a standalone file that answers --version as this command,
#                   i.e. an earlier standalone install of the same program
shadow_removal_plan() {
  shadow_plan_path=$1
  shadow_plan_command=$2
  shadow_plan_resolved=$(shadow_existing_path "$shadow_plan_path") || return 0

  shadow_is_within "$shadow_plan_path" "$HOME" || return 0
  shadow_is_within "$shadow_plan_resolved" "$HOME" || return 0

  # Control characters cannot be represented safely by this tab-delimited
  # removal plan. Unknown paths remain untouched rather than reparsed as plans.
  if printf '%s%s' "$shadow_plan_path" "$shadow_plan_resolved" | LC_ALL=C grep -q '[[:cntrl:]]'; then return 0; fi
  shadow_plan_owner=$(shadow_package_owner "$shadow_plan_resolved")
  shadow_plan_package=$(shadow_owning_package "$shadow_plan_resolved" "$shadow_plan_command")
  if [ -n "$shadow_plan_owner" ] && [ -z "$shadow_plan_package" ]; then
    # A foreign/private package must not fall through to standalone-file
    # deletion just because its command forwards a GoodVibes version banner.
    return 0
  fi
  [ -n "$(shadow_version_of "$shadow_plan_path" "$shadow_plan_command")" ] || return 0
  if [ -n "$shadow_plan_package" ]; then
    shadow_plan_global=$(shadow_global_owner "$shadow_plan_package" "$shadow_plan_resolved")
    [ -n "$shadow_plan_global" ] || return 0
    if printf '%s' "$shadow_plan_global" | LC_ALL=C grep -q '[[:cntrl:]]' ; then
      # Tabs are the three structured fields, all path facts themselves must
      # be single-line and tab-free (validated independently below).
      shadow_plan_scope=$(printf '%s' "$shadow_plan_global" | cut -f2)
      shadow_plan_bin=$(printf '%s' "$shadow_plan_global" | cut -f3)
      if printf '%s%s' "$shadow_plan_scope" "$shadow_plan_bin" | LC_ALL=C grep -q '[[:cntrl:]]'; then return 0; fi
    fi
    shadow_plan_scope=$(printf '%s' "$shadow_plan_global" | cut -f2)
    shadow_is_within "$shadow_plan_scope" "$HOME" || return 0
    shadow_plan_bin=$(printf '%s' "$shadow_plan_global" | cut -f3)
    [ "$shadow_plan_bin" = '-' ] || shadow_is_within "$shadow_plan_bin" "$HOME" || return 0
    printf 'package\t%s\t%s\n' "$shadow_plan_package" "$shadow_plan_global"
  else
    printf 'file\t%s\n' "$shadow_plan_path"
  fi
}

# The exact command that removes a recognised copy. A package link is removed
# by uninstalling the package that provides it — with the manager that owns it,
# established by its selected global context — never by deleting the link,
# which the next command of that package manager would put straight back.
shadow_removal_command() {
  shadow_display_kind=$(printf '%s' "$1" | cut -f1)
  shadow_display_detail=$(printf '%s' "$1" | cut -f2)
  shadow_display_manager=$(printf '%s' "$1" | cut -f3)
  shadow_display_scope=$(printf '%s' "$1" | cut -f4)
  shadow_display_bin=$(printf '%s' "$1" | cut -f5)
  case "$shadow_display_kind:$shadow_display_manager" in
    package:bun) printf 'BUN_INSTALL_GLOBAL_DIR=%s BUN_INSTALL_BIN=%s bun remove -g --ignore-scripts %s\n' "$(shadow_quote "$shadow_display_scope")" "$(shadow_quote "$shadow_display_bin")" "$(shadow_quote "$shadow_display_detail")" ;;
    package:npm) printf 'npm --prefix %s rm -g --ignore-scripts %s\n' "$(shadow_quote "$shadow_display_scope")" "$(shadow_quote "$shadow_display_detail")" ;;
    file:*) printf 'rm -- %s\n' "$(shadow_quote "$shadow_display_detail")" ;;
  esac
}

# Asks on the terminal, when there is one. `curl … | sh` leaves stdin pointing
# at the script itself, so the question and the answer both go through
# /dev/tty; with no terminal at all (a headless/service-managed run, CI, a
# detached `curl | sh`) the safe default is to remove nothing and report.
shadow_confirm() {
  case "$SHADOW_REMOVE" in
    1) return 0 ;;
    0) return 1 ;;
  esac
  # A stat-based readable/writable check on /dev/tty is NOT sufficient proof
  # that a controlling terminal exists: the device node's own permission bits
  # (crw-rw-rw-, world read/write) pass that check even on a completely
  # headless run — only actually OPENING it fails there, with ENXIO ("No such
  # device or address"). Live incident: exactly that ENXIO surfaced on a
  # headless run, and the failed write was not caught as the CONDITION of an
  # `if` — it fell straight through to the read/prompt below and eventually
  # to the installer's non-zero exit, well after the binaries were already
  # correctly installed. Both directions are attempted as the condition of an
  # `if` here, so a headless run takes the safe non-interactive default (leave
  # the copy in place, say so) instead of failing the whole install over a
  # step nobody could have answered.
  #
  # `true`, not `:` — `:` is a POSIX SPECIAL builtin, and a redirection
  # failure on a special builtin is fatal to a non-interactive shell
  # UNCONDITIONALLY, bypassing the usual set -e exemptions for an if-condition
  # or a `!` negation entirely: `if ! { : > /dev/tty; }; then ...` still
  # killed the whole script on the open failure. `true` is an ORDINARY
  # builtin, so its redirection failure is just a normal command failure,
  # properly exempted here.
  if ! { true > /dev/tty; } 2>/dev/null || ! { true < /dev/tty; } 2>/dev/null; then
    SHADOW_HEADLESS_UNCONFIRMED=1
    say "  (no terminal available to ask; leaving this copy in place for now;"
    say "   re-run this installer interactively, or set GOODVIBES_SHADOW_REMOVE=1, to remove it.)"
    return 1
  fi
  printf '%s [y/N] ' "$1" > /dev/tty 2>/dev/null || return 1
  read -r shadow_answer < /dev/tty 2>/dev/null || return 1
  case "$shadow_answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Zero-based PATH position of a directory, or nothing when it is not on PATH.
shadow_path_index() {
  shadow_path_entries | awk -v want="$1" '{ if ($0 == want) { print NR - 1; exit } }'
}

# Every copy of $1 on PATH, as "<index>\t<path>", in search order.
shadow_copies_of() {
  shadow_copies_command=$1
  shadow_path_entries | awk -v cmd="$shadow_copies_command" '{ print (NR - 1) "\t" $0 "/" cmd }' \
    | while IFS='	' read -r shadow_copy_index shadow_copy_path; do
        if [ -f "$shadow_copy_path" ] && [ -x "$shadow_copy_path" ]; then
          printf '%s\t%s\n' "$shadow_copy_index" "$shadow_copy_path"
        fi
      done
}

# Reports and, where recognised and allowed, resolves shadowing copies of one
# command. Returns 0 when the maintained copy is reachable afterwards, 1 when a
# shadow remains.
check_command_shadowing() {
  shadow_command=$1
  shadow_install_dir=$(shadow_trim_dir "$INSTALL_DIR")
  shadow_target="$shadow_install_dir/$shadow_command"

  # Nothing installed under this name here: not ours to have an opinion about.
  [ -f "$shadow_target" ] && [ -x "$shadow_target" ] || return 0

  # shadow_path_entries now prints NORMALIZED directories (see
  # shadow_normalize_dir), so the index lookup must query with the same
  # normalized form — otherwise "$INSTALL_DIR" (unnormalized) could fail to
  # match its own normalized entry and look absent from PATH entirely.
  shadow_install_index=$(shadow_path_index "$(shadow_normalize_dir "$INSTALL_DIR")")
  if [ -z "$shadow_install_index" ]; then
    say ""
    say "PROBLEM: $shadow_target is installed, but $shadow_install_dir is not on your PATH,"
    say "         so typing \"$shadow_command\" does not reach it."
    say "         Add it to your PATH, or run it by full path: $shadow_target"
    return 1
  fi

  shadow_found=0
  shadow_remaining=0
  shadow_copies=$(shadow_copies_of "$shadow_command")

  # Nothing to say while the maintained copy is the first one on PATH.
  shadow_earlier=$(printf '%s\n' "$shadow_copies" | awk -F'\t' -v limit="$shadow_install_index" '
    NF == 2 && $1 + 0 < limit + 0 { print $2 }')
  [ -n "$shadow_earlier" ] || return 0

  shadow_installed_version=$(shadow_version_of "$shadow_target" "$shadow_command")
  [ -n "$shadow_installed_version" ] || shadow_installed_version="unknown"

  shadow_winner=$(printf '%s\n' "$shadow_earlier" | head -1)
  shadow_winner_version=$(shadow_version_of "$shadow_winner" "$shadow_command")
  [ -n "$shadow_winner_version" ] || shadow_winner_version="unknown"

  say ""
  say "PROBLEM: typing \"$shadow_command\" does not run the copy this installer maintains."
  say "         wins on PATH: $shadow_winner (version $shadow_winner_version)"
  say "         installed here: $shadow_target (version $shadow_installed_version)"

  # One newline-separated list, one pass, no subshell — so the counters below
  # survive the loop in a POSIX shell.
  shadow_ifs_backup=$IFS
  IFS='
'
  for shadow_copy in $shadow_earlier; do
    IFS=$shadow_ifs_backup

    # Belt and braces on top of shadow_path_entries' own normalization: even
    # if some PATH shape slipped past directory-level normalization (a
    # symlinked ancestor the no-readlink-f fallback cannot fully chase, etc.),
    # a copy that resolves to the EXACT SAME real file as the one this
    # installer maintains is not a shadow — it is the same binary reached
    # through a different spelling — and must never be offered for deletion.
    shadow_copy_real=$(shadow_existing_path "$shadow_copy") || shadow_copy_real=''
    shadow_target_real=$(shadow_real_path "$shadow_target")
    if [ -n "$shadow_copy_real" ] && [ "$shadow_copy_real" = "$shadow_target_real" ]; then
      IFS='
'
      continue
    fi

    shadow_found=1
    shadow_copy_version=$(shadow_version_of "$shadow_copy" "$shadow_command")
    [ -n "$shadow_copy_version" ] || shadow_copy_version="unknown"
    shadow_plan=$(shadow_removal_plan "$shadow_copy" "$shadow_command")
    if [ -z "$shadow_plan" ]; then
      say ""
      say "  $shadow_copy (version $shadow_copy_version) is not something we can identify as"
      say "  one of our programs, so it will not be touched. Remove it yourself, or put"
      say "  $shadow_install_dir earlier on your PATH."
      shadow_remaining=1
      IFS='
'
      continue
    fi

    shadow_kind=$(printf '%s' "$shadow_plan" | cut -f1)
    shadow_detail=$(printf '%s' "$shadow_plan" | cut -f2)
    shadow_fix=$(shadow_removal_command "$shadow_plan")
    say ""
    say "  $shadow_copy (version $shadow_copy_version) is a copy of our own program."
    say "  Remove it with: $shadow_fix"

    SHADOW_HEADLESS_UNCONFIRMED=0
    if confirm_shadow_removal "$shadow_plan" "$shadow_copy" "$shadow_command" "$shadow_copy_real"; then
      say "  removed     $shadow_copy"
    else
      shadow_removal_status=$?
      if [ "$shadow_removal_status" != 20 ]; then
        [ "$shadow_removal_status" = 10 ] || say "  could not run: $shadow_fix"
        shadow_remaining=1
      fi
    fi
    IFS='
'
  done
  IFS=$shadow_ifs_backup

  [ "$shadow_found" = "1" ] || return 0

  # Re-check rather than trusting the removal: the only thing that settles this
  # is whether an earlier copy is still there.
  shadow_still=$(shadow_copies_of "$shadow_command" | awk -F'\t' -v limit="$shadow_install_index" '
    NF == 2 && $1 + 0 < limit + 0 { print $2 }')
  if [ "$shadow_remaining" = "1" ]; then
    return 1
  fi
  if [ -n "$shadow_still" ]; then
    # Something is still there, but every reason it wasn't removed was "no
    # terminal to ask" (never a decline, an unidentified copy, or a failed
    # removal — those all set shadow_remaining above). A headless/unattended
    # run cannot be blamed for skipping a step nobody could have answered:
    # report it honestly (already done above) and let the install succeed.
    say "  \"$shadow_command\" could not be fully resolved without a terminal to confirm removal;"
    say "  re-run this installer interactively, or set GOODVIBES_SHADOW_REMOVE=1, to finish this."
    return 0
  fi
  say "  \"$shadow_command\" now runs $shadow_target"
  return 0
}

# Runs one removal. A package link is removed through its package manager; a
# standalone file is deleted, and only after re-checking that it is still
# inside the user's home directory.
run_shadow_removal() (
  # Re-observe exact package/global context after interactive confirmation.
  # The captured plan is never evaluated as shell source or word-split argv.
  shadow_execute_plan=$1
  shadow_execute_path=$2
  shadow_execute_command=$3
  [ "$(shadow_existing_path "$shadow_execute_path")" = "$4" ] || return 1
  shadow_execute_current=$(shadow_removal_plan "$shadow_execute_path" "$shadow_execute_command")
  [ "$shadow_execute_plan" = "$shadow_execute_current" ] || return 1
  shadow_execute_kind=$(printf '%s' "$shadow_execute_plan" | cut -f1)
  shadow_execute_detail=$(printf '%s' "$shadow_execute_plan" | cut -f2)
  shadow_execute_manager=$(printf '%s' "$shadow_execute_plan" | cut -f3)
  shadow_execute_scope=$(printf '%s' "$shadow_execute_plan" | cut -f4)
  shadow_execute_bin=$(printf '%s' "$shadow_execute_plan" | cut -f5)
  installer_open_file_matches 3 "$shadow_execute_path" || return 1
  installer_open_file_matches 4 "$(dirname "$shadow_execute_path")" || return 1
  [ "$(shadow_entry_stamp "$shadow_execute_path")" = "$shadow_confirm_stamp" ] || return 1
  [ "$(shadow_target_stamp)" = "$shadow_confirm_target_stamp" ] || return 1
  case "$shadow_execute_kind:$shadow_execute_manager" in
    package:bun) BUN_INSTALL_GLOBAL_DIR="$shadow_execute_scope" BUN_INSTALL_BIN="$shadow_execute_bin" bun remove -g --ignore-scripts "$shadow_execute_detail" >/dev/null 2>&1 ;;
    package:npm) npm --prefix "$shadow_execute_scope" rm -g --ignore-scripts "$shadow_execute_detail" >/dev/null 2>&1 ;;
    file:*) shadow_is_within "$shadow_execute_detail" "$HOME" || return 1; rm -f -- "$shadow_execute_detail" ;;
    *) return 1 ;;
  esac
)

# The whole-install verdict, run after everything is placed.
resolve_path_shadows() {
  SHADOW_PATH=$(shadow_effective_path)
  for shadow_each in goodvibes goodvibes-daemon goodvibes-agent; do
    if ! check_command_shadowing "$shadow_each"; then
      PATH_SHADOW_UNRESOLVED=1
    fi
  done
}

# --- uninstall mode (GOODVIBES_UNINSTALL=1) ---
# Stops the running daemon/agent and removes ONLY what this installer manages:
# the three binaries, the sqlite-vec addon dirs, and the service unit/plist when
# (and only when) it carries the installer-managed marker. ~/.goodvibes user
# data is preserved deliberately. No downloads happen in this mode.

UNINSTALL_REMOVED=""
UNINSTALL_KEPT=""
UNINSTALL_DIRECTORY_ASSETS_KEPT=0
record_removed() { UNINSTALL_REMOVED="${UNINSTALL_REMOVED}  $1
"; }
record_kept() { UNINSTALL_KEPT="${UNINSTALL_KEPT}  $1
"; }

stop_bare_processes() {
  # stop_bare_processes <pgrep-pattern> <label> — TERM processes matching the
  # pattern whose executable lives under $INSTALL_DIR. A process that cannot be
  # attributed to $INSTALL_DIR is left alone and reported, never killed.
  pattern="$1"
  label="$2"
  # The comment above promised foreign processes were "left alone and
  # reported"; they were left alone but never reported, so an uninstall that
  # deliberately skipped another install's daemon looked identical to one that
  # found nothing at all.
  report_foreign_processes "$pattern" "$label"
  pids=$(pids_owned_by_install "$pattern")
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    say "Stopping $label (pid $pid) ..."
    kill "$pid" 2>/dev/null || continue
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "  NOTE: pid $pid did not exit within 10s; stop it yourself: kill $pid"
    else
      say "  stopped    $label (pid $pid)"
      record_removed "$label process (pid $pid)"
    fi
  done
}

uninstall_systemd_service() {
  # uninstall_systemd_service <unit> <unit_path>
  unit="$1"
  unit_path="$2"
  command -v systemctl >/dev/null 2>&1 || return 0

  unit_present=0
  systemctl --user cat "$unit" >/dev/null 2>&1 && unit_present=1
  [ -f "$unit_path" ] && unit_present=1
  [ "$unit_present" = "1" ] || return 0

  managed=0
  [ -f "$unit_path" ] && grep -q "$INSTALLER_MARKER" "$unit_path" 2>/dev/null && managed=1

  if [ "$managed" = "1" ]; then
    say "Stopping and removing installer-managed $unit ..."
    systemctl --user disable --now "$unit" 2>/dev/null ||
      systemctl --user stop "$unit" 2>/dev/null || true
    rm -f "$unit_path"
    systemctl --user daemon-reload 2>/dev/null || true
    say "  removed    $unit_path"
    record_removed "$unit_path (installer-managed unit)"
  else
    say "Stopping $unit (present but not installer-managed) ..."
    systemctl --user stop "$unit" 2>/dev/null || true
    if [ -f "$unit_path" ]; then
      # A hand-written unit is never removed by uninstall, but it is still
      # worth saying plainly when its ExecStart binary is already gone (e.g.
      # a bun-era unit left behind by `bun remove -g`) rather than reporting
      # it identically to a working hand-written unit.
      exec_bin=$(systemd_unit_exec_binary "$unit")
      if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
        say "  NOTE: $unit_path points at $exec_bin, which no longer exists (a broken,"
        say "  non-installer-managed unit); it is left in place; remove it yourself:"
      else
        say "  KEPT       $unit_path is not installer-managed (no marker); leaving it in place."
        say "  Remove it yourself:"
      fi
      say "    systemctl --user disable --now $unit && rm $unit_path && systemctl --user daemon-reload"
      record_kept "$unit_path (hand-written $unit; not installer-managed)"
    fi
  fi
}

uninstall_launchd_agent() {
  # uninstall_launchd_agent <label> <plist_path>
  label="$1"
  plist_path="$2"
  command -v launchctl >/dev/null 2>&1 || return 0
  uid=$(id -u)

  present=0
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 && present=1
  [ -f "$plist_path" ] && present=1
  [ "$present" = "1" ] || return 0

  managed=0
  [ -f "$plist_path" ] && grep -q "$INSTALLER_MARKER" "$plist_path" 2>/dev/null && managed=1

  say "Stopping launchd user agent $label ..."
  launchctl bootout "gui/$uid/$label" 2>/dev/null ||
    launchctl unload "$plist_path" 2>/dev/null || true

  if [ "$managed" = "1" ]; then
    rm -f "$plist_path"
    say "  removed    $plist_path"
    record_removed "$plist_path (installer-managed agent)"
  elif [ -f "$plist_path" ]; then
    say "  KEPT       $plist_path is not installer-managed (no marker); leaving it in place."
    say "  Remove it yourself:"
    say "    launchctl bootout gui/$uid/$label ; rm $plist_path"
    record_kept "$plist_path (hand-written agent; not installer-managed)"
  fi
}

uninstall_services_and_processes() {
  case "$os_tag" in
    linux)
      uninstall_systemd_service "$SYSTEMD_DAEMON_UNIT" "$(systemd_daemon_unit_path)"
      # Also clean up the retired goodvibes-daemon.service unit name: removed
      # when installer-marker-managed, left in place (and reported) otherwise.
      uninstall_systemd_service "$LEGACY_SYSTEMD_DAEMON_UNIT" "$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")"
      uninstall_systemd_service goodvibes-agent.service "$HOME/.config/systemd/user/goodvibes-agent.service"
      ;;
    macos)
      uninstall_launchd_agent "$LAUNCHD_DAEMON_LABEL" "$(launchd_daemon_plist_path)"
      # The product's in-app plist becomes installer-marker-managed once a
      # migration regenerates it — cover it too (marker-gated, like the rest).
      uninstall_launchd_agent goodvibes "$(launchd_product_plist_path)"
      uninstall_launchd_agent sh.goodvibes.agent "$HOME/Library/LaunchAgents/sh.goodvibes.agent.plist"
      ;;
  esac
  # Any bare (non-service) processes launched from this INSTALL_DIR.
  stop_bare_processes '[g]oodvibes-daemon' goodvibes-daemon
  stop_bare_processes '[g]oodvibes-agent' goodvibes-agent
}

assert_uninstall_recovery_slots_idle() {
  for _uninstall_recovery_slot in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
    _uninstall_recovery_path="$1$_uninstall_recovery_slot"
    [ ! -e "$_uninstall_recovery_path" ] && [ ! -L "$_uninstall_recovery_path" ] \
      || fail "Retained update files include $_uninstall_recovery_path. Inspect the original transaction before uninstalling; nothing was removed."
  done
}

assert_uninstall_update_idle() {
  # Do not unlink programs beneath an admitted or uncertain updater. These
  # concrete transaction names are exclusion fences, never deletion receipts.
  # This recheck runs while this uninstaller owns the three primary claims.
  for _uninstall_product in goodvibes-daemon goodvibes goodvibes-agent; do
    for _uninstall_companion in '' .bun .bun.json .bun.LICENSE.md .readers.json; do
      for _uninstall_slot in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
        [ -n "$_uninstall_companion" ] || [ "$_uninstall_slot" != .update-transaction ] || continue
        _uninstall_pending="$INSTALL_DIR/$_uninstall_product$_uninstall_companion$_uninstall_slot"
        [ ! -e "$_uninstall_pending" ] && [ ! -L "$_uninstall_pending" ] \
          || fail "An update or retained transaction owns $_uninstall_pending. Stop the updater and inspect its recovery files before uninstalling; nothing was removed."
      done
    done
  done
  assert_uninstall_recovery_slots_idle "$INSTALL_DIR/daemon-installation.json"
  if [ -d "$INSTALL_DIR/lib" ] && [ ! -L "$INSTALL_DIR/lib" ]; then
    for _uninstall_native_target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
      case "$_uninstall_native_target" in darwin-*) _uninstall_native_vec=vec0.dylib ;; *) _uninstall_native_vec=vec0.so ;; esac
      for _uninstall_native_leaf in "sqlite-vec-$_uninstall_native_target/$_uninstall_native_vec" "sqlite-$_uninstall_native_target/libsqlite3.dylib" "sqlite-$_uninstall_native_target/libsqlite3.dylib.json"; do
        _uninstall_native_parent="$INSTALL_DIR/lib/${_uninstall_native_leaf%/*}"
        [ -d "$_uninstall_native_parent" ] && [ ! -L "$_uninstall_native_parent" ] || continue
        assert_uninstall_recovery_slots_idle "$INSTALL_DIR/lib/$_uninstall_native_leaf"
      done
    done
  fi
  for _uninstall_pending in "$INSTALL_DIR/playwright-core.directory-update.lock"; do
    [ ! -e "$_uninstall_pending" ] && [ ! -L "$_uninstall_pending" ] \
      || fail "An update or retained transaction owns $_uninstall_pending. Inspect it before uninstalling; nothing was removed."
  done
  if [ -d "$WEBUI_ROOT" ] && [ ! -L "$WEBUI_ROOT" ]; then
    for _uninstall_pending in "$WEBUI_ROOT"/*.directory-update.lock; do
      [ ! -e "$_uninstall_pending" ] && [ ! -L "$_uninstall_pending" ] \
        || fail "A WebUI update owns $_uninstall_pending. Inspect it before uninstalling; nothing was removed."
    done
  fi
}

preserve_uninstall_directory() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  record_kept "$1 (directory/deployment contents cannot be attributed safely; not followed or recursively deleted)"
  UNINSTALL_DIRECTORY_ASSETS_KEPT=1
}

run_uninstall() (
  say "Uninstalling GoodVibes (installer-managed files) from $INSTALL_DIR"
  say ""

  _uninstall_has_directory=0
  _uninstall_mutation_started=0
  _uninstall_complete=0
  _uninstall_claim_exit() {
    _uninstall_exit=$?
    trap - EXIT INT TERM
    if [ -n "$INSTALL_CLAIM_OWNER" ]; then
      if [ "$_uninstall_mutation_started" = 0 ] || [ "$_uninstall_complete" = 1 ]; then
        if ! release_install_claims; then
          say "install.sh: original uninstall claims changed; inspect retained transaction files in $INSTALL_CLAIM_DIR before retrying." >&2
          _uninstall_exit=1
        fi
      else
        say "install.sh: uninstall did not finish; inspect retained transaction files in $INSTALL_CLAIM_DIR and remaining programs before retrying." >&2
        _uninstall_exit=1
      fi
    fi
    exit "$_uninstall_exit"
  }
  trap _uninstall_claim_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    [ -d "$INSTALL_DIR" ] || fail 'The selected uninstall directory is unavailable; it was preserved.'
    _uninstall_original=$(CDPATH= cd -- "$INSTALL_DIR" && pwd -P) || fail 'Could not retain the original uninstall directory.'
    exec 0< "$_uninstall_original"
    installer_open_file_matches 0 "$_uninstall_original" || fail 'The original uninstall directory changed.'
    INSTALL_DIR=$_uninstall_original
    WEBUI_ROOT="$INSTALL_DIR/webui"
    VERSION=${VERSION:-uninstall}
    claim_release_install uninstall
    assert_uninstall_update_idle
    _uninstall_has_directory=1
  fi
  uninstall_services_and_processes
  if [ "$_uninstall_has_directory" = 1 ]; then
  assert_install_claims
  _uninstall_mutation_started=1

  if [ -e "$INSTALL_DIR/.goodvibes-reader-requirements.json" ] || [ -L "$INSTALL_DIR/.goodvibes-reader-requirements.json" ]; then
    record_kept "$INSTALL_DIR/.goodvibes-reader-requirements.json (saved-data reader requirements)"
  fi

  # Binaries the installer places, plus the updater's parked rollback copy
  # beside each one (<path>.previous — see self-update.ts's swapFileAtomically/
  # PREVIOUS_FILE_SUFFIX contract). Retained transaction sources have already
  # refused above; support-directory contents below are preserved separately.
  for name in goodvibes goodvibes-daemon goodvibes-agent; do
    for companion in .bun .bun.json .bun.LICENSE.md .readers.json; do
      for tail in '' .previous; do
        if [ -f "$INSTALL_DIR/$name$companion$tail" ]; then
          assert_install_claims
          rm -f "$INSTALL_DIR/$name$companion$tail"
          record_removed "$INSTALL_DIR/$name$companion$tail"
        fi
      done
    done
    bin_path="$INSTALL_DIR/$name"
    if [ -e "$bin_path" ]; then
      assert_install_claims
      rm -f "$bin_path"
      say "  removed    $bin_path"
      record_removed "$bin_path"
    fi
    previous_path="$INSTALL_DIR/$name.previous"
    if [ -e "$previous_path" ]; then
      assert_install_claims
      rm -f "$previous_path"
      say "  removed    $previous_path"
      record_removed "$previous_path"
    fi
  done

  # Known library leaves still require their original physical parent at each
  # unlink. A parent changed after the first leaf must not redirect a later
  # .previous cleanup through a new alias outside this installation.
  _uninstall_library_current() {
    assert_install_claims
    [ ! -L "$INSTALL_DIR/lib" ] && installer_open_file_matches 3 "$INSTALL_DIR/lib" \
      && [ ! -L "$_uninstall_parent" ] && installer_open_file_matches 4 "$_uninstall_parent" \
      || fail 'An original native library directory changed during uninstall; its remaining files were preserved.'
  }
  if [ -L "$INSTALL_DIR/lib" ]; then
    record_kept "$INSTALL_DIR/lib (native library alias; not followed)"
  elif [ -d "$INSTALL_DIR/lib" ]; then
    exec 3< "$INSTALL_DIR/lib"
    assert_install_claims
    [ ! -L "$INSTALL_DIR/lib" ] && installer_open_file_matches 3 "$INSTALL_DIR/lib" || fail 'The original native library root changed.'
    for _uninstall_target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
      case "$_uninstall_target" in darwin-*) _uninstall_vec=vec0.dylib ;; *) _uninstall_vec=vec0.so ;; esac
      for _uninstall_library in "sqlite-vec-$_uninstall_target/$_uninstall_vec" "sqlite-$_uninstall_target/libsqlite3.dylib" "sqlite-$_uninstall_target/libsqlite3.dylib.json"; do
        _uninstall_parent="$INSTALL_DIR/lib/${_uninstall_library%/*}"
        if [ -L "$_uninstall_parent" ]; then record_kept "$_uninstall_parent (native library alias; not followed)"; continue; fi
        [ -d "$_uninstall_parent" ] || continue
        exec 4< "$_uninstall_parent"
        _uninstall_library_current
        for _uninstall_tail in '' .previous; do
          _uninstall_library_current
          _uninstall_leaf="$INSTALL_DIR/lib/$_uninstall_library$_uninstall_tail"
          if [ -L "$_uninstall_leaf" ]; then record_kept "$_uninstall_leaf (not an installer-created regular library)"
          elif [ -f "$_uninstall_leaf" ]; then
            _uninstall_library_current
            rm -f "$_uninstall_leaf"
            _uninstall_library_current
            record_removed "$_uninstall_leaf"
          fi
        done
        _uninstall_library_current
        rmdir "$_uninstall_parent" 2>/dev/null || true
      done
    done
    assert_install_claims
    [ ! -L "$INSTALL_DIR/lib" ] && installer_open_file_matches 3 "$INSTALL_DIR/lib" || fail 'The original native library root changed before cleanup.'
    rmdir "$INSTALL_DIR/lib" 2>/dev/null || true
  elif [ -e "$INSTALL_DIR/lib" ]; then
    record_kept "$INSTALL_DIR/lib (custom non-directory path; not removed)"
  fi
  for native in "$INSTALL_DIR/goodvibes-daemon-$PLATFORM_SUFFIX" "$INSTALL_DIR/goodvibes-daemon-$PLATFORM_SUFFIX.bun" "$INSTALL_DIR/goodvibes-daemon-$PLATFORM_SUFFIX.bun.json" "$INSTALL_DIR/goodvibes-daemon-$PLATFORM_SUFFIX.bun.LICENSE.md" "$INSTALL_DIR/daemon-installation.json"; do
    for tail in '' .previous; do
      if [ -f "$native$tail" ]; then assert_install_claims; rm -f "$native$tail"; record_removed "$native$tail"; fi
    done
  done
  # A release marker or conventional directory name cannot establish the
  # ownership of every nested file. Keep support/rollback/custom trees in place
  # rather than delete user additions or a bundle served by another deployment.
  for driver_dir in "$INSTALL_DIR/playwright-core" "$INSTALL_DIR/playwright-core.previous" "$INSTALL_DIR/playwright-core.incoming"; do
    preserve_uninstall_directory "$driver_dir"
  done
  preserve_uninstall_directory "$WEBUI_ROOT"
  # Failed publications and deliberately retained previous trees have unique
  # paths. Naming one here is guidance, never deletion authority.
  for retained_directory in "$INSTALL_DIR"/.goodvibes-directory-install.* "$INSTALL_DIR"/.playwright-core.update-*; do
    preserve_uninstall_directory "$retained_directory"
  done

  elif [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    record_kept "$INSTALL_DIR (appeared after initial absence; not this uninstall's original directory)"
  fi

  # The selected install-tree removal is settled. A later shell-rc/reporting
  # failure does not turn the completed removal into an uncertain cohort.
  _uninstall_complete=1

  # The installer-managed PATH line, if one was ever added.
  uninstall_shell_rc_path_line

  say ""
  say "Uninstall summary"
  say "-----------------"
  if [ -n "$UNINSTALL_REMOVED" ]; then
    say "Removed:"
    printf '%s' "$UNINSTALL_REMOVED"
  else
    say "Removed: nothing; no installer-managed files were found in $INSTALL_DIR."
  fi
  say ""
  say "Preserved:"
  say "  $HOME/.goodvibes (your GoodVibes data: settings, sessions, memory) is left untouched."
  if [ -n "$UNINSTALL_KEPT" ]; then
    printf '%s' "$UNINSTALL_KEPT"
  fi
  if [ "$UNINSTALL_DIRECTORY_ASSETS_KEPT" = 1 ]; then
    say '  Review the retained directory paths and any other running deployments before removing their contents manually.'
  fi
  say ""
  say "To also erase all GoodVibes user data, remove it yourself:"
  say "  rm -rf -- $(shadow_quote "$HOME/.goodvibes")"
)

DECISION_POLICY=''
parse_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        say 'Install released GoodVibes binaries, daemon, agent, browser driver and WebUI.'
        say 'Usage: install.sh [--version VERSION] [--bin-dir DIR] [--no-service|--service] [--decision-policy POLICY] [--uninstall]'
        say 'GOODVIBES_VERSION selects one monorepo release (default: latest). No source build is performed.'
        exit 0 ;;
      --uninstall) UNINSTALL=1; shift ;;
      --no-service) DAEMON_SERVICE=0; shift ;;
      --service) DAEMON_SERVICE=1; shift ;;
      --version|--bin-dir|--install-dir|--decision-policy)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value"
        case "$1" in
          --version) REQUESTED_VERSION=$2; REQUESTED_DAEMON_VERSION=$2; REQUESTED_AGENT_VERSION=$2; REQUESTED_WEBUI_VERSION=$2 ;;
          --bin-dir|--install-dir) INSTALL_DIR=$2; WEBUI_ROOT="$INSTALL_DIR/webui" ;;
          --decision-policy)
            case "$2" in 'Default - On'|Preferred|'Classic - Off') DECISION_POLICY=$2 ;; *) fail 'Unknown decision policy' ;; esac ;;
        esac
        shift 2 ;;
      *) fail "Unknown option: $1. Use --help for released-version installation; source builds use scripts/install-from-checkout.sh." ;;
    esac
  done
}

main() {
  parse_options "$@"
  resolve_platform

  if [ "$UNINSTALL" = "1" ]; then
    for installed_command in goodvibes goodvibes-daemon goodvibes-agent; do
      command_path="$INSTALL_DIR/$installed_command"
      if [ -L "$command_path" ]; then
        linked=$(readlink "$command_path")
        case "$linked" in
          */commands/goodvibes|*/commands/goodvibes-daemon|*/commands/goodvibes-agent)
            owned_prefix=$(dirname "$(dirname "$linked")")
            if [ -f "$owned_prefix/installation.json" ]; then
              [ -x "$owned_prefix/current/runtime/bun" ] && [ -f "$owned_prefix/current/uninstall.js" ] || fail 'The receipt-owned uninstaller is missing; restore that installation before removing it.'
              exec "$owned_prefix/current/runtime/bun" "$owned_prefix/current/uninstall.js" --prefix "$owned_prefix"
            fi ;;
        esac
      fi
    done
    run_uninstall
    return 0
  fi

  # Receipt-owned checkout installs use a different data/service layout. Do not
  # replace their command links and strand their installed uninstaller.
  for installed_command in goodvibes goodvibes-daemon goodvibes-agent; do
    command_path="$INSTALL_DIR/$installed_command"
    if [ -L "$command_path" ]; then
      linked=$(readlink "$command_path")
      case "$linked" in
        */commands/goodvibes|*/commands/goodvibes-daemon|*/commands/goodvibes-agent)
          owned_prefix=$(dirname "$(dirname "$linked")")
          if [ -f "$owned_prefix/installation.json" ]; then
            fail "A checkout installation owns $command_path. Run its goodvibes-uninstall first (user data is preserved), then install released binaries. Its saved data remains in the data directory recorded by $owned_prefix/installation.json."
          fi ;;
      esac
    fi
  done
  resolve_version

  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/goodvibes-install.XXXXXX")
  trap cleanup_release_install EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  prepare_release
  claim_release_install
  check_release_reader

  say "Installing GoodVibes $VERSION for $PLATFORM_SUFFIX into $INSTALL_DIR"
  say ""
  say "Installing goodvibes $VERSION ..."

  mkdir -p "$INSTALL_DIR"
  # Install atomically: write next to the target, then rename over it, so a
  # running binary is replaced cleanly (the old inode stays alive for
  # existing processes — this is also what /update relies on).
  INSTALL_SWAP_BEGUN=1
  install_release_binary goodvibes
  say "  installed  $INSTALL_DIR/goodvibes"

  # The daemon, from the same monorepo release. It comes before the addon
  # (which rides its manifest), before the wake model (which runs this binary)
  # and before the web UI (which this binary configures).
  install_daemon

  ensure_path_on_shell_rc

  # Smoke test: the installed binary must at least report its version.
  # (doctor is a next-step suggestion, not an install gate: a healthy install
  # exits 0 — advisory findings render as notes, not failures — so there is
  # no "healthy install reports broken" case here to work around.)
  say ""
  if installed_version=$("$INSTALL_DIR/goodvibes" --version 2>/dev/null); then
    say "Installed: $installed_version"
  else
    fail "the installed binary failed to run ('goodvibes --version'); the download may not match this platform"
  fi

  # Install the sqlite-vec addon before restarting the daemon so the restarted
  # process picks it up and semantic vector search is live immediately.
  install_sqlite_vec

  # Publish support trees while the suite is excluded. Configure the WebUI only
  # after the complete native cohort settles, before restarting its services.
  install_webui

  # The driver is shared platform support, including when Agent is skipped.
  install_browser_driver
  if [ "$WITH_AGENT" = 1 ]; then install_agent; fi

  # All program and companion writes are complete before a service may start
  # the new cohort. Startup must not see our own in-flight update claims.
  INSTALL_SWAP_FINISHED=1
  release_install_claims || fail 'Suite files were installed, but changed transaction claims require inspection before starting services.'

  if [ -n "$DECISION_POLICY" ]; then
    "$INSTALL_DIR/goodvibes-daemon" config set judgment.policy "$DECISION_POLICY"
  fi
  # Both commands may load configuration and publish native data. Their real
  # writer checks must see a complete, idle suite, never our own in-flight
  # installation. Provisioning still precedes the first service start.
  install_wake_word_model
  configure_webui

  # Bring a platform-managed canonical unit up to the current (config-derived)
  # launch shape BEFORE the restart below, so the restart applies it.
  refresh_stale_canonical_unit

  restart_running_daemon

  if [ "$WITH_AGENT" = "1" ]; then
    restart_running_agent
  fi

  # First-run only: register the daemon as a user service when nothing is
  # running and no unit exists yet (a no-op on an upgrade, which the restart
  # path above already handled).
  setup_daemon_service

  # Upgrade path: once the canonical goodvibes.service is in place, retire a
  # leftover installer-managed goodvibes-daemon.service (the retired unit name)
  # so the host never runs two competing daemon units. A hand-written legacy
  # unit is left alone and only reported.
  migrate_legacy_installer_unit

  # Everything is placed; now find out whether any of it is reachable. This
  # runs last on purpose — it inspects the files that were just installed,
  # including the agent — and it is the last word on whether the install
  # succeeded, because a copy the shell never runs is not an install.
  resolve_path_shadows
  if [ "$PATH_SHADOW_UNRESOLVED" = "1" ]; then
    say ""
    say "Install FAILED to become reachable: another copy earlier on your PATH still"
    say "answers one or more of these commands. Until that is resolved, upgrading here"
    say "changes nothing you can run. Fix the copies named above, then re-run this"
    say "installer. To run this install directly in the meantime: $INSTALL_DIR/goodvibes"
    exit 3
  fi

  say ""
  if [ "$PATH_LINE_ADDED" = "1" ]; then
    # $INSTALL_DIR was just added to PATH in $RC_FILE_USED, but THIS shell
    # session hasn't re-sourced it yet — the bare 'goodvibes' command would
    # not resolve here. State a command that works RIGHT NOW instead of a
    # promise that depends on a shell restart the user hasn't done.
    say "Done. Start with: $INSTALL_DIR/goodvibes   (health check: $INSTALL_DIR/goodvibes doctor)"
    say "PATH updated in $RC_FILE_USED; open a new shell (or run: . $RC_FILE_USED) to use the plain 'goodvibes' command from then on."
  else
    say "Done. Start with: goodvibes   (health check: goodvibes doctor)"
  fi
  if [ "$WITH_AGENT" = "1" ]; then
    say "Personal agent:   goodvibes-agent"
  fi
  if [ "$WEBUI_INSTALLED" = "1" ] && [ -n "$WEBUI_URL" ]; then
    # The posture line follows the URL the daemon actually reported, so a host
    # that was already bound to its network is never told it is on loopback.
    case "$WEBUI_URL" in
      http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*)
        say "Web UI:           $WEBUI_URL   (this machine only: the daemon is bound to loopback)"
        say "                  To reach it from another device on your network:"
        say "                    goodvibes-daemon webui enable --lan"
        ;;
      *)
        say "Web UI:           $WEBUI_URL   (reachable from your network: the daemon is bound to all interfaces)"
        say "                  To take it back to this machine only:"
        say "                    goodvibes-daemon webui enable --loopback"
        ;;
    esac
  fi
}

# Run unless sourced as a library. The shell-level tests source this file with
# GOODVIBES_INSTALL_SH_LIB=1 to exercise individual functions (unit generation,
# uninstall file handling) without performing a network install.
if [ "${GOODVIBES_INSTALL_SH_LIB:-0}" != "1" ]; then
  main "$@"
fi

