/**
 * Shared validator infrastructure for write and edit tools: how a project
 * checks itself, and the sequence runner. Each validator is the project's own
 * declared command (a package.json script through the project's package
 * manager, the toolchain's own check for a Cargo or Go project, a Makefile
 * target, or a Python tool the pyproject configures), else the owner's
 * `tools.validators.<name>` setting; nothing is run when neither names one. A validator runs only
 * through a runner the composition supplies, which is the exec tool's own path
 * (exec/runtime.ts createExecValidatorRunner, or the captured runner for a
 * contract view), so the sandbox plan, the containment decision, the
 * credential scrub and the working-directory check apply to it as to any
 * command. There is no runner that spawns on the host by itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import { declaredPackageManager, PACKAGE_MANAGER_LOCKFILES } from '../../utils/project-test-runner.js';
import { shellSplit } from '../../utils/shell-split.js';

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

export const VALIDATOR_NAMES: readonly ValidatorName[] = ['typecheck', 'lint', 'test', 'build'];

/** package.json script names that declare each validator, first match wins. */
const SCRIPT_NAMES: Record<ValidatorName, readonly string[]> = {
  typecheck: ['typecheck', 'type-check', 'check-types', 'tsc'],
  lint: ['lint'],
  test: ['test'],
  build: ['build'],
};

/** A toolchain's own check commands, for projects that declare no scripts of their own. */
const TOOLCHAIN_COMMANDS: ReadonlyArray<readonly [manifest: string, commands: Partial<Record<ValidatorName, readonly string[]>>]> = [
  ['Cargo.toml', { typecheck: ['cargo', 'check'], lint: ['cargo', 'clippy'], test: ['cargo', 'test'], build: ['cargo', 'build'] }],
  ['go.mod', { typecheck: ['go', 'vet', './...'], test: ['go', 'test', './...'], build: ['go', 'build', './...'] }],
];

/** The project's command for each validator it declares; absent names have none. */
export type ProjectValidatorCommands = Partial<Record<ValidatorName, readonly string[]>>;

/** Makefile targets that declare each validator, first match wins. */
const MAKE_TARGETS: Record<ValidatorName, readonly string[]> = {
  typecheck: ['typecheck', 'type-check', 'check-types'],
  lint: ['lint'],
  test: ['test'],
  build: ['build'],
};
const MAKEFILES: readonly string[] = ['GNUmakefile', 'makefile', 'Makefile'];

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf-8'); } catch { return undefined; }
}

/** `make <target>` for each validator whose target the project's Makefile defines. */
function makeCommands(root: string): ProjectValidatorCommands {
  const file = MAKEFILES.find((name) => existsSync(join(root, name)));
  const text = file === undefined ? undefined : readText(join(root, file));
  if (text === undefined) return {};
  const targets = new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((match) => match[1]!));
  const commands: ProjectValidatorCommands = {};
  for (const name of VALIDATOR_NAMES) {
    const target = MAKE_TARGETS[name].find((candidate) => targets.has(candidate));
    if (target) commands[name] = ['make', target];
  }
  return commands;
}

/** The Python tools a project's pyproject.toml (or pytest.ini) configures: pytest, mypy, ruff. */
function pythonCommands(root: string): ProjectValidatorCommands {
  const pyproject = readText(join(root, 'pyproject.toml')) ?? '';
  const commands: ProjectValidatorCommands = {};
  if (/^\[tool\.pytest/m.test(pyproject) || existsSync(join(root, 'pytest.ini'))) commands.test = ['python', '-m', 'pytest'];
  if (/^\[tool\.mypy\]/m.test(pyproject) || existsSync(join(root, 'mypy.ini'))) commands.typecheck = ['python', '-m', 'mypy', '.'];
  if (/^\[tool\.ruff/m.test(pyproject) || existsSync(join(root, 'ruff.toml'))) commands.lint = ['ruff', 'check', '.'];
  return commands;
}

/** The owner's setting naming the command of a validator, for a project that declares none. */
export function validatorSettingKey(name: ValidatorName): `tools.validators.${ValidatorName}` {
  return `tools.validators.${name}`;
}

/**
 * The validator commands the owner set (`tools.validators.<name>`, each a
 * command line), split into arguments. A value that does not split (an open
 * quote) is left out. Read on each call, so a changed setting applies to the
 * next write or edit.
 */
export function validatorSettings(configManager: Pick<ConfigManager, 'get'> | undefined): ProjectValidatorCommands {
  const commands: ProjectValidatorCommands = {};
  if (!configManager) return commands;
  for (const name of VALIDATOR_NAMES) {
    let value: unknown;
    try { value = configManager.get(validatorSettingKey(name)); } catch { continue; }
    if (typeof value !== 'string' || value.trim() === '') continue;
    try {
      const argv = shellSplit(value.trim(), { strict: true });
      if (argv.length > 0) commands[name] = argv;
    } catch { /* an unterminated quote names no command */ }
  }
  return commands;
}

function readManifest(root: string): Record<string, unknown> | undefined {
  let raw: string;
  try { raw = readFileSync(join(root, 'package.json'), 'utf-8'); } catch { return undefined; }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/**
 * Reads how the project at `root` checks itself: its package.json scripts run
 * through its declared package manager (npm when it declares none), then a
 * Cargo or Go toolchain's own commands, then its Makefile targets, then the
 * Python tools its pyproject configures. `overrides` win per validator;
 * `fallbacks` (the owner's `tools.validators.*` settings) fill a validator the
 * project declares nothing for. Cost: a read of package.json, the Makefile and
 * pyproject.toml when present, and a few existence checks.
 */
export function resolveProjectValidators(root: string, overrides?: ProjectValidatorCommands, fallbacks?: ProjectValidatorCommands): ProjectValidatorCommands {
  const commands: ProjectValidatorCommands = {};
  const manifest = readManifest(root);
  const scripts = manifest?.scripts;
  if (manifest && scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    const lockfiles = PACKAGE_MANAGER_LOCKFILES.map(([file]) => file).filter((file) => existsSync(join(root, file)));
    const manager = declaredPackageManager(manifest, lockfiles) ?? 'npm';
    for (const name of VALIDATOR_NAMES) {
      const script = SCRIPT_NAMES[name].find((candidate) => typeof (scripts as Record<string, unknown>)[candidate] === 'string');
      if (script) commands[name] = [manager, 'run', script];
    }
  }
  const declaredSources = [
    ...TOOLCHAIN_COMMANDS.filter(([file]) => existsSync(join(root, file))).map(([, toolchain]) => toolchain),
    makeCommands(root),
    pythonCommands(root),
    fallbacks ?? {},
  ];
  for (const source of declaredSources) {
    for (const name of VALIDATOR_NAMES) {
      const command = source[name];
      if (command && command.length > 0 && !commands[name]) commands[name] = command;
    }
  }
  for (const name of VALIDATOR_NAMES) {
    const override = overrides?.[name];
    if (override && override.length > 0) commands[name] = override;
  }
  return commands;
}

/** The validators asked for that the project declares no command for (and no setting names). */
export function undeclaredValidators(
  validators: readonly ValidatorName[], root: string, overrides?: ProjectValidatorCommands, fallbacks?: ProjectValidatorCommands,
): ValidatorName[] {
  const commands = resolveProjectValidators(root, overrides, fallbacks);
  return validators.filter((name) => !commands[name]);
}

/** The refusal for validators the project does not declare, with what it does declare and the setting that supplies one. */
export function describeUndeclaredValidators(
  missing: readonly ValidatorName[], root: string, overrides?: ProjectValidatorCommands, fallbacks?: ProjectValidatorCommands,
): string {
  const commands = resolveProjectValidators(root, overrides, fallbacks);
  const declared = VALIDATOR_NAMES.filter((name) => commands[name]).map((name) => `${name} (${commands[name]!.join(' ')})`);
  return `No ${missing.join(', ')} command is declared for this project (no matching package.json script, Cargo or Go toolchain, Makefile target or pyproject tool). `
    + (declared.length > 0 ? `It declares: ${declared.join(', ')}. ` : 'It declares none. ')
    + 'Nothing was changed; resend without those validators, run the check with the exec tool, '
    + `or ask the owner to set ${missing.map(validatorSettingKey).join(', ')} to the command (for example "pnpm -r test") in their own settings.`;
}

/** The commands resolved for the run in progress; the runners read them through {@link validatorCommand}. */
const runCommands = new AsyncLocalStorage<ProjectValidatorCommands>();

/**
 * The command of one validator in the run {@link runValidators} started. The
 * runners call this; outside such a run, or for a validator the project does
 * not declare, it throws rather than guess a default.
 */
export function validatorCommand(name: ValidatorName): readonly string[] {
  const command = runCommands.getStore()?.[name];
  if (!command) throw new Error(`No ${name} command is declared for this project.`);
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
 * Run the validators in sequence with the project's own commands. Returns the
 * failures (empty when all pass). A validator the project does not declare is
 * a failure that ran nothing. Without a runner nothing is spawned: each
 * validator is reported failed with {@link VALIDATORS_UNAVAILABLE}.
 */
export async function runValidators(
  validators: ValidatorName[],
  cwd: string,
  runner: ValidatorRunner | undefined,
  assertCurrent?: () => void,
  signal?: AbortSignal,
  overrides?: ProjectValidatorCommands,
  fallbacks?: ProjectValidatorCommands,
): Promise<ValidatorResult[]> {
  if (!runner) return validators.map((validator) => ({ validator, passed: false, stdout: '', stderr: VALIDATORS_UNAVAILABLE, exitCode: -1 }));
  const commands = resolveProjectValidators(cwd, overrides, fallbacks);
  const failures: ValidatorResult[] = [];
  for (const name of validators) {
    assertCurrent?.();
    if (!commands[name]) {
      failures.push({ validator: name, passed: false, stdout: '', stderr: `No ${name} command is declared for this project; nothing ran.`, exitCode: -1 });
      continue;
    }
    const execution = assertCurrent ? { assertCurrent, ...(signal ? { signal } : {}) } : undefined;
    const result = await runCommands.run(commands, () => runner(name, cwd, execution));
    if (!result.passed) failures.push(result);
  }
  return failures;
}

/**
 * Runs one already-resolved command through a validator runner, which is the
 * exec tool's own path (sandbox plan, containment, credential scrub). The REPL
 * evaluates its snippet this way instead of keeping a second command runner.
 */
export function runResolvedCommand(runner: ValidatorRunner, command: readonly string[], cwd: string, execution: ValidatorExecution): Promise<ValidatorResult> {
  return runCommands.run({ test: command }, () => runner('test', cwd, execution));
}

/** How much of each output stream a failure carries: the end, where a check prints its errors and summary. */
export const VALIDATOR_OUTPUT_CHARS = 8_000;

/** The last {@link VALIDATOR_OUTPUT_CHARS} characters of a stream, saying how much was left out. */
export function capValidatorOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= VALIDATOR_OUTPUT_CHARS) return trimmed;
  return `[${trimmed.length - VALIDATOR_OUTPUT_CHARS} earlier characters left out]\n${trimmed.slice(-VALIDATOR_OUTPUT_CHARS)}`;
}

/** Format a validator failure into one message, each stream once and capped. */
export function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):` ];
  if (result.stderr.trim()) parts.push(capValidatorOutput(result.stderr));
  if (result.stdout.trim()) parts.push(capValidatorOutput(result.stdout));
  return parts.join('\n');
}
