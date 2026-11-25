/**
 * Evaluation Harness, external task-suite adapter (Terminal-Bench-style).
 *
 * A Terminal-Bench task suite is a DIRECTORY of tasks, each its own
 * subdirectory holding a task definition and a verification script:
 *
 *   <suiteDir>/
 *     <taskId>/
 *       task.json     { id, instruction, verify, timeoutMs? }
 *       verify.sh     exits 0 = pass, non-zero = fail
 *       ...           any fixtures the task needs
 *
 * This adapter runs each task through a REAL session, supplied by the caller as
 * an injectable `TaskSessionExecutor` (the seam a consumer fills with an actual
 * model-driven session operating in the task's working directory), and then
 * runs the task's verification script to decide pass/fail. It reports a
 * per-task result and an aggregate.
 *
 * The verifier a task is judged by is the suite's, not whatever the session
 * left in the task directory: before the session runs, the verification
 * script and the files task.json lists in `verifyFiles` are copied out of the
 * task directory into a private snapshot (and, when the caller names the
 * original suite, their sha256 compared with it). Verification runs that
 * snapshot, contained (runContained, origin `project`) with the task directory
 * read-only, so a session that rewrites verify.sh to `exit 0` still fails.
 *
 * SCOPE (honest). This is the adapter CONTRACT plus a default script verifier,
 * not a benchmark import: it does not bundle Terminal-Bench's task corpus, a
 * container runtime, or a specific model harness. The session executor and (if
 * desired) the verifier are injected, so the same contract drives the bundled
 * example suite in tests and a real suite + real session in a consumer.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { ContainmentUnavailableError, runContained } from '../sandbox/contained-spawn.js';
import { hostSandboxAvailability } from '../../tools/exec/sandbox.js';
import type { EvalRawResult, EvalResult, EvalSuiteResult } from './types.js';

/** One task's on-disk definition (task.json). */
export interface TaskDefinition {
  /** Stable task id (used as the result key). Defaults to the task directory name when omitted. */
  readonly id: string;
  /** The instruction handed to the session. */
  readonly instruction: string;
  /** Path (relative to the task directory) to the verification script. Defaults to `verify.sh`. */
  readonly verify: string;
  /** Optional per-task wall-clock cap for the session executor, in ms. */
  readonly timeoutMs?: number;
  /** Files (relative to the task directory) the verifier reads besides its script; snapshotted with it before the session runs. */
  readonly verifyFiles?: readonly string[];
}

/** What the session executor is given for one task. */
export interface TaskExecutionContext {
  readonly taskId: string;
  /** Absolute path to the task directory (definition + fixtures + verify script). */
  readonly taskDir: string;
  /** The instruction from the task definition. */
  readonly instruction: string;
  readonly timeoutMs?: number | undefined;
  /** Fires when the owner stops the suite; the executor ends the session and reports it not completed. */
  readonly signal?: AbortSignal | undefined;
}

/** The outcome the session executor reports (whether the session ran to completion). */
export interface TaskSessionOutcome {
  readonly completed: boolean;
  readonly summary?: string;
}

/** The injectable "real session" seam: run one task's instruction in its directory. */
export type TaskSessionExecutor = (ctx: TaskExecutionContext) => Promise<TaskSessionOutcome>;

/** What the verifier is given. */
export interface TaskVerifyContext {
  readonly taskId: string;
  readonly taskDir: string;
  /** Absolute path to the verification script: the snapshot taken before the session ran, outside the task directory. */
  readonly verifyScript: string;
  /** The snapshot directory: the script and its `verifyFiles` at their task-relative paths (GOODVIBES_EVAL_VERIFY_DIR for the default verifier). */
  readonly verifyDir: string;
  readonly timeoutMs?: number | undefined;
  /** Fires when the owner stops the suite; the verifier stops its script. */
  readonly signal?: AbortSignal | undefined;
}

/** The verifier's verdict. */
export interface TaskVerifyResult {
  readonly passed: boolean;
  readonly output: string;
}

/** Runs a task's verification script and decides pass/fail. Injectable; defaults to a shell runner. */
export type TaskVerifier = (ctx: TaskVerifyContext) => Promise<TaskVerifyResult>;

/** One task's result. */
export interface TaskResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly sessionCompleted: boolean;
  readonly verifierPassed: boolean;
  readonly verifierOutput: string;
  readonly reason: string;
  readonly durationMs: number;
}

/** The aggregate for a whole suite directory. */
export interface TaskSuiteResult {
  readonly suiteDir: string;
  readonly results: readonly TaskResult[];
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
}

export interface RunTaskSuiteOptions {
  /** The real-session seam. Required, there is no faked default session. */
  readonly executor: TaskSessionExecutor;
  /** Verification runner. Defaults to {@link defaultShellVerifier} (runs the script, exit 0 = pass). */
  readonly verifier?: TaskVerifier;
  /**
   * The original suite when `suiteDir` is a working copy of it: each task's
   * verification files are compared (sha256) with the original's before the
   * session runs, and a task whose files differ fails without running.
   */
  readonly sourceDir?: string;
  /**
   * Stops the suite: the running session and verifier are stopped and no
   * further task starts. The result then holds only the tasks that ran.
   */
  readonly signal?: AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Load and validate a task.json from a task directory. Throws a named error on a malformed definition. */
export function loadTaskDefinition(taskDir: string): TaskDefinition {
  const defPath = join(taskDir, 'task.json');
  if (!existsSync(defPath)) {
    throw new Error(`task-suite: ${taskDir} has no task.json`);
  }
  const parsed = JSON.parse(readFileSync(defPath, 'utf-8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.instruction !== 'string' || parsed.instruction.length === 0) {
    throw new Error(`task-suite: ${defPath} is missing a non-empty "instruction"`);
  }
  const dirName = taskDir.split(/[\\/]/).filter(Boolean).pop() ?? taskDir;
  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : dirName;
  const verify = typeof parsed.verify === 'string' && parsed.verify.length > 0 ? parsed.verify : 'verify.sh';
  const timeoutMs = typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined;
  const verifyFiles = parsed.verifyFiles === undefined ? undefined
    : Array.isArray(parsed.verifyFiles) && parsed.verifyFiles.every((entry) => typeof entry === 'string' && entry.length > 0)
      ? parsed.verifyFiles as string[]
      : (() => { throw new Error(`task-suite: ${defPath} "verifyFiles" must be a list of paths relative to the task directory`); })();
  for (const file of [verify, ...(verifyFiles ?? [])]) taskRelativePath(taskDir, file, defPath);
  return { id, instruction: parsed.instruction, verify, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(verifyFiles ? { verifyFiles } : {}) };
}

/** A path task.json names, which must stay inside the task directory. */
function taskRelativePath(taskDir: string, file: string, defPath: string): string {
  const rel = normalize(file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`task-suite: ${defPath} names ${file}, which is not inside the task directory`);
  }
  return rel;
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Copy the task's verification script and its `verifyFiles` out of the task
 * directory into a private snapshot, before the session can touch them. With
 * `sourceTaskDir` (the same task in the original suite), every snapshotted
 * file must have the original's sha256. Throws a named reason otherwise.
 */
function snapshotVerifier(taskDir: string, task: TaskDefinition, sourceTaskDir: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-eval-verify-'));
  try {
    for (const file of [task.verify, ...(task.verifyFiles ?? [])]) {
      const rel = taskRelativePath(taskDir, file, join(taskDir, 'task.json'));
      const from = join(taskDir, rel);
      if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`verification file ${rel} is missing from the task`);
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (sourceTaskDir !== undefined) {
        const original = join(sourceTaskDir, rel);
        if (!existsSync(original) || sha256File(original) !== sha256File(to)) throw new Error(`verification file ${rel} differs from the suite's`);
      }
    }
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A discovered task: its parsed definition and the absolute directory it lives in. */
export interface DiscoveredTask {
  readonly definition: TaskDefinition;
  readonly taskDir: string;
}

/** Discover the task subdirectories (each containing a task.json) of a suite directory, sorted by id. */
export function discoverTasks(suiteDir: string): DiscoveredTask[] {
  const root = resolve(suiteDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`task-suite: ${root} is not a directory`);
  }
  const tasks: DiscoveredTask[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(root, entry.name);
    if (!existsSync(join(taskDir, 'task.json'))) continue;
    tasks.push({ definition: loadTaskDefinition(taskDir), taskDir });
  }
  return tasks.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
}

const VERIFY_ENV_NAMES = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM'] as const;

/**
 * Default verifier: run the snapshotted verification script through `bash`,
 * contained (origin `project`) with the task directory read-only, and treat
 * exit 0 as pass. Where no boundary exists the script runs on the host and the
 * output says so.
 */
export const defaultShellVerifier: TaskVerifier = async (ctx) => {
  if (!existsSync(ctx.verifyScript)) {
    return { passed: false, output: `verification script not found: ${ctx.verifyScript}` };
  }
  const timeoutMs = ctx.timeoutMs ?? 60_000;
  const env: Record<string, string> = { HOME: tmpdir(), GOODVIBES_EVAL_VERIFY_DIR: ctx.verifyDir };
  for (const name of VERIFY_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const limit = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([limit, ctx.signal]) : limit;
  try {
    const result = await runContained({
      argv: ['bash', ctx.verifyScript],
      cwd: ctx.taskDir,
      env,
      signal,
      origin: 'project',
      containment: {
        boundary: 'host-allowed',
        network: 'on',
        writable: [],
        readOnly: [ctx.verifyDir],
        reason: `the verification script of task ${ctx.taskId} reads the task directory without changing it`,
      },
    });
    const output = `${result.stdout}${result.stderr}`.trim();
    // The one boundary the product has is bubblewrap on Linux (tools/exec/sandbox.ts); macOS, native
    // Windows and a Linux without bubblewrap or user namespaces have none, and only there does this run on the host.
    const host = result.applied.backend === 'host'
      ? `verification was NOT isolated: it ran on the host with the task directory writable, because no sandbox boundary exists here (${hostSandboxAvailability().reason})`
      : '';
    if (result.exitCode === 0) return { passed: true, output: [output, host].filter(Boolean).join('\n') };
    const stopped = ctx.signal?.aborted ? 'verification script was stopped by the owner' : `verification script was stopped after ${timeoutMs} ms`;
    const fault = result.exitCode === null ? stopped : '';
    return { passed: false, output: [output, fault, host].filter(Boolean).join('\n') };
  } catch (error) {
    if (ctx.signal?.aborted) return { passed: false, output: 'verification script was stopped by the owner' };
    if (limit.aborted) return { passed: false, output: `verification script was stopped after ${timeoutMs} ms` };
    const reason = error instanceof ContainmentUnavailableError ? `${error.reason} ${error.next}` : error instanceof Error ? error.message : String(error);
    return { passed: false, output: `verification script could not run: ${reason}` };
  }
};

/**
 * Run every task in `suiteDir` through the injected session executor, then its
 * verification script, and report pass/fail per task. A task passes only when
 * the session completed AND its verifier passed.
 */
export async function runTaskSuite(suiteDir: string, options: RunTaskSuiteOptions): Promise<TaskSuiteResult> {
  const root = resolve(suiteDir);
  const sourceRoot = options.sourceDir !== undefined ? resolve(options.sourceDir) : undefined;
  const verifier = options.verifier ?? defaultShellVerifier;
  const tasks = discoverTasks(root);
  const results: TaskResult[] = [];

  for (const { definition: task, taskDir } of tasks) {
    // Stopped by the owner: no further task starts.
    if (options.signal?.aborted) break;
    const startedAt = Date.now();

    // The verifier is taken out of the task directory before the session can change it.
    let verifyDir: string;
    try {
      verifyDir = snapshotVerifier(taskDir, task, sourceRoot !== undefined ? join(sourceRoot, relative(root, taskDir)) : undefined);
    } catch (err) {
      const reason = `task was not run: ${err instanceof Error ? err.message : String(err)}`;
      results.push({ taskId: task.id, passed: false, sessionCompleted: false, verifierPassed: false, verifierOutput: reason, reason, durationMs: Date.now() - startedAt });
      continue;
    }

    let sessionCompleted = false;
    let sessionSummary = '';
    try {
      const outcome = await options.executor({
        taskId: task.id,
        taskDir,
        instruction: task.instruction,
        timeoutMs: task.timeoutMs,
        signal: options.signal,
      });
      sessionCompleted = outcome.completed;
      sessionSummary = outcome.summary ?? '';
    } catch (err) {
      sessionCompleted = false;
      sessionSummary = err instanceof Error ? err.message : String(err);
    }

    let verifierPassed = false;
    let verifierOutput = 'skipped (session did not complete)';
    if (sessionCompleted) {
      try {
        const verdict = await verifier({
          taskId: task.id,
          taskDir,
          verifyScript: join(verifyDir, normalize(task.verify)),
          verifyDir,
          timeoutMs: task.timeoutMs,
          signal: options.signal,
        });
        verifierPassed = verdict.passed;
        verifierOutput = verdict.output;
      } catch (err) {
        // One verifier that throws must not discard every other task's result.
        verifierPassed = false;
        verifierOutput = `verifier threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    rmSync(verifyDir, { recursive: true, force: true });

    const passed = sessionCompleted && verifierPassed;
    results.push({
      taskId: task.id,
      passed,
      sessionCompleted,
      verifierPassed,
      verifierOutput,
      reason: !sessionCompleted
        ? `session did not complete${sessionSummary ? `: ${sessionSummary}` : ''}`
        : verifierPassed
          ? 'session completed and verification passed'
          : 'session completed but verification failed (see verifierOutput)',
      durationMs: Date.now() - startedAt,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    suiteDir: root,
    results,
    total: results.length,
    passedCount,
    passed: results.length > 0 && passedCount === results.length,
  };
}

/** Format a task-suite result as sentences, one per task, that wrap at any width. */
export function formatTaskSuiteResult(result: TaskSuiteResult): string {
  const lines: string[] = [`The task suite in ${result.suiteDir}: ${result.passedCount} of ${result.total} task${result.total === 1 ? '' : 's'} passed.`];
  for (const r of result.results) {
    lines.push(`  ${r.taskId} ${r.passed ? 'passed' : 'failed'}${r.reason ? `: ${r.reason}` : ''}.`.replace(/\.\.$/, '.'));
  }
  return lines.join('\n');
}

/**
 * A task-suite run read as an eval suite result, so baselines, the regression
 * gate and the eval views carry real task outcomes: a task that passed scores
 * 100 and one that did not scores 0 (failing its floor), on the quality
 * dimension, with its measured duration. `startedAt` is when the run began.
 */
export function taskSuiteAsEvalSuite(suite: string, result: TaskSuiteResult, startedAt: number): EvalSuiteResult {
  let clock = startedAt;
  const results = result.results.map((task): EvalResult => {
    const taskStartedAt = clock;
    clock += task.durationMs;
    const score = task.passed ? 100 : 0;
    const raw: EvalRawResult = {
      completed: task.sessionCompleted,
      durationMs: task.durationMs,
      observations: { verifierPassed: task.verifierPassed },
      ...(task.passed ? {} : { errorMessage: task.reason }),
    };
    return {
      scenario: {
        id: task.taskId,
        name: task.taskId,
        suite,
        description: `Task ${task.taskId}: run through a real session, then its verification script.`,
        tags: ['task'],
        // The recorded outcome; a task is run again only by running the suite again.
        run: async () => raw,
      },
      raw,
      scorecard: {
        scenarioId: task.taskId,
        scenarioName: task.taskId,
        dimensions: [{ dimension: 'quality', score, weight: 1, rationale: task.reason }],
        compositeScore: score,
        passed: task.passed,
        ...(task.passed ? {} : { notes: [task.reason] }),
      },
      startedAt: taskStartedAt,
      finishedAt: clock,
    };
  });
  return {
    suite,
    startedAt,
    finishedAt: clock,
    results,
    meanScore: results.length > 0 ? results.reduce((sum, entry) => sum + entry.scorecard.compositeScore, 0) / results.length : 0,
    passed: result.passed,
  };
}
