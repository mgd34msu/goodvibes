#!/bin/sh
# Compatibility entry point: all products are now installed from this monorepo.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
if [ ! -f "$root/scripts/install.sh" ]; then
  echo 'Clone https://github.com/mgd34msu/goodvibes and run ./scripts/install.sh from its root.' >&2
  exit 1
fi
if [ "${GOODVIBES_UNINSTALL:-0}" = 1 ]; then
  exec bash "$root/scripts/uninstall.sh" "$@"
fi
exec bash "$root/scripts/install.sh" "$@"
