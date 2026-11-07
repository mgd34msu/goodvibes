#!/bin/sh
# Install every GoodVibes product from this monorepo only.
# curl -fsSL https://raw.githubusercontent.com/mgd34msu/goodvibes-jev/main/install.sh | sh
set -eu

# A checkout uses its own installer and exact source revision. A downloaded or
# piped copy bootstraps that same installer from the single repository below.
if [ -f "$0" ]; then
  installer_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
  if [ -f "$installer_root/scripts/install-from-checkout.sh" ] && [ -f "$installer_root/packages/engine/package.json" ]; then
    exec bash "$installer_root/scripts/install-from-checkout.sh" "$@"
  fi
fi

repository='https://github.com/mgd34msu/goodvibes-jev.git'
source_ref=${GOODVIBES_REF:-main}
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Install the daemon, TUI, Agent and WebUI from mgd34msu/goodvibes-jev.

  curl -fsSL https://raw.githubusercontent.com/mgd34msu/goodvibes-jev/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/mgd34msu/goodvibes-jev/main/install.sh | sh -s -- --no-service --decision-policy 'Classic - Off'

GOODVIBES_REF selects one branch or tag for the complete suite (default: main).
GOODVIBES_SOURCE_ROOT selects where persistent source checkouts are kept.
Other arguments are forwarded to the checkout installer. Linux with glibc is
required; all four products are built together from one source revision.
HELP
    exit 0 ;;
esac

case "$(uname -s)" in Linux) ;; *) echo 'The installer currently supports Linux only.' >&2; exit 1 ;; esac
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || { echo 'A glibc Linux distribution is required.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Run as your regular user, without sudo.' >&2; exit 1; }
for required_command in git bash; do
  command -v "$required_command" >/dev/null 2>&1 || { echo "Install the prerequisite: $required_command" >&2; exit 1; }
done
git check-ref-format "refs/heads/$source_ref" >/dev/null 2>&1 || { echo 'GOODVIBES_REF must name a valid branch or tag.' >&2; exit 1; }
: "${HOME:?A home directory is required.}"
umask 077
source_root=${GOODVIBES_SOURCE_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/goodvibes-jev-source}
mkdir -p -- "$source_root"
checkout=$(mktemp -d "$source_root/checkout.XXXXXXXX")
# Keep the checkout: the installed daemon may use it as its selected workspace.
# A unique checkout also prevents an update from rewriting another build's input.
printf 'Installing the complete suite from %s (%s)\n' "$repository" "$source_ref"
if ! GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch --branch "$source_ref" -- "$repository" "$checkout"; then
  rmdir -- "$checkout" 2>/dev/null || true
  echo 'Unable to fetch the GoodVibes monorepo; installation stopped.' >&2
  exit 1
fi
[ -f "$checkout/scripts/install-from-checkout.sh" ] || { echo 'The selected monorepo revision has no checkout installer.' >&2; exit 1; }
exec bash "$checkout/scripts/install-from-checkout.sh" "$@"
