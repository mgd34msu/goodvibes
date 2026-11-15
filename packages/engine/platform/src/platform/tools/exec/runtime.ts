import { assertCurrentExecInvocation, captureCurrentExecWorkspaceConstraint } from '../registry.js';
import { isInvocationAdmitted, isYoloExecution } from '../../gate/execution-context.js';
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { assertProjectionCurrent, captureProjectionStructure, projectionFunction, projectionProperty } from '../input-projection.js';
import { SANDBOX_RUNTIME_BIN, withSandboxRuntimes } from './sandbox-runtimes.js';
import { startCapturedBackground } from './captured-exec-background.js';
import { capturedExecUnsupportedOptions, MAX_CAPTURE_CHARS, UNTIL_PATTERN_WINDOW_CHARS, runCapturedCommand, type CapturedExecAuthority } from './captured-exec.js';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import type { Tool } from '../../types/tools.js';
import { logger } from '../../utils/logger.js';
import { EXEC_TOOL_SCHEMA } from './schema.js';
import { DEFAULT_MAX_CHARS, OverflowHandler } from '../shared/overflow.js';
import { execCommandText, type ExecInput, type ExecCommandInput, type ExecCommandResult, type ExecVerbosity } from './schema.js';
import { ProcessManager } from '../shared/process-manager.js';
import { guardExecCommand, formatDenialResponse } from './ast-guard.js';
import { executeFileOperations } from './file-ops.js';
import { DEFAULT_VALIDATOR_TIMEOUT_MS, validatorCommand, type ValidatorRunner } from '../shared/validators.js';
import { formatResult } from './result-format.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { mapWithConcurrency, sleep } from '../../utils/concurrency.js';
import { createSafeRegex } from '../../utils/safe-regex.js';
import {
  resolveCredentialEnvScrub,
  scrubCredentialEnv,
  type CredentialEnvScrubConfig,
  type ResolvedCredentialEnvScrub,
} from './credential-env.js';
import {
  attachSandboxMeta,
  resolveRuntimeSandboxPlan,
  brokerSandboxEscalation,
  type ExecSandboxRuntime,
  type ExecSandboxPlan,
} from './sandbox.js';
import {
  shouldRerunUnderPty,
  shouldRunInteractive,
  runInteractiveCommand,
  terminalRequiredNote,
  type ExecInteractionRuntime,
} from './interactive.js';
import type { ExecContainmentRequirement } from './containment.js';
import {
  backgroundContainmentRefusal,
  containmentRefusal,
  sandboxWorkspaceRefusal,
  type ExecRunPolicy,
} from './policy.js';
import { judge } from '../../runtime/judge.js';
import { execFailureView, execRetry, MAX_JUDGED_STDERR_CHARS, type ExecFailureCategory } from '../batteries/exec-retry.js';

const DEFAULT_TIMEOUT_MS = 0;
const PROGRESS_AUTO_THRESHOLD_MS = 30_000;
const OVERFLOW_SUBDIR = ['.goodvibes', '.overflow'] as const;
const MAX_PARALLEL_EXEC_COMMANDS = 3;

const decodeCmd = execCommandText;

interface CaptureSink { text: string; dropped: boolean }

function appendCapped(sink: CaptureSink, chunk: string): void {
  const room = MAX_CAPTURE_CHARS - sink.text.length;
  if (room <= 0) { sink.dropped = true; return; }
  if (chunk.length > room) { sink.text += chunk.slice(0, room); sink.dropped = true; return; }
  sink.text += chunk;
}

/**
 * Resolve the effective working directory for an exec call.
 *
 * An explicit `working_dir` on the input always wins. Otherwise falls back to
 * `defaultWorkingDirectory`, the session/tool-context working directory,
 * threaded in by the caller (see createExecTool), so a model that omits
 * working_dir still runs in a sensible place instead of failing outright
 * after the user has already approved the call (the approval card's
 * "Directory" line is sourced from the same session working directory
 * independently of this arg, so it was already showing the truth the whole
 * time, see permissions/prompt.ts on the TUI side). Throws only when
 * neither is available, which should not happen in practice since every
 * tool-registration path supplies a defaultWorkingDirectory.
 */
function requireWorkingDirectory(input: ExecInput, defaultWorkingDirectory?: string): string {
  const explicit = input.working_dir?.trim();
  if (explicit) return explicit;
  if (defaultWorkingDirectory && defaultWorkingDirectory.trim().length > 0) {
    return defaultWorkingDirectory;
  }
  throw new Error('exec requires an explicit working_dir');
}

function normalizeExecInput(input: ExecInput): ExecInput {
  const hasTopLevelWorkingDir = Boolean(input.working_dir?.trim());
  const commandWorkingDir = input.commands[0]?.working_dir?.trim();
  const commandCwd = input.commands[0]?.cwd?.trim();
  const promotedWorkingDir = !hasTopLevelWorkingDir && input.commands.length === 1
    ? commandWorkingDir || commandCwd
    : undefined;
  const commands = input.commands.map((command) => {
    const itemWorkingDir = command.working_dir?.trim();
    const itemCwd = command.cwd?.trim();
    if (itemWorkingDir) {
      if (!hasTopLevelWorkingDir && input.commands.length === 1 && promotedWorkingDir === itemWorkingDir && !itemCwd) {
        return command;
      }
      return { ...command, cwd: itemCwd || itemWorkingDir };
    }
    if (!hasTopLevelWorkingDir && input.commands.length === 1 && promotedWorkingDir === itemCwd) {
      return { ...command, cwd: undefined };
    }
    return command;
  });
  const workingDir = hasTopLevelWorkingDir ? input.working_dir : promotedWorkingDir;
  return { ...input, working_dir: workingDir, commands };
}

async function truncate(
  overflowHandler: OverflowHandler,
  s: string,
  label: string,
  call: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): Promise<{ text: string; truncated: boolean }> {
  const result = await overflowHandler.handle(s, { maxChars, label, call });
  return { text: result.content, truncated: result.overflowRef !== undefined };
}

function resolveCwd(cwd: string | undefined, workingDirectory: string): string {
  const effective = cwd ?? workingDirectory;
  if (isAbsolute(effective)) return effective;
  return resolve(workingDirectory, effective);
}



/**
 * The wait before retry number `attempt + 1`. `fixed` is always `delayMs`;
 * `exponential` is a random delay in [0, min(delayMs * 2^attempt, maxDelayMs)].
 * `random` is the source of the jitter, injectable so the bounds can be tested.
 */
export function computeRetryDelay(
  attempt: number,
  delayMs: number,
  backoff: 'fixed' | 'exponential',
  maxDelayMs: number = 30_000,
  random: (min: number, max: number) => number = randomInt,
): number {
  if (backoff === 'fixed') return delayMs;
  // Full jitter: random in [0, min(base * 2^attempt, maxDelay)], avoids thundering herd
  const cap = Math.min(delayMs * Math.pow(2, attempt), maxDelayMs);
  return random(0, Math.max(1, Math.floor(cap) + 1));
}

function buildCleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function applyExpectations(
  result: ExecCommandResult,
  expect: ExecCommandInput['expect'] | undefined,
  exitCode: number | null,
): ExecCommandResult {
  if (!expect) return result;

  const failures: string[] = [];
  const { exit_code: expCode, stdout_contains, stderr_contains } = expect;

  if (expCode !== undefined && exitCode !== expCode) failures.push(`exit_code: expected ${expCode}, got ${exitCode}`);
  if (stdout_contains !== undefined && !result.stdout.includes(stdout_contains)) failures.push(`stdout_contains: '${stdout_contains}' not found`);
  if (stderr_contains !== undefined && !result.stderr.includes(stderr_contains)) failures.push(`stderr_contains: '${stderr_contains}' not found`);

  if (failures.length > 0) {
    return { ...result, success: false, expectation_error: failures.join('; ') };
  }

  return result;
}

function buildTimedOutResult(cmdStr: string, cwd: string | undefined, durationMs: number, progressFile?: string): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, timed_out: true, duration_ms: durationMs, cwd, ...(progressFile ? { progress_file: progressFile } : {}) };
}

/** Cooperative cancellation: mirrors buildTimedOutResult's shape for the AbortSignal path. */
function buildCancelledResult(cmdStr: string, cwd: string | undefined, durationMs: number): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, cancelled: true, duration_ms: durationMs, cwd };
}

/**
 * Grace window for draining a killed child's stdout/stderr after a
 * timeout/abort stop before returning regardless. Kept well under the
 * cancellation-latency budget the cooperative-cancellation tests assert
 * (< 5s).
 */
const POST_STOP_DRAIN_GRACE_MS = 500;

/**
 * Cooperative cancellation: after a timeout/abort kill the
 * child has already been SIGKILL'd, but a grandchild that inherited the
 * stdout/stderr pipe can hold it open, so reading those streams to EOF may
 * never settle. Awaiting the full IO promise unbounded here could therefore
 * block until the grandchild's own duration elapses (observed as a hang under
 * loaded CI). A cancelled/timed-out result never depends on fully-drained
 * content, so bound the wait to a short grace window and return regardless.
 * The still-pending IO promise is defused so it can never surface as an
 * unhandled rejection; the grace timer is unref'd so it cannot keep the event
 * loop (or a test runner) alive.
 */
async function drainAfterStop(io: Promise<unknown>, graceMs: number): Promise<void> {
  const settled = io.then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref?.();
  });
  await Promise.race([settled, grace]);
  if (timer) clearTimeout(timer);
}

/**
 * A foreground command leads its own process group, so a timeout or cancel
 * reaches what its shell started (a `cmd &`, a build's workers), not only the
 * shell. PTY runs are spawned elsewhere and keep their controlling terminal.
 */
const FOREGROUND_OWNS_GROUP = process.platform !== 'win32';

function spawnForeground(argv: string[], options: Parameters<typeof Bun.spawn>[1]): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(argv, { ...options, detached: FOREGROUND_OWNS_GROUP } as Parameters<typeof Bun.spawn>[1]);
}

function signalForeground(proc: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void {
  if (FOREGROUND_OWNS_GROUP && Number.isSafeInteger(proc.pid) && proc.pid > 1) {
    try { process.kill(-proc.pid, signal); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  proc.kill(signal);
}

async function stopForeground(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  signalForeground(proc, 'SIGTERM');
  await sleep(200);
  signalForeground(proc, 'SIGKILL');
}

/** Reads a child stream into `sink` as it arrives, so a stopped run keeps what it printed. */
async function readStreamInto(stream: ReadableStream<Uint8Array>, sink: CaptureSink, onProgress?: () => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      appendCapped(sink, decoder.decode(value, { stream: true }));
      onProgress?.();
    }
    appendCapped(sink, decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function getProgressDirectory(workingDirectory: string): string {
  return join(workingDirectory, ...OVERFLOW_SUBDIR);
}

function getProgressFilePath(workingDirectory: string, id: string): string {
  return join(getProgressDirectory(workingDirectory), `${id}-progress.txt`);
}

/**
 * Creates the progress file. A directory that cannot be written costs the
 * caller the progress file, never the command: `path` is then undefined.
 */
function initProgressFile(cmdStr: string, workingDirectory: string): { path: string | undefined; append: (line: string) => void; discard: () => void } {
  const progressDirectory = getProgressDirectory(workingDirectory);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const filePath = getProgressFilePath(workingDirectory, id);
  try {
    mkdirSync(progressDirectory, { recursive: true });
    writeFileSync(filePath, `# Progress: ${cmdStr}\n# Started: ${new Date().toISOString()}\n`);
  } catch (err) {
    logger.warn('initProgressFile: could not create the progress file; running without one', { error: summarizeError(err) });
    return { path: undefined, append: () => {}, discard: () => {} };
  }
  return {
    path: filePath,
    append: (chunk: string) => {
      try { appendFileSync(filePath, chunk); } catch (err) { logger.warn('initProgressFile: appendFileSync failed', { path: filePath, error: summarizeError(err) }); }
    },
    discard: () => {
      try { rmSync(filePath, { force: true }); } catch (err) { logger.warn('initProgressFile: could not remove the progress file', { path: filePath, error: summarizeError(err) }); }
    },
  };
}

import { summarizeError } from '../../utils/error-display.js';

async function spawnBackground(
  processManager: ProcessManager,
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  scrub: ResolvedCredentialEnvScrub,
  signal?: AbortSignal,
  beforeSpawn?: () => void,
): Promise<ExecCommandResult> {
  return processManager.spawn(cmd, cwd, env, { credentialEnvScrub: scrub, beforeSpawn, ...(signal === undefined ? {} : { signal }) });
}

function handleBgSpecialCommand(processManager: ProcessManager, cmd: string): Promise<ExecCommandResult | null> {
  return processManager.handleCommandAsync(cmd);
}

async function runCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
  scrub: ResolvedCredentialEnvScrub,
  policy: ExecRunPolicy,
  signal?: AbortSignal,
): Promise<ExecCommandResult> {
  // The command and policy are this call's own values; the signal and the invocation check say whether it is still wanted.
  const assertCurrent = () => { signal?.throwIfAborted(); policy.assertCurrent?.(); };
  const cwd = resolveCwd(cmdInput.cwd, workingDirectory);
  const resolved = await resolveRuntimeSandboxPlan(policy.sandbox, cmdStr, workingDirectory, cwd, { signal, assertCurrent });
  const plan = resolved && !policy.capturedInput ? withSandboxRuntimes(resolved, workingDirectory) : resolved;
  assertCurrent();
  if (!policy.capturedInput) {
    const uncontained = containmentRefusal(policy, cmdStr, plan);
    if (uncontained) return attachSandboxMeta(uncontained, plan);
    const outside = sandboxWorkspaceRefusal(policy, cmdStr, plan, workingDirectory);
    if (outside) return attachSandboxMeta(outside, plan);
  }
  const escalation = await brokerSandboxEscalation(policy.sandbox, plan, cmdStr, cwd, { signal, assertCurrent });
  if (escalation && 'deniedEscalations' in escalation) return attachSandboxMeta({
    cmd: cmdStr, exit_code: null, stdout: '', success: false, denied: true,
    stderr: `Sandbox escalation denied: ${escalation.deniedEscalations.join('; ')}`,
  }, plan);
  const admission = escalation?.admission;
  let spawned = false;
  const beforeSpawn = () => {
    assertCurrent();
    if (spawned) throw new Error('Exec spawn admission already consumed');
    admission?.claim();
    spawned = true;
  };
  const executionSignal = admission ? AbortSignal.any([admission.signal, ...(signal ? [signal] : [])]) : signal;
  try {
    const result = await runAdmittedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, plan, beforeSpawn, executionSignal, assertCurrent);
    // A piped run that failed only because it needed a terminal runs once more under the PTY, where its
    // prompt reaches the owner. Not after an escalation: that approval covered one run.
    if (policy.capturedInput || admission || !shouldRerunUnderPty(policy.interaction, cmdInput, result)) return result;
    const rerun = await runAdmittedCommand(processManager, overflowHandler, featureFlags, cmdStr, { ...cmdInput, interactive: true }, workingDirectory, globalTimeout, scrub, policy, plan, assertCurrent, executionSignal, assertCurrent);
    return { ...rerun, warnings: [...(rerun.warnings ?? []), 'The piped run failed because the command needed a terminal, so it was run again under one.'] };
  } finally { admission?.close(); }
}

async function runAdmittedCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
  scrub: ResolvedCredentialEnvScrub,
  policy: ExecRunPolicy,
  sandboxPlan: ExecSandboxPlan | null,
  beforeSpawn: () => void,
  signal?: AbortSignal,
  assertOwnerCurrent?: () => void,
): Promise<ExecCommandResult> {
  if (policy.capturedInput) {
    // Preserve the existing trusted exec policy's network decision. Captured
    // filesystem authority neither grants network access nor vetoes a grant.
    const plan = sandboxPlan;
    const scrubbed = await scrubCredentialEnv(buildCleanEnv(), scrub);
    signal?.throwIfAborted();
    const withheld = scrubbed.withheld.filter((name) => !(cmdInput.env && name in cmdInput.env));
    const network = !plan || plan.network === 'enabled' ? 'enabled' : 'disabled';
    const interactive = shouldRunInteractive(policy.interaction, cmdInput);
    const result = cmdInput.background || (cmdInput.until && !cmdInput.until.kill_after)
      ? await startCapturedBackground(processManager, policy.capturedInput, cmdStr, cmdInput, workingDirectory, cmdInput.timeout_ms ?? globalTimeout, signal, network, scrubbed.env, beforeSpawn, policy.assertWorkspaceCurrent)
      : await runCapturedCommand(policy.capturedInput, cmdStr, cmdInput, workingDirectory, cmdInput.timeout_ms ?? globalTimeout, signal, network, scrubbed.env, { beforeSpawn, beforePublish: policy.assertCurrent, ...(interactive && policy.interaction ? { interaction: policy.interaction } : {}) });
    if (!result.denied) {
      const out = await truncate(overflowHandler, result.stdout, 'stdout', cmdStr);
      const err = await truncate(overflowHandler, result.stderr, 'stderr', cmdStr);
      result.stdout = out.text; result.stderr = err.text;
      result.stdout_truncated = out.truncated; result.stderr_truncated = err.truncated;
    }
    return withheld.length > 0 ? { ...result, withheld_env: withheld } : result;
  }
  const interaction = policy.interaction;
  // The catastrophic reading is the permission gate's, made before this runtime
  // runs; the exec tool does not read it again.
  const cwd = resolveCwd(cmdInput.cwd, workingDirectory);
  const timeoutMs = cmdInput.timeout_ms ?? globalTimeout;
  const sandboxArgv = sandboxPlan?.sandboxed ? sandboxPlan.argvPrefix : [];
  // Scrub credential-bearing vars out of the inherited base env, then layer the
  // model-supplied per-command env on top (an explicit per-command opt-in that a
  // withheld var is legitimately wanted). withheld_env reports only names the
  // command did NOT re-provide, by name only, never values.
  const scrubbed = await scrubCredentialEnv(buildCleanEnv(), scrub);
  const mergedEnv = { ...scrubbed.env, ...cmdInput.env };
  if (sandboxPlan?.sandboxed && cmdInput.env?.PATH === undefined)
    mergedEnv.PATH = `${SANDBOX_RUNTIME_BIN}:${mergedEnv.PATH ?? '/usr/bin:/bin'}`;
  const withheldEnv = scrubbed.withheld.filter((name) => !(cmdInput.env && name in cmdInput.env));
  const attachWithheld = (result: ExecCommandResult): ExecCommandResult => {
    const tty = !result.pty && !result.success && !result.tty_note ? terminalRequiredNote(result.stderr) : undefined;
    const withMeta = attachSandboxMeta(tty ? { ...result, tty_note: tty } : result, sandboxPlan);
    return withheldEnv.length > 0 ? { ...withMeta, withheld_env: withheldEnv } : withMeta;
  };
  const startTime = Date.now();

  // PTY prompt-answer path: prompt-prone or explicitly-interactive commands
  // run under a PTY nested INSIDE the sandbox argv (the boundary, when active,
  // wraps the PTY allocation). Detected prompts ride the approval machinery
  // via the interaction seam; the runner + detection live in interactive.ts.
  if (shouldRunInteractive(interaction, cmdInput)) {
    return attachWithheld(await runInteractiveCommand({
      cmdStr, cwd, env: mergedEnv, timeoutMs, startTime, sandboxArgv,
      interaction: interaction!, signal, beforeSpawn,
    }));
  }

  // The reading, isolated matcher and child share this invocation's lifetime.
  if (cmdInput.until) {
    return attachWithheld(await runUntil(processManager, overflowHandler, cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime, sandboxArgv, beforeSpawn, signal, assertOwnerCurrent ?? policy.assertCurrent));
  }

  const useProgress = cmdInput.progress === true || (cmdInput.progress !== false && (timeoutMs === 0 || timeoutMs > PROGRESS_AUTO_THRESHOLD_MS));
  if (useProgress) {
    // An automatic progress file only serves a caller polling a long run; a
    // command that finishes on its own leaves nothing behind in the workspace.
    // One the caller asked for with `progress: true` is kept.
    return attachWithheld(await runCommandWithProgress(processManager, overflowHandler, cmdStr, cmdInput, workingDirectory, cwd, mergedEnv, timeoutMs, startTime, sandboxArgv, signal, beforeSpawn, policy.onProgress, cmdInput.progress !== true));
  }

  beforeSpawn?.();
  const proc = spawnForeground([...sandboxArgv, '/bin/sh', '-c', cmdStr], { ...(cwd !== undefined ? { cwd } : {}), env: mergedEnv, stdout: 'pipe', stderr: 'pipe' } as Parameters<typeof Bun.spawn>[1]);
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopResolve!: () => void;
  const stopSentinel = new Promise<void>((res) => { stopResolve = res; });

  if (timeoutMs > 0) killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      await stopForeground(proc);
    } catch (err: unknown) {
      // The process may have already exited before kill.
      logger.debug('[ExecRuntime] kill on timeout failed (process may have exited)', { error: String(err) });
    }
    stopResolve();
  }, timeoutMs);
  killTimer?.unref?.();

  const onAbort = (): void => {
    if (timedOut || cancelled) return;
    cancelled = true;
    void (async () => {
      try {
        await stopForeground(proc);
      } catch (err: unknown) {
        logger.debug('[ExecRuntime] kill on cancellation failed (process may have exited)', { error: String(err) });
      }
      stopResolve();
    })();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    type ProcResult = [string, string, number];
    const stdoutSink: CaptureSink = { text: '', dropped: false };
    const stderrSink: CaptureSink = { text: '', dropped: false };
    const procPromise = Promise.all([
      readStreamInto(proc.stdout as ReadableStream<Uint8Array>, stdoutSink, policy.onProgress).then(() => stdoutSink.text),
      readStreamInto(proc.stderr as ReadableStream<Uint8Array>, stderrSink, policy.onProgress).then(() => stderrSink.text),
      proc.exited,
    ]) as Promise<ProcResult>;

    let procResult: ProcResult | undefined;
    await Promise.race([
      procPromise.then((r) => { procResult = r; }),
      stopSentinel,
    ]);

    clearTimeout(killTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (timedOut || cancelled) {
      // Bounded drain: the child is already killed; never block past a short
      // grace window on streams an orphaned grandchild may keep open.
      await drainAfterStop(procPromise, POST_STOP_DRAIN_GRACE_MS);
      // What the command printed before it was stopped is kept; it is often
      // the only clue to why it ran long.
      const partialOut = await truncate(overflowHandler, stdoutSink.text, 'stdout', cmdStr);
      const partialErr = await truncate(overflowHandler, stderrSink.text, 'stderr', cmdStr);
      const stopped = timedOut
        ? buildTimedOutResult(cmdStr, cwd, Date.now() - startTime)
        : buildCancelledResult(cmdStr, cwd, Date.now() - startTime);
      return attachWithheld({ ...stopped, stdout: partialOut.text, stderr: partialErr.text,
        ...((partialOut.truncated || stdoutSink.dropped) && { stdout_truncated: true }), ...((partialErr.truncated || stderrSink.dropped) && { stderr_truncated: true }) });
    }

    const [stdoutRaw, stderrRaw, exitCode] = procResult!;
    const stdoutResult = await truncate(overflowHandler, stdoutRaw, 'stdout', cmdStr);
    const stderrResult = await truncate(overflowHandler, stderrRaw, 'stderr', cmdStr);
    const duration = Date.now() - startTime;
    const result: ExecCommandResult = {
      cmd: cmdStr,
      exit_code: exitCode,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      success: exitCode === 0,
      duration_ms: duration,
      cwd,
      env: cmdInput.env,
      ...((stdoutResult.truncated || stdoutSink.dropped) && { stdout_truncated: true }),
      ...((stderrResult.truncated || stderrSink.dropped) && { stderr_truncated: true }),
    };
    return attachWithheld(applyExpectations(result, cmdInput.expect, exitCode));
  } catch (err) {
    clearTimeout(killTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw err;
  }
}

async function runCommandWithProgress(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  cwd: string | undefined,
  mergedEnv: Record<string, string>,
  timeoutMs: number,
  startTime: number,
  sandboxArgv: string[],
  signal?: AbortSignal,
  beforeSpawn?: () => void,
  onProgress?: () => void,
  discardWhenDone = false,
): Promise<ExecCommandResult> {
  const progressFile = initProgressFile(cmdStr, workingDirectory);
  const withProgressFile = (path: string | undefined): { progress_file?: string } => (path ? { progress_file: path } : {});
  beforeSpawn?.();
  const proc = spawnForeground([...sandboxArgv, '/bin/sh', '-c', cmdStr], { ...(cwd !== undefined ? { cwd } : {}), env: mergedEnv, stdout: 'pipe', stderr: 'pipe' } as Parameters<typeof Bun.spawn>[1]);
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopResolve!: () => void;
  const stopSentinel = new Promise<void>((res) => { stopResolve = res; });

  if (timeoutMs > 0) killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      await stopForeground(proc);
    } catch (err: unknown) {
      logger.debug('[ExecRuntime] kill on streamed timeout failed (process may have exited)', { error: String(err) });
    }
    progressFile.append('# Timed out\n');
    stopResolve();
  }, timeoutMs);
  killTimer?.unref?.();

  const onAbort = (): void => {
    if (timedOut || cancelled) return;
    cancelled = true;
    void (async () => {
      try {
        await stopForeground(proc);
      } catch (err: unknown) {
        logger.debug('[ExecRuntime] kill on cancellation failed (process may have exited)', { error: String(err) });
      }
      progressFile.append('# Cancelled\n');
      stopResolve();
    })();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const stdoutSink: CaptureSink = { text: '', dropped: false };
  const stderrSink: CaptureSink = { text: '', dropped: false };
  const warnings: string[] = [];
  const readStdout = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        appendCapped(stdoutSink, chunk);
        progressFile.append(chunk);
        onProgress?.();
      }
    } catch (err: unknown) {
      const warning = `stdout stream read failed: ${summarizeError(err)}`;
      warnings.push(warning);
      logger.warn('[ExecRuntime] stdout stream read ended with error', { error: summarizeError(err) });
    } finally {
      reader.releaseLock();
    }
  };
  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        appendCapped(stderrSink, chunk);
        onProgress?.();
      }
    } catch (err: unknown) {
      const warning = `stderr stream read failed: ${summarizeError(err)}`;
      warnings.push(warning);
      logger.warn('[ExecRuntime] stderr stream read ended with error', { error: summarizeError(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const ioPromise = Promise.all([readStdout(), readStderr(), proc.exited]);
  await Promise.race([ioPromise, stopSentinel]);
  clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);

  if (timedOut || cancelled) {
    // Bounded drain: the child is already killed; never block past a short
    // grace window on streams an orphaned grandchild may keep open. stdoutBuf/
    // stderrBuf already hold whatever the background readers captured so far.
    await drainAfterStop(ioPromise, POST_STOP_DRAIN_GRACE_MS);
    // The same overflow cut a finished run gets: a stopped noisy command is the
    // case where the output is largest.
    const partialOut = await truncate(overflowHandler, stdoutSink.text, 'stdout', cmdStr);
    const partialErr = await truncate(overflowHandler, stderrSink.text, 'stderr', cmdStr);
    return {
      ...(timedOut
        ? buildTimedOutResult(cmdStr, cwd, Date.now() - startTime, progressFile.path)
        : { ...buildCancelledResult(cmdStr, cwd, Date.now() - startTime), ...withProgressFile(progressFile.path) }),
      stdout: partialOut.text,
      stderr: partialErr.text,
      ...((partialOut.truncated || stdoutSink.dropped) && { stdout_truncated: true }),
      ...((partialErr.truncated || stderrSink.dropped) && { stderr_truncated: true }),
    };
  }

  const ioResult = await ioPromise.catch((error) => {
    logger.warn('exec progress command IO collection failed', {
      command: cmdStr,
      error: summarizeError(error),
    });
    warnings.push(`progress command IO collection failed: ${summarizeError(error)}`);
    return [undefined, undefined, undefined] as [void, void, number | undefined];
  });
  const actualExitCode = (ioResult[2] as number | undefined) ?? await proc.exited;
  const stdoutResult = await truncate(overflowHandler, stdoutSink.text, 'stdout', cmdStr);
  const stderrResult = await truncate(overflowHandler, stderrSink.text, 'stderr', cmdStr);
  const duration = Date.now() - startTime;
  progressFile.append(`# Completed: exit=${actualExitCode} duration=${duration}ms\n`);
  if (discardWhenDone) progressFile.discard();

  const result: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: actualExitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    success: actualExitCode === 0 && warnings.length === 0,
    duration_ms: duration,
    cwd,
    env: cmdInput.env,
    ...(discardWhenDone ? {} : withProgressFile(progressFile.path)),
    ...(warnings.length > 0 && { warnings }),
    ...((stdoutResult.truncated || stdoutSink.dropped) && { stdout_truncated: true }),
    ...((stderrResult.truncated || stderrSink.dropped) && { stderr_truncated: true }),
  };
  return applyExpectations(result, cmdInput.expect, actualExitCode);
}

async function runUntil(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  cwd: string | undefined,
  env: Record<string, string>,
  timeoutMs: number,
  startTime: number,
  sandboxArgv: string[],
  beforeSpawn?: () => void,
  signal?: AbortSignal,
  assertOwnerCurrent?: () => void,
): Promise<ExecCommandResult> {
  const until = cmdInput.until!;
  const deadline = new AbortController();
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const current = () => { active.throwIfAborted(); assertOwnerCurrent?.(); };
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  // A stop reaches the command's whole group; the closing cleanup after a
  // natural exit leaves anything the command deliberately left running.
  const stop = (afterExit = false) => {
    try { if (proc && (!afterExit || proc.exitCode === null)) signalForeground(proc, 'SIGKILL'); } catch { /* Already exited. */ }
    for (const reader of readers) void reader.cancel().catch(() => {});
  };
  const commandTimer = timeoutMs > 0 ? setTimeout(() => deadline.abort(), Math.max(0, timeoutMs - (Date.now() - startTime))) : undefined;
  let untilTimer: ReturnType<typeof setTimeout> | undefined;
  const onStop = () => stop();
  active.addEventListener('abort', onStop, { once: true });
  let streams: Promise<void[]> | undefined;
  const stdoutSink: CaptureSink = { text: '', dropped: false };
  const stderrSink: CaptureSink = { text: '', dropped: false };
  let matched = false;
  try {
    current();
    await using pattern = await createSafeRegex(until.pattern, '', { operation: 'exec until pattern', signal: active, assertCurrent: current });
    current(); beforeSpawn?.();
    proc = spawnForeground([...sandboxArgv, '/bin/sh', '-c', cmdStr], { ...(cwd !== undefined ? { cwd } : {}), env, stdout: 'pipe', stderr: 'pipe' } as Parameters<typeof Bun.spawn>[1]);
    const untilTimeout = until.timeout_ms ?? timeoutMs;
    if (untilTimeout > 0) untilTimer = setTimeout(() => { if (!matched) deadline.abort(); }, untilTimeout);
    const readStream = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
      const decoder = new TextDecoder();
      const reader = stream.getReader(); readers.add(reader);
      try {
        while (true) {
          current();
          const { done, value } = await reader.read();
          current();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          appendCapped(isStderr ? stderrSink : stdoutSink, chunk);
          if (!matched && await pattern.test((stdoutSink.text.slice(-UNTIL_PATTERN_WINDOW_CHARS) + stderrSink.text.slice(-UNTIL_PATTERN_WINDOW_CHARS)).slice(-UNTIL_PATTERN_WINDOW_CHARS))) {
            current(); matched = true; clearTimeout(untilTimer);
            if (until.kill_after) stop();
          }
        }
      } catch (error) { stop(); throw error; }
      finally { readers.delete(reader); reader.releaseLock(); }
    };
    streams = Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array>, false),
      readStream(proc.stderr as ReadableStream<Uint8Array>, true),
    ]);
    const [, exitCode] = await Promise.all([streams, proc.exited]);
    current(); pattern.assertCurrent();
    const stdoutResult = await truncate(overflowHandler, stdoutSink.text, 'stdout', cmdStr);
    const stderrResult = await truncate(overflowHandler, stderrSink.text, 'stderr', cmdStr);
    current(); pattern.assertCurrent();
    return { cmd: cmdStr, exit_code: exitCode, stdout: stdoutResult.text, stderr: stderrResult.text,
      success: matched, duration_ms: Date.now() - startTime, cwd,
      ...((stdoutResult.truncated || stdoutSink.dropped) && { stdout_truncated: true }), ...((stderrResult.truncated || stderrSink.dropped) && { stderr_truncated: true }) };
  } catch (error) {
    // The wait ran out (until.timeout_ms or the command's timeout): that is a
    // result with what was printed, not a failure of the call. A cancel by the
    // caller's own signal keeps propagating.
    if (!deadline.signal.aborted || signal?.aborted) throw error;
    stop();
    const stdoutResult = await truncate(overflowHandler, stdoutSink.text, 'stdout', cmdStr);
    const stderrResult = await truncate(overflowHandler, stderrSink.text, 'stderr', cmdStr);
    return { ...buildTimedOutResult(cmdStr, cwd, Date.now() - startTime),
      stdout: stdoutResult.text, stderr: stderrResult.text,
      ...((stdoutResult.truncated || stdoutSink.dropped) && { stdout_truncated: true }), ...((stderrResult.truncated || stderrSink.dropped) && { stderr_truncated: true }) };
  } finally {
    clearTimeout(commandTimer); clearTimeout(untilTimer);
    active.removeEventListener('abort', onStop); stop(true);
    await streams?.catch(() => {});
    await proc?.exited.catch(() => {});
  }
}

function killExecProcess(proc: ReturnType<typeof Bun.spawn>, command: string, reason: string): void {
  try {
    proc.kill('SIGTERM');
  } catch (error) {
    logger.debug('exec process kill failed; process may already be exited', {
      command,
      reason,
      error: summarizeError(error),
    });
  }
}

const EXEC_RETRY_SITE = 'tools.exec.retry';

/** The retry-on categories a caller may list (schema.ts `retry.on`). */
export type ExecRetryCategory = Exclude<ExecFailureCategory, 'lasting'>;

/** Categories retried when the caller lists none (schema.ts documents this default). */
const DEFAULT_RETRY_ON: readonly ExecRetryCategory[] = ['network', 'lock', 'busy'];

/**
 * The failure kinds the program can name from structure: the exit code, or an
 * errno code or lock message the failing tool printed. Checked against the
 * end of the output, where failures are reported. A failure none of these
 * name is read by Jev.
 */
const KNOWN_FAILURES: ReadonlyArray<readonly [ExecFailureCategory, RegExp]> = [
  ['network', /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/],
  ['lock', /index\.lock'?:? File exists|Could not get lock|database is locked/],
  ['busy', /\bEBUSY\b|Resource temporarily unavailable/],
  ['oom', /\bENOMEM\b|Cannot allocate memory|heap out of memory/],
  ['lasting', /\b(?:ENOENT|EACCES|EPERM)\b|command not found|No such file or directory|Permission denied/],
];

/** Output read from the end; the reading and the table look only at this much of each stream. */
function outputTail(text: string): string {
  return text.length > MAX_JUDGED_STDERR_CHARS ? text.slice(-MAX_JUDGED_STDERR_CHARS) : text;
}

function knownFailure(result: ExecCommandResult): ExecFailureCategory | undefined {
  if (result.exit_code === 126 || result.exit_code === 127) return 'lasting';
  if (result.exit_code === 75) return 'busy';
  const output = `${outputTail(result.stderr)}\n${outputTail(result.stdout)}`;
  return KNOWN_FAILURES.find(([, pattern]) => pattern.test(output))?.[0];
}

/** Whether a failed run is retried, and why not when it is not. */
interface RetryDecision { readonly retry: boolean; readonly note?: string }

/**
 * Whether a failed exec result is retried. A timed-out or cancelled run never
 * is (structure: the caller or an operator stopped it). A failure the program
 * can name from its exit code or errno is decided in code; any other is read
 * by Jev (`engine.tools.exec-retry`) within the decision deadline. The run is
 * retried only when the category is one the caller listed in `retry.on`
 * (default network, lock, busy). A failure no one could classify is not
 * retried and the result says so; the command's own result is never replaced.
 */
async function decideRetry(
  result: ExecCommandResult,
  allowed: ReadonlyArray<ExecRetryCategory> | undefined,
  signal: AbortSignal | undefined,
): Promise<RetryDecision> {
  signal?.throwIfAborted();
  if (result.timed_out || result.cancelled) return { retry: false };
  const retryOn = allowed ?? DEFAULT_RETRY_ON;
  const known = knownFailure(result);
  if (known !== undefined) return { retry: known !== 'lasting' && retryOn.includes(known) };
  const outcome = await judge({
    site: EXEC_RETRY_SITE,
    battery: execRetry,
    state: execFailureView(result.cmd, result.exit_code, outputTail(result.stdout), outputTail(result.stderr)),
    settle: ({ category }) => category.outcome === 'act' ? category.choice : undefined,
    fallback: () => undefined,
    describe: (category) => category !== undefined && category !== 'lasting' && retryOn.includes(category) ? `retried on ${category}` : `stopped (${category})`,
    ...(signal === undefined ? {} : { signal }),
  });
  const category = outcome.value;
  if (category === undefined) {
    const reason = outcome.why === 'off' ? 'decision models are off'
      : outcome.why === 'unsure' ? 'the reading was not sure' : outcome.detail ?? 'no reading arrived';
    return { retry: false, note: `retry: the failure could not be classified (${reason}); not retried. Rerun the command if the failure is temporary.` };
  }
  return { retry: category !== 'lasting' && retryOn.includes(category) };
}

/**
 * Whether a failed exec result would be retried (see decideRetry).
 *
 * @param result - The failed command result.
 * @param allowed - The caller's retry-on categories.
 */
export async function isRetryableExecResult(
  result: ExecCommandResult,
  allowed?: ReadonlyArray<ExecRetryCategory>,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await decideRetry(result, allowed, signal)).retry;
}

async function runWithRetry(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
  scrub: ResolvedCredentialEnvScrub,
  policy: ExecRunPolicy,
  signal?: AbortSignal,
): Promise<ExecCommandResult> {
  if (!cmdInput.retry) {
    return runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal);
  }

  const maxRetries = Math.min(cmdInput.retry.max ?? 3, 10);
  const delayMs = cmdInput.retry.delay_ms ?? 1000;
  const maxDelayMs = cmdInput.retry.max_delay_ms ?? 30_000;
  const backoff = cmdInput.retry.backoff ?? 'exponential';
  const retryOn = cmdInput.retry.on;
  let lastResult: ExecCommandResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    lastResult = await runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal);
    if (lastResult.success) {
      return { ...lastResult, retries: attempt };
    }
    if (attempt < maxRetries) {
      const decision = await decideRetry(lastResult, retryOn, signal);
      if (!decision.retry) {
        logger.debug('exec: not retrying', { cmd: cmdStr, attempt, stderr: lastResult.stderr.slice(0, 200) });
        return { ...lastResult, retries: attempt,
          ...(decision.note === undefined ? {} : { warnings: [...(lastResult.warnings ?? []), decision.note] }) };
      }
      const delay = computeRetryDelay(attempt, delayMs, backoff, maxDelayMs);
      logger.debug('exec: retrying after jittered delay', { cmd: cmdStr, attempt, delay: Math.round(delay) });
      await sleep(delay, signal === undefined ? {} : { signal });
      signal?.throwIfAborted();
    }
  }

  return { ...lastResult!, retries: maxRetries };
}

async function executeResolvedCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
  scrub: ResolvedCredentialEnvScrub,
  policy: ExecRunPolicy,
  signal?: AbortSignal,
): Promise<ExecCommandResult> {
  // ── Everything below is judged HERE, and not inside runCommand ───────────
  //
  // This is the one point EVERY path goes through: foreground, retried,
  // interactive, and, the one that mattered, detached. The background branch
  // below returns before `runWithRetry`, so anything checked inside runCommand
  // is simply not checked for a `background: true` command.
  //
  // Measured on a real host under the daemon's own service environment: one
  // witness command reported 5 processes and a masked $HOME in the foreground
  // (the boundary) and 581 with $HOME readable in the background (the host).
  // The boundary never failed, this path never entered it.
  //
  // The shell-structure guard had the same hole: on the detached path it did
  // not run at all. It only refuses a command that parses to no runnable
  // segment (ast-guard.ts); the catastrophic reading and every other risk were
  // decided by the permission gate before this runtime runs, and are not read
  // again here.
  signal?.throwIfAborted();
  const guardResult = await guardExecCommand(cmdStr, featureFlags, signal);
  if (!guardResult.allowed) {
    const denial = formatDenialResponse(guardResult, cmdStr);
    return {
      cmd: cmdStr,
      exit_code: null,
      stdout: '',
      stderr: denial.denial_reason as string ?? 'Command denied by policy',
      success: false,
      denied: true,
      denial_detail: denial,
    };
  }

  policy.assertCurrent?.();
  // A captured command never reaches the host ProcessManager's special commands.
  if (policy.capturedInput) {
    const backgroundResult = await processManager.handleOwnedBoundaryCommand(cmdStr, policy.capturedInput.authority);
    if (backgroundResult) return backgroundResult;
    return cmdInput.background
      ? runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal)
      : runWithRetry(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal);
  }
  const bgSpecial = await handleBgSpecialCommand(processManager, cmdStr);
  if (bgSpecial) return bgSpecial;
  if (cmdInput.background) {
    // Background processes intentionally outlive this tool call, cancelling
    // the caller's item/agent must not kill a process the user asked to
    // detach. The signal controls admission only, including the pending
    // credential scrub; ProcessManager stops observing it once spawned.
    // They are also NOT
    // sandboxed, a bwrap boundary is --die-with-parent, so wrapping one would
    // kill the very process the caller asked to detach. That exemption is real
    // and stays; what does NOT stay is it being silent. A composition that
    // requires containment has no contained background path at all, so it is
    // refused here rather than handed the exemption (see policy.ts).
    const uncontainable = backgroundContainmentRefusal(policy, cmdStr);
    if (uncontainable) return uncontainable;
    return spawnBackground(processManager, cmdStr, resolveCwd(cmdInput.cwd, workingDirectory), cmdInput.env, scrub, signal, policy.assertCurrent);
  }
  return runWithRetry(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal);
}

async function executeResolvedCommands(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }>,
  parallel: boolean,
  workingDirectory: string,
  globalTimeout: number,
  failFast: boolean,
  scrub: ResolvedCredentialEnvScrub,
  policy: ExecRunPolicy,
  signal?: AbortSignal,
): Promise<ExecCommandResult[]> {
  const skipped = (cmdStr: string, reason: string): ExecCommandResult => ({ cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, skipped: true, skipped_reason: reason });
  // A cancel settles the command it interrupts as cancelled and leaves every
  // finished command's result in place; nothing already done is dropped.
  const runOne = async (cmdStr: string, cmdInput: ExecCommandInput): Promise<ExecCommandResult> => {
    if (signal?.aborted) return skipped(cmdStr, 'cancelled');
    const startedAt = Date.now();
    try {
      return await executeResolvedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout, scrub, policy, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      return buildCancelledResult(cmdStr, undefined, Date.now() - startedAt);
    }
  };
  if (parallel) {
    return mapWithConcurrency(
      resolvedCmds,
      MAX_PARALLEL_EXEC_COMMANDS,
      ({ cmdStr, cmdInput }) => runOne(cmdStr, cmdInput),
    );
  }

  const results: ExecCommandResult[] = [];
  let stoppedBy: string | undefined;
  for (const { cmdStr, cmdInput } of resolvedCmds) {
    if (signal?.aborted) {
      results.push(skipped(cmdStr, 'cancelled'));
      continue;
    }
    if (stoppedBy !== undefined) {
      results.push(skipped(cmdStr, `earlier command failed: ${stoppedBy}`));
      continue;
    }

    const result = await runOne(cmdStr, cmdInput);
    results.push(result);
    if (failFast && !result.success) {
      stoppedBy = cmdStr;
    }
  }

  return results;
}

const capturedExecTools = new WeakMap<Tool, CapturedExecAuthority['authority']>();

/** Tool names/model arguments cannot manufacture a captured backend binding. */
export function isCapturedExecTool(tool: Tool, authority: CapturedExecAuthority['authority']): boolean {
  return capturedExecTools.get(tool) === authority;
}

/** What a composition states about its exec tool. */
export interface ExecToolOptions {
  readonly capturedInput?: CapturedExecAuthority | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly overflowHandler?: OverflowHandler | undefined;
  /**
   * Default working directory used when a call omits the top-level
   * working_dir (and no single command supplies one to promote). Callers
   * register this tool with the session/project working directory they
   * already have in hand (see tools/index.ts registerAllTools) so the
   * parameter stays genuinely optional for the model instead of a
   * mandatory-in-practice field that fails a call after the user has
   * already approved it.
   */
  readonly defaultWorkingDirectory?: string | undefined;
  /**
   * Credential-bearing env-var scrub applied to every spawned command's
   * environment. Enabled by default (see resolveCredentialEnvScrub). Consumers
   * wire their `permissions.exec.*` config through here; the withheld names are
   * reported on each ExecCommandResult (`withheld_env`) by name only.
   */
  readonly credentialEnvScrub?: CredentialEnvScrubConfig | undefined;
  /**
   * Per-command exec sandbox wiring. When present AND active (gate on,
   * config enabled, host provides a boundary), each foreground command runs
   * inside a bwrap boundary and its result carries sandbox metadata. Omitted or
   * inactive → every command runs the unchanged non-sandboxed path.
   */
  readonly sandbox?: ExecSandboxRuntime | null | undefined;
  /**
   * PTY prompt-answer wiring. When present AND the host has a PTY backend,
   * prompt-prone / explicitly-interactive commands run under a PTY and
   * detected prompts ride the approval machinery through its seam. Omitted
   * or unavailable → every command runs the unchanged pipe-based path.
   */
  readonly interaction?: ExecInteractionRuntime | null | undefined;
  /**
   * Whether this composition REQUIRES the exec boundary (containment.ts).
   * Omitted ⇒ `host-allowed`: no boundary means the command runs on the host
   * with the self-labelling note, exactly as before. A hosted conversational
   * turn passes `required`, so an absent boundary refuses instead.
   */
  readonly containment?: ExecContainmentRequirement | null | undefined;
}

function prepareExecRun(options: ExecToolOptions): {
  readonly overflowHandler: OverflowHandler;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  readonly credentialEnvScrub: ResolvedCredentialEnvScrub;
  readonly policy: ExecRunPolicy;
} {
  if (!options.overflowHandler) {
    throw new Error('createExecTool requires an explicit overflowHandler');
  }
  return {
    overflowHandler: options.overflowHandler,
    featureFlags: options.featureFlags ?? null,
    credentialEnvScrub: resolveCredentialEnvScrub(options.credentialEnvScrub),
    policy: {
      capturedInput: options.capturedInput ? Object.freeze({ ...options.capturedInput, dependencyInputs: options.capturedInput.dependencyInputs ? Object.freeze([...options.capturedInput.dependencyInputs]) : undefined }) : undefined,
      sandbox: options.sandbox ?? null,
      interaction: options.interaction ?? null,
      containment: options.containment ?? null,
      workspaceRoot: options.defaultWorkingDirectory?.trim() || undefined,
    },
  };
}

const shellWord = (part: string): string => `'${part.replace(/'/g, `'\\''`)}'`;

/**
 * The validator runner of a composition whose exec tool runs on this process:
 * each validator's fixed command (shared/validators.ts) goes through the same
 * path as an exec command, so the sandbox plan, the containment decision, the
 * credential scrub and the working-directory check apply unchanged. A session
 * that requires the boundary and has none gets the containment refusal as the
 * validator's failure; nothing runs on the host.
 */
export function createExecValidatorRunner(processManager: ProcessManager, options: ExecToolOptions): ValidatorRunner {
  const { overflowHandler, featureFlags, credentialEnvScrub, policy } = prepareExecRun(options);
  return async (name, cwd, execution) => {
    execution?.assertCurrent();
    const command = validatorCommand(name).map(shellWord).join(' ');
    const timeoutMs = execution?.timeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
    const result = await executeResolvedCommand(processManager, overflowHandler, featureFlags, command,
      { cmd: command, timeout_ms: timeoutMs, progress: false, interactive: false }, cwd, timeoutMs, credentialEnvScrub,
      { ...policy, ...(execution ? { assertCurrent: execution.assertCurrent } : {}) }, execution?.signal);
    const stopped = result.timed_out ? `Validator '${name}' timed out after ${timeoutMs}ms and was killed`
      : result.cancelled ? `Validator '${name}' was cancelled and killed` : undefined;
    return {
      validator: name,
      passed: result.success,
      exitCode: result.exit_code ?? -1,
      stdout: result.stdout,
      stderr: stopped ? `${stopped}\n${result.stderr}`.trimEnd() : result.stderr,
    };
  };
}

export function createExecTool(
  processManager: ProcessManager,
  options: ExecToolOptions = {},
): Tool {
  const { overflowHandler, featureFlags, credentialEnvScrub, policy } = prepareExecRun(options);

  const tool: Tool = {
    definition: {
      name: 'exec',
      description:
        'Execute shell commands. Supports batch, parallel, background, retry, timeout,'
        + ' expectation-checking, until-pattern, and pre-command file operations.',
      parameters: EXEC_TOOL_SCHEMA,
      sideEffects: ['exec', 'read_fs', 'write_fs'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(args: Record<string, unknown>, opts?: { readonly signal?: AbortSignal | undefined }) {
      let signal: AbortSignal | undefined;
      try {
        const rawYolo = isYoloExecution() && !isInvocationAdmitted('exec', args);
        const rawCallerCurrent = rawYolo && opts !== undefined
          ? projectionFunction<() => void>(projectionProperty(opts, 'assertCurrent')) : undefined;
        if (rawYolo) args = captureProjectionStructure(args);
        const lifecycleSignal = policy.capturedInput?.signal;
        const parentSignal = rawYolo ? currentExternalOperationSource()?.signal : undefined;
        const callerSignal = opts?.signal;
        const signals = [lifecycleSignal, parentSignal, callerSignal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
        signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        signal?.throwIfAborted();
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (rawYolo) {
            if (!isYoloExecution()) throw new Error('Execution mode changed during raw command invocation');
            assertProjectionCurrent(rawCallerCurrent);
          } else assertCurrentExecInvocation(args, opts);
        };
        assertCurrent();
        const onProgress = opts === undefined ? undefined : projectionFunction<() => void>(projectionProperty(opts, 'onProgress'));
        const executionPolicy = { ...policy, assertCurrent, ...(onProgress ? { onProgress } : {}),
          assertWorkspaceCurrent: rawYolo ? undefined : captureCurrentExecWorkspaceConstraint(args, opts) };
        if (!Array.isArray(args['commands']) || (args['commands'] as unknown[]).length === 0) {
          return { success: false, error: 'commands must be a non-empty array' };
        }
        if (policy.capturedInput) {
          const unsupported = capturedExecUnsupportedOptions(args);
          if (unsupported.length > 0) return {
            success: false,
            error: 'Captured exec does not support stdin/input options; use a shell pipe or an authorized input file.',
            output: JSON.stringify({ denied: true, captured_exec_unsupported_options: unsupported }),
          };
        }
        const input = normalizeExecInput(args as unknown as ExecInput);
        const workingDirectory = requireWorkingDirectory(input, options.defaultWorkingDirectory);
        const verbosity: ExecVerbosity = (input.verbosity as ExecVerbosity) ?? 'standard';
        const globalTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const failFast = input.fail_fast === true || input.stop_on_error === true;
        const projectRoot = resolve(workingDirectory);

        // Decoded first: an entry that cannot be read must stop the call before any file operation changes the tree.
        const resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }> = [];
        for (const cmdInput of input.commands) {
          let cmdStr: string;
          try {
            cmdStr = decodeCmd(cmdInput);
          } catch (err) {
            const msg = summarizeError(err);
            return { success: false, error: msg };
          }
          resolvedCmds.push({ cmdStr, cmdInput });
        }

        let fileOperations: Awaited<ReturnType<typeof executeFileOperations>>;
        if (policy.capturedInput && input.file_ops?.length) {
          let capturedOperations: Awaited<ReturnType<typeof executeFileOperations>> | undefined;
          const applied = await runCapturedCommand(policy.capturedInput, ':', {}, workingDirectory, globalTimeout, signal,
            'disabled', {}, { beforeSpawn: assertCurrent, beforePublish: assertCurrent, fileOps: input.file_ops.map((operation) => ({ ...operation,
              source: resolve(projectRoot, operation.source),
              ...(operation.destination ? { destination: resolve(projectRoot, operation.destination) } : {}),
            })), onFileOperations: (result) => { capturedOperations = result; } });
          if (applied.denied || applied.cancelled || applied.timed_out || !capturedOperations)
            return { success: false, error: applied.stderr || 'Captured file operations did not complete.' };
          fileOperations = capturedOperations;
        } else {
          // These operations run on the host with plain file calls, outside the
          // boundary, so a session that requires the boundary cannot have them.
          if (input.file_ops?.length && policy.containment?.posture === 'required') {
            return { success: false, error: 'file_ops refused: they run on the host, outside the exec boundary, and this session requires containment '
              + `(${policy.containment.reason}). Nothing was changed. Run the equivalent commands (cp, mv, rm) in the boundary instead.` };
          }
          fileOperations = await executeFileOperations(input.file_ops, projectRoot, undefined, assertCurrent);
        }
        const { fileOpResults, fileOpError, fileOpFailedIndex, fileOpWarnings } = fileOperations;
        signal?.throwIfAborted();
        if (fileOpError) {
          const total = input.file_ops?.length ?? 0;
          const applied = fileOpResults.length;
          return {
            success: false,
            error: `${fileOpError} (${applied} of ${total} file_ops applied before it; no commands were run${applied > 0 ? '; the applied operations are listed in output and were not undone' : ''})`,
            // The operations that already happened, so a retry does not repeat them.
            output: JSON.stringify({ file_ops: fileOpResults, failed_op_index: fileOpFailedIndex, commands_run: false }),
            ...(fileOpWarnings && fileOpWarnings.length > 0 ? { warnings: fileOpWarnings } : {}),
          };
        }

        const results = await executeResolvedCommands(
          processManager,
          input.output_keep === 'ranked' ? overflowHandler.ranked() : overflowHandler,
          featureFlags,
          resolvedCmds,
          input.parallel === true,
          workingDirectory,
          globalTimeout,
          failFast,
          credentialEnvScrub,
          executionPolicy,
          signal,
        );
        const formatted = results.map((r) => formatResult(r, verbosity));
        const allSuccess = results.every((r) => r.success);
        const responseData: Record<string, unknown> = formatted.length === 1 ? { ...formatted[0] } : { commands: formatted, total: formatted.length };
        if (fileOpResults.length > 0) responseData.file_ops = fileOpResults;
        if (fileOpWarnings && fileOpWarnings.length > 0) responseData.warnings = fileOpWarnings;

        // Populate a top-level error summary on failure so any consumer keying off
        // `.error` alone (not just `.output`) still gets a coherent signal, the
        // per-command diagnostics remain in `output` in full.
        const failed = results.filter((r) => !r.success);
        const errorSummary = failed.length > 0
          ? `${failed.length} of ${results.length} command(s) failed: `
            + failed.map((r) => `'${r.cmd}'${r.skipped ? ' (skipped)' : ` exit ${r.exit_code}${r.timed_out ? ' (timed out)' : r.cancelled ? ' (cancelled)' : ''}`}`).join('; ')
          : undefined;

        if (signal?.aborted) {
          // Same cancellation markers as before, now with the batch's results.
          responseData.cancelled = true;
          return { success: false, cancelled: true, output: JSON.stringify(responseData), error: 'cancelled by user',
            ...(fileOpWarnings && fileOpWarnings.length > 0 ? { warnings: fileOpWarnings } : {}) };
        }
        return {
          success: allSuccess,
          output: JSON.stringify(responseData),
          ...(errorSummary ? { error: errorSummary } : {}),
          ...(fileOpWarnings && fileOpWarnings.length > 0 ? { warnings: fileOpWarnings } : {}),
        };
      } catch (err) {
        if (signal?.aborted) {
          // Older exec consumers read cancellation from the serialized output.
          // Admission may stop before arguments are read or a command starts,
          // so retain that marker without inventing command or retry facts.
          return { success: false, cancelled: true, output: JSON.stringify({ cancelled: true }), error: 'cancelled by user' };
        }
        const message = summarizeError(err);
        return { success: false, error: message };
      }
    },
  };
  if (policy.capturedInput) capturedExecTools.set(tool, policy.capturedInput.authority);
  return tool;
}
