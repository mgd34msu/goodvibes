/**
 * Quality gates: the configured commands (`contract.gates`) whose results are
 * contract evidence and a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6). A failing gate that
 * was not skipped means the unit cannot pass, whatever the readings say.
 *
 * Whether a gate applies (a tsconfig, an ESLint config, a package script) and
 * whether its command exited zero are file-system and process facts, so all
 * of this is code.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { CONTRACT_CONFIG_DEFAULTS, getContractGateTimeoutMs, getEnabledContractGates, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';
import { captureGateInput, type GateSourceInputIdentity } from './gate-input.js';
import { isDeepStrictEqual } from 'node:util';
import { bunTestCommand, junitCompletion, protocolCompletion, type GateCompletion } from './gate-receipts.js';
import type { ContractCheckedGate, GateResultOutcome } from '../../events/contract.js';

/** One configured gate. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
  /** Required unavailable checks leave their acceptance obligation unverified. Tests are required by default. */
  required?: boolean;
  /** Assertion checks require a supported machine reporter or the registered completion protocol. */
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
  provenance?: {
    readonly sourceBefore: string;
    readonly sourceAfter: string;
    readonly definitionBefore: string;
    readonly definitionAfter: string;
  };
}

interface GateCommandResult {
  readonly passed: boolean;
  readonly output: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly kind: 'completed' | 'timeout' | 'tool-error';
}

type GateInputIdentity = GateSourceInputIdentity & { readonly definition: string };
let definitionSequence = 0;
function nextDefinitionId(): string {
  if (!Number.isSafeInteger(++definitionSequence)) throw new Error('Gate definition identity exhausted');
  return `gate-definition-${definitionSequence}`;
}
const gateDefinitions = (gates: readonly QualityGate[]) => gates.map(gate => Object.freeze({
  name: gate.name, command: gate.command, enabled: gate.enabled, required: gate.required, verification: gate.verification,
}));

const liveGateInputs = new WeakMap<QualityGateResult, () => GateInputIdentity>();
const gateInvalidations = new WeakMap<QualityGateResult, (result: QualityGateResult) => void>();
const invalidatedGates = new WeakMap<QualityGateResult, QualityGateResult>();

const requiredGate = (gate: QualityGate): boolean => gate.required ?? (gate.name === 'test' || gate.verification === 'assertions');

/** Historical booleans remain readable; an absent required assertion receipt never proves acceptance. */
export function gateOutcome(result: QualityGateResult): GateResultOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped || (result.required === true && !result.completion)) return 'unverified';
  return result.passed ? 'passed' : 'failed';
}

function unknownResult(result: QualityGateResult, reason: string): QualityGateResult {
  const existing = invalidatedGates.get(result);
  if (existing) return existing;
  const revised: QualityGateResult = { ...result, outcome: 'unverified', passed: false, reason };
  const current = liveGateInputs.get(result);
  if (current) liveGateInputs.set(revised, current);
  invalidatedGates.set(result, revised);
  gateInvalidations.get(result)?.(revised);
  return revised;
}

export function gateEventSummary(result: QualityGateResult): ContractCheckedGate {
  return { gate: result.gate, passed: result.passed, skipped: result.skipped === true,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.required === undefined ? {} : { required: result.required }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/** Revalidate after asynchronous judgment; a saved receipt alone is not live evidence. */
export function refreshGateResults(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  const captures = new Map<() => GateInputIdentity, GateInputIdentity | undefined>();
  return (results ?? []).map(result => {
    const invalidated = invalidatedGates.get(result);
    if (invalidated) return invalidated;
    if (!result.provenance || gateOutcome(result) !== 'passed') return result;
    const capture = liveGateInputs.get(result);
    if (!capture) return unknownResult(result, 'historical-check-requires-current-execution');
    try {
      if (!captures.has(capture)) captures.set(capture, capture());
      const current = captures.get(capture);
      if (!current) return unknownResult(result, 'source-identity-unavailable');
      if (current.source !== result.provenance.sourceAfter) return unknownResult(result, 'source-changed-after-check');
      if (current.definition !== result.provenance.definitionAfter) return unknownResult(result, 'check-definition-changed-after-check');
      return result;
    } catch { return unknownResult(result, 'source-identity-unavailable'); }
  });
}

/** Required unknown checks cannot be promoted by a semantic reading. */
export function unverifiedGates(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  return (results ?? []).filter(result => result.required === true && gateOutcome(result) === 'unverified');
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

function killGateProcess(proc: ReturnType<typeof Bun.spawn>, reason: string): void {
  try {
    // The shell owns a fresh process group. Killing only the shell leaves its
    // children running with our stdout/stderr pipes open, so the timeout would
    // still wait for them and their side effects could continue afterward.
    process.kill(-proc.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    process.stderr.write(`[contract-gates] failed to kill gate process after ${reason}: ${summarizeError(error)}\n`);
  }
}

/**
 * Runs one gate command through `/bin/sh -c`. `cwd` is the unit's worktree in
 * worktree mode, so the gate sees the unit's isolated changes; omitted, the
 * command runs in the process cwd. A positive explicit `timeoutMs` is an optional
 * deadline; zero waits for completion or cancellation. An expired command is
 * killed and fails, with the timeout stated at the end of its output.
 */
export async function executeGateCommand(
  command: string,
  cwd?: string,
  timeoutMs: number = CONTRACT_CONFIG_DEFAULTS.gateTimeoutMs,
  signal?: AbortSignal,
  environment?: Readonly<Record<string, string>>,
): Promise<GateCommandResult> {
  try {
    signal?.throwIfAborted();
    const proc = Bun.spawn(['/bin/sh', '-c', command], { detached: true, stdout: 'pipe', stderr: 'pipe',
      ...(environment ? { env: { ...process.env, ...environment } } : {}), ...(cwd ? { cwd } : {}) });
    const cancel = () => killGateProcess(proc, 'cancellation');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killGateProcess(proc, 'timeout');
    }, timeoutMs) : undefined;
    timer?.unref?.();
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      // Drain both streams while the command runs, and keep the deadline until
      // they close too: a shell can exit before a child releases its pipes.
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } catch (error) {
      killGateProcess(proc, 'exit-error');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
    signal?.throwIfAborted();
    const output = [stdout, stderr, timedOut ? `Gate timed out after ${timeoutMs} ms and was stopped.` : '']
      .filter(Boolean)
      .join('\n')
      .trim();
    return { passed: exitCode === 0 && !timedOut, output, stdout, exitCode, kind: timedOut ? 'timeout' : 'completed' };
  } catch (error) {
    signal?.throwIfAborted();
    return { passed: false, output: summarizeError(error), stdout: '', exitCode: null, kind: 'tool-error' };
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
  readonly onResult?: ((results: readonly QualityGateResult[], result: QualityGateResult) => void) | undefined;
}

/**
 * Runs every enabled `contract.gates` entry in order against `cwd`, each under
 * `contract.gateTimeoutMs`. A gate that does not apply is recorded as a
 * unverified result when unavailable. Every result is emitted as CONTRACT_GATE_RESULT.
 */
export async function runContractGates(options: RunContractGatesOptions): Promise<QualityGateResult[]> {
  const gates = getEnabledContractGates(options.configManager).map(gate => Object.freeze({ ...gate }));
  if (gates.length === 0) return [];
  let definitionSnapshot = gateDefinitions(gates), definition = nextDefinitionId();
  const expectedDefinition = definition;
  const timeoutMs = getContractGateTimeoutMs(options.configManager);
  const results: QualityGateResult[] = [];
  let sourceObservation: GateSourceInputIdentity | undefined;
  const capture = (): GateInputIdentity => {
    const current = gateDefinitions(getEnabledContractGates(options.configManager));
    if (!isDeepStrictEqual(current, definitionSnapshot)) {
      definitionSnapshot = current;
      definition = nextDefinitionId();
    }
    // Compare configured command bytes privately. The receipt carries only an
    // owned label, so credentials embedded in commands cannot enter provenance.
    sourceObservation = captureGateInput(options.cwd, sourceObservation);
    return { ...sourceObservation, definition };
  };
  const emitResult = (result: QualityGateResult): void => {
    emitContractEvent(options.runtimeBus, options.sessionId, {
      type: 'CONTRACT_GATE_RESULT', contractId: options.contractId, targetId: options.targetId,
      ...gateEventSummary(result), durationMs: result.durationMs,
    });
  };

  for (const gate of gates) {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    let before: GateInputIdentity | undefined;
    try { before = capture(); } catch { /* An incomplete source inventory never proves current check evidence. */ }
    const skipReason = before ? getSkippedGateReason(gate.name, options.cwd, { ...before.packageScripts }, gate.command) : null;
    let result: QualityGateResult = { gate: gate.name, passed: false, outcome: 'unverified', required: requiredGate(gate),
      output: skipReason ?? '', durationMs: 0, skipped: skipReason !== null,
      ...(before ? {} : { reason: 'source-identity-unavailable' }),
    };
    if (before && before.definition !== expectedDefinition) result.reason = 'check-definition-changed-before-check';
    else if (skipReason !== null) result.reason = 'not-applicable';
    else {
      if (before) {
        const directory = mkdtempSync(join(tmpdir(), 'goodvibes-gate-'));
        const report = join(directory, 'result.xml');
        try {
          const assertions = gate.verification === 'assertions' || gate.name === 'test';
          const instrumented = assertions ? bunTestCommand(gate.command, before.packageScripts, report) : undefined;
          const runId = randomUUID();
          const run = await executeGateCommand(instrumented ?? gate.command, options.cwd, timeoutMs, options.signal,
            { GOODVIBES_GATE_NAME: gate.name, GOODVIBES_GATE_RUN_ID: runId });
          result.output = run.output;
          result.durationMs = Date.now() - startedAt;
          let completion: GateCompletion | undefined;
          if (run.kind === 'completed') {
            if (assertions) {
              try { completion = instrumented ? junitCompletion(readFileSync(report, 'utf8')) : protocolCompletion(run.stdout, gate.name, runId); }
              catch { /* Missing reporter output is unverified execution. */ }
            } else if (run.exitCode !== null) completion = { kind: 'command-exit', exitCode: run.exitCode };
          }
          if (completion) result.completion = completion;
          if (run.kind !== 'completed') result.reason = run.kind;
          else if (!completion) result.reason = 'check-completion-unverified';
          else if (completion.kind === 'assertions') {
            if (completion.checks.failed > 0 && run.exitCode !== 0) { result.outcome = 'failed'; result.reason = 'assertion-failure'; }
            else if (completion.checks.failed === 0 && run.exitCode === 0) { result.outcome = 'passed'; result.passed = true; }
            else result.reason = 'inconsistent-check-result';
          } else { result.outcome = run.passed ? 'passed' : 'failed'; result.passed = run.passed; }
          try {
            const after = capture();
            result.provenance = { sourceBefore: before.source, sourceAfter: after.source, definitionBefore: before.definition, definitionAfter: after.definition };
            if (before.source !== after.source) result = unknownResult(result, 'source-changed-during-check');
            else if (before.definition !== after.definition) result = unknownResult(result, 'check-definition-changed-during-check');
            liveGateInputs.set(result, capture);
          } catch { result = unknownResult(result, 'source-identity-unavailable'); }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      }
    }
    results.push(result);
    gateInvalidations.set(result, emitResult);
    emitResult(result);
    options.onResult?.(results.slice(), result);
    logger.debug('contract gates: gate result', { contractId: options.contractId, targetId: options.targetId, gate: gate.name, passed: result.passed, skipped: result.skipped });
  }
  return refreshGateResults(results);
}

/** Gates that ran and failed; a skipped gate never fails. */
export function failedGates(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  return (results ?? []).filter((result) => gateOutcome(result) === 'failed');
}
