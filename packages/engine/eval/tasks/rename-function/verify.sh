#!/usr/bin/env bash
set -euo pipefail
! grep -q addNumbers math.mjs report.mjs
grep -q 'export function sum' math.mjs
node --input-type=module -e "import { total } from './report.mjs'; import { sum } from './math.mjs'; if (total([1, 2, 3]) !== 6 || sum(2, 3) !== 5) process.exit(1);"
