/**
 * Evaluating the product on real work: the terminal app's services for the
 * eval capabilities (platform builtin/eval.ts), whose controls are on the Work
 * place's Evaluations tab.
 *
 * A task suite is one directory per task, each with a `task.json`
 * (`instruction`, optional `timeoutMs`) and a `verify.sh` that exits 0 when
 * the work is right. The suite is copied to a scratch directory, every
 * instruction runs as one headless `goodvibes run --output json` in its task's
 * copy, and the task's script decides pass or fail. The checked-in tasks are
 * never changed. The results of this session are kept in the app's eval
 * registry, which the Evaluations tab lists.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import { EvalRunner, createHeadlessRunExecutor, discoverTasks, formatTaskSuiteResult, runTaskSuite, taskSuiteAsEvalSuite } from '@/runtime/index.ts';
import type { EvalSuiteResult } from '@/runtime/index.ts';
import { loadBaseline, captureBaseline, formatBaselineComparison, writeBaseline } from '@/runtime/index.ts';
import type { EvalRegistry } from '@goodvibes/engine/platform/platform/observe';
import { formatGateResult } from '@/runtime/index.ts';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { CapabilityRefusal, DEFAULT_EVAL_BASELINE, DEFAULT_TASK_SUITE_DIR, type EvalResultRow, type EvalSuiteServices } from '@goodvibes/engine/platform/platform/capabilities';

export { DEFAULT_TASK_SUITE_DIR };

/** A task suite on disk: its directory and the name its baseline entries use. */
interface TaskSuiteLocation {
  readonly dir: string;
  readonly name: string;
}

/** The suite directory named (or the default); a refusal saying how to make one when there is none. */
function locateSuite(named: string | undefined, context: CommandContext): TaskSuiteLocation {
  const projectRoot = requireShellPaths(context).workingDirectory;
  const dir = named ? (isAbsolute(named) ? named : resolve(projectRoot, named)) : join(projectRoot, DEFAULT_TASK_SUITE_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CapabilityRefusal(
      `No task suite at ${dir}.`,
      `Make one folder per task under ${named ? dir : DEFAULT_TASK_SUITE_DIR}, each with a task.json ({"instruction": "..."}) and a verify.sh that exits 0 when the work is right, then run the suite again.`,
      'NOT_FOUND',
    );
  }
  const inProject = relative(projectRoot, dir);
  return { dir, name: inProject && !inProject.startsWith('..') && !isAbsolute(inProject) ? inProject : dir };
}

/**
 * Runs the suite in a scratch copy; its words and result, or 'stopped' when the owner stopped it. The run holds the
 * terminal's eval slot: Esc and Ctrl-C stop it, closing the terminal stops it, and a second run while one runs is refused.
 */
async function runSuite(location: TaskSuiteLocation, context: CommandContext): Promise<{ readonly words: string; readonly result: EvalSuiteResult } | 'stopped'> {
  const slot = context.evalRuns;
  const signal = slot ? slot.begin() : undefined;
  if (signal === null) throw new CapabilityRefusal('Nothing was run: a task suite is already running in this terminal.', 'Press Esc to stop it, then run this again.', 'CONFLICT');
  const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-eval-tasks-'));
  try {
    const copy = join(scratch, 'suite');
    cpSync(location.dir, copy, { recursive: true });
    const startedAt = Date.now();
    const result = await runTaskSuite(copy, { executor: createHeadlessRunExecutor(), sourceDir: location.dir, signal });
    if (signal?.aborted) return 'stopped';
    // Its first line already says how many passed.
    const words = [
      formatTaskSuiteResult({ ...result, suiteDir: location.dir }),
      ...(result.total === 0 ? ['The suite has no tasks: add a folder with a task.json and a verify.sh.'] : []),
    ].join('\n');
    return { words, result: taskSuiteAsEvalSuite(location.name, result, startedAt) };
  } catch (error) {
    if (signal?.aborted) return 'stopped';
    throw new CapabilityRefusal(`The task suite did not run: ${summarizeError(error)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (signal) slot?.finish(signal);
  }
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

const STOPPED = 'Stopped before it finished; no result was kept.';

function list(suite: string, context: CommandContext): string {
  const location = locateSuite(suite || undefined, context);
  let tasks: ReturnType<typeof discoverTasks>;
  try {
    tasks = discoverTasks(location.dir);
  } catch (error) {
    throw new CapabilityRefusal(`The task suite at ${location.dir} could not be read: ${summarizeError(error)}`);
  }
  if (tasks.length === 0) return `The task suite at ${location.dir} has no tasks: add a folder with a task.json and a verify.sh.`;
  return [
    `The task suite at ${location.dir} has ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
    ...tasks.map(({ definition }) => {
      const instruction = definition.instruction.replace(/\s+/g, ' ').trim();
      return `${definition.id}: ${instruction.length > 80 ? `${instruction.slice(0, 79)}…` : instruction}`;
    }),
  ].join('\n');
}

async function run(suite: string, context: CommandContext): Promise<string> {
  const location = locateSuite(suite || undefined, context);
  const registry = context.extensions.evalRegistry;
  return withEvalRunning(registry, async () => {
    const fresh = await runSuite(location, context);
    if (fresh === 'stopped') return STOPPED;
    registry?.push(fresh.result);
    return fresh.words;
  });
}

async function compare(baselinePath: string, context: CommandContext): Promise<string> {
  const baselineFile = baselinePath || DEFAULT_EVAL_BASELINE;
  const projectRoot = requireShellPaths(context).workingDirectory;
  const suiteResults = context.extensions.evalRegistry?.getSuiteResults() ?? [];
  if (suiteResults.length === 0) throw new CapabilityRefusal('There is no suite run of this session to compare.', 'Run a task suite first, from the Evaluations tab.');
  const baseline = await loadBaseline(baselineFile, projectRoot);
  if (!baseline) throw new CapabilityRefusal(`There is no baseline at ${baselineFile}.`, 'Gating a suite makes one.', 'NOT_FOUND');
  return suiteResults.map((result) => formatBaselineComparison(baseline, result)).join('\n');
}

async function gate(suite: string, baselinePath: string, saveFlag: boolean, context: CommandContext): Promise<string> {
  const baselineFile = baselinePath || DEFAULT_EVAL_BASELINE;
  const projectRoot = requireShellPaths(context).workingDirectory;
  const location = locateSuite(suite || undefined, context);
  const registry = context.extensions.evalRegistry;
  const fresh = await withEvalRunning(registry, async () => {
    const result = await runSuite(location, context);
    if (result !== 'stopped') registry?.push(result.result);
    return result;
  });
  if (fresh === 'stopped') return STOPPED;
  const baseline = await loadBaseline(baselineFile, projectRoot);
  const verdict = new EvalRunner().evaluateGate(fresh.result, baseline);
  registry?.pushGate(verdict);
  const report = [fresh.words, formatGateResult(verdict)];
  if (saveFlag || !baseline) {
    try {
      await writeBaseline(baselineFile, captureBaseline(location.name, [fresh.result]), projectRoot);
      report.push(`This run is now the baseline, in ${baselineFile}.`);
    } catch (err) {
      report.push(`The baseline could not be saved: ${summarizeError(err)}`);
    }
  }
  const failures = [
    `${verdict.floorFailures.length} failed task(s)`,
    `${verdict.regressions.length} regression(s) against the baseline`,
    ...(verdict.missingFromRun.length > 0 ? [`${verdict.missingFromRun.length} baseline task(s) missing from the run: ${verdict.missingFromRun.join(', ')}`] : []),
    ...(fresh.result.results.length === 0 ? ['the run has no tasks'] : []),
  ];
  report.push(verdict.passed ? 'The gate passed.' : `The gate failed: ${failures.join(', ')}.`);
  return report.join('\n');
}

/** The suites run in this session, newest result each, with the gate's verdict where there was one. */
function results(registry: EvalRegistry | undefined): readonly EvalResultRow[] {
  if (!registry) return [];
  const gates = new Map(registry.getGateResults().map((entry) => [entry.suite, entry.passed]));
  return registry.getSuiteResults().map((suite): EvalResultRow => {
    const passed = suite.results.filter((entry) => entry.scorecard.passed).length;
    const verdict = gates.get(suite.suite);
    return {
      suite: suite.suite, passed, total: suite.results.length, at: suite.finishedAt,
      ...(verdict === undefined ? {} : { gate: verdict ? 'passed' as const : 'failed' as const }),
      failed: suite.results.filter((entry) => !entry.scorecard.passed).map((entry) => entry.scenario.id),
    };
  });
}

/** This app's task suites (builtin/eval.ts services), run in its project folder. */
export function evalSuitesOf(ctx: CommandContext): EvalSuiteServices {
  const registry = ctx.extensions.evalRegistry;
  return {
    list: async (suite) => list(suite, ctx),
    run: (suite) => run(suite, ctx),
    compare: (baseline) => compare(baseline, ctx),
    gate: (suite, baseline, save) => gate(suite, baseline, save, ctx),
    results: () => results(registry),
    subscribe: (listener) => registry?.subscribe(listener) ?? (() => {}),
  };
}
