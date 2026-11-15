/**
 * tsc-run.ts, the one way the build and typecheck scripts run the compiler.
 *
 * The pinned compiler from the repository root, a heap the type surface needs,
 * output captured (never piped through `head`, see typecheck-output-rule.ts) and
 * judged by typecheckFailures. A run that writes package output takes the build
 * lock, so a typecheck and a build never rewrite `dist` under each other.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { typecheckFailures, type CommandResult } from './typecheck-output-rule.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TSC = resolve(REPO_ROOT, 'node_modules/typescript/bin/tsc');
// The compiler's launcher is a node script; where node is absent (an install
// host with only bun) bun runs it.
const RUNTIME = Bun.which('node') ?? process.execPath;

// Node's default old-space ceiling is ~4 GB regardless of how much the host
// has. The contract surface passed that: with the operator methods rendered into
// OperatorMethodInputMap / OperatorMethodOutputMap, a full engine build dies with
// "Ineffective mark-compacts near heap limit", a SIGNAL, not a diagnostic, so a
// caller reading only the exit code sees a failure with no errors to act on.
export const TSC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=16384`.trim(),
};

export interface TscStep {
  readonly label: string;
  /** Arguments after the compiler path, relative to the repository root. */
  readonly args: readonly string[];
  /** `tsc -b` writes declarations and JavaScript into package `dist`. */
  readonly emits: boolean;
}

/**
 * Judgment and every engine package (the engine solution references judgment
 * through platform). `--force` is for the gate: `tsc -b` decides up-to-date-ness
 * from input mtimes, so a tree whose mtimes were restored (a CI cache, a
 * worktree switch) builds nothing and prints nothing. Without it, the build is
 * the incremental refresh that keeps declarations current for the projects
 * that read them.
 */
export function engineSourcesBuild(force: boolean): TscStep {
  return {
    label: `tsc -b${force ? ' --force' : ''} packages/engine (judgment and every engine package)`,
    args: ['-b', ...(force ? ['--force'] : []), 'packages/engine'],
    emits: true,
  };
}

/** Run the compiler once, unlocked. A caller that already holds the build lock uses this. */
export function runTscUnlocked(label: string, args: readonly string[]): CommandResult {
  const run = spawnSync(RUNTIME, [TSC, ...args, '--pretty', 'false'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: TSC_ENV,
  });
  if (run.error) return { label, exitCode: null, output: `could not run the compiler: ${run.error.message}\n` };
  return { label, exitCode: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/**
 * Run one step, print its output, and return every reason it failed (none when
 * clean). A caller that already holds the build lock says so; the lock is not
 * reentrant.
 */
export async function runTscStep(step: TscStep, holdingLock = false): Promise<string[]> {
  console.log(`[typecheck] ${step.label} ...`);
  const result = step.emits && !holdingLock
    ? await withWorkspaceLock(step.label, () => runTscUnlocked(step.label, step.args))
    : runTscUnlocked(step.label, step.args);
  if (result.output.trim().length > 0) process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
  return typecheckFailures(result);
}
