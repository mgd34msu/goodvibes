#!/bin/sh
# Remove a released suite or an earlier receipt-owned checkout installation.
set -eu
prefix="${HOME:?}/.local/share/goodvibes"
explicit_prefix=0
purge=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo '--prefix needs a directory.' >&2; exit 1; }; prefix=$2; explicit_prefix=1; shift 2 ;;
    --purge) purge=1; shift ;;
    --help|-h)
      echo 'Usage: uninstall.sh [--prefix DIR] [--purge]'
      echo 'Removes managed programs/services and preserves user data. --purge applies to receipt-owned installations.'
      echo ''
      echo 'Options:'
      echo '  --prefix DIR   The checkout installation to remove (default: $HOME/.local/share/goodvibes).'
      echo '  --purge        Also remove that installation data directory (receipt-owned installations only).'
      echo '  --help|-h      Print this help and exit.'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [ -f "$prefix/installation.json" ]; then
  # A first install stopped just after it recorded its receipt has not published `current` yet; its release has the uninstaller.
  release_root="$prefix/current"
  if [ ! -e "$release_root" ]; then
    release=$(sed -n 's/^ *"release": *"\([0-9a-f-]*\)",*$/\1/p' "$prefix/installation.json" | head -n 1)
    [ -z "$release" ] || release_root="$prefix/releases/$release"
  fi
  set -- --prefix "$prefix"
  if [ "$purge" = 1 ]; then set -- "$@" --purge; fi
  if [ -x "$release_root/runtime/bun" ] && [ -f "$release_root/uninstall.js" ]; then
    exec "$release_root/runtime/bun" "$release_root/uninstall.js" "$@"
  fi
  # The installed uninstaller is damaged or gone. It needs only the receipt, so this checkout's copy of it does
  # the same job, run by any Bun: one on PATH or one left in another release of this installation.
  checkout=
  if [ -f "$0" ]; then
    checkout=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
    [ -f "$checkout/scripts/uninstall.ts" ] && [ -f "$checkout/scripts/installation.ts" ] || checkout=
  fi
  if [ -n "$checkout" ]; then
    runtime=$(command -v bun 2>/dev/null || true)
    if [ -z "$runtime" ]; then
      for candidate in "$prefix"/releases/*/runtime/bun; do
        if [ -x "$candidate" ]; then runtime=$candidate; break; fi
      done
    fi
    if [ -n "$runtime" ]; then
      echo "The installed uninstaller for $prefix is missing ($release_root/uninstall.js); removing it with $checkout/scripts/uninstall.ts instead." >&2
      exec "$runtime" "$checkout/scripts/uninstall.ts" "$@"
    fi
    echo "The installed uninstaller for $prefix is missing ($release_root/uninstall.js) and no Bun was found to run this checkout's copy; nothing was removed. Install Bun (https://bun.sh), then run: bun $checkout/scripts/uninstall.ts $*" >&2
    exit 1
  fi
  echo "The installed uninstaller for $prefix is missing ($release_root/uninstall.js); nothing was removed. From a GoodVibes source checkout, run: ./scripts/uninstall.sh $*" >&2
  exit 1
fi
if [ "$explicit_prefix" = 1 ]; then
  echo "No receipt-owned installation at $prefix. User data remains untouched."
  exit 0
fi
[ "$purge" = 0 ] || { echo 'Release installs preserve ~/.goodvibes data; --purge requires a receipt-owned installation.' >&2; exit 1; }
if [ -f "$0" ]; then
  root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
  if [ -f "$root/scripts/install.sh" ]; then
    exec env GOODVIBES_UNINSTALL=1 sh "$root/scripts/install.sh"
  fi
fi
umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/goodvibes-uninstall.XXXXXXXX")
trap 'rm -rf -- "$work"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
# The release installer that wrote this installation is the one that removes it: it reads the installed
# daemon's output in that release's form. The version comes from the installed goodvibes-daemon
# (`goodvibes-daemon --version` prints `goodvibes-daemon X.Y.Z`); GOODVIBES_VERSION=vX.Y.Z names it instead.
# Only when neither answers is the current main script used.
ref=main
# Same repository as REPO in install.sh; a downloaded script cannot read it from there.
repo=mgd34msu/goodvibes
if [ -n "${GOODVIBES_VERSION:-}" ]; then
  case "$GOODVIBES_VERSION" in
    v[0-9]*.[0-9]*.[0-9]*) ref=$GOODVIBES_VERSION ;;
    *) echo "GOODVIBES_VERSION must look like v3.2.0, not '$GOODVIBES_VERSION'." >&2; exit 1 ;;
  esac
else
  installed_daemon="${GOODVIBES_INSTALL_DIR:-$HOME/.local/bin}/goodvibes-daemon"
  [ -x "$installed_daemon" ] || installed_daemon=$(command -v goodvibes-daemon 2>/dev/null || true)
  installed_version=
  if [ -n "$installed_daemon" ]; then
    installed_version=$("$installed_daemon" --version 2>/dev/null | sed -n 's/^goodvibes-daemon v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | head -n 1) || installed_version=
  fi
  if [ -n "$installed_version" ]; then
    ref="v$installed_version"
  else
    echo "Could not read the installed goodvibes-daemon's version; using the current release installer to remove it." >&2
  fi
fi
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 120 --retry 2 \
  "https://raw.githubusercontent.com/$repo/$ref/scripts/install.sh" -o "$work/install.sh"
env GOODVIBES_UNINSTALL=1 sh "$work/install.sh"
