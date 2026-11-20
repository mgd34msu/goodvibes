/**
 * Run a task suite against the real program: each task's instruction goes
 * through one headless `goodvibes run`, then the task's verification script
 * decides pass or fail. The suite is copied to a scratch directory first, so
 * the checked-in fixtures are never changed.
 *
 *   bun packages/engine/scripts/eval-tasks.ts [suiteDir] [--command "<program and args>"]
 *
 * The default suite is packages/engine/eval/tasks; the default command is
 * `goodvibes` on PATH (it needs a configured provider). Exit 0 when every task
 * passed, 1 when any failed, 2 on a usage error.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHeadlessRunExecutor } from '../platform/src/platform/runtime/eval/headless-executor.ts';
import { formatTaskSuiteResult, runTaskSuite } from '../platform/src/platform/runtime/eval/task-suite.ts';

const args = process.argv.slice(2);
const commandIndex = args.indexOf('--command');
const command = commandIndex >= 0 ? args[commandIndex + 1]?.split(/\s+/).filter(Boolean) : undefined;
if (commandIndex >= 0 && (!command || command.length === 0)) {
  console.error('Usage: eval-tasks.ts [suiteDir] [--command "<program and args>"]');
  process.exit(2);
}
const positional = args.filter((_, index) => commandIndex < 0 || (index !== commandIndex && index !== commandIndex + 1));
const suiteDir = resolve(positional[0] ?? join(import.meta.dir, '..', 'eval', 'tasks'));

const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-eval-tasks-'));
try {
  const copy = join(scratch, 'suite');
  cpSync(suiteDir, copy, { recursive: true });
  const result = await runTaskSuite(copy, { executor: createHeadlessRunExecutor({ command }), sourceDir: suiteDir });
  console.log(formatTaskSuiteResult({ ...result, suiteDir }));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
