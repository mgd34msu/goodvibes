#!/bin/sh
# GoodVibes release installer — https://goodvibes.sh/install.sh
# Installs prebuilt, checksum-verified release assets from one monorepo tag.
# Trust root: that tag's GitHub release, over HTTPS. SHA256SUMS.txt comes from
# the same origin as the assets, so the checksums catch a corrupt or mismatched
# download, not a compromised release origin.
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
# GOODVIBES_AUTO_UPDATE=0 (or --no-auto-update) keeps every program from updating
# itself, from the first launch. GOODVIBES_RELEASE_DIR=DIR (or --from-dir DIR)
# installs from a directory holding a release's files and its SHA256SUMS.txt,
# with no request to GitHub; each file is checked against that list the same way.
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
# Whether the service choice was stated (--service, --no-service or GOODVIBES_DAEMON_SERVICE). An
# unstated choice never installs a service the owner removed: setup_daemon_service reads service.enabled.
DAEMON_SERVICE_EXPLICIT=0
[ -z "${GOODVIBES_DAEMON_SERVICE+set}" ] || DAEMON_SERVICE_EXPLICIT=1
UNINSTALL="${GOODVIBES_UNINSTALL:-0}"
AUTO_UPDATE="${GOODVIBES_AUTO_UPDATE:-1}"
RELEASE_DIR="${GOODVIBES_RELEASE_DIR:-}"

# Where the unpacked web UI bundles live: one versioned directory per installed
# version under the install tree, beside the binaries that serve them. Versioned
# because the daemon is configured to serve one directory by absolute path, and
# unpacking a new version over a running daemon's directory would swap files
# under it mid-request. A new version lands in its own directory, the daemon is
# pointed at it, and previous/custom bundles stay available to running readers
# and explicit rollback. Their directory names do not prove they can be deleted.
# The installer is the only writer that follows this rule: a native self-update
# replaces the contents of the configured directory in place and rewrites its
# release marker, so a directory named for an older release can hold a newer one.
WEBUI_ROOT="$INSTALL_DIR/webui"

# Set by install_webui() once the daemon has actually been configured to serve
# the bundle, so the closing lines can name the web UI without claiming an
# install that did not finish. WEBUI_URL is lifted from the daemon's own
# receipt, never rebuilt here.
WEBUI_INSTALLED=0
WEBUI_URL=""
# Set when the owner had turned the web UI off: the new bundle is put in place
# and serving is left off.
WEBUI_LEFT_OFF=0

# Set where a step after the programs were replaced printed a NOTE that the daemon or the web UI is not
# running as asked; the closing lines repeat each one and the run exits 4 (installed, with problems).
SERVICE_NOT_SET_UP=0
SERVICE_NOT_RUNNING=0
DAEMON_RESTART_FAILED=0
WEBUI_NOT_CONFIGURED=0
SERVICE_CHOICE_UNSAVED=0

# The daemon native publisher checks the same executable transaction slots.
# Keep private hardlink references until the whole suite has landed;
# a failed partial replacement retains the claims for explicit recovery.
INSTALL_CLAIM_OWNER=""
INSTALL_CLAIM_DIR=""
INSTALL_CLAIM_COUNT=0
INSTALL_SWAP_BEGUN=0
INSTALL_SWAP_FINISHED=0
# One line per file the suite swap replaced (R: backed up, N: newly created), so an
# unfinished swap can be undone. Backups are hard links named <file>.goodvibes-previous.
INSTALL_JOURNAL=""
INSTALL_DAEMON_CLAIM_ID=""
INSTALL_TUI_CLAIM_ID=""
INSTALL_AGENT_CLAIM_ID=""

# The product identifiers in release evidence (packageName in each
# <asset>.reader-ci-artifact.json and in daemon-installation.json). They are a
# contract with installed updaters and are not the workspace package names; the
# one statement of them is the cohort table
# (packages/engine/platform/src/platform/runtime/native-cohort-table.ts).
EVIDENCE_ID_TUI='@goodvibes-jev/tui'
EVIDENCE_ID_AGENT='@goodvibes-jev/agent'
EVIDENCE_ID_DAEMON='@goodvibes-jev/daemon'

# The marker string the installer writes above the PATH line it adds to a shell
# rc file; uninstall keys on it.
INSTALLER_MARKER="managed by goodvibes install.sh"

# The daemon's service (a systemd user unit on Linux, a launchd agent on macOS)
# belongs to the daemon: `goodvibes-daemon install-service` writes and starts it
# on a first install, `goodvibes-daemon refresh-service` brings it to the current
# launch on an upgrade, and `goodvibes-daemon service-status --json` names it and
# says whether the definition there is GoodVibes's own. This installer writes no
# unit or plist and keeps no copy of the service's name, launch or provenance
# rules; read_daemon_service fills these from the installed daemon.
DAEMON_SERVICE_KNOWN=0
DAEMON_SERVICE_NAME=""
DAEMON_SERVICE_PATH=""
DAEMON_SERVICE_PLATFORM=""
DAEMON_SERVICE_OWNER=""
DAEMON_SERVICE_INSTALLED=0
# The names of every daemon service GoodVibes wrote for this user (the one above
# and any second daemon installed under its own service.serviceName), one per
# line, as `service-status --json` lists them in productServices.
DAEMON_PRODUCT_SERVICES=""
# Set when refresh_daemon_service changed the definition on disk in this run, so
# the restart reloads a launchd agent (kickstart alone keeps the plist it loaded).
DAEMON_DEFINITION_CHANGED=0

say() { printf '%s\n' "$*"; }
# Every refusal carries a stable id (INSTALL_E###) after its sentence. Logs that must not show the sentence's
# expanded values (published acceptance records) print the id alone. A new refusal takes the next unused number;
# an id is never reused for a different refusal.
fail() { _fail_id=$1; shift; printf 'install.sh: %s (%s)\n' "$*" "$_fail_id" >&2; exit 1; }

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

# Run one of the installed daemon's commands from $HOME, so a service definition
# it writes takes the home directory (or the daemon's saved working directory) as
# its workspace, never the directory this installer was started from.
daemon_service_command() (
  cd "$HOME" 2>/dev/null || cd / || exit 1
  exec "$INSTALL_DIR/goodvibes-daemon" "$@"
)

# One field of `goodvibes-daemon service-status --json`, which prints one key per
# line: a string value without its quotes, or a bare word (true/false).
daemon_service_string() { printf '%s\n' "$2" | sed -n 's/^ *"'"$1"'": *"\(.*\)",\{0,1\}$/\1/p' | head -n 1; }
daemon_service_word() { printf '%s\n' "$2" | sed -n 's/^ *"'"$1"'": *\([a-z]*\),\{0,1\}$/\1/p' | head -n 1; }
# A true/false or number setting as the installed daemon reports it (`config get <key> --json`); empty when it cannot.
daemon_setting_value() {
  _dsv_json=$("$INSTALL_DIR/goodvibes-daemon" config get "$1" --json 2>/dev/null) || _dsv_json=''
  printf '%s\n' "$_dsv_json" | sed -n 's/^ *"value": *\([a-z0-9]*\),\{0,1\}$/\1/p' | head -n 1
}

# Ask the installed daemon about its service: the name (systemd unit without
# .service, or the launchd label), the definition path, the platform, whether it
# is installed, and who wrote the definition (product | other | absent |
# unreadable). One daemon start and one service-manager query. Returns 1, with
# DAEMON_SERVICE_KNOWN=0, when it cannot answer (program missing, user service
# manager unreachable) or when the service runs under a manager this installer
# does not drive (service.platform manual or windows).
read_daemon_service() {
  DAEMON_SERVICE_KNOWN=0
  DAEMON_SERVICE_NAME=""
  DAEMON_SERVICE_PATH=""
  DAEMON_SERVICE_PLATFORM=""
  DAEMON_SERVICE_OWNER=""
  DAEMON_SERVICE_INSTALLED=0
  DAEMON_PRODUCT_SERVICES=""
  [ -x "$INSTALL_DIR/goodvibes-daemon" ] || return 1
  # Exits 0, 3 and 4 all print the service-status document (schema
  # goodvibes.daemon.service-status, version 1); 1 (manager unreachable) prints
  # the {ok:false, code, error, fix} failure document. A daemon from 3.3.4 or
  # before prints the same fields with "ok": true and no schema; the uninstall
  # asks whichever daemon is installed, and a rollback reinstates such a daemon.
  _rds_json=$(daemon_service_command service-status --json 2>/dev/null) || :
  [ -n "$_rds_json" ] || return 1
  _rds_schema=$(daemon_service_string schema "$_rds_json")
  _rds_version=$(printf '%s\n' "$_rds_json" | sed -n 's/^ *"schemaVersion": *\([0-9]*\),\{0,1\}$/\1/p' | head -n 1)
  if [ -z "$_rds_schema" ] && [ -z "$_rds_version" ] && [ "$(daemon_service_word ok "$_rds_json")" = true ]; then
    _rds_schema=goodvibes.daemon.service-status
    _rds_version=1
  fi
  if [ "$_rds_schema" != goodvibes.daemon.service-status ] || [ "$_rds_version" != 1 ]; then
    _rds_error=$(daemon_service_string error "$_rds_json")
    if [ -n "$_rds_error" ]; then
      say "NOTE: goodvibes-daemon could not report its service ($_rds_error), so the service was not refreshed, restarted or removed." >&2
    else
      say "NOTE: goodvibes-daemon answered service-status --json in a form this installer does not read, so the service was not refreshed, restarted or removed." >&2
    fi
    return 1
  fi
  _rds_name=$(daemon_service_string serviceName "$_rds_json")
  _rds_path=$(daemon_service_string path "$_rds_json")
  _rds_platform=$(daemon_service_string platform "$_rds_json")
  _rds_owner=$(daemon_service_string definitionOwner "$_rds_json")
  if [ -z "$_rds_name" ] || [ -z "$_rds_path" ] || [ -z "$_rds_owner" ]; then return 1; fi
  case "$_rds_platform" in systemd|launchd) : ;; *) return 1 ;; esac
  DAEMON_SERVICE_NAME=$_rds_name
  DAEMON_SERVICE_PATH=$_rds_path
  DAEMON_SERVICE_PLATFORM=$_rds_platform
  DAEMON_SERVICE_OWNER=$_rds_owner
  if [ "$(daemon_service_word installed "$_rds_json")" = true ]; then DAEMON_SERVICE_INSTALLED=1; fi
  DAEMON_PRODUCT_SERVICES=$(printf '%s\n' "$_rds_json" | awk '
    /"productServices": \[\]/ { exit }
    /"productServices": \[/ { inside = 1; next }
    inside && /\]/ { exit }
    inside { gsub(/[ ",]/, ""); if ($0 ~ /^[A-Za-z0-9_.@-]+$/) print }')
  DAEMON_SERVICE_KNOWN=1
}

# The daemon service as systemctl names it (<name>.service) or its launchd label.
daemon_service_unit() {
  if [ "$DAEMON_SERVICE_PLATFORM" = systemd ]; then
    printf '%s.service' "$DAEMON_SERVICE_NAME"
  else
    printf '%s' "$DAEMON_SERVICE_NAME"
  fi
}

# A command's output, indented under the installer's own lines.
say_indented() {
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | sed 's/^/  /'
}

# The newest backup goodvibes-daemon refresh-service kept beside a definition
# (<path>.bak.<YYYYMMDDHHMMSS>), or nothing.
newest_definition_backup() {
  ls -t "$1".bak.* 2>/dev/null | head -n 1 || :
}

# --- PATH line (installer-managed, marker-tagged) ---
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

# Whether an rc file already carries the marker-tagged export for THIS
# $INSTALL_DIR: the marker comment immediately followed by its exact export
# line. A marker written for another install directory does not count, so a
# second install into a different directory still gets its own line.
rc_has_path_line() {
  [ -f "$1" ] || return 1
  awk -v marker="$INSTALLER_MARKER" -v line="$(path_export_line)" '
    after_marker && $0 == line { found = 1 }
    { after_marker = (index($0, marker) > 0) }
    END { exit !found }
  ' "$1" 2>/dev/null
}

# Idempotent: does nothing if $INSTALL_DIR is already on PATH, or if a prior
# run already added the marker-tagged line for this directory (this shell just
# hasn't re-sourced its rc file yet). Otherwise appends the marker comment +
# export line.
ensure_path_on_shell_rc() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  rc_file=$(resolve_shell_rc)
  if rc_has_path_line "$rc_file"; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true
  say ""
  if printf '\n# %s\n%s\n' "$INSTALLER_MARKER" "$(path_export_line)" 2>/dev/null >> "$rc_file"; then
    PATH_LINE_ADDED=1
    RC_FILE_USED="$rc_file"
    say "Added $INSTALL_DIR to PATH in $rc_file (installer-managed; uninstall removes it)."
  else
    say "NOTE: could not write $rc_file; add this line to your shell startup file yourself:"
    say "    $(path_export_line)"
  fi
}

# Uninstall-side removal of the PATH line: only the marker comment line and
# the export/set line for THIS $INSTALL_DIR immediately after it — the exact two
# lines ensure_path_on_shell_rc() appended — never anything else in the file, and
# never the pair another install directory wrote.
uninstall_shell_rc_path_line() {
  rc_file=$(resolve_shell_rc)
  rc_has_path_line "$rc_file" || return 0
  # The filtered text is written back through the file (as install appended
  # to it), so a symlinked rc keeps its link and its target keeps inode, mode
  # and owner.
  _usr_written=0
  if tmp_file=$(mktemp "${TMPDIR:-/tmp}/goodvibes-uninstall-rc.XXXXXX" 2>/dev/null); then
    if awk -v marker="$INSTALLER_MARKER" -v line="$(path_export_line)" '
      held != "" { if ($0 == line) { held = ""; next } print held; held = "" }
      index($0, marker) > 0 { held = $0; next }
      { print }
      END { if (held != "") print held }
    ' "$rc_file" 2>/dev/null > "$tmp_file" && cat "$tmp_file" 2>/dev/null > "$rc_file"; then
      _usr_written=1
    fi
    rm -f "$tmp_file"
  fi
  if [ "$_usr_written" = 1 ]; then
    say "  removed    PATH line from $rc_file"
    record_removed "PATH line in $rc_file (installer-managed)"
  else
    say "  NOTE: could not rewrite $rc_file; delete these two lines from it yourself:"
    say "    # $INSTALLER_MARKER"
    say "    $(path_export_line)"
  fi
}

# --- platform detection (release asset naming: goodvibes[-daemon]-{linux|macos}-{x64|arm64}) ---
resolve_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_tag="linux" ;;
    Darwin) os_tag="macos" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      fail INSTALL_E001 "native Windows is not supported yet. Install WSL2 and run GoodVibes inside it (the Linux binaries apply unchanged):
    1. In an elevated PowerShell:  wsl --install
    2. Open your WSL2 distribution, then re-run:  curl -fsSL https://goodvibes.sh/install.sh | sh
  WSL2 setup and native-Windows status: https://github.com/$REPO/blob/main/docs/windows.md" ;;
    *) fail INSTALL_E002 "unsupported operating system: $os (Windows: use WSL2; see https://github.com/$REPO/blob/main/docs/windows.md)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_tag="x64" ;;
    aarch64|arm64) arch_tag="arm64" ;;
    *) fail INSTALL_E003 "unsupported architecture: $arch" ;;
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
  # From a local release directory BASE_URL is that directory: copy the file;
  # the caller checks it against SHA256SUMS.txt exactly as a download.
  if [ -n "$RELEASE_DIR" ]; then
    [ -f "$1" ] || fail INSTALL_E125 "$1 is not in the release directory $RELEASE_DIR; copy every file of the release (and its SHA256SUMS.txt) there"
    cp -- "$1" "$2" || fail INSTALL_E126 "could not copy $1"
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget_https_only "$1" "$2"
  else
    fail INSTALL_E004 "need curl or wget"
  fi
}

wget_https_only() {
  # wget_https_only <url> <dest>: wget has no switch that limits redirects to
  # https, so each hop is asked for by hand (headers only, no redirect
  # followed) and refused unless it stays https; the final URL is then
  # downloaded with redirects off, so a redirect that appears only then fails
  # instead of being followed.
  _wget_url=$1
  _wget_hops=0
  while :; do
    case "$_wget_url" in
      https://*) : ;;
      *) fail INSTALL_E131 "a download was redirected to $_wget_url, which is not https; nothing more was downloaded. Install curl, or copy the release files over https into a directory and run the installer with --from-dir" ;;
    esac
    _wget_location=$(wget -q -S --spider --max-redirect=0 --timeout=30 --tries=3 "$_wget_url" 2>&1 |
      awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r' | tail -n 1)
    [ -n "$_wget_location" ] || break
    _wget_hops=$((_wget_hops + 1))
    [ "$_wget_hops" -le 10 ] || fail INSTALL_E131 "a download of $1 was redirected more than 10 times; nothing more was downloaded"
    case "$_wget_location" in
      *://*) _wget_url=$_wget_location ;;
      //*) _wget_url="https:$_wget_location" ;;
      /*) _wget_url="$(printf '%s' "$_wget_url" | sed 's#^\(https://[^/]*\).*#\1#')$_wget_location" ;;
      *) _wget_url="${_wget_url%/*}/$_wget_location" ;;
    esac
  done
  wget -q --max-redirect=0 --timeout=30 --tries=3 -O "$2" "$_wget_url"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail INSTALL_E005 "need sha256sum or shasum to verify downloads"
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
        fail INSTALL_E006 "could not resolve the latest release tag for $tag_repo"
      tag="${redirect##*/}"
    else
      redirect=$(wget -q --max-redirect=0 --server-response "https://github.com/$tag_repo/releases/latest" 2>&1 |
        awk '/Location:/ {print $2}' | tr -d '\r' | head -1)
      tag="${redirect##*/}"
    fi
    [ -n "$tag" ] || fail INSTALL_E007 "could not resolve the latest release tag for $tag_repo"
    # Another release in the repository (the voice-runtime host, say) can hold
    # the Latest mark; installing from it would fail later on a missing file.
    printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
      fail INSTALL_E123 "the latest release of $tag_repo is '$tag', which is not a suite release; set GOODVIBES_VERSION=vX.Y.Z"
  else
    tag="$tag_requested"
  fi
  case "$tag" in v*) : ;; *) tag="v$tag" ;; esac
  printf '%s' "$tag"
}

resolve_version() {
  # Resolve once. A suite cannot mix versions from former product repositories.
  for requested in "$REQUESTED_DAEMON_VERSION" "$REQUESTED_AGENT_VERSION" "$REQUESTED_WEBUI_VERSION"; do
    [ "${requested#v}" = "${REQUESTED_VERSION#v}" ] || fail INSTALL_E008 "All products use GOODVIBES_VERSION; remove conflicting per-product version overrides."
  done
  if [ -n "$RELEASE_DIR" ]; then
    # A local release names its version in its web UI bundle's file name.
    [ -f "$RELEASE_DIR/SHA256SUMS.txt" ] || fail INSTALL_E127 "$RELEASE_DIR has no SHA256SUMS.txt; copy the whole release there, including that file"
    _dir_version=$(sed -n 's/^[0-9a-fA-F]\{64\}  *\*\{0,1\}goodvibes-webui-bundle-\([0-9][0-9A-Za-z.+-]*\)\.tar\.gz$/\1/p' "$RELEASE_DIR/SHA256SUMS.txt" | head -n 1)
    if [ "$REQUESTED_VERSION" = latest ]; then
      [ -n "$_dir_version" ] || fail INSTALL_E128 "cannot tell which release $RELEASE_DIR holds; name it with --version vX.Y.Z"
      VERSION="v$_dir_version"
    else
      VERSION=$REQUESTED_VERSION
      case "$VERSION" in v*) : ;; *) VERSION="v$VERSION" ;; esac
      [ -z "$_dir_version" ] || [ "v$_dir_version" = "$VERSION" ] || fail INSTALL_E129 "$RELEASE_DIR holds release v$_dir_version, not $VERSION"
    fi
  else
    VERSION=$(resolve_tag "$REPO" "$REQUESTED_VERSION")
  fi
  printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' || fail INSTALL_E009 "Invalid release version: $VERSION"
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
  _release_expected=$(release_checksum "$_release_asset") || fail INSTALL_E010 "Missing or ambiguous checksum: $_release_asset. Release $VERSION is incomplete; no source build will be attempted."
  fetch "$BASE_URL/$_release_asset" "$WORKDIR/$_release_asset"
  _release_actual=$(sha256_of "$WORKDIR/$_release_asset")
  [ "$_release_actual" = "$_release_expected" ] || fail INSTALL_E011 "Checksum mismatch: $_release_asset"
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
  tar -xzf "$WORKDIR/browser-driver.tar.gz" -C "$WORKDIR/browser-driver-staging" || fail INSTALL_E012 'Could not extract the verified browser driver.'
  for _driver_entry in package.json index.js cli.js; do
    [ -f "$WORKDIR/browser-driver-staging/playwright-core/$_driver_entry" ] || fail INSTALL_E013 "The verified browser driver is missing playwright-core/$_driver_entry."
  done
  if [ "$WITH_WEBUI" = 1 ]; then
    mkdir -p "$WORKDIR/webui-staging"
    tar -xzf "$WORKDIR/goodvibes-webui-bundle-${VERSION#v}.tar.gz" -C "$WORKDIR/webui-staging" || fail INSTALL_E014 'Could not extract the verified WebUI.'
    [ -f "$WORKDIR/webui-staging/goodvibes-webui/index.html" ] || fail INSTALL_E015 'The verified WebUI is missing goodvibes-webui/index.html.'
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
    _compiled_readers=$("$WORKDIR/$_receipt_asset" check-install-reader --describe) || fail INSTALL_E016 'The verified daemon did not confirm its compiled readers. No installed program was replaced.'
  fi
  # The ordinary released Bun prepares metadata in private staging. Older
  # updaters still consume the original descriptor; richer evidence must name
  # precisely the same source and payloads and match the actual staged reader.
  "$WORKDIR/$_receipt_asset.bun" -e '
    try {
      const [primaryFile, readerFile, compiledJson, version, output, packageName] = process.argv.slice(1);
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
      await Bun.write(output, JSON.stringify({schema:1,packageName,version,artifact},null,2)+"\n");
    } catch { process.exitCode = 1; }
  ' "$WORKDIR/$_receipt_asset.ci-artifact.json" "$_reader_source" "$_compiled_readers" "${VERSION#v}" "$WORKDIR/daemon-installation.json" "$EVIDENCE_ID_DAEMON" || fail INSTALL_E017 'The verified daemon release metadata could not be confirmed. No installed program was replaced.'
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
    # Re-entrant: an earlier, interrupted release may already have removed this
    # product's public claim and/or private reference. Releasing something that
    # is already gone succeeds; anything still present is verified exactly as before.
    if [ ! -e "$_claim_path" ] && [ ! -L "$_claim_path" ]; then
      if [ ! -e "$_claim_reference" ] && [ ! -L "$_claim_reference" ]; then continue; fi
      [ -f "$_claim_reference" ] && [ ! -L "$_claim_reference" ] || return 1
      exec 3< "$_claim_reference"
      if ! install_claim_directories_current || [ -L "$_claim_reference" ] || ! installer_open_file_matches 3 "$_claim_reference" \
        || [ "$(install_claim_file_identity "$_claim_reference")" != "$_claim_expected" ]; then
        exec 3<&-
        return 1
      fi
      if ! rm -f "$_claim_reference"; then exec 3<&-; return 1; fi
      exec 3<&-
      continue
    fi
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
  rm -f "${INSTALL_CLAIM_OWNER:?}/swap-journal" "${INSTALL_CLAIM_OWNER:?}/swap-journal.committed" || return 1
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
  [ "$INSTALL_CLAIM_COUNT" = 3 ] || fail INSTALL_E018 'The complete suite installation claims are not retained.'
  install_claim_directories_current || fail INSTALL_E019 'The original installation or private claim directory changed; no further program replacement is allowed.'
  for _assert_product in goodvibes-daemon goodvibes goodvibes-agent; do
    _assert_claim="$INSTALL_CLAIM_DIR/$_assert_product.update-transaction"
    _assert_expected=$(expected_install_claim_identity "$_assert_product") || fail INSTALL_E020 'Original installation claim identity is unavailable.'
    [ -n "$_assert_expected" ] && [ ! -L "$_assert_claim" ] && [ ! -L "$INSTALL_CLAIM_OWNER/$_assert_product" ] \
      && [ "$_assert_claim" -ef "$INSTALL_CLAIM_OWNER/$_assert_product" ] \
      && [ "$(install_claim_file_identity "$_assert_claim")" = "$_assert_expected" ] \
      && [ "$(install_claim_file_identity "$INSTALL_CLAIM_OWNER/$_assert_product")" = "$_assert_expected" ] \
      || fail INSTALL_E021 'Original installation claim ownership changed; no further program replacement is allowed.'
  done
}

# Journal a file before the swap replaces or removes it: keep the previous bytes beside it.
# The restore entry ("R") is written only AFTER the backup is complete, so a target that was never
# backed up can never be "restored". A hard link is atomic; the copy fallback is made under a
# temporary name and renamed into place only once it succeeded.
install_journal_target() {
  _journal_target=$1
  [ -n "$INSTALL_JOURNAL" ] || fail INSTALL_E022 'The installer swap journal is not available.'
  _journal_backup="$_journal_target.goodvibes-previous"
  if [ -e "$_journal_target" ] || [ -L "$_journal_target" ]; then
    [ ! -e "$_journal_backup" ] && [ ! -L "$_journal_backup" ] || fail INSTALL_E023 "A previous-program backup appeared at $_journal_backup during this install; nothing more was replaced. Check that $_journal_target runs, then remove the backup and re-run the installer."
    if ! ln "$_journal_target" "$_journal_backup" 2>/dev/null; then
      _journal_partial="$_journal_backup.partial"
      rm -f "$_journal_partial"
      if ! cp -Pp "$_journal_target" "$_journal_partial" || ! mv -f "$_journal_partial" "$_journal_backup"; then
        rm -f "$_journal_partial"
        fail INSTALL_E024 "Could not back up $_journal_target before replacing it."
      fi
    fi
    printf 'R%s\n' "$_journal_target" >> "$INSTALL_JOURNAL" || { rm -f "$_journal_backup"; fail INSTALL_E025 'Could not record the swap journal.'; }
  else
    printf 'N%s\n' "$_journal_target" >> "$INSTALL_JOURNAL" || fail INSTALL_E026 'Could not record the swap journal.'
  fi
}

# Leftover backups (a killed or hung-up earlier run) are never restored automatically: they may be
# older than what is installed now. List every one in a single refusal, with the command to remove them.
assert_no_stale_backups() {
  _stale_list=''
  _stale_quoted=''
  for _stale_file in "$INSTALL_DIR"/*.goodvibes-previous "$INSTALL_DIR"/*.goodvibes-previous.partial \
                     "$INSTALL_DIR"/lib/*/*.goodvibes-previous "$INSTALL_DIR"/lib/*/*.goodvibes-previous.partial; do
    if [ -e "$_stale_file" ] || [ -L "$_stale_file" ]; then
      _stale_list="$_stale_list
  $_stale_file"
      _stale_quoted="$_stale_quoted $(shadow_quote "$_stale_file")"
    fi
  done
  [ -z "$_stale_list" ] || fail INSTALL_E027 "Leftover previous-program backups from an interrupted earlier install were found; nothing was changed. They are never restored automatically (they may be older than the installed programs):$_stale_list
Check that the installed programs run, then remove them all and re-run the installer: rm -f --$_stale_quoted
If an installed program is broken, put its backup back first: mv -f <file>.goodvibes-previous <file>"
}

# The native updater keeps the release it replaced as <program>.previous, and a
# crash-loop rollback or `/update rollback` restores that set. An installer upgrade
# replaces the programs without refreshing it, so the set would still hold a release
# older than the one just replaced, and a rollback would land two releases back
# while reporting the previous one. When the daemon program was replaced by different
# bytes, drop the stale single files so a rollback truthfully finds nothing to
# restore. Directory copies are left alone: a set missing its programs is refused as
# incomplete. A republish of the same release keeps the set, which is still correct.
# Best effort and only while the claims are provably held.
discard_stale_previous_cohort() {
  [ -f "$INSTALL_DIR/goodvibes-daemon.goodvibes-previous" ] && [ ! -L "$INSTALL_DIR/goodvibes-daemon.goodvibes-previous" ] || return 0
  ! cmp -s "$INSTALL_DIR/goodvibes-daemon.goodvibes-previous" "$INSTALL_DIR/goodvibes-daemon" || return 0
  ( assert_install_claims ) >/dev/null 2>&1 || return 0
  _stale_candidates="$INSTALL_DIR/daemon-installation.json.previous
$INSTALL_DIR/lib/sqlite-vec-${VEC_OS}-${arch_tag}/vec0.${VEC_SUFFIX}.previous
$INSTALL_DIR/lib/sqlite-darwin-${arch_tag}/libsqlite3.dylib.previous
$INSTALL_DIR/lib/sqlite-darwin-${arch_tag}/libsqlite3.dylib.json.previous"
  for _stale_name in goodvibes goodvibes-daemon goodvibes-agent; do
    for _stale_companion in '' .bun .bun.json .bun.LICENSE.md .readers.json; do
      _stale_candidates="$_stale_candidates
$INSTALL_DIR/$_stale_name$_stale_companion.previous"
    done
  done
  for _stale_companion in '' .bun .bun.json .bun.LICENSE.md; do
    _stale_candidates="$_stale_candidates
$INSTALL_DIR/goodvibes-daemon-$PLATFORM_SUFFIX$_stale_companion.previous"
  done
  _stale_old_ifs=$IFS
  IFS='
'
  for _stale_file in $_stale_candidates; do
    [ -f "$_stale_file" ] && [ ! -L "$_stale_file" ] || continue
    ( assert_install_claims ) >/dev/null 2>&1 || break
    rm -f "$_stale_file" && say "  removed    $_stale_file (a rollback copy of a release older than the one just replaced)"
  done
  IFS=$_stale_old_ifs
}

# The swap finished. Record that on disk before any backup is deleted: the journal is renamed
# (one atomic step) to swap-journal.committed beside the claims, so a run killed outright while
# committing is finished by the next run (recover_abandoned_install_claims), never rolled back
# half way into programs from two releases. The renamed journal is the one committed from.
mark_install_swap_committed() {
  [ -n "$INSTALL_JOURNAL" ] && [ -n "$INSTALL_CLAIM_OWNER" ] || return 1
  _committed_journal="$INSTALL_CLAIM_OWNER/swap-journal.committed"
  mv -f "$INSTALL_JOURNAL" "$_committed_journal" || return 1
  INSTALL_JOURNAL=$_committed_journal
  INSTALL_SWAP_FINISHED=1
}

# The swap finished: the previous bytes are no longer needed, and a superseded published
# directory (queued as "O") can now go, because nothing can roll back to it any more.
# Safe to repeat: a run interrupted here, or the run that finds it abandoned, commits again.
commit_install_journal() {
  [ -n "$INSTALL_JOURNAL" ] && [ -f "$INSTALL_JOURNAL" ] || return 0
  while IFS= read -r _journal_line; do
    case "$_journal_line" in
      R*) rm -f "${_journal_line#R}.goodvibes-previous" ;;
      O*) _outgoing=${_journal_line#O}
          case "$_outgoing" in
            "$INSTALL_DIR"/.goodvibes-directory-install.*/outgoing)
              if [ -d "$_outgoing" ] && [ ! -L "$_outgoing" ]; then
                rm -rf "$_outgoing" 2>/dev/null || say "  NOTE: could not remove the superseded previous directory at $_outgoing; it is safe to delete." >&2
                rmdir "${_outgoing%/outgoing}" 2>/dev/null || :
              fi ;;
          esac ;;
    esac
  done < "$INSTALL_JOURNAL"
  : > "$INSTALL_JOURNAL"
}

# Undo an unfinished swap: restore every backed-up file, delete every file the swap created,
# and drop staged .incoming files. Returns non-zero if any step failed (the journal is kept).
rollback_install_swap() {
  [ -n "$INSTALL_JOURNAL" ] && [ -f "$INSTALL_JOURNAL" ] || return 0
  _rollback_ok=1
  _rollback_directory=''
  while IFS= read -r _journal_line; do
    _journal_path=${_journal_line#?}
    case "$_journal_line" in
      T*) _rollback_directory=$_journal_path; continue ;;
      O*)
        # A support directory (the browser driver) this run replaced: the new tree goes and the
        # parked previous one comes back, so a suite rolled back never keeps a newer support tree
        # beside the previous programs.
        if [ -n "$_rollback_directory" ] && [ -d "$_journal_path" ] && [ ! -L "$_journal_path" ]; then
          _rollback_aside="$_journal_path.rolled-back"
          if { [ ! -e "$_rollback_directory" ] || mv "$_rollback_directory" "$_rollback_aside"; } && mv "$_journal_path" "$_rollback_directory"; then
            rm -rf "${_rollback_aside:?}" 2>/dev/null || :
          else
            _rollback_ok=0
          fi
        fi
        _rollback_directory=''
        continue ;;
    esac
    rm -f "$_journal_path.incoming" || _rollback_ok=0
    case "$_journal_line" in
      R*) if [ -e "$_journal_path.goodvibes-previous" ] || [ -L "$_journal_path.goodvibes-previous" ]; then
            if [ "$_journal_path.goodvibes-previous" -ef "$_journal_path" ]; then
              # The link was made but the program was not replaced yet: it is already the previous file.
              rm -f "$_journal_path.goodvibes-previous" || _rollback_ok=0
            else
              mv -f "$_journal_path.goodvibes-previous" "$_journal_path" || _rollback_ok=0
            fi
          fi ;;
      N*) rm -f "$_journal_path" || _rollback_ok=0 ;;
    esac
  done < "$INSTALL_JOURNAL"
  [ "$_rollback_ok" = 1 ] || return 1
  : > "$INSTALL_JOURNAL"
}

report_unfinished_swap() {
  say "install.sh: suite replacement did not finish and could not be undone automatically. Its claims ($INSTALL_CLAIM_DIR/*.update-transaction) and journal ($INSTALL_JOURNAL) were kept." >&2
  # Recovery commands are only printed while the original directory is still the one on record.
  if [ "${1:-}" = commands ] && [ -n "$INSTALL_JOURNAL" ] && [ -s "$INSTALL_JOURNAL" ]; then
    say 'install.sh: files this run replaced, with the command that puts each previous version back:' >&2
    while IFS= read -r _journal_line; do
      _journal_path=${_journal_line#?}
      case "$_journal_line" in
        R*) if [ "$_journal_path.goodvibes-previous" -ef "$_journal_path" ]; then
              say "  already the previous file (not replaced yet), remove the spare link: rm -f $(shadow_quote "$_journal_path.goodvibes-previous")" >&2
            else
              say "  restore: mv -f $(shadow_quote "$_journal_path.goodvibes-previous") $(shadow_quote "$_journal_path")" >&2
            fi ;;
        N*) say "  new file, remove: rm -f $(shadow_quote "$_journal_path")" >&2 ;;
      esac
    done < "$INSTALL_JOURNAL"
    say "install.sh: once those are done, remove the claims with: rm -f -- $(shadow_quote "$INSTALL_CLAIM_DIR")/*.update-transaction $(shadow_quote "$INSTALL_CLAIM_OWNER")/*; rmdir $(shadow_quote "$INSTALL_CLAIM_OWNER"); then re-run the installer. Re-running the installer first retries this undo from the kept journal." >&2
  fi
}

cleanup_release_install() {
  _install_exit=$?
  # A second Ctrl-C or hang-up must not cut the rollback short.
  trap '' INT TERM HUP
  trap - EXIT
  if [ -n "$INSTALL_CLAIM_OWNER" ]; then
    # A journal already renamed to committed means every program was replaced, even when the
    # signal came between the rename and the flag: finish the commit, never undo it.
    if [ "$INSTALL_SWAP_FINISHED" = 0 ] && [ -f "$INSTALL_CLAIM_OWNER/swap-journal.committed" ]; then
      INSTALL_JOURNAL="$INSTALL_CLAIM_OWNER/swap-journal.committed"
      INSTALL_SWAP_FINISHED=1
    fi
    if [ "$INSTALL_SWAP_FINISHED" = 1 ]; then commit_install_journal; fi
    if [ "$INSTALL_SWAP_BEGUN" = 0 ] || [ "$INSTALL_SWAP_FINISHED" = 1 ]; then
      if ! release_install_claims; then
        say "install.sh: this run's installation claims in $INSTALL_CLAIM_DIR changed while it ran, so they were left in place. Re-run the installer once no other goodvibes install or update is running; it releases claims whose process is gone." >&2
        _install_exit=1
      fi
    else
      # Undo the partial swap only while this run still provably owns the directory and its claims.
      if ! ( assert_install_claims ) >/dev/null 2>&1; then
        report_unfinished_swap
      elif rollback_install_swap; then
        if release_install_claims; then
          say 'install.sh: installation did not finish. The previous programs were restored and the installation claims were released; running services were not touched.' >&2
          say "install.sh: to try again, re-run the installer: curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=$VERSION sh" >&2
        else
          say "install.sh: the previous programs were restored, but this run's installation claims in $INSTALL_CLAIM_DIR changed, so they were left in place. Re-run the installer once no other goodvibes install or update is running; it releases claims whose process is gone." >&2
        fi
      else
        report_unfinished_swap commands
      fi
      [ "$_install_exit" != 0 ] || _install_exit=1
    fi
  fi
  rm -rf "$WORKDIR"
  exit "$_install_exit"
}

# The pid an installation claim records, or nothing when the claim cannot be read. install.sh writes the pid
# first; the native updater writes it after its operation and targets, so the field is found anywhere.
install_claim_pid() { sed -n 's/.*"pid":\([0-9][0-9]*\)[,}].*/\1/p' "$1" 2>/dev/null | head -n 1; }

# True while the process that wrote a claim is still running. A pid that is alive but started after the claim
# was written belongs to another program that reused the number (after a reboot, say), not to the claim's owner.
install_claim_owner_running() {
  kill -0 "$2" 2>/dev/null || return 1
  _owner_started_ms=$(sed -n 's/.*"startedAt":\([0-9][0-9]*\)[,}].*/\1/p' "$1" 2>/dev/null | head -n 1)
  [ -n "$_owner_started_ms" ] || return 0
  _owner_elapsed=$(ps -o etime= -p "$2" 2>/dev/null | awk '{ t = $1; d = 0
    if (index(t, "-")) { d = substr(t, 1, index(t, "-") - 1); t = substr(t, index(t, "-") + 1) }
    n = split(t, a, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + a[i]; print d * 86400 + s }')
  [ -n "$_owner_elapsed" ] || return 0
  # Started (now - elapsed) no later than the claim, with a few seconds for clock granularity.
  [ $(( $(date +%s) - _owner_elapsed )) -le $(( _owner_started_ms / 1000 + 5 )) ]
}

# Release a dead owner's claim by taking it, never by deleting the shared path: another installer, or the
# native updater reclaiming the same dead claim, may have put its own live claim there since the owner was
# judged dead. One rename moves whatever is at the path into this run's private claim directory; the moved
# file is then checked against the claim judged dead ($2 = ref: the same file as reference $3; $2 = id: the
# file identity $3). A different claim is put back without replacing anything there now, and the run stops.
take_abandoned_install_claim() {
  _taken_claim="$INSTALL_CLAIM_OWNER/abandoned.${1##*/}"
  rm -f "$_taken_claim"
  if ! mv "$1" "$_taken_claim" 2>/dev/null; then
    # Gone already: another run released it first. Anything else is a claim this run cannot move.
    if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
    fail INSTALL_E117 "The installation claim $1 could not be released; nothing was changed. If no goodvibes install or update is running, remove it and re-run the installer: rm -rf -- $(shadow_quote "$1")"
  fi
  case "$2" in
    ref) [ ! -L "$_taken_claim" ] && [ "$_taken_claim" -ef "$3" ] && _taken_same=1 || _taken_same=0 ;;
    *) [ "$(install_claim_file_identity "$_taken_claim")" = "$3" ] && _taken_same=1 || _taken_same=0 ;;
  esac
  if [ "$_taken_same" = 1 ]; then
    rm -f "$_taken_claim"
    return 0
  fi
  _taken_pid=$(install_claim_pid "$_taken_claim")
  if ln "$_taken_claim" "$1" 2>/dev/null; then
    rm -f "$_taken_claim"
    fail INSTALL_E118 "Another goodvibes update or install (process ${_taken_pid:-unknown}) claimed $1 while this run was releasing a claim left by a process that is gone; its claim was left in place and nothing was changed. Wait for it to finish, then re-run the installer."
  fi
  fail INSTALL_E118 "Another goodvibes update or install (process ${_taken_pid:-unknown}) claimed $1 while this run was releasing a claim left by a process that is gone, and a third claim took the path before its claim could be put back; nothing was changed. Its claim is at $_taken_claim: once no goodvibes install or update is running, remove it and re-run the installer."
}

# A claim whose process is gone was left by an install or update that was killed outright (SIGKILL, power
# loss, out of memory). An install.sh run keeps its swap journal in its private claim directory: undo that
# swap exactly as its EXIT trap would have, or, when the run had already replaced every program and renamed
# its journal to swap-journal.committed, finish its commit (drop the backups it left); then release its
# claims and continue. Any other claim of a dead process is released when no partial file remains beside
# the program. A live owner is refused with its pid.
recover_abandoned_install_claims() {
  for _abandoned_product in goodvibes-daemon goodvibes goodvibes-agent; do
    _abandoned_claim="$INSTALL_CLAIM_DIR/$_abandoned_product.update-transaction"
    [ -e "$_abandoned_claim" ] || [ -L "$_abandoned_claim" ] || continue
    _abandoned_pid=''
    _abandoned_identity=''
    if [ -f "$_abandoned_claim" ] && [ ! -L "$_abandoned_claim" ]; then
      _abandoned_identity=$(install_claim_file_identity "$_abandoned_claim") || _abandoned_identity=''
      _abandoned_pid=$(install_claim_pid "$_abandoned_claim")
    fi
    [ -n "$_abandoned_pid" ] || fail INSTALL_E117 "The installation claim $_abandoned_claim cannot be read, so its owner is unknown; nothing was changed. If no goodvibes install or update is running, remove it and re-run the installer: rm -rf -- $(shadow_quote "$_abandoned_claim")"
    if install_claim_owner_running "$_abandoned_claim" "$_abandoned_pid"; then
      fail INSTALL_E118 "Another goodvibes update or install (process $_abandoned_pid) is replacing programs in $INSTALL_CLAIM_DIR and holds $_abandoned_claim; nothing was changed. Wait for it to finish, then re-run the installer."
    fi
    _abandoned_owner=''
    for _abandoned_dir in "$INSTALL_CLAIM_DIR"/.goodvibes-install-claim.*; do
      [ "$_abandoned_dir" != "$INSTALL_CLAIM_OWNER" ] && [ -d "$_abandoned_dir" ] && [ ! -L "$_abandoned_dir" ] || continue
      if [ "$_abandoned_dir/$_abandoned_product" -ef "$_abandoned_claim" ]; then _abandoned_owner=$_abandoned_dir; break; fi
    done
    if [ -n "$_abandoned_owner" ]; then
      _abandoned_outcome='restored the programs it had replaced'
      _abandoned_own_journal=$INSTALL_JOURNAL
      if [ -f "$_abandoned_owner/swap-journal.committed" ]; then
        # It had replaced every program: keep them, and drop the backups its commit had not reached.
        INSTALL_JOURNAL="$_abandoned_owner/swap-journal.committed"
        commit_install_journal
        _abandoned_outcome='it had replaced every program, so the new ones were kept and its leftover backups removed'
      elif [ -s "$_abandoned_owner/swap-journal" ]; then
        INSTALL_JOURNAL="$_abandoned_owner/swap-journal"
        if ! rollback_install_swap; then
          INSTALL_JOURNAL=$_abandoned_own_journal
          fail INSTALL_E119 "An installation interrupted earlier (process $_abandoned_pid, no longer running) could not be undone automatically; nothing else was changed. Its journal $_abandoned_owner/swap-journal lists each replaced file (R: put back <file>.goodvibes-previous) and each new file (N: remove it). Once those are done, release its claims and re-run the installer: rm -rf -- $(shadow_quote "$_abandoned_owner") $(shadow_quote "$INSTALL_CLAIM_DIR")/*.update-transaction"
        fi
      else
        _abandoned_outcome='it had replaced nothing'
      fi
      INSTALL_JOURNAL=$_abandoned_own_journal
      for _abandoned_released in goodvibes-daemon goodvibes goodvibes-agent; do
        if [ "$_abandoned_owner/$_abandoned_released" -ef "$INSTALL_CLAIM_DIR/$_abandoned_released.update-transaction" ]; then
          take_abandoned_install_claim "$INSTALL_CLAIM_DIR/$_abandoned_released.update-transaction" ref "$_abandoned_owner/$_abandoned_released"
        fi
      done
      rm -rf "${_abandoned_owner:?}"
      say "  recovered  an installation interrupted earlier (process $_abandoned_pid is gone): $_abandoned_outcome; its claims were released"
      continue
    fi
    _abandoned_partial=''
    for _abandoned_companion in '' .bun .bun.json .bun.LICENSE.md .readers.json; do
      for _abandoned_tail in .update-download .update-previous .rollback-exchange .incoming; do
        _abandoned_path="$INSTALL_CLAIM_DIR/$_abandoned_product$_abandoned_companion$_abandoned_tail"
        if [ -e "$_abandoned_path" ] || [ -L "$_abandoned_path" ]; then _abandoned_partial="$_abandoned_partial
  $_abandoned_path"; fi
      done
    done
    [ -z "$_abandoned_partial" ] || fail INSTALL_E120 "An update or install that is no longer running (process $_abandoned_pid) left $_abandoned_claim with partial files beside the program; nothing was changed:$_abandoned_partial
If $INSTALL_CLAIM_DIR/$_abandoned_product is missing, put its saved copy back first: mv -f <file>.update-previous <file>. Then remove the partial files and the claim, and re-run the installer."
    [ -n "$_abandoned_identity" ] || fail INSTALL_E117 "The installation claim $_abandoned_claim cannot be read, so its owner is unknown; nothing was changed. If no goodvibes install or update is running, remove it and re-run the installer: rm -rf -- $(shadow_quote "$_abandoned_claim")"
    take_abandoned_install_claim "$_abandoned_claim" id "$_abandoned_identity"
    say "  released   $_abandoned_claim (process $_abandoned_pid is gone and no partial file remains beside the program)"
  done
}

# A run killed between creating its private claim directory and linking its
# first claim into it, or between releasing its claims and removing the
# directory, leaves a directory no claim leads to. Once this run holds every
# claim no other run can link into one (its claim creation fails and it exits),
# so every other claim directory is such a leftover. One holding a non-empty
# swap journal is named and kept; the rest are removed.
sweep_orphan_install_claim_directories() {
  for _orphan_dir in "$INSTALL_CLAIM_DIR"/.goodvibes-install-claim.*; do
    [ "$_orphan_dir" != "$INSTALL_CLAIM_OWNER" ] && [ -d "$_orphan_dir" ] && [ ! -L "$_orphan_dir" ] || continue
    _orphan_journal=''
    for _orphan_name in swap-journal swap-journal.committed; do
      if [ -f "$_orphan_dir/$_orphan_name" ] && [ ! -L "$_orphan_dir/$_orphan_name" ] && [ -s "$_orphan_dir/$_orphan_name" ]; then
        _orphan_journal="$_orphan_dir/$_orphan_name"
      fi
    done
    if [ -n "$_orphan_journal" ]; then
      say "  NOTE: $_orphan_dir was left by an installation interrupted earlier and holds its journal, which no claim leads to; it was kept."
      say "    $_orphan_journal lists each replaced file (R: put back <file>.goodvibes-previous) and each new file (N: remove it)."
      say "    Once those are done, remove it: rm -rf -- $(shadow_quote "$_orphan_dir")"
      continue
    fi
    rm -rf -- "${_orphan_dir:?}"
    say "  removed    $_orphan_dir (a claim directory an earlier installation left without claims)"
  done
}

claim_release_install() {
  _claim_purpose=${1:-install}
  case "$_claim_purpose" in install|uninstall) : ;; *) fail INSTALL_E028 'Unknown suite claim purpose.' ;; esac
  command -v stat >/dev/null 2>&1 || fail INSTALL_E029 'The native stat utility is required to retain original installation ownership.'
  if [ "$_claim_purpose" = uninstall ]; then
    [ -d "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ] && installer_open_file_matches 0 "$INSTALL_DIR" || fail INSTALL_E030 'The original uninstall directory changed before exclusion.'
  else mkdir -p "$INSTALL_DIR"
  fi
  INSTALL_CLAIM_DIR=$(CDPATH= cd -- "$INSTALL_DIR" && pwd -P) || fail INSTALL_E031 'Could not retain the installation directory.'
  # Publish only to the selected directory, even when the original option was
  # a relative path or symlink. The open descriptor detects its replacement.
  exec 9< "$INSTALL_CLAIM_DIR"
  installer_open_file_matches 9 "$INSTALL_CLAIM_DIR" || fail INSTALL_E032 'Could not retain the selected installation directory.'
  if [ "$_claim_purpose" = uninstall ]; then
    installer_open_file_matches 0 "$INSTALL_CLAIM_DIR" || fail INSTALL_E033 'The original uninstall directory changed before claiming.'
  fi
  INSTALL_DIR=$INSTALL_CLAIM_DIR
  WEBUI_ROOT="$INSTALL_DIR/webui"
  INSTALL_CLAIM_OWNER=$(mktemp -d "$INSTALL_CLAIM_DIR/.goodvibes-install-claim.XXXXXX")
  [ ! -L "$INSTALL_CLAIM_OWNER" ] || fail INSTALL_E034 'The private installation claim directory changed.'
  exec 8< "$INSTALL_CLAIM_OWNER"
  install_claim_directories_current || fail INSTALL_E035 'Could not retain the original private claim directory.'
  recover_abandoned_install_claims
  for _claim_product in goodvibes-daemon goodvibes goodvibes-agent; do
    # Occupied native transaction slots never grant execution, even while
    # their owner writes the receipt. Noclobber creates exclusively without
    # following a symlink or treating an existing directory as a destination.
    _claim_path="$INSTALL_CLAIM_DIR/$_claim_product.update-transaction"
    [ ! -e "$_claim_path" ] && [ ! -L "$_claim_path" ] || fail INSTALL_E036 "Another goodvibes update or install claimed $_claim_path while this run started; nothing was changed. Re-run the installer once it finishes."
    # The native updater shares this claim file and treats a claim as a live
    # transaction only when it parses as JSON with a numeric pid and a startedAt
    # in milliseconds. Written that way, a daemon that checks for updates during
    # this install defers instead of reading the claim as a crashed transaction.
    (umask 077; set -C; printf '{"pid":%s,"startedAt":%s000,"owner":"install.sh","version":"%s","note":"Interrupted replacement: inspect installed programs and retained claims before recovery."}\n' "$$" "$(date +%s)" "$VERSION" > "$_claim_path") || fail INSTALL_E037 "Another goodvibes update or install claimed $_claim_path while this run started; nothing was changed. Re-run the installer once it finishes."
    INSTALL_CLAIM_COUNT=$((INSTALL_CLAIM_COUNT + 1))
    case "$_claim_product" in
      goodvibes-daemon) exec 5< "$_claim_path"; _created_claim_fd=5 ;;
      goodvibes) exec 6< "$_claim_path"; _created_claim_fd=6 ;;
      goodvibes-agent) exec 7< "$_claim_path"; _created_claim_fd=7 ;;
    esac
    [ ! -L "$_claim_path" ] && installer_open_file_matches "$_created_claim_fd" "$_claim_path" || fail INSTALL_E038 'The original installation claim changed during capture.'
    _created_claim_id=$(install_claim_file_identity "$_claim_path") || fail INSTALL_E039 'Could not retain the original native installation claim.'
    [ ! -L "$_claim_path" ] && installer_open_file_matches "$_created_claim_fd" "$_claim_path" || fail INSTALL_E040 'The native installation claim changed during observation.'
    case "$_claim_product" in
      goodvibes-daemon) INSTALL_DAEMON_CLAIM_ID=$_created_claim_id ;;
      goodvibes) INSTALL_TUI_CLAIM_ID=$_created_claim_id ;;
      goodvibes-agent) INSTALL_AGENT_CLAIM_ID=$_created_claim_id ;;
    esac
    ln "$_claim_path" "$INSTALL_CLAIM_OWNER/$_claim_product" || fail INSTALL_E041 'The installer could not retain its transaction ownership. Inspect the retained claim before retrying.'
    [ ! -L "$_claim_path" ] && [ ! -L "$INSTALL_CLAIM_OWNER/$_claim_product" ] \
      && installer_open_file_matches "$_created_claim_fd" "$_claim_path" && installer_open_file_matches "$_created_claim_fd" "$INSTALL_CLAIM_OWNER/$_claim_product" \
      || fail INSTALL_E042 'The original installation claim changed before retention.'
  done
  sweep_orphan_install_claim_directories
  if [ "$_claim_purpose" = uninstall ]; then assert_install_claims; return 0; fi
  # An interrupted updater may have retained a companion slot even when its
  # primary claim is missing. Never overwrite that recovery evidence.
  for _idle_product in goodvibes-daemon goodvibes goodvibes-agent; do
    for _idle_companion in '' .bun .bun.json .bun.LICENSE.md .readers.json; do
      for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
        [ -n "$_idle_companion" ] || [ "$_idle_tail" != .update-transaction ] || continue
        _idle_path="$INSTALL_CLAIM_DIR/$_idle_product$_idle_companion$_idle_tail"
        [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail INSTALL_E043 "An interrupted update left the partial program file $_idle_path; nothing was changed. No update holds it now. If the installed programs run, remove it and re-run the installer."
      done
    done
  done
  for _idle_file in daemon-installation.json "lib/sqlite-vec-${VEC_OS}-${arch_tag}/vec0.${VEC_SUFFIX}"; do
    for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
      _idle_path="$INSTALL_CLAIM_DIR/$_idle_file$_idle_tail"
      [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail INSTALL_E044 "An interrupted update left the partial companion file $_idle_path; nothing was changed. No update holds it now. If the installed programs run, remove it and re-run the installer."
    done
  done
  if [ "$os_tag" = macos ]; then
    for _sqlite_tail in '' .json; do
      for _idle_tail in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
        _idle_path="$INSTALL_CLAIM_DIR/lib/sqlite-darwin-$arch_tag/libsqlite3.dylib$_sqlite_tail$_idle_tail"
        [ ! -e "$_idle_path" ] && [ ! -L "$_idle_path" ] || fail INSTALL_E045 "An interrupted update left the partial SQLite runtime file $_idle_path; nothing was changed. No update holds it now. If the installed programs run, remove it and re-run the installer."
      done
    done
  fi
  assert_install_library_directory "sqlite-vec-${VEC_OS}-${arch_tag}"
  if [ "$os_tag" = macos ]; then assert_install_library_directory "sqlite-darwin-$arch_tag"; fi
}

assert_install_library_directory() {
  for _library_parent in "$INSTALL_DIR/lib" "$INSTALL_DIR/lib/$1"; do
    [ ! -L "$_library_parent" ] || fail INSTALL_E046 "The native library directory $_library_parent is a symbolic link, and the installer does not replace programs through one; nothing was changed. Replace the link with a plain directory (or remove it), then re-run the installer."
    [ ! -e "$_library_parent" ] || [ -d "$_library_parent" ] || fail INSTALL_E047 'An installed native library parent is not a directory.'
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
  [ ! -e "$_library_target.incoming" ] && [ ! -L "$_library_target.incoming" ] || fail INSTALL_E048 "An interrupted run left the staged library $_library_target.incoming; nothing was changed. No install holds it now: remove it and re-run the installer: rm -rf -- $(shadow_quote "$_library_target.incoming")"
  # Journal the stage before creating it (the check above proved it is not someone else's), so an
  # interrupt while it exists is cleaned up by the rollback instead of blocking the retry.
  printf 'I%s\n' "$_library_target" >> "$INSTALL_JOURNAL" || fail INSTALL_E049 'Could not record the swap journal.'
  (set -C; cat "$WORKDIR/$_library_asset" > "$_library_target.incoming") || fail INSTALL_E050 'Could not exclusively stage the native library.'
  chmod 644 "$_library_target.incoming"
  assert_install_claims
  assert_install_library_directory "$_library_directory"
  install_journal_target "$_library_target"
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
  [ -f "$_evidence_file" ] && [ ! -L "$_evidence_file" ] || fail INSTALL_E051 "The selected $_evidence_product release has no reader evidence. The installed programs were kept."
  case "$_evidence_product" in goodvibes) _evidence_package=$EVIDENCE_ID_TUI ;; goodvibes-agent) _evidence_package=$EVIDENCE_ID_AGENT ;; goodvibes-daemon) _evidence_package=$EVIDENCE_ID_DAEMON ;; *) fail INSTALL_E052 'Unsupported native reader evidence.' ;; esac
  _evidence_target="$VEC_OS-$arch_tag"
  awk -v package="$_evidence_package" -v version="${VERSION#v}" -v target="$_evidence_target" '
    /^  "schema": 1,$/ { schema++ }
    /^  "packageName": / { if ($0 == "  \"packageName\": \"" package "\",") name++ }
    /^  "version": / { if ($0 == "  \"version\": \"" version "\",") release++ }
    /^  "target": / { if ($0 == "  \"target\": \"" target "\",") host++ }
    /^  "readers": \{$/ { readers++ }
    END { exit !(schema==1 && name==1 && release==1 && host==1 && readers==1) }
  ' "$_evidence_file" || fail INSTALL_E053 "The selected $_evidence_product reader evidence does not name this release and platform. The installed programs were kept."
  _evidence_members=''
  if [ "$os_tag" = linux ]; then _evidence_members='.bun .bun.LICENSE.md .bun.json'; fi
  for _evidence_suffix in '' $_evidence_members; do
    _evidence_member="$_evidence_asset$_evidence_suffix"
    _evidence_pin=$(awk -v wanted="$_evidence_member" '
      /"path": / { name=$0; sub(/^.*"path": "/,"",name); sub(/",? *$/,"",name); selected=(name==wanted); next }
      selected && /"sha256": / { pin=$0; sub(/^.*"sha256": "/,"",pin); sub(/",? *$/,"",pin); print pin; count++; selected=0 }
      END { if (count != 1) exit 1 }
    ' "$_evidence_file") || fail INSTALL_E054 'Reader evidence has a missing or ambiguous program pin.'
    _evidence_expected=$(release_checksum "$_evidence_member") || fail INSTALL_E055 'Reader evidence names an unavailable release member.'
    [ "$_evidence_pin" = "$_evidence_expected" ] || fail INSTALL_E056 'Reader evidence does not match the selected released program bytes. No installed program was replaced.'
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
    _reader_receipt=$("$_reader_binary" check-install-reader "$INSTALL_CLAIM_DIR/$_reader_product") || fail INSTALL_E057 "The selected $_reader_product release cannot read the saved data. The installed programs were kept; choose a compatible newer release."
    assert_install_claims
    [ "$_reader_receipt" = "$_reader_expected" ] || fail INSTALL_E058 "The selected $_reader_product did not confirm its matching compiled readers. The installed programs were kept."
  done
}

install_release_binary() {
  assert_install_claims
  _binary=$1
  _binary_asset="$_binary-$PLATFORM_SUFFIX"
  _installed_binary=$_binary
  _has_readers=0
  if [ "$_binary" != goodvibes-daemon ] || [ "$os_tag" = macos ]; then _has_readers=1; fi
  _installed_readers="$INSTALL_DIR/$_installed_binary.readers.json"
  # Stage every incoming file first. Nothing live changes until all of them exist,
  # and the main program is renamed last, so an interruption never leaves a new
  # companion beside an old program that has not yet been replaced.
  _stage_files=''
  # Linux compiled entrypoints require their adjacent, released ordinary Bun.
  # Keep the filename relationship when installing under the command name.
  if [ "$os_tag" = linux ]; then
    for _binary_suffix in .bun .bun.json .bun.LICENSE.md; do
      _stage_target="$INSTALL_DIR/$_installed_binary$_binary_suffix"
      printf 'I%s\n' "$_stage_target" >> "$INSTALL_JOURNAL" || fail INSTALL_E059 'Could not record the swap journal.'
      cp "$WORKDIR/$_binary_asset$_binary_suffix" "$_stage_target.incoming"
      case "$_binary_suffix" in .bun) chmod 755 "$_stage_target.incoming" ;; *) chmod 644 "$_stage_target.incoming" ;; esac
      _stage_files="$_stage_files $_binary_suffix"
    done
  fi
  _readers_mode=none
  if [ "$_has_readers" = 1 ]; then
    if [ -f "$WORKDIR/$_binary_asset.reader-ci-artifact.json" ]; then
      require_client_reader_evidence "$_binary"
      printf 'I%s\n' "$_installed_readers" >> "$INSTALL_JOURNAL" || fail INSTALL_E060 'Could not record the swap journal.'
      cp "$WORKDIR/$_binary_asset.reader-ci-artifact.json" "$_installed_readers.incoming"
      chmod 644 "$_installed_readers.incoming"
      _readers_mode=publish
    elif [ -e "$_installed_readers" ] || [ -L "$_installed_readers" ]; then
      _readers_mode=remove
    fi
  fi
  if [ "$_binary" = goodvibes-daemon ] && [ "$os_tag" = linux ]; then
    printf 'I%s\n' "$INSTALL_DIR/daemon-installation.json" >> "$INSTALL_JOURNAL" || fail INSTALL_E061 'Could not record the swap journal.'
    cp "$WORKDIR/daemon-installation.json" "$INSTALL_DIR/daemon-installation.json.incoming"
    chmod 644 "$INSTALL_DIR/daemon-installation.json.incoming"
  fi
  printf 'I%s\n' "$INSTALL_DIR/$_installed_binary" >> "$INSTALL_JOURNAL" || fail INSTALL_E062 'Could not record the swap journal.'
  cp "$WORKDIR/$_binary_asset" "$INSTALL_DIR/$_installed_binary.incoming"
  chmod 755 "$INSTALL_DIR/$_installed_binary.incoming"
  # Publish companions, then descriptors, then the program itself.
  for _binary_suffix in $_stage_files; do
    _stage_target="$INSTALL_DIR/$_installed_binary$_binary_suffix"
    assert_install_claims
    install_journal_target "$_stage_target"
    mv -f "$_stage_target.incoming" "$_stage_target"
  done
  case "$_readers_mode" in
    publish)
      assert_install_claims
      install_journal_target "$_installed_readers"
      mv -f "$_installed_readers.incoming" "$_installed_readers" ;;
    remove)
      # No old descriptor may describe a different newly installed executable.
      assert_install_claims
      install_journal_target "$_installed_readers"
      rm -f "$_installed_readers" ;;
  esac
  if [ "$_binary" = goodvibes-daemon ] && [ "$os_tag" = linux ]; then
    assert_install_claims
    install_journal_target "$INSTALL_DIR/daemon-installation.json"
    mv -f "$INSTALL_DIR/daemon-installation.json.incoming" "$INSTALL_DIR/daemon-installation.json"
  fi
  assert_install_claims
  install_journal_target "$INSTALL_DIR/$_installed_binary"
  mv -f "$INSTALL_DIR/$_installed_binary.incoming" "$INSTALL_DIR/$_installed_binary"
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

# The first argument (one per line on stdin, executable already dropped) that
# names a subcommand, or nothing when the process was started bare or with flags
# only (a server). Arguments holding a '/' (a bun-embedded script path) are not
# subcommands.
args_subcommand() {
  awk 'index($0, "/") > 0 { next } { if (NF && substr($0, 1, 1) != "-") print; exit }'
}
proc_subcommand() {
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' '\n' < "/proc/$1/cmdline" | tail -n +2 | args_subcommand
  else
    ps -o args= -p "$1" 2>/dev/null | tr ' ' '\n' | tail -n +2 | args_subcommand
  fi
}

# Whether a pgrep match is the long-running program itself. `pgrep -f` also
# matches a short-lived call of the same binary (`goodvibes-daemon status
# --json`, `config get`) and any other process that merely carries the name in
# its arguments, such as the terminal UI; SIGTERM on those would kill a
# person's unrelated command and the relaunch would start a daemon nobody asked
# for. The executable must be the named program, and for the daemon the only
# subcommand that means "run" is `serve`, for the agent it is `tui` or none.
proc_is_the_program() {
  _pitp_name=$(printf '%s' "$2" | tr -d '[]')
  _pitp_exe=$(proc_exe_path "$1")
  case "${_pitp_exe##*/}" in
    "$_pitp_name"|"$_pitp_name".*|"$_pitp_name"-*) : ;;
    *) return 1 ;;
  esac
  case "$_pitp_name" in
    goodvibes-daemon)
      case "$(proc_subcommand "$1")" in
        ''|serve) return 0 ;;
        *) return 1 ;;
      esac ;;
    goodvibes-agent)
      # The agent's long-running program is the terminal UI (bare, or `tui`);
      # `run`, `memory` and `doctor` are one-shot calls that must not be stopped.
      case "$(proc_subcommand "$1")" in
        ''|tui) return 0 ;;
        *) return 1 ;;
      esac ;;
    *) return 0 ;;
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
    if proc_belongs_to_install_dir "$_p" && proc_is_the_program "$_p" "$1"; then
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
      # could not be ASKED, and cannot-ask is never read as free-to-kill. The
      # label is the daemon's own, as the daemon reported it; without it
      # nothing can be asked.
      if [ -z "$DAEMON_SERVICE_NAME" ]; then
        printf 'unknown'
        return 0
      fi
      _lrc=0
      _lout=$(launchctl print "gui/$(id -u)/$DAEMON_SERVICE_NAME" 2>/dev/null) || _lrc=$?
      if [ "$_lrc" -eq 0 ]; then
        # Anchored: pid 123 must not match an agent that runs as pid 1234.
        if printf '%s\n' "$_lout" | grep -Eq "^[[:space:]]*pid = $_q[[:space:]]*$"; then
          printf 'supervised'
          return 0
        fi
      elif [ "$_lrc" -ne 113 ]; then
        printf 'unknown'
        return 0
      fi
      # The daemon's label affirmatively does not own it. launchd supervision
      # under a foreign label is not cheaply enumerable; the practical
      # supervision surface for the goodvibes binaries is the daemon's label.
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

# Upgrade: bring the daemon's own service definition to the current launch BEFORE
# the restart below, so the restart applies it. The daemon decides whether the
# file is its own and what the current launch is: one an older release wrote
# (pinned --hostname/--port, an explicit --daemon-home, a moved program, no
# working directory) is rewritten with a backup beside it, one that is current is
# left untouched, and one GoodVibes did not write is never written over. Silent
# when nothing changed.
refresh_daemon_service() {
  DAEMON_DEFINITION_CHANGED=0
  [ "$DAEMON_SERVICE_KNOWN" = "1" ] || return 0
  [ "$DAEMON_SERVICE_INSTALLED" = "1" ] || return 0
  case "$DAEMON_SERVICE_OWNER" in
    product) : ;;
    other)
      say ""
      say "NOTE: the daemon service definition at $DAEMON_SERVICE_PATH was not written by GoodVibes,"
      say "  so it was left as it is and keeps whatever launch it names. To have upgrades keep it current,"
      say "  move it aside and run: $INSTALL_DIR/goodvibes-daemon refresh-service"
      return 0
      ;;
    *)
      say ""
      say "NOTE: the daemon service definition at $DAEMON_SERVICE_PATH could not be read; it was left as it is."
      return 0
      ;;
  esac
  _rf_before=$(cksum < "$DAEMON_SERVICE_PATH" 2>/dev/null || :)
  _rf_rc=0
  _rf_out=$(daemon_service_command refresh-service 2>&1) || _rf_rc=$?
  _rf_after=$(cksum < "$DAEMON_SERVICE_PATH" 2>/dev/null || :)
  [ "$_rf_before" = "$_rf_after" ] || DAEMON_DEFINITION_CHANGED=1
  if [ "$DAEMON_DEFINITION_CHANGED" != "1" ] && [ "$_rf_rc" -eq 0 ]; then return 0; fi
  say ""
  say "Refreshing the daemon service $(daemon_service_unit) ..."
  say_indented "$_rf_out"
  if [ "$_rf_rc" -ne 0 ]; then
    say "  NOTE: goodvibes-daemon refresh-service exited $_rf_rc; its lines above say what was and was not changed."
    say "  Once that is fixed, run it again:  $INSTALL_DIR/goodvibes-daemon refresh-service"
  elif [ "$RESTART_DAEMON" != "1" ]; then
    say "  NOTE: GOODVIBES_RESTART_DAEMON=0; a running daemon keeps its previous launch until restarted:"
    say "    $INSTALL_DIR/goodvibes-daemon restart-service"
  fi
  return 0
}

restart_systemd_unit() {
  # restart_systemd_unit <unit> <expected-binary> — returns 0 if it handled an
  # active unit (restarted, or reported and left alone), 1 if no active unit
  # exists, so the caller falls through to bare-process handling and then
  # first-run service setup.
  unit="$1"
  expected_bin="$2"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$unit" 2>/dev/null || return 1

  # A unit whose ExecStart binary no longer exists cannot be brought back by
  # restarting it: that only "restarts" a corpse, and the running process may be
  # executing a deleted binary that a restart would end with nothing to start.
  # The daemon's own unit was already rewritten to the current program by
  # refresh_daemon_service, so a unit still in this state was not written by
  # GoodVibes (or could not be refreshed): it is reported and left untouched. A
  # unit whose ExecStart is a DIFFERENT but still-existing binary (a genuinely
  # hand-written working unit) keeps the ordinary restart-and-note behavior below.
  exec_bin=$(systemd_unit_exec_binary "$unit")
  if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
    say ""
    say "NOTE: ${unit} points at $exec_bin, which no longer exists; leaving it (and its running"
    say "  process, which may be executing a deleted binary) untouched."
    say "  Fix the unit's ExecStart yourself (for the daemon's own unit: $INSTALL_DIR/goodvibes-daemon refresh-service),"
    say "  then: systemctl --user restart $unit"
    return 0
  fi

  say ""
  say "Restarting the running ${unit%.service} (systemd user service) ..."
  # The unit is Type=simple, so systemctl returns once the process is forked.
  # Restarted only once the daemon's runtime record (written after its listener
  # is bound, in the daemon home that process runs with) names the unit's new
  # main pid while that pid is alive; a daemon that dies during startup is not.
  _rsu_restarted=0
  _rsu_serving=0
  if systemctl --user restart "$unit" 2>/dev/null; then
    _rsu_restarted=1
    _rsu_pid=$(systemctl --user show "$unit" --property=MainPID --value 2>/dev/null || :)
    case "$_rsu_pid" in ''|0|*[!0-9]*) _rsu_pid='' ;; esac
    if [ -n "$_rsu_pid" ]; then
      while pid_alive "$_rsu_pid" && ! daemon_record_names_pid "$_rsu_pid" "$(daemon_record_of_process "$_rsu_pid")"; do
        sleep 1
      done
      if daemon_record_names_pid "$_rsu_pid" "$(daemon_record_of_process "$_rsu_pid")" && pid_alive "$_rsu_pid"; then
        _rsu_serving=1
      fi
    fi
  fi
  if [ "$_rsu_serving" = 1 ]; then
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
    DAEMON_RESTART_FAILED=1
    if [ "$_rsu_restarted" = 1 ]; then
      _rsu_state=$(systemctl --user show "$unit" --property=ActiveState --value 2>/dev/null || :)
      say "  NOTE: $unit was restarted but its daemon exited before it was serving (the unit is ${_rsu_state:-in an unknown state}). See why with:"
      say "    systemctl --user status $unit"
      say "    journalctl --user -u $unit"
    else
      say "  NOTE: restart failed; see why, then restart it yourself:"
      say "    systemctl --user status $unit"
      say "    journalctl --user -u $unit"
      say "    systemctl --user restart $unit"
    fi
  fi
  return 0
}

# Whether a process is alive: it exists and is not a zombie (a relaunched child
# this shell has not reaped still answers kill -0).
pid_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -o stat= -p "$1" 2>/dev/null || :)" in Z*) return 1 ;; esac
  return 0
}

# Whether the daemon's runtime record names a pid. The daemon writes the record
# (detached-daemon.json in its daemon home) only once its listener is bound.
# daemon_record_names_pid <pid> [<record path>]: without a path, the record in
# the daemon home this installer's own environment selects.
daemon_record_names_pid() {
  _drn_record="${2:-${GOODVIBES_DAEMON_HOME:-${GOODVIBES_HOME:-$HOME}/.goodvibes/daemon}/detached-daemon.json}"
  [ -f "$_drn_record" ] && grep -Eq '"pid": *'"$1"'([^0-9]|$)' "$_drn_record"
}

# The runtime record path of the daemon running as <pid>, from that process's
# own arguments and environment, resolved as the daemon resolves its home:
# --daemon-home, else GOODVIBES_DAEMON_HOME, else .goodvibes/daemon under
# GOODVIBES_HOME, else under its HOME. A unit for a second daemon carries its
# home in its own definition, which this installer's environment does not.
daemon_record_of_process() {
  _drp_home=$(tr '\0' '\n' 2>/dev/null < "/proc/$1/cmdline" | awk '
    take { print; exit }
    $0 == "--daemon-home" { take = 1; next }
    index($0, "--daemon-home=") == 1 { print substr($0, 15); exit }' || :)
  if [ -z "$_drp_home" ]; then
    _drp_env=$(tr '\0' '\n' 2>/dev/null < "/proc/$1/environ" || :)
    _drp_home=$(printf '%s\n' "$_drp_env" | sed -n 's/^GOODVIBES_DAEMON_HOME=//p' | head -n 1)
    if [ -z "$_drp_home" ]; then
      _drp_tree=$(printf '%s\n' "$_drp_env" | sed -n 's/^GOODVIBES_HOME=//p' | head -n 1)
      [ -n "$_drp_tree" ] || _drp_tree=$(printf '%s\n' "$_drp_env" | sed -n 's/^HOME=//p' | head -n 1)
      _drp_home="${_drp_tree:-$HOME}/.goodvibes/daemon"
    fi
  fi
  printf '%s/detached-daemon.json' "$_drp_home"
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
  # from. The daemon service's own launch (the bare
  # "$INSTALL_DIR/goodvibes-daemon", no arguments, which is what
  # goodvibes-daemon install-service writes for the default home) is used
  # instead for the daemon: it resolves everything else (host/port, etc.) from
  # settings at startup, so nothing is lost by not replaying old flags, and
  # the relaunch runs from $HOME rather than the installer's own (possibly
  # scratch/temp) cwd. goodvibes-agent has no canonical invocation known to
  # this installer (it has no service of its own here), so its original
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
    # A program running in someone's terminal (an interactive goodvibes-agent,
    # a daemon in the foreground) is never stopped: a relaunch would have no
    # terminal, so it would take the session away. It keeps the version it
    # started with; the person running it is told to restart it.
    _tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ' || :)
    case "$_tty" in
      ''|'?'|'??') : ;;
      *)
        say ""
        say "Leaving ${new_bin##*/} (pid $pid) running: it is attached to terminal $_tty and still runs the previous version."
        say "  Quit it and start it again in that terminal to use $VERSION."
        continue ;;
    esac
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
        # The arguments are replayed unquoted below, so an argument with
        # whitespace or a glob character (or an empty one) would be split,
        # expanded or dropped. Such a process is left running, untouched, and
        # the exact command to restart it is printed with every argument quoted.
        _unsafe_args=$(tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2 | grep -Ec '[[:space:]*?[]|^$' || :)
        # An argument with an embedded newline shows up as extra lines: more lines than NUL terminators.
        _cmd_nuls=$(( $(tr -cd '\0' < "/proc/$pid/cmdline" | wc -c) ))
        _cmd_lines=$(( $(tr '\0' '\n' < "/proc/$pid/cmdline" | wc -l) ))
        _has_newline=0
        [ "$_cmd_nuls" = "$_cmd_lines" ] || _has_newline=1
        if [ "${_unsafe_args:-0}" != 0 ] || [ "$_has_newline" = 1 ]; then
          say ""
          say "Skipping pid $pid: its arguments contain spaces, wildcard characters or newlines that cannot be replayed safely."
          if [ "$_has_newline" = 1 ]; then
            say "  Nothing was touched. An argument contains a newline, so it cannot be shown on one line; read the exact"
            say "  arguments with: tr '\\0' '\\n' < /proc/$pid/cmdline   then stop pid $pid and start $(shadow_quote "$new_bin") yourself."
          else
            # The trailing marker keeps command substitution from dropping a final empty argument.
            _all_args=$(tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2; printf x)
            _all_args=${_all_args%x}
            _quoted_args=$(printf '%s' "$_all_args" | while IFS= read -r _one_arg; do printf ' %s' "$(shadow_quote "$_one_arg")"; done)
            say "  Nothing was touched. To run the new ${new_bin##*/} yourself: stop pid $pid (kill $pid), then run:"
            say "    nohup $(shadow_quote "$new_bin")$_quoted_args >/dev/null 2>&1 &"
          fi
          continue
        fi
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
    # The daemon ends itself at its shutdown deadline after draining, so it is
    # waited for until it is gone; another program carries no such promise and
    # gets 10 s.
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      [ "$_is_daemon" = "1" ] || [ "$waited" -lt 10 ] || break
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "  NOTE: pid $pid did not exit within 10s; not starting a second instance."
      say "  Stop it, then start the new one: $new_bin ${display_args:-}"
      continue
    fi

    if [ "$_is_daemon" = "1" ]; then
      # Canonical relaunch: the fixed binary with no arguments, matching
      # the ExecStart the daemon writes for its service, run from $HOME — never the
      # installer's own (possibly scratch/temp) cwd, and never any argv carried
      # over from the process just stopped. The daemon resolves its own default
      # state directory; $HOME stays the working directory, which is what the
      # unit gets from systemd by default.
      (
        cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true
        exec nohup "$new_bin" >/dev/null 2>&1
      ) &
      newpid=$!
      # Restarted once the daemon's runtime record names the new pid (it is
      # written after the listener is bound); not started when the process ends first.
      while pid_alive "$newpid" && ! daemon_record_names_pid "$newpid"; do
        sleep 1
      done
      if daemon_record_names_pid "$newpid" && pid_alive "$newpid"; then
        say "  restarted  pid $newpid"
      else
        DAEMON_RESTART_FAILED=1
        say "  NOTE: the new daemon (pid $newpid) exited before it was serving. Run it in a terminal to see why:"
        say "    $new_bin"
      fi
      continue
    fi
    # shellcheck disable=SC2086  # args is intentionally word-split
    nohup "$new_bin" ${args:-} >/dev/null 2>&1 &
    newpid=$!
    sleep 1
    if pid_alive "$newpid"; then
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
    DAEMON_RESTART_FAILED=1
    say "  NOTE: restart failed; restart it yourself with:"
    say "    launchctl kickstart -k gui/$(id -u)/$_label"
  fi
  return 0
}

# Reload a loaded launchd agent whose plist refresh_daemon_service rewrote in this
# run: kickstart restarts the process but keeps the plist launchd loaded, so the
# new launch needs bootout + bootstrap. If the rewritten plist will not load, the
# backup goodvibes-daemon kept beside it is put back and loaded, so the agent
# keeps running as before. Returns 1 when the label is not loaded (the caller
# falls through to the guarded bare-process path; an agent the owner unloaded is
# never loaded here, and its new definition applies when it is).
reload_launchd_agent() {
  _rl_label="$1"
  _rl_path="$2"
  command -v launchctl >/dev/null 2>&1 || return 1
  _rl_uid=$(id -u)
  _prc=0
  launchctl print "gui/$_rl_uid/$_rl_label" >/dev/null 2>&1 || _prc=$?
  if [ "$_prc" -ne 0 ]; then
    if [ "$_prc" -eq 113 ]; then
      say ""
      say "NOTE: the $_rl_label agent is not loaded, so it was left stopped; its refreshed definition applies when you load it:"
      say "    launchctl bootstrap gui/$_rl_uid $_rl_path"
      return 1
    fi
    say ""
    say "NOTE: cannot determine the $_rl_label agent state (launchctl print failed, is the GUI session"
    say "  reachable from this session?). No process was touched; reload the agent yourself from a"
    say "  logged-in session:  launchctl bootout gui/$_rl_uid/$_rl_label ; launchctl bootstrap gui/$_rl_uid $_rl_path"
    return 0
  fi
  say ""
  say "Reloading the running $_rl_label (launchd user agent) with its refreshed definition ..."
  # Only the gui/<uid> verbs: the legacy load/unload act on the caller's own
  # domain (not this agent's from an SSH login) and exit 0 whatever happened,
  # so as a fallback they turned a failed load into "reloaded". bootout can
  # return before launchd lets go of the job, so the bootstrap waits until the
  # old job is gone; a bootstrap that fails after that is the new plist's own.
  if ! bootout_launchd_job "$_rl_uid" "$_rl_label"; then
    DAEMON_RESTART_FAILED=1
    say "  NOTE: launchd still lists $_rl_label after bootout, so the refreshed definition was not loaded. From a"
    say "  logged-in session: launchctl bootout gui/$_rl_uid/$_rl_label ; launchctl bootstrap gui/$_rl_uid $_rl_path"
    return 0
  fi
  if launchctl bootstrap "gui/$_rl_uid" "$_rl_path" 2>/dev/null; then
    say "  reloaded   $_rl_label"
    return 0
  fi
  DAEMON_RESTART_FAILED=1
  _rl_backup=$(newest_definition_backup "$_rl_path")
  if [ -n "$_rl_backup" ] && [ -f "$_rl_backup" ] && cp -p "$_rl_backup" "$_rl_path" 2>/dev/null; then
    if launchctl bootstrap "gui/$_rl_uid" "$_rl_path" 2>/dev/null; then
      say "  NOTE: the refreshed LaunchAgent could not be loaded, so the previous $_rl_path (kept at $_rl_backup)"
      say "  was put back and loaded; $_rl_label is running as before, without the new launch."
    else
      say "  NOTE: the refreshed LaunchAgent could not be loaded; the previous $_rl_path was put back"
      say "  (copy at $_rl_backup) but it could not be loaded either. Load it yourself:"
      say "    launchctl bootstrap gui/$_rl_uid $_rl_path"
    fi
  else
    say "  NOTE: could not reload the LaunchAgent and the previous file could not be restored; load it yourself:"
    say "    launchctl bootstrap gui/$_rl_uid $_rl_path"
  fi
  return 0
}

# Boot a launchd job out and wait until launchd has let go of it: its process
# (read from launchctl print before the bootout) has exited and its label is no
# longer listed. The daemon ends itself at its shutdown deadline and launchd
# kills the job at its ExitTimeOut, so the wait ends on that event. Returns 1
# when bootout failed and the label is still listed once the process is gone.
bootout_launchd_job() {
  _bl_pid=$(launchctl print "gui/$1/$2" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -n 1 || :)
  _bl_rc=0
  launchctl bootout "gui/$1/$2" 2>/dev/null || _bl_rc=$?
  if [ -n "$_bl_pid" ]; then
    while kill -0 "$_bl_pid" 2>/dev/null; do sleep 0.25; done
  fi
  if [ "$_bl_rc" -ne 0 ]; then
    ! launchctl print "gui/$1/$2" >/dev/null 2>&1
    return
  fi
  while launchctl print "gui/$1/$2" >/dev/null 2>&1; do sleep 0.25; done
  return 0
}

# Every other daemon service GoodVibes wrote for this user (a second daemon
# under its own service.serviceName, with its own GOODVIBES_HOME) runs the
# same program file, so it is restarted too when it is running. One that is
# stopped is left stopped. Its definition names the program by path, so a
# restart is enough; nothing else of it changes.
restart_other_daemon_services() {
  [ -n "$DAEMON_PRODUCT_SERVICES" ] || return 0
  for _other in $DAEMON_PRODUCT_SERVICES; do
    [ "$_other" != "$DAEMON_SERVICE_NAME" ] || continue
    if [ "$DAEMON_SERVICE_PLATFORM" = systemd ]; then
      restart_systemd_unit "$_other.service" "$INSTALL_DIR/goodvibes-daemon" || :
    else
      restart_launchd_agent "$_other" || :
    fi
  done
}

restart_running_daemon() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  restart_other_daemon_services
  if [ "$os_tag" = "macos" ]; then
    if [ "$DAEMON_SERVICE_KNOWN" = "1" ]; then
      if [ "$DAEMON_DEFINITION_CHANGED" = "1" ]; then
        reload_launchd_agent "$DAEMON_SERVICE_NAME" "$DAEMON_SERVICE_PATH" && return 0
      else
        restart_launchd_agent "$DAEMON_SERVICE_NAME" && return 0
      fi
    fi
    restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
    return 0
  fi
  if [ "$DAEMON_SERVICE_KNOWN" = "1" ]; then
    restart_systemd_unit "$(daemon_service_unit)" "$INSTALL_DIR/goodvibes-daemon" && return 0
  fi
  restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
}

restart_running_agent() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  # The agent has no service of its own. One in a terminal is left running and
  # named (restart_bare_processes never stops a program that has a terminal);
  # one without a terminal is restarted in place.
  restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
}

# --- daemon liveness detection (shared by first-run setup and uninstall) ---
# A systemd user unit reported active, OR a bare goodvibes-daemon process.

daemon_systemd_active() {
  [ "$DAEMON_SERVICE_KNOWN" = "1" ] && [ "$DAEMON_SERVICE_PLATFORM" = "systemd" ] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$(daemon_service_unit)" 2>/dev/null
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
# running AND no service definition exists yet, the daemon registers itself as a
# user service (`goodvibes-daemon install-service`), so it comes up now and on
# every login, and at boot when lingering could be enabled (its receipt says
# which). An existing definition is never replaced here: the upgrade path
# (refresh_daemon_service, restart_running_daemon) owns an installed service.
# Every outcome is stated plainly; success is never faked.
setup_daemon_service() {
  if [ "$DAEMON_SERVICE" != "1" ]; then
    say ""
    say "Daemon service setup skipped (--no-service); service.enabled records that this machine runs without one,"
    say "  so a daemon started by hand does not install one. Start the daemon yourself with:"
    say "  $INSTALL_DIR/goodvibes-daemon"
    return 0
  fi

  # A daemon already running (its systemd unit reports active, or a process
  # from this install directory) was handled by restart_running_daemon; no
  # service is set up beside it.
  daemon_running && return 0

  # Without a stated choice, a daemon whose service the owner removed
  # (goodvibes-daemon uninstall-service records service.enabled=false) gets none back.
  if [ "$DAEMON_SERVICE_EXPLICIT" != "1" ] \
    && [ "$(daemon_setting_value service.enabled)" = "false" ]; then
    say ""
    say "Daemon service: off by your choice (service.enabled is false), so none was set up."
    say "  To run the daemon as a service:  $INSTALL_DIR/goodvibes-daemon install-service"
    return 0
  fi

  say ""
  case "$os_tag" in
    linux) _sds_manager=systemctl ;;
    macos) _sds_manager=launchctl ;;
    *) _sds_manager='' ;;
  esac
  if [ -z "$_sds_manager" ] || ! command -v "$_sds_manager" >/dev/null 2>&1; then
    # No supported user service manager available (or the tool is missing).
    say "No user service manager (systemd/launchd) is available to run the daemon"
    say "automatically. Start it yourself with:"
    say "  $INSTALL_DIR/goodvibes-daemon"
    return 0
  fi
  if [ "$DAEMON_SERVICE_KNOWN" != "1" ]; then
    SERVICE_NOT_SET_UP=1
    say "NOTE: goodvibes-daemon could not report on its service (is the user service manager reachable"
    say "  from this session?), so no service was set up. Set it up yourself from a logged-in session:"
    say "    $INSTALL_DIR/goodvibes-daemon install-service"
    return 0
  fi
  if [ "$DAEMON_SERVICE_INSTALLED" = "1" ]; then
    say "A daemon service definition already exists at $DAEMON_SERVICE_PATH; leaving it as is."
    say "  Start it yourself if it is not running:"
    say "    $INSTALL_DIR/goodvibes-daemon start-service"
    return 0
  fi

  say "Setting up the goodvibes daemon as a $DAEMON_SERVICE_PLATFORM user service ..."
  _sds_rc=0
  _sds_out=$(daemon_service_command install-service 2>&1) || _sds_rc=$?
  say_indented "$_sds_out"
  case "$_sds_rc" in
    0)
      DAEMON_SERVICE_INSTALLED=1
      DAEMON_SERVICE_OWNER=product
      ;;
    3)
      DAEMON_SERVICE_INSTALLED=1
      DAEMON_SERVICE_OWNER=product
      SERVICE_NOT_RUNNING=1
      say "  NOTE: the service is installed but not running yet. Inspect it with:"
      say "    $INSTALL_DIR/goodvibes-daemon service-status"
      ;;
    *)
      SERVICE_NOT_SET_UP=1
      say "  NOTE: goodvibes-daemon install-service exited $_sds_rc (see above), so the daemon is not set up as a service."
      say "  Once that is fixed, run it again from a logged-in session:"
      say "    $INSTALL_DIR/goodvibes-daemon install-service"
      ;;
  esac
  return 0
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
    fail INSTALL_E063 "the installed goodvibes-daemon binary failed to run ('goodvibes-daemon --version')"
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
# "set up the wake word" (System, Voice) fetches it on demand.
#
# GOODVIBES_WAKE_MODEL=0 skips it, for an air-gapped host or a user who does not
# want the feature.
install_wake_word_model() {
  [ "$WITH_WAKE_MODEL" = "1" ] || {
    say ""
    say "  note: skipping the wake-word model (GOODVIBES_WAKE_MODEL=0). Wake-word"
    say "  detection will report not-provisioned until you run: goodvibes-daemon provision-wake-model"
    say "  (or, in goodvibes: the menu, System, Voice, \"set up the wake word\")"
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
    say "  will fetch its model at the next daemon start, or in goodvibes: the menu, System, Voice, \"set up the wake word\""
  fi
}

# --- the programs' hashes, recorded where the daemon trusts them ---
# `goodvibes-daemon record-installed-programs` writes <daemon home>/program-hashes.json
# (0600) from the reader files this run placed. A daemon that finds none records them
# once at its start, so a failure here is said and the install still stands.
record_program_hashes() {
  [ "$os_tag" = linux ] || return 0
  [ -x "$INSTALL_DIR/goodvibes-daemon" ] || return 0
  if "$INSTALL_DIR/goodvibes-daemon" record-installed-programs >/dev/null 2>&1; then
    say "  recorded   the programs' hashes in the daemon's home"
  else
    say "  note: the programs' hashes were not recorded in the daemon's home now; the daemon records them at its next start"
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
    fail INSTALL_E064 "the installed goodvibes-agent binary failed to run ('goodvibes-agent --version')"
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
      [ ! -L "$_directory_parent" ] || fail INSTALL_E065 'The WebUI directory is an alias; its existing deployment was preserved.'
      if [ ! -e "$_directory_parent" ]; then
        assert_install_claims
        # The scoped umask makes this new original level mode700.
        mkdir "$_directory_parent" || fail INSTALL_E066 'Could not exclusively create the WebUI directory.'
      fi ;;
    *) fail INSTALL_E067 'Released directories must belong to this original suite installation.' ;;
  esac
  [ -d "$_directory_parent" ] && [ ! -L "$_directory_parent" ] || fail INSTALL_E068 'The original directory publication parent is unavailable.'
  exec 0< "$_directory_parent"
  installer_open_file_matches 0 "$_directory_parent" || fail INSTALL_E069 'Could not retain the original directory publication parent.'
  [ -d "$_directory_source" ] && [ ! -L "$_directory_source" ] || fail INSTALL_E070 'Verified directory staging is unavailable.'
  exec 7< "$_directory_source"
  installer_open_file_matches 7 "$_directory_source" || fail INSTALL_E071 'Verified directory staging changed.'
  [ ! -e "$_directory_target.incoming" ] && [ ! -L "$_directory_target.incoming" ] || fail INSTALL_E072 "An interrupted run left the staged directory $_directory_target.incoming; it was preserved and nothing was changed. If no goodvibes install or update is running, remove it and re-run the installer: rm -rf -- $(shadow_quote "$_directory_target.incoming")"
  _directory_had_old=0
  if [ -e "$_directory_target" ] || [ -L "$_directory_target" ]; then
    [ -d "$_directory_target" ] && [ ! -L "$_directory_target" ] || fail INSTALL_E073 'The existing directory target is a custom file or alias; it was preserved.'
    exec 6< "$_directory_target"
    installer_open_file_matches 6 "$_directory_target" || fail INSTALL_E074 'Could not retain the original installed directory.'
    _directory_had_old=1
  fi
  # A repair run, or any re-run of the same release, finds exactly the files it was
  # about to publish. Swapping them would park a full copy of the old tree that
  # nothing ever deletes (the marker is not a deletion receipt) and would rename a
  # directory a running daemon may be serving, for no change. Leave it in place.
  if [ "$_directory_had_old" = 1 ] && diff -r "$_directory_source" "$_directory_target" >/dev/null 2>&1; then
    return 0
  fi
  _directory_work=$(mktemp -d "$_directory_parent/.goodvibes-directory-install.XXXXXX") || fail INSTALL_E075 'Could not reserve private directory staging.'
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
    trap - EXIT INT TERM HUP
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
      # The update succeeded and its claim is released, but the suite swap may still fail and roll
      # back, so the superseded tree is not deleted here: it is queued ("O") for the commit step,
      # which runs only after the whole swap finished. Only a driver tree published by a DIFFERENT
      # release is queued; the same release reinstalled, and every WebUI tree, is retained (the
      # release marker is not a deletion receipt, and WebUI directories are deliberately never pruned).
      _directory_queued=0
      if [ "$_directory_had_old" = 1 ] && [ -n "$INSTALL_JOURNAL" ] && [ "$_directory_parent" = "$INSTALL_DIR" ] && _directory_base_current \
        && [ -d "$_directory_outgoing" ] && [ ! -L "$_directory_outgoing" ] && installer_open_file_matches 6 "$_directory_outgoing" \
        && [ -f "$_directory_outgoing/.goodvibes-release.json" ] && [ ! -L "$_directory_outgoing/.goodvibes-release.json" ] \
        && ! grep -qF "\"version\":\"${VERSION#v}\"" "$_directory_outgoing/.goodvibes-release.json" 2>/dev/null; then
        # T names the directory the parked tree (O) came from, so a rollback of the suite puts it back there.
        if printf 'T%s\nO%s\n' "$_directory_target" "$_directory_outgoing" >> "$INSTALL_JOURNAL"; then _directory_queued=1; fi
      fi
      if _directory_base_current && rmdir "$_directory_work" 2>/dev/null; then :
      elif [ "$_directory_queued" = 1 ]; then say "  retained   $_directory_work (the previous directory is removed when the whole suite install has finished)"
      else say "  retained   $_directory_work (previous directory or additional files)"
      fi
    fi
    exit "$_directory_exit"
  }
  trap _directory_finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  _directory_base_current || fail INSTALL_E076 'Original directory staging changed.'
  [ ! -e "$_directory_claim" ] && [ ! -L "$_directory_claim" ] || fail INSTALL_E077 'Another directory update or interrupted publication owns this target.'
  (set -C; printf 'GoodVibes directory installation %s\n' "$VERSION" > "$_directory_claim") || fail INSTALL_E078 'Could not claim the original directory target.'
  ln "$_directory_claim" "$_directory_work/claim" || fail INSTALL_E079 'Could not retain the directory claim; inspect it before retrying.'
  exec 3< "$_directory_work/claim"
  _directory_claim_owned=1
  _directory_claim_current || fail INSTALL_E080 'The directory claim changed before staging.'
  mkdir "$_directory_incoming" || fail INSTALL_E081 'Could not exclusively create incoming directory staging.'
  exec 4< "$_directory_incoming"
  _directory_incoming_owned=1
  _directory_original_current || fail INSTALL_E082 'Original directory sources changed before copying.'
  cp -Rp "$_directory_source/." "$_directory_incoming/" || fail INSTALL_E083 'Could not copy the verified directory into its private publication stage.'
  _directory_original_current || fail INSTALL_E084 'Original directory sources changed while copying.'
  chmod 755 "$_directory_incoming" || fail INSTALL_E085 'Could not set incoming directory permissions.'
  _directory_original_current || fail INSTALL_E086 'Original directory sources changed before publication.'
  if [ "$_directory_had_old" = 1 ]; then
    [ ! -e "$_directory_outgoing" ] && [ ! -L "$_directory_outgoing" ] || fail INSTALL_E087 'An unknown outgoing directory slot appeared.'
    mv "$_directory_target" "$_directory_outgoing" || fail INSTALL_E088 'Could not park the original directory.'
    _directory_claim_current || fail INSTALL_E089 'Original directory ownership changed after parking.'
    [ ! -L "$_directory_outgoing" ] && installer_open_file_matches 6 "$_directory_outgoing" || fail INSTALL_E090 'The parked original directory changed.'
  fi
  [ ! -e "$_directory_target" ] && [ ! -L "$_directory_target" ] || fail INSTALL_E091 'A foreign live directory appeared; it was preserved.'
  [ ! -L "$_directory_incoming" ] && installer_open_file_matches 4 "$_directory_incoming" || fail INSTALL_E092 'The original incoming directory changed.'
  mv "$_directory_incoming" "$_directory_target" || fail INSTALL_E093 'Could not publish the retained incoming directory.'
  _directory_claim_current || fail INSTALL_E094 'Original directory ownership changed after publication.'
  [ ! -L "$_directory_target" ] && installer_open_file_matches 4 "$_directory_target" || fail INSTALL_E095 'The directory rename result is unknown.'
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

  # The owner's choice is kept: with a bundle directory already configured and
  # serving off (`webui disable`), only the directory moves to this version's
  # bundle, so a later `goodvibes-daemon webui enable` serves the current one.
  # `webui status --json` is one line (schema goodvibes.daemon.webui-binding).
  webui_state=$("$INSTALL_DIR/goodvibes-daemon" webui status --json 2>/dev/null) || webui_state=''
  webui_serve=$(printf '%s\n' "$webui_state" | sed -n 's/.*"serve":\(true\).*/\1/p; s/.*"serve":\(false\).*/\1/p' | head -n 1)
  webui_bundle=$(printf '%s\n' "$webui_state" | sed -n 's/.*"bundleDir":"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$webui_bundle" ] && [ "$webui_serve" = false ]; then
    if "$INSTALL_DIR/goodvibes-daemon" config set controlPlane.webui.bundleDir "$webui_target" >/dev/null 2>&1; then
      WEBUI_LEFT_OFF=1
      say "  Web UI: left off (you turned it off). Turn it on: goodvibes-daemon webui enable"
    else
      WEBUI_NOT_CONFIGURED=1
      say "  NOTE: the web UI is off and its bundle directory could not be moved to $webui_target. Run:"
      say "    goodvibes-daemon config set controlPlane.webui.bundleDir $webui_target"
    fi
    return 0
  fi

  # Point the daemon at it. The binary owns the settings; this reads its
  # receipt (`webui enable --json`, schema goodvibes.daemon.webui-enable: one key
  # and one `lines` entry per line) and prints its lines, so the install's own
  # output states the URL and the posture.
  # Not fatal: an unconfigured bundle on disk is a working install of everything
  # else plus one command to run, whereas an aborted install is neither.
  webui_output=$("$INSTALL_DIR/goodvibes-daemon" webui enable --bundle-dir "$webui_target" --json 2>&1) && webui_ok=1 || webui_ok=0
  printf '%s\n' "$webui_output" | awk '
    /^  "lines": \[\]/ { exit }
    /^  "lines": \[/ { inside = 1; next }
    inside && /^  \]/ { exit }
    inside { sub(/^    "/, ""); sub(/",?$/, ""); gsub(/\\"/, "\""); gsub(/\\\\/, "\\"); print "  " $0 }'
  if [ "$webui_ok" != "1" ]; then
    WEBUI_NOT_CONFIGURED=1
    webui_error=$(printf '%s\n' "$webui_output" | sed -n 's/^ *"error": *"\(.*\)",\{0,1\}$/\1/p' | head -n 1)
    [ -z "$webui_error" ] || say "  $webui_error"
    say "  NOTE: the bundle is on disk but the daemon was not configured to serve it. Run:"
    say "    goodvibes-daemon webui enable --bundle-dir $webui_target"
    return 0
  fi

  # The URL the daemon reported, read from its own receipt rather than rebuilt
  # here from config: the command that wrote the settings is the one that knows
  # which listener serves the bundle and on what port.
  WEBUI_URL=$(printf '%s\n' "$webui_output" | sed -n 's/^  "url": *"\(.*\)",\{0,1\}$/\1/p' | head -n 1)

  WEBUI_INSTALLED=1
}

write_directory_release_marker() {
  _marker_root=$1
  _marker_path="$_marker_root/.goodvibes-release.json"
  [ -d "$_marker_root" ] && [ ! -L "$_marker_root" ] || fail INSTALL_E096 'Released directory staging is unavailable.'
  [ ! -e "$_marker_path" ] && [ ! -L "$_marker_path" ] || fail INSTALL_E097 'The release archive collides with local directory bookkeeping.'
  (umask 022; set -C; printf '{"schema":1,"version":"%s"}\n' "${VERSION#v}" > "$_marker_path") || fail INSTALL_E098 'Could not record the selected directory release.'
  chmod 644 "$_marker_path" || fail INSTALL_E099 'Could not set directory release metadata permissions.'
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
  if rc_has_path_line "$shadow_effective_rc"; then
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
# existing package install. Current @goodvibes products are private workspace
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
    # A standalone file is removed only when this installer recorded writing it.
    shadow_in_receipt "$shadow_plan_path" || shadow_in_receipt "$shadow_plan_resolved" || return 0
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
      say "  $shadow_copy (version $shadow_copy_version) is not a program this installer"
      say "  recorded writing (in $SHADOW_PROGRAM_RECEIPT) or a GoodVibes package it can name,"
      say "  so it will not be touched. Remove it yourself, or put"
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

# The installer's own record of the program files it has written, one absolute
# path per line, across every install directory it was ever pointed at. A
# standalone shadowing copy is removed only when it is listed here: a file that
# merely answers --version as one of our programs is not proof this installer
# put it there.
SHADOW_PROGRAM_RECEIPT="${XDG_STATE_HOME:-$HOME/.local/state}/goodvibes/installed-programs"

# True when $1 (an absolute path) is listed in the program receipt.
shadow_in_receipt() {
  [ -f "$SHADOW_PROGRAM_RECEIPT" ] && [ ! -L "$SHADOW_PROGRAM_RECEIPT" ] || return 1
  grep -Fxq -- "$1" "$SHADOW_PROGRAM_RECEIPT"
}

# Record the programs this run placed in $INSTALL_DIR. Best effort: a receipt
# that cannot be written only means an old copy is reported, never removed.
record_installed_programs() {
  _receipt_dir=$(dirname "$SHADOW_PROGRAM_RECEIPT")
  mkdir -p "$_receipt_dir" 2>/dev/null || return 0
  [ ! -L "$SHADOW_PROGRAM_RECEIPT" ] || return 0
  _receipt_install_dir=$(shadow_trim_dir "$INSTALL_DIR")
  for _receipt_command in goodvibes goodvibes-daemon goodvibes-agent; do
    _receipt_path="$_receipt_install_dir/$_receipt_command"
    [ -f "$_receipt_path" ] || continue
    shadow_in_receipt "$_receipt_path" || printf '%s\n' "$_receipt_path" >> "$SHADOW_PROGRAM_RECEIPT" 2>/dev/null || :
    _receipt_real=$(shadow_existing_path "$_receipt_path") || _receipt_real=''
    if [ -n "$_receipt_real" ] && [ "$_receipt_real" != "$_receipt_path" ]; then
      shadow_in_receipt "$_receipt_real" || printf '%s\n' "$_receipt_real" >> "$SHADOW_PROGRAM_RECEIPT" 2>/dev/null || :
    fi
  done
}

# The whole-install verdict, run after everything is placed.
resolve_path_shadows() {
  record_installed_programs
  SHADOW_PATH=$(shadow_effective_path)
  for shadow_each in goodvibes goodvibes-daemon goodvibes-agent; do
    if ! check_command_shadowing "$shadow_each"; then
      PATH_SHADOW_UNRESOLVED=1
    fi
  done
}

# --- uninstall mode (GOODVIBES_UNINSTALL=1) ---
# Stops the running daemon/agent and removes ONLY what this installer manages:
# the three binaries, the sqlite-vec addon dirs, and the daemon's service unit or
# plist when (and only when) the daemon reports it wrote it. ~/.goodvibes user
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
    # The daemon ends itself at its shutdown deadline after draining, so it is
    # waited for until it is gone; another program gets 10 s.
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      [ "$label" = goodvibes-daemon ] || [ "$waited" -lt 10 ] || break
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
  # uninstall_systemd_service <unit> <unit_path> <remove: 1 when the unit is
  # GoodVibes's own (the daemon said so), 0 when it is kept>
  unit="$1"
  unit_path="$2"
  managed="$3"
  command -v systemctl >/dev/null 2>&1 || return 0

  unit_present=0
  systemctl --user cat "$unit" >/dev/null 2>&1 && unit_present=1
  [ -f "$unit_path" ] && unit_present=1
  [ "$unit_present" = "1" ] || return 0

  if [ "$managed" = "1" ]; then
    say "Stopping and removing $unit (written by GoodVibes) ..."
    systemctl --user disable --now "$unit" 2>/dev/null ||
      systemctl --user stop "$unit" 2>/dev/null || true
    rm -f "$unit_path"
    systemctl --user daemon-reload 2>/dev/null || true
    say "  removed    $unit_path"
    record_removed "$unit_path (GoodVibes service unit)"
  else
    say "Stopping $unit (present but not one this uninstall removes) ..."
    systemctl --user stop "$unit" 2>/dev/null || true
    if [ -f "$unit_path" ]; then
      # A kept unit is never removed by uninstall, but it is still worth saying
      # plainly when its ExecStart binary is already gone (e.g. a bun-era unit
      # left behind by `bun remove -g`) rather than reporting it identically to
      # a working hand-written unit.
      exec_bin=$(systemd_unit_exec_binary "$unit")
      if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
        say "  NOTE: $unit_path points at $exec_bin, which no longer exists (a broken"
        say "  unit this uninstall does not own); it is left in place; remove it yourself:"
      else
        say "  KEPT       $unit_path was not written by GoodVibes (or could not be checked); leaving it in place."
        say "  Remove it yourself:"
      fi
      # The program this unit starts is removed by this uninstall: an enabled unit
      # would fail at every login. Disabling is reversible and keeps the file.
      case "$exec_bin" in
        "$INSTALL_DIR"/*)
          if systemctl --user disable "$unit" 2>/dev/null; then
            say "  disabled   $unit (it starts $exec_bin, which this uninstall removes); the unit file was kept"
          fi ;;
      esac
      say "    systemctl --user disable --now $unit && rm $unit_path && systemctl --user daemon-reload"
      record_kept "$unit_path ($unit; not removed by this uninstall)"
    fi
  fi
}

uninstall_launchd_agent() {
  # uninstall_launchd_agent <label> <plist_path> <remove: 1 when GoodVibes's own, 0 when kept>
  label="$1"
  plist_path="$2"
  managed="$3"
  command -v launchctl >/dev/null 2>&1 || return 0
  uid=$(id -u)

  present=0
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 && present=1
  [ -f "$plist_path" ] && present=1
  [ "$present" = "1" ] || return 0

  say "Stopping launchd user agent $label ..."
  # bootout names the agent's own domain; the legacy unload acts on the caller's
  # domain and exits 0 whatever happened, so it was no fallback. The plist is
  # removed only once launchd has let go of the job.
  if ! bootout_launchd_job "$uid" "$label"; then
    say "  NOTE: launchd still lists $label after bootout; it was left in place. From a logged-in session:"
    say "    launchctl bootout gui/$uid/$label ; rm $plist_path"
    record_kept "$plist_path ($label agent; launchd did not let it go)"
    return 0
  fi

  if [ "$managed" = "1" ]; then
    rm -f "$plist_path"
    say "  removed    $plist_path"
    record_removed "$plist_path (GoodVibes launchd agent)"
  elif [ -f "$plist_path" ]; then
    say "  KEPT       $plist_path was not written by GoodVibes (or could not be checked); leaving it in place."
    say "  Remove it yourself:"
    say "    launchctl bootout gui/$uid/$label ; rm $plist_path"
    record_kept "$plist_path ($label agent; not removed by this uninstall)"
  fi
}

# The daemon's service. Whether its definition is GoodVibes's own is the daemon's
# answer, read by run_uninstall (read_daemon_service) before the installation is
# claimed; it is removed when the daemon wrote it and stopped and kept otherwise.
uninstall_daemon_service() {
  if [ "$DAEMON_SERVICE_KNOWN" != "1" ]; then
    # The daemon could not say whether it has a service, so none is removed; one
    # left enabled would start a program this uninstall deletes at every login.
    case "$os_tag" in
      linux)
        command -v systemctl >/dev/null 2>&1 || return 0
        _uds_how="systemctl --user disable --now goodvibes.service, then remove its unit file (~/.config/systemd/user/goodvibes.service)" ;;
      macos)
        command -v launchctl >/dev/null 2>&1 || return 0
        _uds_how="launchctl bootout gui/$(id -u)/sh.goodvibes.daemon, then remove the plist (~/Library/LaunchAgents/sh.goodvibes.daemon.plist)" ;;
      *) return 0 ;;
    esac
    say "NOTE: goodvibes-daemon could not report its service (the user service manager was not reachable from this"
    say "  session), so a daemon service, if there is one, was left in place. From a logged-in session run:"
    say "    $_uds_how"
    say "  (the default name; a daemon given another service.serviceName uses that name)"
    record_kept "the daemon's service (goodvibes-daemon could not report it: the user service manager was not reachable from this session); from a logged-in session run: $_uds_how"
    return 0
  fi
  _uds_managed=0
  if [ "$DAEMON_SERVICE_OWNER" = "product" ]; then _uds_managed=1; fi
  if [ "$DAEMON_SERVICE_PLATFORM" = "systemd" ]; then
    uninstall_systemd_service "$(daemon_service_unit)" "$DAEMON_SERVICE_PATH" "$_uds_managed"
  else
    uninstall_launchd_agent "$DAEMON_SERVICE_NAME" "$DAEMON_SERVICE_PATH" "$_uds_managed"
  fi
  return 0
}

uninstall_services_and_processes() {
  uninstall_daemon_service
  # Any bare (non-service) processes launched from this INSTALL_DIR.
  stop_bare_processes '[g]oodvibes-daemon' goodvibes-daemon
  stop_bare_processes '[g]oodvibes-agent' goodvibes-agent
}

assert_uninstall_recovery_slots_idle() {
  for _uninstall_recovery_slot in .update-transaction .update-download .update-previous .rollback-exchange .incoming; do
    _uninstall_recovery_path="$1$_uninstall_recovery_slot"
    [ ! -e "$_uninstall_recovery_path" ] && [ ! -L "$_uninstall_recovery_path" ] \
      || fail INSTALL_E100 "An interrupted update left $_uninstall_recovery_path; nothing was removed. If $1 is missing and this is its .update-previous copy, put it back (mv -f -- $(shadow_quote "$_uninstall_recovery_path") $(shadow_quote "$1")); otherwise remove it (rm -rf -- $(shadow_quote "$_uninstall_recovery_path")). Then re-run the uninstall."
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
          || fail INSTALL_E101 "An interrupted update left $_uninstall_pending; nothing was removed. If $INSTALL_DIR/$_uninstall_product$_uninstall_companion is missing and this is its .update-previous copy, put it back (mv -f -- $(shadow_quote "$_uninstall_pending") $(shadow_quote "$INSTALL_DIR/$_uninstall_product$_uninstall_companion")); otherwise remove it (rm -rf -- $(shadow_quote "$_uninstall_pending")). Then re-run the uninstall."
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
      || fail INSTALL_E102 "A browser-driver update holds $_uninstall_pending; nothing was removed. If no goodvibes update is running, remove it (rm -rf -- $(shadow_quote "$_uninstall_pending")), then re-run the uninstall."
  done
  if [ -d "$WEBUI_ROOT" ] && [ ! -L "$WEBUI_ROOT" ]; then
    for _uninstall_pending in "$WEBUI_ROOT"/*.directory-update.lock; do
      [ ! -e "$_uninstall_pending" ] && [ ! -L "$_uninstall_pending" ] \
        || fail INSTALL_E103 "A WebUI update holds $_uninstall_pending; nothing was removed. If no goodvibes update is running, remove it (rm -rf -- $(shadow_quote "$_uninstall_pending")), then re-run the uninstall."
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
  _uninstall_services_begun=0
  _uninstall_claim_exit() {
    _uninstall_exit=$?
    trap - EXIT INT TERM HUP
    if [ -n "$INSTALL_CLAIM_OWNER" ]; then
      if [ "$_uninstall_mutation_started" = 0 ] || [ "$_uninstall_complete" = 1 ]; then
        if [ "$_uninstall_complete" != 1 ] && [ "$_uninstall_services_begun" = 1 ] && [ "$_uninstall_exit" != 0 ]; then
          # The claims are released here because no program file had been touched, but the
          # service/process step had already started and its completed parts are not undone.
          say 'install.sh: uninstall stopped before any program file was removed, after its service and process step had started. Services, units or processes handled by that step stay stopped or removed; no program file was removed and the installation claims were released.' >&2
          say 'install.sh: each step can be repeated safely; finish the uninstall by running the same uninstall command again (curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh).' >&2
        fi
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
  trap 'exit 129' HUP
  if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    [ -d "$INSTALL_DIR" ] || fail INSTALL_E104 'The selected uninstall directory is unavailable; it was preserved.'
    _uninstall_original=$(CDPATH= cd -- "$INSTALL_DIR" && pwd -P) || fail INSTALL_E105 'Could not retain the original uninstall directory.'
    exec 0< "$_uninstall_original"
    installer_open_file_matches 0 "$_uninstall_original" || fail INSTALL_E106 'The original uninstall directory changed.'
    INSTALL_DIR=$_uninstall_original
    WEBUI_ROOT="$INSTALL_DIR/webui"
    VERSION=${VERSION:-uninstall}
    # The daemon names its service and says whether GoodVibes wrote it; asked
    # before the claims, which hold its program's update slot.
    read_daemon_service || :
    claim_release_install uninstall
    assert_uninstall_update_idle
    _uninstall_has_directory=1
  fi
  _uninstall_services_begun=1
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
      || fail INSTALL_E107 'An original native library directory changed during uninstall; its remaining files were preserved.'
  }
  if [ -L "$INSTALL_DIR/lib" ]; then
    record_kept "$INSTALL_DIR/lib (native library alias; not followed)"
  elif [ -d "$INSTALL_DIR/lib" ]; then
    exec 3< "$INSTALL_DIR/lib"
    assert_install_claims
    [ ! -L "$INSTALL_DIR/lib" ] && installer_open_file_matches 3 "$INSTALL_DIR/lib" || fail INSTALL_E108 'The original native library root changed.'
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
    [ ! -L "$INSTALL_DIR/lib" ] && installer_open_file_matches 3 "$INSTALL_DIR/lib" || fail INSTALL_E109 'The original native library root changed before cleanup.'
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
DECISION_POLICY_UNSAVED=0

# The programs are already replaced and committed by now, so a failed policy
# write must not end the install half-done (no restart, no service, no WebUI
# configuration). Say what was not saved and how to set it, and carry on, the
# way the other late configuration steps do.
apply_decision_policy() {
  [ -n "$DECISION_POLICY" ] || return 0
  if "$INSTALL_DIR/goodvibes-daemon" config set judgment.policy "$DECISION_POLICY"; then
    return 0
  fi
  DECISION_POLICY_UNSAVED=1
  say ""
  say "  NOTE: the decision policy was not saved; the install continues. Set it afterwards with:"
  say "    $INSTALL_DIR/goodvibes-daemon config set judgment.policy '$DECISION_POLICY'"
}

AUTO_UPDATE_UNSAVED=0

# --no-auto-update: update.auto and update.autoUpdateAtLaunch are daemon
# settings, kept in the daemon's settings file and read by the daemon, the
# terminal app and the Agent alike, so these two writes keep all three programs
# from replacing themselves, from their first launch. Like the decision policy,
# a refused write is said and the install continues.
apply_update_choice() {
  [ "$AUTO_UPDATE" = 0 ] || return 0
  if "$INSTALL_DIR/goodvibes-daemon" config set update.auto false >/dev/null \
    && "$INSTALL_DIR/goodvibes-daemon" config set update.autoUpdateAtLaunch false >/dev/null; then
    say ""
    say "Automatic updates: off for goodvibes, goodvibes-daemon and goodvibes-agent. Update by running this installer again."
    return 0
  fi
  AUTO_UPDATE_UNSAVED=1
  say ""
  say "  NOTE: automatic updates could not be turned off; the install continues. Turn them off with:"
  say "    $INSTALL_DIR/goodvibes-daemon config set update.auto false"
  say "    $INSTALL_DIR/goodvibes-daemon config set update.autoUpdateAtLaunch false"
}

# --no-service on a machine with no daemon service: record the choice in
# service.enabled, the setting the daemon reads before it would install itself
# as a service at its first idle moment, and the one doctor reads. An
# installed service is left alone and recorded as it is.
apply_service_choice() {
  [ "$DAEMON_SERVICE" = 0 ] || return 0
  [ "$DAEMON_SERVICE_INSTALLED" != 1 ] || return 0
  if "$INSTALL_DIR/goodvibes-daemon" config set service.enabled false >/dev/null; then
    return 0
  fi
  SERVICE_CHOICE_UNSAVED=1
  say ""
  say "  NOTE: the no-service choice could not be saved, so a daemon started by hand may install itself as a service."
  say "    Save it with: $INSTALL_DIR/goodvibes-daemon config set service.enabled false"
}

parse_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        say 'Install released GoodVibes binaries, daemon, agent, browser driver and WebUI.'
        say 'Usage: install.sh [--version VERSION] [--bin-dir DIR] [--from-dir DIR] [--no-service|--service] [--no-auto-update]'
        say '                  [--decision-policy POLICY] [--uninstall]'
        say 'GOODVIBES_VERSION selects one monorepo release (default: latest). No source build is performed.'
        say ''
        say 'Options:'
        say '  --version VERSION     Install this release, such as v3.5.0, for every program (default: latest;'
        say '                        also GOODVIBES_VERSION).'
        say '  --bin-dir|--install-dir DIR  Put the commands in DIR (default: ~/.local/bin; also GOODVIBES_INSTALL_DIR).'
        say '  --from-dir DIR        Install from DIR, a directory holding the release files and their SHA256SUMS.txt,'
        say '                        with no request to GitHub; every file is checked against that list (also'
        say '                        GOODVIBES_RELEASE_DIR). The release is read from the file names unless --version names it.'
        say '  --no-service          Do not install the daemon as a service, and record that choice so a daemon started'
        say '                        by hand never installs one (also GOODVIBES_DAEMON_SERVICE=0).'
        say '  --service             Install the daemon as a service (the default), even when GOODVIBES_DAEMON_SERVICE=0.'
        say '  --no-auto-update      Keep the daemon, the terminal app and the Agent from updating themselves, from their'
        say '                        first launch (also GOODVIBES_AUTO_UPDATE=0). Update later by running this installer.'
        say '  --decision-policy POLICY  Save the decision model policy (the judgment.policy setting; the daemon refuses'
        say '                        a value it does not accept and names the allowed ones; see the current one with'
        say '                        goodvibes-daemon config get judgment.policy).'
        say '  --uninstall           Remove the installed programs and services; settings and data in ~/.goodvibes are kept.'
        say '  --help|-h             Print this help and exit.'
        exit 0 ;;
      --uninstall) UNINSTALL=1; shift ;;
      --no-service) DAEMON_SERVICE=0; DAEMON_SERVICE_EXPLICIT=1; shift ;;
      --service) DAEMON_SERVICE=1; DAEMON_SERVICE_EXPLICIT=1; shift ;;
      --no-auto-update) AUTO_UPDATE=0; shift ;;
      --version|--bin-dir|--install-dir|--decision-policy|--from-dir)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail INSTALL_E110 "$1 needs a value"
        case "$1" in
          --version) REQUESTED_VERSION=$2; REQUESTED_DAEMON_VERSION=$2; REQUESTED_AGENT_VERSION=$2; REQUESTED_WEBUI_VERSION=$2 ;;
          --bin-dir|--install-dir) INSTALL_DIR=$2; WEBUI_ROOT="$INSTALL_DIR/webui" ;;
          --from-dir) RELEASE_DIR=$2 ;;
          # The daemon's settings schema is the one list of policies: apply_decision_policy's
          # `config set` checks the value and names the allowed ones when it refuses.
          --decision-policy) DECISION_POLICY=$2 ;;
        esac
        shift 2 ;;
      *) fail INSTALL_E112 "Unknown option: $1. Use --help for released-version installation; source builds use scripts/install-from-checkout.sh." ;;
    esac
  done
}

main() {
  parse_options "$@"
  resolve_platform
  if [ -n "$RELEASE_DIR" ]; then
    RELEASE_DIR=$(CDPATH= cd -- "$RELEASE_DIR" 2>/dev/null && pwd -P) || fail INSTALL_E130 "the release directory given with --from-dir (GOODVIBES_RELEASE_DIR) does not exist"
    # The wake-word model is downloaded by the daemon, not part of the release files.
    [ -n "${GOODVIBES_WAKE_MODEL:-}" ] || WITH_WAKE_MODEL=0
  fi

  if [ "$UNINSTALL" = "1" ]; then
    for installed_command in goodvibes goodvibes-daemon goodvibes-agent; do
      command_path="$INSTALL_DIR/$installed_command"
      if [ -L "$command_path" ]; then
        linked=$(readlink "$command_path")
        case "$linked" in
          */commands/goodvibes|*/commands/goodvibes-daemon|*/commands/goodvibes-agent)
            owned_prefix=$(dirname "$(dirname "$linked")")
            if [ -f "$owned_prefix/installation.json" ]; then
              if [ -x "$owned_prefix/current/runtime/bun" ] && [ -f "$owned_prefix/current/uninstall.js" ]; then
                exec "$owned_prefix/current/runtime/bun" "$owned_prefix/current/uninstall.js" --prefix "$owned_prefix"
              fi
              # The installed uninstaller needs only the receipt; the checkout this script runs from has it too.
              owned_checkout=
              if [ -f "$0" ]; then
                owned_checkout=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
                [ -f "$owned_checkout/scripts/uninstall.ts" ] && [ -f "$owned_checkout/scripts/installation.ts" ] || owned_checkout=
              fi
              [ -n "$owned_checkout" ] || fail INSTALL_E113 "The installed uninstaller of $owned_prefix is missing; nothing was removed. From a GoodVibes source checkout, run: ./scripts/uninstall.sh --prefix $owned_prefix"
              owned_runtime=$(command -v bun 2>/dev/null || true)
              if [ -z "$owned_runtime" ]; then
                for owned_candidate in "$owned_prefix"/releases/*/runtime/bun; do
                  if [ -x "$owned_candidate" ]; then owned_runtime=$owned_candidate; break; fi
                done
              fi
              [ -n "$owned_runtime" ] || fail INSTALL_E122 "The installed uninstaller of $owned_prefix is missing and no Bun was found to run this checkout's copy; nothing was removed. Install Bun (https://bun.sh), then run: bun $owned_checkout/scripts/uninstall.ts --prefix $owned_prefix"
              say "The installed uninstaller of $owned_prefix is missing; removing it with $owned_checkout/scripts/uninstall.ts instead." >&2
              exec "$owned_runtime" "$owned_checkout/scripts/uninstall.ts" --prefix "$owned_prefix"
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
            owned_data=$(sed -n 's/^ *"dataDir": *"\([^"]*\)",*$/\1/p' "$owned_prefix/installation.json" | head -n 1)
            [ -n "$owned_data" ] || owned_data="the data directory recorded in $owned_prefix/installation.json"
            fail INSTALL_E114 "A checkout installation owns $command_path; nothing was changed. Run $owned_prefix/commands/goodvibes-uninstall first (it keeps your data), then re-run this installer. That installation's sessions and settings are in $owned_data/.goodvibes and its credentials in $owned_data/environment; released programs read $HOME/.goodvibes. To keep using them, after uninstalling and before installing, when $HOME/.goodvibes does not exist yet, move them: mv -- '$owned_data/.goodvibes' '$HOME/.goodvibes'"
          fi ;;
      esac
    fi
  done
  resolve_version

  if [ -n "$RELEASE_DIR" ]; then
    BASE_URL=$RELEASE_DIR
  else
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  fi
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/goodvibes-install.XXXXXX")
  trap cleanup_release_install EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  prepare_release
  claim_release_install
  # The journal sits with the claims, so a run killed outright can be undone by the next one.
  INSTALL_JOURNAL="$INSTALL_CLAIM_OWNER/swap-journal"
  : > "$INSTALL_JOURNAL" || fail INSTALL_E121 "Could not create the swap journal in $INSTALL_CLAIM_OWNER; nothing was replaced."
  check_release_reader
  assert_no_stale_backups

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

  # Smoke test: the installed binary must at least report its version.
  # (doctor is a next-step suggestion, not an install gate: a healthy install
  # exits 0 — advisory findings render as notes, not failures — so there is
  # no "healthy install reports broken" case here to work around.)
  say ""
  if installed_version=$("$INSTALL_DIR/goodvibes" --version 2>/dev/null); then
    say "Installed: $installed_version"
  else
    fail INSTALL_E115 "the installed binary failed to run ('goodvibes --version'); the download may not match this platform"
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
  discard_stale_previous_cohort
  mark_install_swap_committed || fail INSTALL_E124 "Every program was replaced, but the swap journal in $INSTALL_CLAIM_OWNER could not be marked finished, so the previous programs are being put back."
  commit_install_journal
  release_install_claims || fail INSTALL_E116 "Suite files were installed, but this run's transaction claims in $INSTALL_CLAIM_DIR changed, so services were not started. Re-run the installer once no other goodvibes install or update is running; it releases claims whose process is gone."

  # After the swap is committed: a PATH line is a convenience and never fails or
  # undoes an install. It precedes resolve_path_shadows, which reads PATH_LINE_ADDED.
  ensure_path_on_shell_rc

  apply_decision_policy
  apply_update_choice
  # Both commands may load configuration and publish native data. Their real
  # writer checks must see a complete, idle suite, never our own in-flight
  # installation. Provisioning still precedes the first service start.
  install_wake_word_model
  configure_webui

  # The programs just placed, recorded in the daemon's own home (0600), where the
  # daemon reads their hashes at its start: never the reader files in the install
  # folder, which every program of the account can write. Before the restart.
  record_program_hashes

  # The daemon names its service once for the steps below, then brings its own
  # definition to the current launch BEFORE the restart, so the restart applies it.
  read_daemon_service || :
  apply_service_choice
  refresh_daemon_service

  restart_running_daemon

  if [ "$WITH_AGENT" = "1" ]; then
    restart_running_agent
  fi

  # First-run only: the daemon registers itself as a user service when nothing
  # is running and no definition exists yet (a no-op on an upgrade, which the
  # restart path above already handled).
  setup_daemon_service

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
  _install_problems=0
  if [ "$SERVICE_NOT_SET_UP" = "1" ] || [ "$SERVICE_NOT_RUNNING" = "1" ] || [ "$DAEMON_RESTART_FAILED" = "1" ] \
    || [ "$WEBUI_NOT_CONFIGURED" = "1" ] || [ "$SERVICE_CHOICE_UNSAVED" = "1" ]; then
    _install_problems=1
  fi
  _install_word=Done.
  [ "$_install_problems" = "0" ] || _install_word=Installed.
  if [ "$PATH_LINE_ADDED" = "1" ]; then
    # $INSTALL_DIR was just added to PATH in $RC_FILE_USED, but THIS shell
    # session hasn't re-sourced it yet — the bare 'goodvibes' command would
    # not resolve here. State a command that works RIGHT NOW instead of a
    # promise that depends on a shell restart the user hasn't done.
    say "$_install_word Start with: $INSTALL_DIR/goodvibes   (health check: $INSTALL_DIR/goodvibes doctor)"
    say "PATH updated in $RC_FILE_USED; open a new shell (or run: . $RC_FILE_USED) to use the plain 'goodvibes' command from then on."
  else
    say "$_install_word Start with: goodvibes   (health check: goodvibes doctor)"
  fi
  if [ "$WITH_AGENT" = "1" ]; then
    say "Personal agent:   goodvibes-agent"
  fi
  if [ "$AUTO_UPDATE_UNSAVED" = "1" ]; then
    say "Automatic updates: NOT turned off (the daemon refused the write); see the NOTE above."
  fi
  if [ "$DECISION_POLICY_UNSAVED" = "1" ]; then
    say "Decision policy:  NOT saved (the daemon refused the write); set it with: $INSTALL_DIR/goodvibes-daemon config set judgment.policy '$DECISION_POLICY'"
  fi
  if [ "$WEBUI_INSTALLED" = "1" ] && [ -n "$WEBUI_URL" ]; then
    # Who can reach it, and the command that changes that, is in the daemon's
    # own lines printed when the web UI was configured.
    say "Web UI:           $WEBUI_URL"
    say "Sign in:          run goodvibes pair (or goodvibes-daemon pair) and open the link it prints, or scan its QR"
  fi
  if [ "$WEBUI_LEFT_OFF" = "1" ]; then
    say "Web UI:           left off (you turned it off); the new bundle is in place. Turn it on: $INSTALL_DIR/goodvibes-daemon webui enable"
  fi
  if [ "$WEBUI_NOT_CONFIGURED" = "1" ]; then
    say "Web UI:           NOT configured (the daemon refused); serve it with: $INSTALL_DIR/goodvibes-daemon webui enable --bundle-dir $webui_target"
  fi
  if [ "$SERVICE_CHOICE_UNSAVED" = "1" ]; then
    say "No-service choice: NOT saved; save it with: $INSTALL_DIR/goodvibes-daemon config set service.enabled false"
  fi
  if [ "$SERVICE_NOT_SET_UP" = "1" ]; then
    say "Daemon service:   NOT set up; see the NOTE above. Then run: $INSTALL_DIR/goodvibes-daemon install-service"
  fi
  if [ "$SERVICE_NOT_RUNNING" = "1" ]; then
    say "Daemon service:   installed but NOT running; inspect it with: $INSTALL_DIR/goodvibes-daemon service-status"
  fi
  if [ "$DAEMON_RESTART_FAILED" = "1" ]; then
    say "Daemon restart:   NOT done; a daemon may still run the previous version, or none may be running. See the NOTE above."
  fi
  if [ "$_install_problems" = "1" ]; then
    say ""
    say "Installed, with the problems above."
    exit 4
  fi
}

# Run unless sourced as a library. The shell-level tests source this file with
# GOODVIBES_INSTALL_SH_LIB=1 to exercise individual functions (unit generation,
# uninstall file handling) without performing a network install.
if [ "${GOODVIBES_INSTALL_SH_LIB:-0}" != "1" ]; then
  main "$@"
fi

