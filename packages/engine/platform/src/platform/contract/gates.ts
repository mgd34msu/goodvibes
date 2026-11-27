/**
 * Quality gates: the configured commands (`contract.gates`) whose results are
 * contract evidence and a deterministic input to a check's outcome. A failing
 * gate that was not skipped means the unit cannot pass, whatever the readings say.
 *
 * Whether a gate applies (a tsconfig, an ESLint config, a package script) and
 * whether its command exited zero are file-system and process facts, so all
 * of this is code.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSandboxWritableExtras } from '../runtime/sandbox/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { ContainmentUnavailableError, runContained } from '../runtime/sandbox/contained-spawn.js';
import { resolveCredentialEnvScrub, scrubCredentialEnv } from '../tools/exec/credential-env.js';
import { configuredCredentialEnvScrub } from '../tools/exec/credential-env-config.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { declaredPackageManager, isDeclaredPackageManager, PACKAGE_MANAGER_LOCKFILES, type DeclaredPackageManager } from '../utils/project-test-runner.js';
import { getContractGates, getEnabledContractGates, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';
import { captureGateInput, linkProjectDependencies, type GateSourceInputIdentity } from './gate-input.js';
import { bunTestCommand, junitCompletion, protocolCompletion, type GateCompletion } from './gate-receipts.js';
import type { ContractCheckedGate, GateResultOutcome } from '../../events/contract.js';

/** One configured gate. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
  /** Required unavailable checks leave their acceptance obligation unverified. Tests are required by default. */
  required?: boolean;
  /**
   * An assertion check passes or fails on its command's exit code, like any
   * other gate; under `bun test` (instrumented) or the registered completion
   * protocol its assertion counts are kept as well. A gate named `test` is an
   * assertion check, whatever this says.
   */
  verification?: 'command' | 'assertions';
}

/** The result of running one gate. */
export interface QualityGateResult {
  gate: QualityGate['name'];
  /** Compatibility display field. Only a completed, current check is passed. */
  passed: boolean;
  output: string;
  durationMs: number;
  /** True when the gate did not apply to the tree it ran against (for example, no script of that name). */
  skipped?: boolean | undefined;
  /** Absent on historical records; new runs always distinguish unknown execution from a failed assertion. */
  outcome?: GateResultOutcome;
  required?: boolean;
  reason?: string;
  completion?: GateCompletion;
  /** Where the gate's command ran: inside the bubblewrap boundary, or on the host where this machine has none. Absent on records from before gates were contained. */
  backend?: 'bubblewrap' | 'host';
  provenance?: {
    readonly sourceBefore: string;
    readonly sourceAfter: string;
    readonly definitionBefore: string;
    readonly definitionAfter: string;
    /** The tree the gate ran in, and the paths its source identity covers (absent: the whole tree). */
    readonly root?: string;
    readonly scope?: readonly string[];
  };
}

interface GateCommandResult {
  readonly passed: boolean;
  readonly output: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly kind: 'completed' | 'tool-error';
  /** Where the command ran; absent when it could not be started. */
  readonly backend?: 'bubblewrap' | 'host' | undefined;
}

type GateInputIdentity = GateSourceInputIdentity & { readonly definition: string };

// Gate definitions are identified by a salted digest: equal definitions compare
// equal within this process, and a command that embeds a credential never
// enters a stored record. After a restart the salt differs, so a stored result
// reads as needing a fresh run, as it should.
const DEFINITION_SALT = randomBytes(16);
const gateDefinitionId = (gates: readonly QualityGate[]): string => `gate-definition-${createHash('sha256').update(DEFINITION_SALT)
  .update(JSON.stringify(gates.map(gate => [gate.name, gate.command, gate.enabled, gate.required ?? null, gate.verification ?? null]))).digest('hex').slice(0, 32)}`;

const requiredGate = (gate: QualityGate): boolean => gate.required ?? (gate.name === 'test' || gate.verification === 'assertions');

/** Historical booleans remain readable; an absent required assertion receipt never proves acceptance. */
export function gateOutcome(result: QualityGateResult): GateResultOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped || (result.required === true && !result.completion)) return 'unverified';
  return result.passed ? 'passed' : 'failed';
}

function unknownResult(result: QualityGateResult, reason: string): QualityGateResult {
  return { ...result, outcome: 'unverified', passed: false, reason,
    // Earlier receipts omitted this field. Preserve the same native defaults
    // rather than turning their missing obligation into an optional check.
    ...(result.required === undefined && (result.gate === 'test' || result.completion?.kind === 'assertions') ? { required: true } : {}),
  };
}

export function gateEventSummary(result: QualityGateResult): ContractCheckedGate {
  return { gate: result.gate, passed: result.passed, skipped: result.skipped === true,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.required === undefined ? {} : { required: result.required }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/**
 * Gate results still current: a passed result keeps its outcome while its tree
 * reads the same source identity it ran against (one capture per tree and
 * scope) and the gate definitions are the ones it ran with. A result with no
 * comparable identity (a record from before this process) reads unverified.
 */
export function refreshGateResults(results: readonly QualityGateResult[] | undefined, configManager?: ContractConfigReader,
  /** Source identities the caller has just read, by `gateSourceKey`: compared without reading them again. */
  known?: ReadonlyMap<string, string>): QualityGateResult[] {
  const captures = new Map<string, string | undefined>(known);
  const definition = configManager === undefined ? undefined : gateDefinitionId(getEnabledContractGates(configManager));
  return (results ?? []).map(result => {
    if (gateOutcome(result) !== 'passed') return result;
    const provenance = result.provenance;
    if (!provenance?.root || !/^(?:tree|paths|stat):/.test(provenance.sourceAfter)) return unknownResult(result, 'historical-check-requires-current-execution');
    if (definition !== undefined && definition !== provenance.definitionAfter) return unknownResult(result, 'check-definition-changed-after-check');
    const key = gateSourceKey(provenance.root, provenance.scope);
    if (!captures.has(key)) {
      try { captures.set(key, captureGateInput(provenance.root, undefined, provenance.scope).source); }
      catch { captures.set(key, undefined); }
    }
    const current = captures.get(key);
    if (current === undefined) return unknownResult(result, 'source-identity-unavailable');
    return current === provenance.sourceAfter ? result : unknownResult(result, 'source-changed-after-check');
  });
}

/** The key of one tree's source identity (its root and the paths it covers) for `refreshGateResults`. */
export function gateSourceKey(root: string, scope?: readonly string[]): string {
  return JSON.stringify([root, scope ?? null]);
}

/**
 * Required unknown checks cannot be promoted by a semantic reading. A check
 * that could not run where the work is (the project's dependencies are not
 * installed there) is not the work's to supply, so it asks nothing of it.
 */
export function unverifiedGates(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  return (results ?? []).filter(result => result.required === true && gateOutcome(result) === 'unverified' && result.reason !== 'dependencies-missing');
}

/** What the nudge tells a worker about a required gate that has no current evidence, including how to supply it when that is possible. */
export function unverifiedGateAdvice(result: QualityGateResult): string {
  switch (result.reason) {
    case 'source-changed-during-check': return 'source-changed-during-check: files the check covers changed while the gate ran; the gate runs again at the next check';
    case 'inconsistent-check-result': return 'inconsistent-check-result: the command\'s exit code and its reported assertion counts disagree';
    default: return result.reason ?? 'unverified check completion';
  }
}

/** The `scripts` of `cwd`'s package.json; empty when there is none or it cannot be read. */
export async function loadPackageScripts(cwd: string): Promise<Record<string, string>> {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkgJson = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
    return pkgJson.scripts ?? {};
  } catch {
    return {};
  }
}

/** Single-quote a word for a `/bin/sh -c` line; an embedded quote becomes `'\''`. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** This project's test command and where it came from (named to the owner). */
export interface ProjectTestCommand {
  readonly command: string;
  readonly source: string;
}

/**
 * The one definition of "this project's test command", for `/test` and anyone
 * else running the project's tests outside a contract check: the
 * `contract.gates` entry named `test` (its command, whether or not checks run
 * it), else the package.json `test` script run through the package manager
 * the project declares, so `node_modules/.bin` is on PATH and `pretest` and
 * `posttest` run. `args` are passed to the command, each quoted. Null when
 * neither exists; `projectTestCommandMissing` says what to set.
 */
export async function resolveProjectTestCommand(
  cwd: string,
  configManager: ContractConfigReader,
  args: readonly string[] = [],
): Promise<ProjectTestCommand | null> {
  const tail = args.length > 0 ? ` ${args.map(shellWord).join(' ')}` : '';
  const configured = getContractGates(configManager).find((gate) => gate.name === 'test' && gate.command.trim() !== '');
  if (configured) return { command: `${configured.command.trim()}${tail}`, source: 'the contract.gates entry named test' };
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await Bun.file(pkgPath).text());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    manifest = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const scripts = manifest.scripts;
  const script = scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts) ? (scripts as Record<string, unknown>).test : undefined;
  if (typeof script !== 'string' || script.trim() === '') return null;
  const lockfiles = PACKAGE_MANAGER_LOCKFILES.map(([file]) => file).filter((file) => existsSync(join(cwd, file)));
  const manager = declaredPackageManager(manifest, lockfiles) ?? undeclaredPackageManager(script);
  // npm alone needs `--` to hand arguments to the script rather than keep them.
  const command = manager === 'npm' ? `npm test${tail ? ` --${tail}` : ''}` : `${manager} run test${tail}`;
  return { command, source: `the package.json test script, run with ${manager}` };
}

/**
 * The manager to run a test script with when the project declares none (no
 * packageManager field, no single lockfile): the one the script itself calls
 * (`bun test` is a Bun project), else the first one installed, npm first.
 */
function undeclaredPackageManager(script: string): DeclaredPackageManager {
  const first = script.trim().split(/\s+/)[0] ?? '';
  if (isDeclaredPackageManager(first)) return first;
  if (first === 'bunx') return 'bun';
  if (first === 'npx') return 'npm';
  for (const manager of ['npm', 'bun', 'pnpm', 'yarn'] as const) {
    if (Bun.which(manager) !== null) return manager;
  }
  return 'npm';
}

/** Why there is no test command for `cwd`, and the two ways to give it one. */
export function projectTestCommandMissing(cwd: string): string {
  const hasManifest = existsSync(join(cwd, 'package.json'));
  return `No test command for ${cwd}: ${hasManifest ? 'package.json has no test script' : 'there is no package.json'} `
    + 'and the contract.gates setting has no gate named test. Add a test script to package.json, or add '
    + '{"name": "test", "command": "<your test command>", "enabled": false} to contract.gates in your settings '
    + '(enabled: true also runs it at each contract check).';
}

const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
] as const;

/** Why a gate does not apply to `cwd`, or null when it does. */
export function getSkippedGateReason(gateName: string, cwd: string, pkgScripts: Record<string, string>, command?: string): string | null {
  if (gateName === 'typecheck' && !existsSync(join(cwd, 'tsconfig.json'))) return 'Skipped: no tsconfig.json found';
  if (gateName === 'lint' && !ESLINT_CONFIGS.some((file) => existsSync(join(cwd, file)))) return 'Skipped: no ESLint config found';
  if (gateName === 'test' && !pkgScripts['test'] && (command === undefined || command.trim() === 'bun run test')) return 'Skipped: no test script in package.json';
  if (gateName === 'build' && !pkgScripts['build']) return 'Skipped: no build script in package.json';
  return null;
}

/** The daemon's environment as strings, before the credential scrub. */
function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** What a gate command runs with: its environment, and the paths it may write beyond its working directory. */
export interface GateCommandOptions {
  /** The scrubbed environment the command runs with (credential-bearing variables already withheld). */
  readonly environment: Readonly<Record<string, string>>;
  /** Absolute paths the command may write besides `cwd`: its report directory and sandbox.workspaceWritable. */
  readonly writable?: readonly string[] | undefined;
}

/**
 * Runs one gate command through `/bin/sh -c`, as a program the project chose:
 * inside the same bubblewrap boundary the exec tool uses (runContained: network
 * on, `cwd` and `writable` writable, the home directory hidden except the
 * toolchain directories every boundary shows read-only, exec/sandbox-home.ts),
 * or on the host where no boundary exists, which the result's `backend` states. `cwd`
 * is the unit's worktree in worktree mode, so the gate sees the unit's
 * isolated changes. It runs until it exits or `signal` stops it (the work
 * stopped by the owner or a decision): no clock stops it, so a command left in
 * watch mode runs on, visible as its step being checked, until it is stopped. A
 * stopped command's whole process group is killed.
 */
export async function executeGateCommand(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  options: GateCommandOptions,
): Promise<GateCommandResult> {
  try {
    signal?.throwIfAborted();
    const run = await runContained({
      argv: ['/bin/sh', '-c', command],
      cwd,
      env: options.environment,
      ...(signal ? { signal } : {}),
      origin: 'project',
      containment: {
        boundary: 'host-allowed',
        network: 'on',
        writable: [cwd, ...(options.writable ?? [])],
        honorsExtraPaths: true,
        reason: 'a contract gate runs the project\'s own scripts',
      },
    });
    signal?.throwIfAborted();
    const output = [run.stdout, run.stderr, run.hint ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();
    return { passed: run.exitCode === 0, output, stdout: run.stdout, exitCode: run.exitCode,
      kind: run.exitCode === null ? 'tool-error' : 'completed', backend: run.applied.backend };
  } catch (error) {
    signal?.throwIfAborted();
    const output = error instanceof ContainmentUnavailableError ? `${error.reason} ${error.next}` : summarizeError(error);
    return { passed: false, output, stdout: '', exitCode: null, kind: 'tool-error' };
  }
}

export interface RunContractGatesOptions {
  readonly configManager: ContractConfigReader;
  readonly signal?: AbortSignal | undefined;
  /** The tree the gates run against: the unit's worktree, the contract worktree, or the project root. */
  readonly cwd: string;
  readonly runtimeBus: RuntimeEventBus;
  readonly sessionId: string;
  readonly contractId: string;
  /** The unit, group or contract the gates are evidence for; carried by CONTRACT_GATE_RESULT. */
  readonly targetId: string;
  /** The project the contract works in (its `projectRoot`): what each result says it is about (events/about.ts). */
  readonly project?: string | null | undefined;
  /**
   * The paths, relative to `cwd`, whose content the results are evidence for
   * (a shared tree the owner keeps working in). Absent: the whole tree.
   */
  readonly scope?: readonly string[] | undefined;
  /**
   * The paths the work being checked changed, relative to `cwd`. Given, only
   * the gates that check one of them run ({@link gateChecks}), and none when
   * nothing changed: work that changed no source has nothing to typecheck or
   * lint. Absent: every enabled gate runs.
   */
  readonly changedPaths?: readonly string[] | undefined;
  readonly onResult?: ((results: readonly QualityGateResult[], result: QualityGateResult) => void) | undefined;
}

const SCRIPT_SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const TYPECHECK_CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json)$/i;
const LINT_CONFIG = /(?:^|\/)(?:\.?eslint[^/]*|package\.json)$/i;

/**
 * Whether a gate checks any of `paths`: `typecheck` a script source or a
 * TypeScript or package configuration, `lint` a script source or an ESLint or
 * package configuration, every other gate (tests, a build, the owner's own)
 * any changed file.
 */
export function gateChecks(gate: Pick<QualityGate, 'name'>, paths: readonly string[]): boolean {
  if (gate.name === 'typecheck') return paths.some((path) => SCRIPT_SOURCE.test(path) || TYPECHECK_CONFIG.test(path));
  if (gate.name === 'lint') return paths.some((path) => SCRIPT_SOURCE.test(path) || LINT_CONFIG.test(path));
  return paths.length > 0;
}

/** Contracts already told that a gate could not run where the work is, by gate: said once per contract. */
const toldCannotRun = new Map<string, Set<string>>();

/** True the first time a contract's gate could not run for want of the project's dependencies. */
function firstCannotRun(contractId: string, gate: string): boolean {
  let told = toldCannotRun.get(contractId);
  if (told === undefined) {
    told = new Set();
    toldCannotRun.set(contractId, told);
    // Kept for the contracts of this process only: the oldest are forgotten first.
    if (toldCannotRun.size > 256) toldCannotRun.delete(toldCannotRun.keys().next().value!);
  }
  if (told.has(gate)) return false;
  told.add(gate);
  return true;
}

/**
 * Runs every enabled `contract.gates` entry in order against `cwd`, each until
 * it exits or the work is stopped. The source is identified once before the gates
 * and once after; when it changed meanwhile, every result reads unverified.
 * A gate passes or fails on its command's exit code; an assertion gate under
 * `bun test` or the completion protocol also carries its counts, and fails
 * on a failed assertion. Every result is emitted as CONTRACT_GATE_RESULT.
 */
export async function runContractGates(options: RunContractGatesOptions): Promise<QualityGateResult[]> {
  const enabled = getEnabledContractGates(options.configManager);
  const changed = options.changedPaths;
  const gates = enabled.filter(gate => changed === undefined || gateChecks(gate, changed)).map(gate => Object.freeze({ ...gate }));
  if (gates.length === 0) return [];
  // The definition is every enabled gate's, whichever of them this work needs, so a result stays comparable with the setting.
  const definitionBefore = gateDefinitionId(enabled);
  // A worktree has no installed dependencies of its own: the project's are linked in where git ignores them, as the project runs its scripts.
  const dependencies = linkProjectDependencies(options.cwd);
  let before: GateInputIdentity | undefined;
  try { before = { ...captureGateInput(options.cwd, undefined, options.scope), definition: definitionBefore }; }
  catch { /* No source identity: every result is unverified below. */ }
  const results: QualityGateResult[] = [];
  const emitResult = (result: QualityGateResult): void => {
    if (result.reason === 'dependencies-missing' && !firstCannotRun(options.contractId, result.gate)) return;
    emitContractEvent(options.runtimeBus, options.sessionId, {
      type: 'CONTRACT_GATE_RESULT', contractId: options.contractId, targetId: options.targetId,
      ...gateEventSummary(result), durationMs: result.durationMs,
    }, options.project);
  };

  for (const gate of gates) {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const skipReason = before ? getSkippedGateReason(gate.name, options.cwd, { ...before.packageScripts }, gate.command) : null;
    const cannotRun = skipReason === null && dependencies.missing
      ? `Could not run here: the project's dependencies (node_modules) are not installed in ${options.cwd} or in the checkout it was made from; install them to run this check. This says nothing about the work.`
      : null;
    const result: QualityGateResult = { gate: gate.name, passed: false, outcome: 'unverified', required: requiredGate(gate),
      output: skipReason ?? cannotRun ?? '', durationMs: 0, skipped: skipReason !== null || cannotRun !== null,
      ...(before ? {} : { reason: 'source-identity-unavailable' }),
    };
    if (skipReason !== null) result.reason = 'not-applicable';
    else if (cannotRun !== null) result.reason = 'dependencies-missing';
    else if (before) {
      const directory = mkdtempSync(join(tmpdir(), 'goodvibes-gate-'));
      const report = join(directory, 'result.xml');
      try {
        const assertions = gate.verification === 'assertions' || gate.name === 'test';
        const instrumented = assertions ? bunTestCommand(gate.command, before.packageScripts, report) : undefined;
        const runId = randomUUID();
        // The daemon's own variables (provider keys, tokens) are withheld, as for every exec.
        const scrubbed = await scrubCredentialEnv(hostEnvironment(), resolveCredentialEnvScrub(configuredCredentialEnvScrub(options.configManager)));
        const run = await executeGateCommand(instrumented ?? gate.command, options.cwd, options.signal, {
          environment: { ...scrubbed.env, GOODVIBES_GATE_NAME: gate.name, GOODVIBES_GATE_RUN_ID: runId },
          // The owner's extra paths reach a gate as they reach every exec command.
          writable: [directory, ...getSandboxWritableExtras(options.configManager)],
        });
        result.output = run.output;
        if (run.backend !== undefined) result.backend = run.backend;
        if (run.backend === 'host') result.output = `${result.output}\n(ran on the host: no sandbox boundary is available on this machine)`.trim();
        result.durationMs = Date.now() - startedAt;
        let counted: GateCompletion | undefined;
        if (run.kind === 'completed' && assertions) {
          try { counted = instrumented ? junitCompletion(readFileSync(report, 'utf8')) : protocolCompletion(run.stdout, gate.name, runId); }
          catch { /* No reporter output: the exit code decides. */ }
        }
        if (run.kind !== 'completed' || run.exitCode === null) result.reason = run.kind;
        else if (counted?.kind === 'assertions') {
          result.completion = counted;
          if (counted.checks.failed > 0 && run.exitCode !== 0) { result.outcome = 'failed'; result.reason = 'assertion-failure'; }
          else if (counted.checks.failed === 0 && run.exitCode === 0) { result.outcome = 'passed'; result.passed = true; }
          else result.reason = 'inconsistent-check-result';
        } else {
          // Any test command (npm, pytest, cargo, go, vitest...) reports by its exit code.
          result.completion = { kind: 'command-exit', exitCode: run.exitCode };
          result.outcome = run.exitCode === 0 ? 'passed' : 'failed';
          result.passed = run.exitCode === 0;
          if (run.exitCode !== 0) result.reason = assertions ? 'test-command-failed' : 'command-failed';
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
    results.push(result);
    emitResult(result);
    options.onResult?.(results.slice(), result);
    logger.debug('contract gates: gate result', { contractId: options.contractId, targetId: options.targetId, gate: gate.name, passed: result.passed, skipped: result.skipped });
  }

  // One identity after every gate ran: the results are evidence only for the source they all saw.
  let after: GateInputIdentity | undefined;
  if (before) {
    try { after = { ...captureGateInput(options.cwd, before, options.scope), definition: gateDefinitionId(getEnabledContractGates(options.configManager)) }; }
    catch { /* Unverified below. */ }
  }
  const settled = results.map((result): QualityGateResult => {
    if (!before || result.skipped === true) return result;
    if (!after) return unknownResult(result, 'source-identity-unavailable');
    const stamped: QualityGateResult = { ...result, provenance: { sourceBefore: before.source, sourceAfter: after.source,
      definitionBefore: before.definition, definitionAfter: after.definition, root: options.cwd,
      ...(options.scope === undefined ? {} : { scope: [...options.scope] }) } };
    if (before.source !== after.source) return unknownResult(stamped, 'source-changed-during-check');
    if (before.definition !== after.definition) return unknownResult(stamped, 'check-definition-changed-during-check');
    return stamped;
  });
  // A result the source change turned unverified is reported again with its new outcome.
  settled.forEach((result, index) => { if (result.outcome !== results[index]!.outcome) emitResult(result); });
  return settled;
}

/** Gates that ran and failed; a skipped gate never fails. */
export function failedGates(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  return (results ?? []).filter((result) => gateOutcome(result) === 'failed');
}
