// The acceptance logic that decides whether a compiled daemon passes its boot
// smoke lives beside the verify scripts. Importing its bun:test files here puts
// them under the product test runner, which only collects src/test.
import '../../../scripts/boot-smoke-reading.test.mjs';
import '../../../scripts/boot-smoke-memory.test.mjs';
