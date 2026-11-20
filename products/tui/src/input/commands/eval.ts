/**
 * `/eval`, described once (command-actions/): evaluate the product on real work.
 *
 *   /eval list [suite-dir]                         List the tasks in a task suite
 *   /eval run [suite-dir]                          Run every task, then its verification script
 *   /eval compare [baseline-file]                  Compare the last run against a baseline file
 *   /eval gate [suite-dir] [--baseline <file>] [--save-baseline]
 *                                                  Run the suite and fail on a failed or regressed task
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
import type { CommandContext } from '../command-registry.ts';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, doAction, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
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

/** Where the baseline is kept when no file is named, relative to the project. */
const DEFAULT_BASELINE = '.goodvibes/eval/baseline.json';

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

function handleList(suite: string, context: CommandContext): void {
  const location = locateSuite(suite || undefined, context);
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
  lines.push('[eval] Run them: /eval run [suite-dir]');
  context.print(lines.join('\n'));
}

// ── /eval run ────────────────────────────────────────────────────────────────

async function handleRun(suite: string, context: CommandContext): Promise<void> {
  const location = locateSuite(suite || undefined, context);
  if (!location) return;
  const registry = getRegistry(context);
  await withEvalRunning(registry, async () => {
    const fresh = await runSuite(location, context);
    if (fresh) registry?.push(fresh);
  });
}

// ── /eval compare ─────────────────────────────────────────────────────────────

async function handleCompare(baselinePath: string, context: CommandContext): Promise<void> {
  const baselineFile = baselinePath || DEFAULT_BASELINE;
  const registry = getRegistry(context);
  const projectRoot = requireShellPaths(context).workingDirectory;
  const suiteResults = registry?.getSuiteResults() ?? [];

  if (suiteResults.length === 0) {
    context.print('[eval] No suite results to compare. Run /eval run [suite-dir] first.');
    return;
  }

  const baseline = await loadBaseline(baselineFile, projectRoot);
  if (!baseline) {
    context.print(`[eval] Baseline file not found: ${baselineFile}\n[eval] /eval gate [suite-dir] makes one.`);
    return;
  }

  context.print(suiteResults.map((result) => formatBaselineComparison(baseline, result)).join('\n'));
}

// ── /eval gate ────────────────────────────────────────────────────────────────

async function handleGate(suite: string, baselinePath: string, saveFlag: boolean, context: CommandContext): Promise<void> {
  const baselineFile = baselinePath || DEFAULT_BASELINE;
  const projectRoot = requireShellPaths(context).workingDirectory;

  const location = locateSuite(suite || undefined, context);
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

// ── The command ──────────────────────────────────────────────────────────────

const SUITE = textInput({ id: 'suite', label: 'Task suite', help: `A folder with one folder per task (default ${DEFAULT_TASK_SUITE_DIR})`, why: 'a folder in this project', kind: 'path', typed: { position: 1 }, optional: { default: '', means: DEFAULT_TASK_SUITE_DIR } });
const TERMINAL_ONLY = { terminalOnly: 'It runs the product in this terminal app\'s project.' } as const;

export const evalCommand = defineCommand<CommandContext>({
  name: 'eval',
  title: 'Evaluate on real tasks',
  summary: 'Run a task suite through goodvibes run, compare it with a baseline, and stop on a regression',
  group: 'Changes',
  report: 'list',
  actions: [
    readAction<CommandContext>({
      id: 'list', label: 'See the tasks in a suite', word: 'list', inputs: [SUITE],
      sentence: 'Lists the tasks in the task suite named, each with its instruction.', example: { suite: 'evals/tasks' }, operator: TERMINAL_ONLY,
      async run(values, ctx) { handleList(values.suite ?? '', ctx); },
    }),
    doAction<CommandContext>({
      id: 'run', label: 'Run a task suite', word: 'run', inputs: [SUITE],
      sentence: 'Each task of the suite runs as one goodvibes run in a scratch copy, then its verify.sh says pass or fail; the suite itself is never changed.', example: { suite: 'evals/tasks' }, operator: TERMINAL_ONLY,
      async run(values, ctx) { await handleRun(values.suite ?? '', ctx); },
    }),
    readAction<CommandContext>({
      id: 'compare', label: 'Compare the last run with a baseline', word: 'compare',
      inputs: [textInput({ id: 'baseline', label: 'Baseline', help: `A baseline file (default ${DEFAULT_BASELINE})`, why: 'a file in this project', kind: 'path', typed: { position: 1 }, optional: { default: '', means: DEFAULT_BASELINE } })],
      sentence: 'Compares the last suite run of this session with the baseline file, task by task.', example: { baseline: 'evals/baseline.json' }, operator: TERMINAL_ONLY,
      async run(values, ctx) { await handleCompare(values.baseline ?? '', ctx); },
    }),
    {
      id: 'gate', label: 'Run a suite and stop on a regression', word: 'gate',
      inputs: [
        SUITE,
        textInput({ id: 'baseline', label: 'Baseline', help: `A baseline file (default ${DEFAULT_BASELINE})`, why: 'a file in this project', kind: 'path', typed: { flag: '--baseline' }, optional: { default: '', means: DEFAULT_BASELINE } }),
        choiceInput({ id: 'save', label: 'Then', help: 'Whether this run becomes the baseline', choices: [{ value: 'no', label: 'Keep the baseline' }, { value: 'yes', label: 'Save this run as the baseline', help: 'The baseline file is written over.' }], typed: { flag: '--save-baseline', switchOn: 'yes' }, optional: { default: 'no', means: 'keep the baseline (one is made when there is none)' } }),
      ],
      sentence: 'The suite runs, and the gate fails on a failed task or one worse than the baseline; a missing baseline is made from this run, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', operator: TERMINAL_ONLY, example: { suite: 'evals/tasks', save: 'yes' },
      async run(values, ctx) { await handleGate(values.suite ?? '', values.baseline ?? '', values.save === 'yes', ctx); },
    },
  ],
});
