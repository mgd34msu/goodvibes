#!/usr/bin/env bash
set -euo pipefail
test -f hello.txt
test "$(cat hello.txt)" = "hello from goodvibes"
