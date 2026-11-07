#!/usr/bin/env bash
set -euo pipefail
prefix="${HOME:?}/.local/share/goodvibes-jev"
explicit_prefix=0
args=()
while (($#)); do
  case "$1" in
    --prefix) [[ $# -ge 2 && -n $2 ]] || { echo '--prefix needs a directory.' >&2; exit 1; }; prefix=$2; explicit_prefix=1; shift 2 ;;
    --purge) args+=(--purge); shift ;;
    --help|-h) echo 'Usage: ./scripts/uninstall.sh [--prefix DIR] [--purge]'; echo 'Stops/removes the installed service and programs. Data is preserved unless --purge is given.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ ! -e "$prefix/installation.json" ]]; then
  if ((explicit_prefix)); then
    echo "No Jev installation at $prefix. Any preserved user data remains untouched."
    exit 0
  fi
  if ((${#args[@]})); then
    echo 'Release installs preserve ~/.goodvibes data; --purge is supported only for a receipt-owned installation.' >&2
    exit 1
  fi
  root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  if [[ -f "$root/scripts/install.sh" ]]; then
    exec env GOODVIBES_UNINSTALL=1 sh "$root/scripts/install.sh"
  fi
  work=$(mktemp -d "${TMPDIR:-/tmp}/goodvibes-uninstall.XXXXXXXX")
  trap 'rm -rf -- "$work"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 120 --retry 2 \
    https://raw.githubusercontent.com/mgd34msu/goodvibes-jev/main/scripts/install.sh -o "$work/install.sh"
  env GOODVIBES_UNINSTALL=1 sh "$work/install.sh"
  exit "$?"
fi
[[ -x "$prefix/current/runtime/bun" && -f "$prefix/current/uninstall.js" ]] || {
  echo "The installed uninstaller is missing. Restore it by re-running scripts/install.sh with --prefix '$prefix'." >&2; exit 1;
}
exec "$prefix/current/runtime/bun" "$prefix/current/uninstall.js" --prefix "$prefix" "${args[@]}"
