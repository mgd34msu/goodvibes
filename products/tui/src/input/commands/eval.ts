/**
 * /eval command handler: evaluate the product on real work.
 *
 *   /eval list [suite-dir]                  , List the tasks in a task suite
 *   /eval run [suite-dir]                   , Run every task, then its verification script
 *   /eval tasks [suite-dir]                 , Same as run
 *   /eval compare [baseline-file]           , Compare the last run against a baseline file
 *   /eval gate [suite-dir] [baseline-file]  , Run the suite and fail on a failed or regressed task
 *
 * A task suite is one directory per task, each with a `task.json`
 * (`instruction`, optional `timeoutMs`) and a `verify.sh` that exits 0 when
 * the work is right. The suite is copied to a scratch directory, every
 * instruction runs as one headless `goodvibes run --output json` in its task's
 * copy, and the task's script decides pass or fail. The checked-in tasks are
 * never changed.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { EvalRunner, createHeadlessRunExecutor, discoverTasks, formatTaskSuiteResult, runTaskSuite, taskSuiteAsEvalSuite } from '@/runtime/index.ts';
import type { EvalSuiteResult } from '@/runtime/index.ts';
import { loadBaseline, captureBaseline, formatBaselineComparison, writeBaseline } from '@/runtime/index.ts';
import type { EvalRegistry } from '@goodvibes-jev/engine/platform/platform/observe';
import { formatGateResult } from '@/runtime/index.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

// ── Subcommand helpers ────────────────────────────────────────────────────────

/** Where /eval looks when no suite directory is named, relative to the project. */
export const DEFAULT_TASK_SUITE_DIR = join('.goodvibes', 'eval', 'tasks');

/** A task suite on disk: its directory and the name its baseline entries use. */
interface TaskSuiteLocation {
  readonly dir: string;
  readonly name: string;
}

/** The suite directory named (or the default), or null after saying why there is none. */
function locateSuite(named: string | undefined, context: CommandContext): TaskSuiteLocation | null {
  const projectRoot = requireShellPaths(context).workingDirectory;
  const dir = named ? (isAbsolute(named) ? named : resolve(projectRoot, named)) : join(projectRoot, DEFAULT_TASK_SUITE_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    context.print([
      `[eval] No task suite at ${dir}.`,
      `[eval] Create one directory per task under ${named ? dir : DEFAULT_TASK_SUITE_DIR}, each with a task.json`
        + ' ({"instruction": "..."}) and a verify.sh that exits 0 when the work is right, then run /eval run again.',
    ].join('\n'));
    return null;
  }
  const inProject = relative(projectRoot, dir);
  return { dir, name: inProject && !inProject.startsWith('..') && !isAbsolute(inProject) ? inProject : dir };
}

/** Runs the suite in a scratch copy and prints each task's outcome; null when it could not run. */
async function runSuite(location: TaskSuiteLocation, context: CommandContext): Promise<EvalSuiteResult | null> {
  const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-eval-tasks-'));
  try {
    const copy = join(scratch, 'suite');
    cpSync(location.dir, copy, { recursive: true });
    context.print(`[eval] Running the task suite ${location.dir}: one goodvibes run per task, then its verify.sh...`);
    const startedAt = Date.now();
    const result = await runTaskSuite(copy, { executor: createHeadlessRunExecutor(), sourceDir: location.dir });
    context.print([
      formatTaskSuiteResult({ ...result, suiteDir: location.dir }),
      result.total === 0
        ? '[eval] The suite has no tasks: add a directory with a task.json and a verify.sh.'
        : result.passed ? '[eval] Every task passed.' : `[eval] ${result.total - result.passedCount} of ${result.total} task(s) failed.`,
    ].join('\n'));
    return taskSuiteAsEvalSuite(location.name, result, startedAt);
  } catch (error) {
    context.print(`[eval] The task suite did not run: ${summarizeError(error)}`);
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function getRegistry(context: CommandContext): EvalRegistry | undefined {
  return context.extensions.evalRegistry;
}

/** Runs in flight per registry: the registry's running flag is one boolean, so it is cleared when the last one ends. */
const activeRuns = new WeakMap<EvalRegistry, number>();

/** Runs `work` with the registry marked running until every concurrent run has finished. */
async function withEvalRunning<T>(registry: EvalRegistry | undefined, work: () => Promise<T>): Promise<T> {
  if (!registry) return work();
  activeRuns.set(registry, (activeRuns.get(registry) ?? 0) + 1);
  registry.setRunning(true);
  try {
    return await work();
  } finally {
    const left = (activeRuns.get(registry) ?? 1) - 1;
    activeRuns.set(registry, left);
    if (left === 0) registry.setRunning(false);
  }
}

// ── /eval list ────────────────────────────────────────────────────────────────

function handleList(args: string[], context: CommandContext): void {
  const location = locateSuite(args[0], context);
  if (!location) return;
  let tasks: ReturnType<typeof discoverTasks>;
  try {
    tasks = discoverTasks(location.dir);
  } catch (error) {
    context.print(`[eval] The task suite at ${location.dir} could not be read: ${summarizeError(error)}`);
    return;
  }
  const lines = [`[eval] Task suite ${location.dir} (${tasks.length} task${tasks.length === 1 ? '' : 's'}):`];
  for (const { definition } of tasks) {
    const instruction = definition.instruction.replace(/\s+/g, ' ').trim();
    lines.push(`  - ${definition.id}: ${instruction.length > 80 ? `${instruction.slice(0, 79)}…` : instruction}`);
  }
  lines.push('[eval] Usage: /eval run [suite-dir]');
  context.print(lines.join('\n'));
}

// ── /eval run ────────────────────────────────────────────────────────────────

async function handleRun(args: string[], context: CommandContext): Promise<void> {
  const location = locateSuite(args[0], context);
  if (!location) return;
  const registry = getRegistry(context);
  await withEvalRunning(registry, async () => {
    const fresh = await runSuite(location, context);
    if (fresh) registry?.push(fresh);
  });
}

// ── /eval compare ─────────────────────────────────────────────────────────────

async function handleCompare(args: string[], context: CommandContext): Promise<void> {
  const baselineFile = args[0] ?? '.goodvibes/eval/baseline.json';
  const registry = getRegistry(context);
  const projectRoot = requireShellPaths(context).workingDirectory;
  const suiteResults = registry?.getSuiteResults() ?? [];

  if (suiteResults.length === 0) {
    context.print('[eval] No suite results to compare. Run /eval run [suite-dir] first.');
    return;
  }

  const baseline = await loadBaseline(baselineFile, projectRoot);
  if (!baseline) {
    context.print(`[eval] Baseline file not found: ${baselineFile}\n[eval] Tip: run /eval gate [suite-dir] to create a baseline.`);
    return;
  }

  context.print(suiteResults.map((result) => formatBaselineComparison(baseline, result)).join('\n'));
}

// ── /eval gate ────────────────────────────────────────────────────────────────

async function handleGate(args: string[], context: CommandContext): Promise<void> {
  const positionals = args.filter(a => !a.startsWith('--'));
  const baselineFile = positionals[1] ?? '.goodvibes/eval/baseline.json';
  const saveFlag = args.includes('--save-baseline');
  const projectRoot = requireShellPaths(context).workingDirectory;

  const location = locateSuite(positionals[0], context);
  if (!location) return;

  const registry = getRegistry(context);
  const runner = new EvalRunner();

  context.print(`[eval] Gate: running the task suite ${location.name}...`);
  const fresh = await withEvalRunning(registry, async () => {
    const result = await runSuite(location, context);
    if (result) registry?.push(result);
    return result;
  });
  if (!fresh) {
    context.print('[eval] Gate FAILED: the task suite did not run.');
    return;
  }

  const baseline = await loadBaseline(baselineFile, projectRoot);
  const gate = runner.evaluateGate(fresh, baseline);
  registry?.pushGate(gate);

  const report = [formatGateResult(gate)];

  if (saveFlag || !baseline) {
    const newBaseline = captureBaseline(location.name, [fresh]);
    try {
      await writeBaseline(baselineFile, newBaseline, projectRoot);
      report.push(`[eval] Baseline saved to ${baselineFile}`);
    } catch (err) {
      report.push(`[eval] Warning: could not save baseline: ${summarizeError(err)}`);
    }
  }

  const gateFailures = [
    `${gate.floorFailures.length} failed task(s)`,
    `${gate.regressions.length} regression(s) against the baseline`,
    ...(gate.missingFromRun.length > 0 ? [`${gate.missingFromRun.length} baseline task(s) missing from the run: ${gate.missingFromRun.join(', ')}`] : []),
    ...(fresh.results.length === 0 ? ['the run has no tasks'] : []),
  ];
  report.push(gate.passed
    ? '[eval] Gate PASSED.'
    : `[eval] Gate FAILED: ${gateFailures.join(', ')}.`);
  context.print(report.join('\n'));
}

// ── Top-level command ─────────────────────────────────────────────────────────

export const evalCommand: SlashCommand = {
  name: 'eval',
  description: 'Evaluate the product on real tasks: run a task suite through goodvibes run, compare baselines, and gate regressions',
  usage: '<subcommand> [args]',
  argsHint: 'list [suite-dir]|run [suite-dir]|tasks [suite-dir]|compare <baseline>|gate [suite-dir]',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'list':
      case 'ls':
        handleList(rest, context);
        break;

      case 'run':
      case 'tasks':
        await handleRun(rest, context);
        break;

      case 'compare':
      case 'cmp':
        await handleCompare(rest, context);
        break;

      case 'gate':
        await handleGate(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /eval <subcommand>',
          `  list [suite-dir]                         — List the tasks in a task suite (default ${DEFAULT_TASK_SUITE_DIR})`,
          '  run [suite-dir]                          — Run each task through goodvibes run, then its verify.sh',
          '  tasks [suite-dir]                        — Same as run',
          '  compare [baseline-file]                  — Compare the last run against a baseline',
          '  gate [suite-dir] [baseline-file]         — Run the suite; fail on a failed task or a regression',
          '    --save-baseline                        — Save the fresh run as the new baseline',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
