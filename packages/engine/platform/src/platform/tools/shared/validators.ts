import { hasCapturedToolInvocation } from './captured-input-tools.js';

/**
 * Shared validator infrastructure for write and edit tools.
 * Runs typecheck / lint / test / build and returns structured results.
 */

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

/** Map validator name to shell command. */
const VALIDATOR_COMMANDS: Record<ValidatorName, string[]> = {
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: ['npx', 'eslint', '--no-error-on-unmatched-pattern'],
  test: ['bun', 'test'],
  build: ['bun', 'run', 'build'],
};

export function validatorCommand(name: ValidatorName): readonly string[] {
  const command = VALIDATOR_COMMANDS[name];
  if (!Object.hasOwn(VALIDATOR_COMMANDS, name) || !command) throw new Error('Unsupported validator');
  return command;
}

export interface ValidatorExecution {
  readonly assertCurrent: () => void;
  /** Kills the validator process when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Kills the validator process after this many milliseconds. Default {@link DEFAULT_VALIDATOR_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** Long enough for a cold `bun run build` or `tsc` on a large project; a hung process is killed after this. */
export const DEFAULT_VALIDATOR_TIMEOUT_MS = 120_000;
/** After a kill, how long to wait for the output pipes to close before reporting without the rest of the output. */
const STOP_GRACE_MS = 2_000;
export type ValidatorRunner = (name: ValidatorName, cwd: string, execution?: ValidatorExecution) => Promise<ValidatorResult>;

export interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a single validator via Bun.spawn and collect its complete result. The
 * process is killed when the timeout passes or the execution signal aborts, and
 * the result then reports the validator as failed with the reason.
 */
export async function runValidator(name: ValidatorName, cwd: string, execution?: ValidatorExecution): Promise<ValidatorResult> {
  if (hasCapturedToolInvocation()) throw new Error('Captured validators require a construction-owned contained runner');
  return runValidatorCommand(name, validatorCommand(name), cwd, execution);
}

export async function runValidatorCommand(
  name: ValidatorName,
  command: readonly string[],
  cwd: string,
  execution?: ValidatorExecution,
): Promise<ValidatorResult> {
  execution?.assertCurrent();
  const timeoutMs = execution?.timeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
  const proc = Bun.spawn([...command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Its own process group, so a kill reaches what `npx` or `bun run` started and not only the direct child.
    detached: true,
  });
  let stopReason: string | undefined;
  let stopped: (value: undefined) => void = () => {};
  const stopSignal = new Promise<undefined>((resolveStop) => { stopped = resolveStop; });
  const stop = (reason: string): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch { proc.kill('SIGKILL'); }
    stopped(undefined);
  };
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => stop(`Validator '${name}' timed out after ${timeoutMs}ms and was killed`), timeoutMs);
  const onAbort = (): void => stop(`Validator '${name}' was cancelled and killed`);
  if (execution?.signal?.aborted) onAbort();
  else execution?.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const collected = Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    collected.catch(() => {});
    // A descendant that left the process group can keep the pipes open after the kill; do not wait for it.
    const gaveUp = stopSignal.then(() => new Promise<null>((resolveGrace) => { graceTimer = setTimeout(() => resolveGrace(null), STOP_GRACE_MS); }));
    const settled = await Promise.race([collected, gaveUp]);
    const [exitCode, stdoutBuf, stderrBuf] = settled ?? [proc.exitCode ?? -1, '', ''];
    return {
      validator: name,
      passed: stopReason === undefined && exitCode === 0,
      stdout: stdoutBuf,
      stderr: stopReason === undefined ? stderrBuf : `${stopReason}\n${stderrBuf}`.trimEnd(),
      exitCode,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    execution?.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Run all validators in sequence. Returns array of all failures (or empty array if all pass).
 */
export async function runValidators(
  validators: ValidatorName[],
  cwd: string,
  runner: ValidatorRunner = runValidator,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<ValidatorResult[]> {
  const failures: ValidatorResult[] = [];
  for (const name of validators) {
    assertCurrent?.();
    const result = await runner(name, cwd, assertCurrent ? { assertCurrent, ...(signal ? { signal } : {}) } : undefined);
    if (!result.passed) failures.push(result);
  }
  return failures;
}

/** Format a validator failure into a human-readable message. */
export function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):` ];
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n');
}
