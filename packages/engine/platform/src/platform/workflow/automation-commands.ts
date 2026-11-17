import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { shellSplit } from '../utils/shell-split.js';
import {
  resolveCredentialEnvScrub,
  scrubCredentialEnv,
  type CredentialEnvScrubConfig,
  type ResolvedCredentialEnvScrub,
} from '../tools/exec/credential-env.js';
import { resolveRuntimeSandboxPlan, type ExecSandboxPlan, type ExecSandboxRuntime } from '../tools/exec/sandbox.js';
import { SANDBOX_RUNTIME_BIN, withSandboxRuntimes } from '../tools/exec/sandbox-runtimes.js';

// ---------------------------------------------------------------------------
// AutomationCommands
// ---------------------------------------------------------------------------
// Starts the background commands of one runtime's workflow automation (hook
// actions and scheduled commands) and owns everything about them: admission
// (split, command guard and the exec sandbox's boundary, once, when the
// automation is added), the project root they run in, the credential-env
// scrub they start with, the per-action
// or per-schedule limit on runs in flight, the kill timer, how each run ended,
// and the set of running processes that shutdown kills. One instance per
// WorkflowServices, so disposing one runtime stops only that runtime's commands.
// ---------------------------------------------------------------------------

export type AutomationCommandKind = 'hook-action' | 'schedule';

export interface AutomationCommandRequest {
  readonly kind: AutomationCommandKind;
  /** The hook action id or schedule name; the in-flight limit counts runs of this kind and key. */
  readonly key: string;
  readonly argv: readonly string[];
  /** The argv starts with the exec sandbox's boundary (admitted that way); the sandbox's runtimes go first on PATH. */
  readonly sandboxed?: boolean | undefined;
  /** Variables added to the scrubbed environment, such as GV_HOOK_ACTION_ID. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly maxInFlight: number;
  /** The run is killed after this long; omitted, it is not timed. */
  readonly timeoutMs?: number | undefined;
  /** Called once with how the run ended: the exit code, or null when a signal (a kill or the timeout) ended it. */
  readonly onExit?: ((exit: AutomationCommandExit) => void) | undefined;
  /** Starts the process. Defaults to Bun.spawn. */
  readonly spawn?: typeof Bun.spawn | undefined;
  /** Arms the kill timer and returns its canceller. Defaults to an unref'd setTimeout. */
  readonly startTimer?: ((callback: () => void, ms: number) => () => void) | undefined;
}

export type AutomationCommandStart =
  | { readonly started: true; readonly pid: number }
  | { readonly started: false; readonly reason: 'busy'; readonly running: number; readonly limit: number }
  | { readonly started: false; readonly reason: 'stopped' | 'failed'; readonly message: string };

/** How one run ended. */
export interface AutomationCommandExit {
  /** The process that ended, so an outcome is kept only on the fire that started it. */
  readonly pid: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly at: number;
}

/**
 * The outcome of admitting a command line: the argv every run uses (behind the
 * exec sandbox's boundary when the sandbox contains it), or why it can never run.
 */
export type AutomationCommandAdmission =
  | { readonly admitted: true; readonly argv: readonly string[]; readonly sandboxed: boolean; readonly boundary?: string | undefined }
  | { readonly admitted: false; readonly reason: string };

/** Returns a refusal reason when the command must not run (the exec path's command guard). */
export type AutomationCommandGuard = (command: string) => Promise<string | undefined>;

interface Run {
  readonly kind: AutomationCommandKind;
  readonly key: string;
  proc: { kill(): void } | null;
  stopped: boolean;
}

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const DEFAULT_SCRUB: ResolvedCredentialEnvScrub = resolveCredentialEnvScrub();

export class AutomationCommands {
  readonly #runs = new Set<Run>();
  #scrub: () => ResolvedCredentialEnvScrub = () => DEFAULT_SCRUB;
  #guard: AutomationCommandGuard | undefined;
  #cwd: string | undefined;
  #sandbox: ExecSandboxRuntime | null = null;

  /** The command guard every added automation is admitted against (the hook dispatcher hands over the exec path's). */
  setCommandGuard(guard: AutomationCommandGuard | undefined): void {
    this.#guard = guard;
  }

  /** The project root automation commands run in; unset, they run in the process's working directory. */
  setWorkingDirectory(directory: string | undefined): void {
    this.#cwd = directory;
  }

  /**
   * The exec tool's sandbox runtime. With one, an added command's boundary is
   * resolved once, as the exec tool resolves it for one of its own commands,
   * and every run of it starts inside that boundary.
   */
  setSandbox(sandbox: ExecSandboxRuntime | null): void {
    this.#sandbox = sandbox;
  }

  /**
   * Decides once whether a command line can run: split it as the run will be
   * (strict POSIX words, no shell), refuse an empty or mis-quoted one, ask the
   * command guard, and put it behind the exec sandbox's boundary when the
   * sandbox is on. The argv returned is what every later run starts, so
   * nothing is split, guarded or planned again per tick or per fire. A boundary
   * the plan opens to the network is never widened later by an escalation:
   * nobody is there to answer one when the command runs.
   */
  async admit(command: string): Promise<AutomationCommandAdmission> {
    let argv: string[];
    try {
      argv = shellSplit(command, { strict: true });
    } catch (err) {
      return { admitted: false, reason: `The command could not be parsed: ${summarizeError(err)}. Close the quote or escape the character, then add it again.` };
    }
    if (argv.length === 0) return { admitted: false, reason: 'The command is empty; give it a program to run.' };
    const refusal = this.#guard ? await this.#guard(command) : undefined;
    if (refusal !== undefined) return { admitted: false, reason: `The command was refused by the command policy: ${refusal}` };
    const directory = this.#cwd ?? process.cwd();
    let plan: ExecSandboxPlan | null;
    try {
      const resolved = await resolveRuntimeSandboxPlan(this.#sandbox, command, directory, directory);
      plan = resolved ? withSandboxRuntimes(resolved, directory) : null;
    } catch (err) {
      return { admitted: false, reason: `The sandbox boundary for the command could not be decided: ${summarizeError(err)}. Add it again.` };
    }
    return plan?.sandboxed
      ? { admitted: true, argv: [...plan.argvPrefix, ...argv], sandboxed: true, boundary: plan.boundary }
      : { admitted: true, argv, sandboxed: false };
  }

  /**
   * The credential-env scrub the exec tool uses; registerAllTools passes the
   * same source to both. A function is read at each start, so the owner's
   * setting applies to the next command whichever registry set it.
   */
  setCredentialEnvScrub(config: CredentialEnvScrubConfig | (() => CredentialEnvScrubConfig) | undefined): void {
    if (typeof config === 'function') {
      this.#scrub = () => resolveCredentialEnvScrub(config());
      return;
    }
    const fixed = resolveCredentialEnvScrub(config);
    this.#scrub = () => fixed;
  }

  /** Runs of this kind and key that are starting or running. */
  running(kind: AutomationCommandKind, key: string): number {
    let count = 0;
    for (const run of this.#runs) if (run.kind === kind && run.key === key) count++;
    return count;
  }

  /**
   * Starts one command. The slot is taken before the first await, so a burst of
   * starts for the same key never exceeds `maxInFlight`.
   */
  async start(request: AutomationCommandRequest): Promise<AutomationCommandStart> {
    const { kind, key } = request;
    const running = this.running(kind, key);
    if (running >= request.maxInFlight) return { started: false, reason: 'busy', running, limit: request.maxInFlight };
    const run: Run = { kind, key, proc: null, stopped: false };
    this.#runs.add(run);
    let spawned = false;
    try {
      const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
      const { env } = await scrubCredentialEnv(hostEnv, this.#scrub());
      // stop() ran while the scrub was being read: nothing may start that stop() cannot kill.
      if (run.stopped) return { started: false, reason: 'stopped', message: 'Automation was stopped before the command started.' };
      const spawn = request.spawn ?? Bun.spawn;
      const runEnv: Record<string, string> = { ...env, ...request.env };
      if (request.sandboxed && request.env?.PATH === undefined) runEnv.PATH = `${SANDBOX_RUNTIME_BIN}:${runEnv.PATH ?? '/usr/bin:/bin'}`;
      const proc = spawn([...request.argv], {
        env: runEnv,
        ...(this.#cwd ? { cwd: this.#cwd } : {}),
        stdout: 'ignore',
        stderr: 'ignore',
      });
      spawned = true;
      run.proc = proc;
      let timedOut = false;
      const cancelTimer = request.timeoutMs === undefined ? () => {} : (request.startTimer ?? defaultTimer)(() => {
        timedOut = true;
        try { proc.kill(); } catch { /* already exited */ }
      }, request.timeoutMs);
      proc.exited.then((code) => {
        if (timedOut) logger.warn('Automation command killed after its timeout', { kind, key, pid: proc.pid, timeoutMs: request.timeoutMs });
        else if (code !== 0 && !run.stopped) logger.warn('Automation command exited non-zero', { kind, key, pid: proc.pid, exitCode: code });
        request.onExit?.({ pid: proc.pid, exitCode: proc.signalCode ? null : code, timedOut, at: Date.now() });
      }).catch((err: unknown) => {
        logger.warn('Automation command exit tracking failed', { kind, key, error: summarizeError(err) });
      }).finally(() => {
        cancelTimer();
        this.#runs.delete(run);
      });
      return { started: true, pid: proc.pid };
    } catch (err) {
      return { started: false, reason: 'failed', message: summarizeError(err) };
    } finally {
      if (!spawned) this.#runs.delete(run);
    }
  }

  /** Kills every command of `kind` (all kinds when omitted; only `key`'s runs when given) and cancels any still starting. */
  stop(kind?: AutomationCommandKind, key?: string): void {
    for (const run of [...this.#runs]) {
      if (kind !== undefined && run.kind !== kind) continue;
      if (key !== undefined && run.key !== key) continue;
      run.stopped = true;
      this.#runs.delete(run);
      try { run.proc?.kill(); } catch (err) {
        logger.debug('Automation command kill failed', { kind: run.kind, key: run.key, error: summarizeError(err) });
      }
    }
  }
}
