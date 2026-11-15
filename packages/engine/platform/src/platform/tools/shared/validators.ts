/**
 * Shared validator infrastructure for write and edit tools: the fixed command
 * table and the sequence runner. A validator runs only through a runner the
 * composition supplies, which is the exec tool's own path (exec/runtime.ts
 * createExecValidatorRunner, or the captured runner for a contract view), so
 * the sandbox plan, the containment decision, the credential scrub and the
 * working-directory check apply to it as to any command. There is no runner
 * that spawns on the host by itself.
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
export type ValidatorRunner = (name: ValidatorName, cwd: string, execution?: ValidatorExecution) => Promise<ValidatorResult>;

export interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Why a validator did not run in a composition that wired no runner. */
export const VALIDATORS_UNAVAILABLE = 'Validators are not available in this session (it has no exec path to run them through). Nothing ran; run the check with the exec tool instead.';

/**
 * Run all validators in sequence. Returns array of all failures (or empty array if all pass).
 * Without a runner nothing is spawned: each validator is reported failed with {@link VALIDATORS_UNAVAILABLE}.
 */
export async function runValidators(
  validators: ValidatorName[],
  cwd: string,
  runner: ValidatorRunner | undefined,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<ValidatorResult[]> {
  if (!runner) return validators.map((validator) => ({ validator, passed: false, stdout: '', stderr: VALIDATORS_UNAVAILABLE, exitCode: -1 }));
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
