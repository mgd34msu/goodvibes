#!/bin/sh
# Remove a released suite or an earlier receipt-owned checkout installation.
set -eu
prefix="${HOME:?}/.local/share/goodvibes-jev"
explicit_prefix=0
purge=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo '--prefix needs a directory.' >&2; exit 1; }; prefix=$2; explicit_prefix=1; shift 2 ;;
    --purge) purge=1; shift ;;
    --help|-h) echo 'Usage: uninstall.sh [--prefix DIR] [--purge]'; echo 'Removes managed programs/services and preserves user data. --purge applies to receipt-owned installations.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [ -f "$prefix/installation.json" ]; then
  [ -x "$prefix/current/runtime/bun" ] && [ -f "$prefix/current/uninstall.js" ] || {
    echo 'The receipt-owned installed uninstaller is missing; restore that installation before removing it.' >&2; exit 1;
  }
  set -- --prefix "$prefix"
  if [ "$purge" = 1 ]; then set -- "$@" --purge; fi
  exec "$prefix/current/runtime/bun" "$prefix/current/uninstall.js" "$@"
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
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 120 --retry 2 \
  https://raw.githubusercontent.com/mgd34msu/goodvibes-jev/main/scripts/install.sh -o "$work/install.sh"
env GOODVIBES_UNINSTALL=1 sh "$work/install.sh"
