import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import { callingAgentId } from '../../agents/calling-agent.js';
import { resolveCredentialEnvScrub, scrubCredentialEnv, type ResolvedCredentialEnvScrub } from '../exec/credential-env.js';
import { withModelCommandMark } from '../exec/model-command-mark.js';

/**
 * ProcessManager, tracks background processes for a single GoodVibes runtime.
 *
 * Extracted from tools/exec/index.ts so that other modules (UI, agent system,
 * live-tail) can query running processes without importing the exec tool.
 */

// ─── BackgroundProcess interface ──────────────────────────────────────────────

export interface BackgroundProcess {
  id: string;
  pid: number;
  cmd: string;
  startTime: number;
  /**
   * Output chunks collected so far. Appended AS THE PROCESS RUNS, not only at
   * exit, so `bg_output` on a still-running process returns what it has printed
   * up to now. It holds the most recent output (a bounded window; see
   * readProcessStream), which is also the tail an on-exit trigger payload carries.
   */
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  done: boolean;
  /**
   * Timestamp (ms since epoch) when SIGKILL was scheduled for termination.
   * Null if the process completed normally or SIGKILL was never scheduled.
   */
  killDeadline: number | null;
  completedAt?: number | undefined;
  /** POSIX signal name that terminated the process, or null if it exited. */
  signal?: string | null | undefined;
  /** True once the process passed its timeout, whether or not it was terminated for it. */
  timedOut?: boolean | undefined;
  /** True when the timeout passed and the process was deliberately left running (kill_on_timeout: false). */
  leftRunningAtTimeout?: boolean | undefined;
  /** The sub-agent whose tool call started this process; absent when the operator or the host started it. */
  startedBy?: string | undefined;
}

const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
/** The most of each stream a managed process keeps in memory; a longer stream's tail starts with a note and is not the whole output. */
export const MANAGED_OUTPUT_WINDOW_BYTES = MAX_PROCESS_OUTPUT_BYTES;
/** A spill file stops growing here; the process keeps running and its output is still drained, but no more is kept. */
const MAX_PROCESS_SPILL_BYTES = 64 * 1024 * 1024;
/**
 * How long to keep draining stdout/stderr AFTER the spawned process has exited.
 *
 * The pipe's write end is inherited by every descendant, so it reaches EOF only
 * once the LAST holder closes it. A command that leaves a child behind, which
 * is any `/bin/sh -c` whose shell did not exec-optimize into a single command,
 * keeps that write end open after the process we spawned is gone, and after a
 * timeout kill that reached only the shell. Waiting for EOF in that case means
 * waiting for the survivor, so the process is never reported finished at all.
 *
 * Exit is therefore what completes a process; this is only the window in which
 * output already in flight is still collected. Normal exits close their pipes
 * at once and never approach it, and output a process wrote before exiting is
 * already in the pipe buffer, so draining it costs microseconds, this bound
 * only decides how long a process whose pipe a survivor holds is delayed
 * before it is reported finished.
 */
const OUTPUT_DRAIN_GRACE_MS = 500;
const MAX_COMPLETED_PROCESSES = 100;
const COMPLETED_PROCESS_TTL_MS = 30 * 60 * 1000;
/** How many expired ids are remembered, so a late `bg_output` hears "finished, output discarded" rather than "unknown". */
const MAX_EXPIRED_PROCESSES = 500;
/** The most one ranged `bg_output` read returns. */
const MAX_OUTPUT_READ_BYTES = MAX_PROCESS_OUTPUT_BYTES;

/** A `bg_output` range: bytes from an offset, or the last N bytes. */
interface OutputRange { readonly from?: number | undefined; readonly tail?: number | undefined }

function parseOutputRange(text: string): OutputRange | string {
  const range: { from?: number; tail?: number } = {};
  for (const part of text.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(from|tail)=(\d+)$/.exec(part);
    if (!match) return `bg_output takes "from=<byte>" or "tail=<bytes>", not "${part}".`;
    range[match[1] as 'from' | 'tail'] = Number(match[2]);
  }
  if (range.from !== undefined && range.tail !== undefined) return 'bg_output takes from= or tail=, not both.';
  return range;
}

/** Reads one range of a stream: from its spill file when it has one, else from the in-memory window (which is then the whole stream). */
function readOutputRange(window: readonly string[], spillPath: string | undefined, range: OutputRange): string {
  let total: number;
  let read: (start: number, length: number) => string;
  let fd: number | undefined;
  if (spillPath) {
    fd = openSync(spillPath, 'r');
    total = fstatSync(fd).size;
    read = (start, length) => {
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) { const n = readSync(fd!, buffer, got, length - got, start + got); if (n === 0) break; got += n; }
      return buffer.subarray(0, got).toString('utf-8');
    };
  } else {
    const whole = Buffer.from(window.join(''), 'utf-8');
    total = whole.length;
    read = (start, length) => whole.subarray(start, start + length).toString('utf-8');
  }
  try {
    const start = range.tail !== undefined ? Math.max(0, total - Math.min(range.tail, MAX_OUTPUT_READ_BYTES)) : Math.min(range.from ?? 0, total);
    const length = Math.min(total - start, range.tail !== undefined ? Math.min(range.tail, MAX_OUTPUT_READ_BYTES) : MAX_OUTPUT_READ_BYTES);
    const text = read(start, length);
    const end = start + length;
    return `[goodvibes: bytes ${start}-${end} of ${total} saved${end < total ? `; continue with from=${end}` : ''}]\n${text}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** An admission check cannot promise to authorize a process after it exists. */
function assertSynchronousAdmission(check: (() => void) | undefined, operation = 'admission'): void {
  assertSynchronousJudgmentGuard(check, () => new Error(`Process ${operation} currentness must be synchronous and return void`));
}

/**
 * A background process started, finished, or was stopped and its record
 * dropped. Published to `observeLifecycle` listeners for host processes the
 * manager spawned (captured boundary executions belong to their authority).
 */
export type ProcessLifecycleEvent =
  | { readonly kind: 'started'; readonly id: string; readonly pid: number; readonly cmd: string; readonly startedBy?: string | undefined }
  | {
    readonly kind: 'finished'; readonly id: string; readonly pid: number;
    readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean;
  }
  | { readonly kind: 'stopped'; readonly id: string; readonly pid: number };

export type ProcessLifecycleListener = (event: ProcessLifecycleEvent) => void;

export interface ProcessInputOptions {
  readonly signal?: AbortSignal | undefined;
  /** Restricts an existing managed pipe; never grants authority to another child. */
  readonly assertCurrent?: (() => void) | undefined;
}

// ─── SpawnOptions ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Native host-owned observer of decoded output. Never supplied by tool args.
   * It runs synchronously; failure terminates this exact managed child. */
  onOutput?: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  /** Trusted per-invocation guard after all asynchronous preparation. */
  beforeSpawn?: (() => void) | undefined;
  /** Cancel admission, including pending credential resolution. Once spawned,
   * the process keeps its declared lifetime; this signal never kills it. */
  signal?: AbortSignal | undefined;
  /** Captured admission authority, rechecked after async preparation and immediately
   * before spawning. Never called to govern an already-running child. */
  assertCurrent?: (() => void) | undefined;
  /** Abort the process if it hasn't completed within this many ms. Omit or use 0 for no deadline. */
  timeout_ms?: number | undefined;
  /** Grace period (ms) between SIGTERM and SIGKILL during termination. Default: 5000. */
  sigterm_grace_ms?: number | undefined;
  /**
   * Whether the timeout watchdog may terminate the process. Default: true.
   *
   * Set false for a process whose lifetime is not the caller's to end, a
   * browser, an editor, a long-running server. `timeout_ms` then bounds only
   * how long a caller waits, and the process keeps running until it is stopped
   * explicitly. Killing such a process on a routine timeout destroys a
   * user-facing application as the default outcome of a normal parameter.
   */
  kill_on_timeout?: boolean | undefined;
  /**
   * End this child when its runtime closes. Defaults to kill_on_timeout (true
   * when omitted), preserving separately owned browser/editor/server lifetimes.
   * Owned POSIX jobs also terminate residual same-group descendants when their
   * leader exits, before reporting done. Opt out for independently owned jobs.
   * Explicit stop still terminates and reaps a child regardless of this setting.
   * Windows owns only direct handles; descendants escaping the group are outside
   * this boundary on every platform.
   */
  kill_on_close?: boolean | undefined;
  /**
   * Start the child in its own session and process group although this runtime
   * does not own its lifetime (`kill_on_close: false`), so closing the terminal
   * or this runtime sends it nothing. An explicit stop still ends the whole group.
   * POSIX only; ignored on Windows.
   */
  own_session?: boolean | undefined;
  /**
   * Credential-bearing env-var scrub applied to the inherited base environment
   * before spawning. Defaults to enabled with an empty allowlist, so a
   * background process is protected even when a caller does not thread config.
   */
  credentialEnvScrub?: ResolvedCredentialEnvScrub | undefined;
  /**
   * Child stdin. Defaults to 'ignore' (closed): a background process has
   * nobody at the keyboard, so a prompt must EOF rather than hang.
   */
  stdin?: 'ignore' | 'pipe' | undefined;
}

// ─── ExecCommandResult subset (for command handler return values) ─────────────

export interface BgCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  process_id?: string | undefined;
  pid?: number | undefined;
}

/** Trusted adapter for an execution boundary which owns its own child/IO.
 * Raw output stays behind its asynchronous authority check, never in sync reads.
 */
export interface OwnedBoundaryExecution {
  readonly owner: object;
  readonly cmd: string;
  readonly includeReadyOutput?: boolean | undefined;
  readonly started: Promise<{ readonly pid: number }>;
  readonly completion: Promise<BgCommandResult & { readonly timed_out?: boolean | undefined; readonly cancelled?: boolean | undefined }>;
  readonly readOutput: () => Promise<BgCommandResult & { readonly denied?: boolean | undefined; readonly cancelled?: boolean | undefined; readonly timed_out?: boolean | undefined }>;
  readonly stop: () => Promise<void>;
}

/** Read-only observation of an actual returned native spawn result. A copied
 * result or supplied process ID cannot acquire another child's lifetime. */
export interface ManagedProcessLifetime {
  readonly processId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly completion: Promise<void>;
  stop(): Promise<void>;
  readStatus(): { readonly running: boolean; readonly exitCode: number | null; readonly signal: string | null;
    readonly timedOut: boolean; readonly stdoutTail: string; readonly stderrTail: string; readonly completedAt?: number | undefined;
    /** The stream passed the in-memory window ({@link MANAGED_OUTPUT_WINDOW_BYTES}): its tail is not the whole output. */
    readonly stdoutOverflowed: boolean; readonly stderrOverflowed: boolean };
}

interface ManagedProcessShutdown {
  readonly killOnClose: boolean;
  stopRequested: boolean;
  stop(): Promise<void>;
  detach(): void;
}

interface ManagedProcessInput {
  readonly entry: BackgroundProcess;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly pipe: Bun.FileSink;
  readonly write: Bun.FileSink['write'];
  readonly flush: Bun.FileSink['flush'];
  readonly shutdown: ManagedProcessShutdown;
}

// ─── ProcessManager ───────────────────────────────────────────────────────────

export class ProcessManager {
  private _counter = 0;
  private readonly _nativeLifetimes = new WeakMap<BgCommandResult, ManagedProcessLifetime>();
  private readonly _boundaryExecutions = new Map<string, OwnedBoundaryExecution>();
  private _processes = new Map<string, BackgroundProcess>();
  private readonly _shutdowns = new Map<string, ManagedProcessShutdown>();
  private readonly _inputs = new Map<string, ManagedProcessInput>();
  /** Private spill directories a large output was written to, removed with the record. */
  private readonly _spills = new Map<string, string[]>();
  /** The spill file of each stream that outgrew its in-memory window; read only by `bg_output` ranges. */
  private readonly _spillFiles = new Map<string, { stdout?: string; stderr?: string }>();
  /** Ids whose records expired, with when the process finished. */
  private readonly _expired = new Map<string, number>();
  private readonly _launches = new Set<Promise<BgCommandResult>>();
  private _closed = false;
  /** Fires when the oldest kept finished record reaches its retention limit; reads never prune. */
  private _pruneTimer: ReturnType<typeof setTimeout> | undefined;
  private _closing: Promise<void> | undefined;
  /** Callers of `whenSettled`, woken when their process finishes or its record goes. */
  private readonly _settledWaiters = new Map<string, Set<() => void>>();
  /** Lifecycle observers (the task list's process adapter). */
  private readonly _lifecycleListeners = new Set<ProcessLifecycleListener>();
  /** Processes announced as started and not yet as finished or stopped, with their pid. */
  private readonly _announced = new Map<string, number>();

  // ─── Private helpers ────────────────────────────────────────────────────────

  private newId(): string {
    return `bg_${++this._counter}_${Date.now()}`;
  }

  private announce(event: ProcessLifecycleEvent): void {
    for (const listener of this._lifecycleListeners) {
      try { listener(event); } catch (error: unknown) {
        logger.warn('Background process lifecycle observer failed', { processId: event.id, kind: event.kind, error: summarizeError(error) });
      }
    }
  }

  /** A record leaving before its process was seen finished: tell observers it was stopped. */
  private announceStopped(id: string): void {
    const pid = this._announced.get(id);
    if (pid === undefined) return;
    this._announced.delete(id);
    this.announce({ kind: 'stopped', id, pid });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Observe host processes starting, finishing and being stopped. Processes
   * started before the listener was added are not replayed (`list()` has them).
   * With no listener nothing is tracked, so an unobserved manager pays nothing.
   */
  observeLifecycle(listener: ProcessLifecycleListener): () => void {
    this._lifecycleListeners.add(listener);
    return () => {
      this._lifecycleListeners.delete(listener);
      if (this._lifecycleListeners.size === 0) this._announced.clear();
    };
  }

  /**
   * Spawn a background process and start collecting its output.
   *
   * @param cmd  Shell command to run via /bin/sh -c.
   * @param cwd  Working directory (undefined = inherit).
   * @param env  Extra env vars merged with the current process env.
   * @param opts Timeout and SIGKILL grace configuration.
   *
   * @returns A BgCommandResult with the process_id and pid, or rejects if
   *          the binary is missing (ENOENT) or exec permission is denied (EACCES).
   */
  async spawn(
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch(['/bin/sh', '-c', cmd], cmd, cwd, env, opts);
  }

  /**
   * Spawn a background process from argv, with NO shell in between.
   *
   * Same tracking, credential-env scrub, live output collection and timeout
   * watchdog as `spawn`, the only difference is that nothing is handed to
   * /bin/sh, so no argument can be reinterpreted as a shell metacharacter.
   * On-exit triggers use this: their command is pre-registered and
   * digest-pinned, and keeping it argv-shaped means the pin covers exactly
   * what runs.
   */
  async spawnArgv(
    command: string,
    args: readonly string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch([command, ...args], [command, ...args].join(' '), cwd, env, opts);
  }

  private launch(
    argv: readonly string[], cmd: string, cwd: string | undefined,
    env: Record<string, string> | undefined, opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    if (this._closed) return Promise.reject(new Error('ProcessManager is closed'));
    const signal = opts?.signal;
    const assertCurrent = opts?.assertCurrent;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<BgCommandResult>((resolve, reject) => {
      let spawned = false;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = (): void => { if (!spawned) finish(() => reject(signal?.reason)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      const launch = this.launchProcess(argv, cmd, cwd, env, opts, signal, assertCurrent, () => {
        spawned = true;
        signal?.removeEventListener('abort', onAbort);
      });
      // Retain the underlying admission until shared credential reads settle,
      // even if its caller cancelled. close() still drains this work.
      this._launches.add(launch);
      void launch.then(
        (result) => { this._launches.delete(launch); finish(() => resolve(result)); },
        (error: unknown) => { this._launches.delete(launch); finish(() => reject(error)); },
      );
    });
  }

  /**
   * Stop admission, terminate/reap owned children and drain output. Previously
   * admitted credential resolutions drain concurrently; shared reads are not
   * cancelled, and close does not resolve before they settle.
   */
  close(): Promise<void> {
    if (this._closing) return this._closing;
    this._closed = true;
    if (this._pruneTimer !== undefined) clearTimeout(this._pruneTimer);
    this._pruneTimer = undefined;
    this._closing = Promise.resolve().then(async () => {
      // No launch may spawn after the closed check, so drain its credential
      // resolution concurrently instead of delaying existing-child termination.
      const launches = Promise.allSettled(this._launches);
      const results = await Promise.allSettled([...this._shutdowns.values()].map((owner) => {
        if (owner.killOnClose || owner.stopRequested) return owner.stop();
        // Keep reading output and observing exit for the external owner:
        // closing its pipes could SIGPIPE a child whose lifetime we do not own.
        owner.detach();
        return Promise.resolve();
      }));
      await launches;
      // The records go with the runtime, so no one can name a spill file again.
      await Promise.all([...this._spills.keys()].map((id) => this.releaseSpills(id)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Background process shutdown failed');
    });
    return this._closing;
  }

  captureProcessLifetime(result: BgCommandResult): ManagedProcessLifetime {
    const original = this._nativeLifetimes.get(result);
    if (!original) throw new Error('Original managed process ownership is unavailable');
    return original;
  }

  private async launchProcess(
    argv: readonly string[],
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
    admissionSignal?: AbortSignal,
    assertAdmissionCurrent?: () => void,
    onSpawned?: () => void,
  ): Promise<BgCommandResult> {
    admissionSignal?.throwIfAborted(); assertSynchronousAdmission(assertAdmissionCurrent);
    admissionSignal?.throwIfAborted();
    const timeoutMs = opts?.timeout_ms ?? 0, outputObserver = opts?.onOutput;
    const sigtermGraceMs = opts?.sigterm_grace_ms ?? 5_000;
    assertTimerRange('timeout_ms', timeoutMs);
    assertTimerRange('sigterm_grace_ms', sigtermGraceMs);
    const killOnTimeout = opts?.kill_on_timeout ?? true;
    const killOnClose = opts?.kill_on_close ?? killOnTimeout;
    // Only runtime-owned commands receive an isolated POSIX session/group.
    // Never send a group signal for a borrowed lifetime or the caller's group.
    const ownsGroup = killOnClose && process.platform !== 'win32';
    // A separately owned job in its own group: never signalled at close, stopped as a group when asked.
    const ownSession = !ownsGroup && opts?.own_session === true && process.platform !== 'win32';

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    // Scrub credential-bearing vars out of the inherited base env before merging
    // the caller-supplied env (an explicit opt-in) on top. Without this, the
    // background spawn would re-introduce every secret from process.env that the
    // foreground scrub already removed.
    const scrub = opts?.credentialEnvScrub ?? resolveCredentialEnvScrub();
    assertSynchronousAdmission(assertAdmissionCurrent); admissionSignal?.throwIfAborted();
    const scrubbedBase = (await scrubCredentialEnv(cleanEnv, scrub)).env;
    assertSynchronousAdmission(assertAdmissionCurrent);
    if (this._closed) throw new Error('ProcessManager is closed');
    admissionSignal?.throwIfAborted();
    // A model's command, marked last so the caller's environment cannot clear it (exec/model-command-mark.ts).
    const mergedEnv = withModelCommandMark({ ...scrubbedBase, ...env });

    const id = this.newId();
    const entry: BackgroundProcess = {
      id,
      pid: 0,
      cmd,
      startTime: Date.now(),
      stdout: [],
      stderr: [],
      exitCode: null,
      done: false,
      killDeadline: null,
      startedBy: callingAgentId(),
    };
    this.pruneCompletedProcesses();
    this._processes.set(id, entry);

    let proc: ReturnType<typeof Bun.spawn>;
    let inputPipe: Bun.FileSink | undefined;
    try {
      const spawnArgv = [...argv];
      const spawnOptions = {
        ...(cwd !== undefined ? { cwd } : {}),
        env: mergedEnv,
        detached: ownsGroup || ownSession,
        // Closed by default. An unattended command that stops to ask for a
        // password gets EOF and fails instead of blocking forever.
        stdin: opts?.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      } as Parameters<typeof Bun.spawn>[1];
      // Caller-owned env/options can have accessors. Recheck after reading
      // them, at the final boundary before an actual process is created.
      assertSynchronousAdmission(assertAdmissionCurrent);
      if (this._closed) throw new Error('ProcessManager is closed');
      admissionSignal?.throwIfAborted();
      assertSynchronousAdmission(opts?.beforeSpawn);
      // The one-shot claim can synchronously revoke or close its owner. Repeat
      // only currentness, then finish on owned state immediately before spawn.
      assertSynchronousAdmission(assertAdmissionCurrent);
      if (this._closed) throw new Error('ProcessManager is closed');
      admissionSignal?.throwIfAborted();
      proc = Bun.spawn(spawnArgv, spawnOptions);
      const stdin = proc.stdin;
      if (spawnOptions?.stdin === 'pipe' && stdin !== null && typeof stdin === 'object') inputPipe = stdin;
      onSpawned?.();
    } catch (spawnErr: unknown) {
      // Surface ENOENT / EACCES immediately, callers should not retry these
      this._processes.delete(id);
      throw spawnErr;
    }

    entry.pid = proc.pid;
    return this.trackChild({
      id, entry, proc, cmd, stdout: proc.stdout as ReadableStream<Uint8Array>, stderr: proc.stderr as ReadableStream<Uint8Array>,
      timeoutMs, sigtermGraceMs, killOnTimeout, killOnClose, ownsGroup, ownSession, outputObserver, inputPipe,
    });
  }

  /**
   * Take over a foreground command that is already running: the exec tool's
   * `until` without `kill_after` hands its child here once the pattern
   * matched. `stdout`/`stderr` carry what the child prints from now on; what
   * it printed so far starts the output window. The child leads its own
   * process group (spawned detached), so it is tracked as a runtime-owned job:
   * `bg_status`, `bg_output` and `bg_stop` reach it, a stop ends its group and
   * closing the runtime ends it. No timeout applies, as for any job started
   * in the background. Throws when the manager is closed; the caller then
   * still owns the child.
   */
  adoptRunning(input: {
    readonly proc: ReturnType<typeof Bun.spawn>;
    readonly cmd: string;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly stdoutSoFar: string;
    readonly stderrSoFar: string;
  }): BgCommandResult {
    if (this._closed) throw new Error('ProcessManager is closed');
    const id = this.newId();
    const entry: BackgroundProcess = {
      id, pid: input.proc.pid, cmd: input.cmd, startTime: Date.now(),
      stdout: input.stdoutSoFar ? [input.stdoutSoFar] : [], stderr: input.stderrSoFar ? [input.stderrSoFar] : [],
      exitCode: null, done: false, killDeadline: null, startedBy: callingAgentId(),
    };
    this.pruneCompletedProcesses();
    this._processes.set(id, entry);
    return this.trackChild({
      id, entry, proc: input.proc, cmd: input.cmd, stdout: input.stdout, stderr: input.stderr,
      timeoutMs: 0, sigtermGraceMs: 5_000, killOnTimeout: true, killOnClose: true,
      ownsGroup: process.platform !== 'win32', ownSession: false, outputObserver: undefined, inputPipe: undefined,
    });
  }

  /** Collects a spawned child's output, observes its exit, and owns its stop, timeout and close. */
  private trackChild(child: {
    readonly id: string;
    readonly entry: BackgroundProcess;
    readonly proc: ReturnType<typeof Bun.spawn>;
    readonly cmd: string;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly timeoutMs: number;
    readonly sigtermGraceMs: number;
    readonly killOnTimeout: boolean;
    readonly killOnClose: boolean;
    readonly ownsGroup: boolean;
    readonly ownSession: boolean;
    readonly outputObserver: SpawnOptions['onOutput'];
    readonly inputPipe: Bun.FileSink | undefined;
  }): BgCommandResult {
    const { id, entry, proc, cmd, timeoutMs, sigtermGraceMs, killOnTimeout, killOnClose, ownsGroup, ownSession, outputObserver, inputPipe } = child;
    if (this._lifecycleListeners.size > 0) {
      this._announced.set(id, proc.pid);
      this.announce({ kind: 'started', id, pid: proc.pid, cmd, startedBy: entry.startedBy });
    }

    // Async collection with timeout escalation, SIGTERM then SIGKILL
    // Cast stdout/stderr to ReadableStream, Bun guarantees these are ReadableStream
    // when stdout/stderr is set to 'pipe', but the return type is a union.
    const drain = new AbortController();
    let processOwner: ManagedProcessShutdown | undefined, observerFailed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let collectedStatus: { exitCode: number; signal: string | null; timedOut: boolean; completedAt: number } | undefined;
    let timedOut = false;
    const publishOutput = (stream: 'stdout' | 'stderr') => (chunk: string): void => {
      if (!outputObserver || observerFailed) return;
      try {
        assertSynchronousJudgmentGuard(() => outputObserver(chunk, stream), () => new Error());
      } catch {
        observerFailed = true;
        void processOwner?.stop().catch(() => logger.warn('Managed output observer child cleanup could not be confirmed', { processId: id }));
        throw new Error('Managed output observer failed');
      }
    };
    const spills: string[] = [];
    this._spills.set(id, spills);
    // A stream spills to a file exactly when it passes the in-memory window.
    let stdoutOverflowed = false, stderrOverflowed = false;
    const spillFailed = (stream: 'stdout' | 'stderr') => (reason: string): void => {
      logger.warn('Background process output could not be saved; later output is kept in memory only', { processId: id, stream, error: reason });
    };
    const streams = Promise.allSettled([
      readProcessStream(child.stdout, entry.stdout, drain.signal, publishOutput('stdout'), spills, undefined,
        (path) => { stdoutOverflowed = true; this._spillFiles.set(id, { ...this._spillFiles.get(id), stdout: path }); }, spillFailed('stdout')),
      readProcessStream(child.stderr, entry.stderr, drain.signal, publishOutput('stderr'), spills, undefined,
        (path) => { stderrOverflowed = true; this._spillFiles.set(id, { ...this._spillFiles.get(id), stderr: path }); }, spillFailed('stderr')),
    ]).then((results) => {
      for (const result of results) if (result.status === 'rejected') {
        logger.warn('Background process output collection ended early', {
          processId: id, error: summarizeError(result.reason),
        });
      }
    });
    let groupStopping: Promise<void> | undefined;
    const stopOwnedGroup = (): Promise<void> => {
      if (!groupStopping) {
        if (ownedGroupExists(proc.pid)) entry.killDeadline = Date.now() + sigtermGraceMs;
        groupStopping = terminateOwnedGroup(proc.pid, sigtermGraceMs);
      }
      return groupStopping;
    };
    const collectionPromise = (async () => {
      const exitCode = await proc.exited;
      // A runtime-owned job does not transfer its descendants when its shell
      // exits. Clean its fresh group now rather than caching a reusable PGID
      // until an arbitrarily later runtime close.
      if (ownsGroup) await stopOwnedGroup();
      // The process we spawned is gone. Collect whatever its pipes still hold,
      // but never block completion on them: a surviving descendant holds the
      // same write end, so EOF may never come. Cancelling the readers releases
      // them instead of leaving a task pending on a pipe nobody will close.
      await settleWithin(streams, OUTPUT_DRAIN_GRACE_MS);
      drain.abort();
      await streams;
      entry.exitCode = exitCode;
      // Bun reports the terminating signal on the handle; capture it so a
      // caller can tell "exited 1" from "killed by SIGKILL", which an on-exit
      // trigger payload has to distinguish.
      entry.signal = readSignalCode(proc);
      entry.done = true;
      entry.completedAt = Date.now();
      collectedStatus = { exitCode, signal: readSignalCode(proc), timedOut, completedAt: entry.completedAt };
      this._inputs.delete(id);
      this.pruneCompletedProcesses();
    })();

    let stopping: Promise<void> | undefined;
    const owner: ManagedProcessShutdown = {
      killOnClose,
      stopRequested: false,
      stop: () => {
        if (stopping) return stopping;
        owner.stopRequested = true;
        clearTimeout(timeoutHandle);
        stopping = (async () => {
          if (ownsGroup || ownSession) {
            await stopOwnedGroup();
          } else if (proc.exitCode === null) {
            killTrackedProcess(proc, 'SIGTERM', id);
            entry.killDeadline = Date.now() + sigtermGraceMs;
            await settleWithin(proc.exited, sigtermGraceMs);
            if (proc.exitCode === null) {
              logger.warn('Background process did not exit after SIGTERM, killing', { processId: id, pid: entry.pid, cmd, timeoutMs, signal: 'SIGKILL' });
              killTrackedProcess(proc, 'SIGKILL', id);
            }
          }
          await collectionPromise;
          this._shutdowns.delete(id);
        })();
        return stopping;
      },
      detach: () => { clearTimeout(timeoutHandle); },
    };
    processOwner = owner;
    this._shutdowns.set(id, owner);
    if (inputPipe) this._inputs.set(id, {
      entry, child: proc, pipe: inputPipe, write: inputPipe.write, flush: inputPipe.flush, shutdown: owner,
    });

    // Timeout opt-outs preserve externally owned lifetimes. Explicit stop and
    // runtime close share one termination sequence, including escalation/reap.
    timeoutHandle = timeoutMs > 0 ? setTimeout(() => {
      if (entry.done) return;
      entry.timedOut = true; timedOut = true;
      if (!killOnTimeout) {
        entry.leftRunningAtTimeout = true;
        logger.info('Background process passed its timeout and was left running', { processId: id, pid: entry.pid, cmd, timeoutMs });
        return;
      }
      logger.warn('Background process timed out, terminating', { processId: id, pid: entry.pid, cmd, timeoutMs, signal: 'SIGTERM', sigtermGraceMs });
      void owner.stop().catch((error: unknown) => {
        logger.warn('Background process termination failed', { processId: id, error: summarizeError(error) });
      });
    }, timeoutMs) : undefined;
    timeoutHandle?.unref?.();
    if (observerFailed) void owner.stop().catch(() => logger.warn('Managed output observer child cleanup could not be confirmed', { processId: id }));

    // Reject the spawn promise if the process errors immediately (ENOENT/EACCES
    // on the child process level), the outer try/catch handles Bun.spawn throws;
    // this handles async failures surfaced via proc.exited rejecting.
    void collectionPromise.catch((error) => {
      logger.warn('Background process output collection failed', { processId: id, error: summarizeError(error) });
      clearTimeout(timeoutHandle);
      drain.abort();
      this._inputs.delete(id);
      if (!ownsGroup) {
        entry.done = true;
        entry.completedAt = Date.now();
        this.pruneCompletedProcesses();
        return;
      }
      // The group's release was not confirmed (the failure may be the group
      // check itself), so the entry stays running, never claimed finished on a
      // guess. owner.stop() replays the same failed group termination, so
      // nothing else would finish it: terminate the group afresh and mark the
      // entry done only once it is confirmed gone.
      void terminateOwnedGroup(proc.pid, sigtermGraceMs).then(() => {
        entry.exitCode = proc.exitCode ?? null; entry.signal = readSignalCode(proc) ?? (proc.exitCode === null ? 'SIGKILL' : null);
        entry.done = true;
        entry.completedAt = Date.now();
        if (this._shutdowns.get(id) === owner) this._shutdowns.delete(id);
        this.pruneCompletedProcesses();
      }).catch((error: unknown) => {
        logger.error('Background process group could not be confirmed gone after output collection failed; it stays listed as running', { processId: id, pid: entry.pid, error: summarizeError(error) });
      });
    });

    // Clear the timeout watchdog once the process completes naturally
    void collectionPromise
      .then(() => {
        clearTimeout(timeoutHandle);
        // Explicit termination may still be returning from its shared drain.
        if (!stopping) this._shutdowns.delete(id);
      })
      .catch((error) => {
        logger.debug('Background process timeout cleanup after failed collection', {
          processId: id,
          error: summarizeError(error),
        });
        clearTimeout(timeoutHandle);
        if (!ownsGroup) this._shutdowns.delete(id);
      });

    const result: BgCommandResult = { cmd, exit_code: null, stdout: '', stderr: '', success: true, process_id: id, pid: proc.pid };
    this._nativeLifetimes.set(result, Object.freeze({ processId: id, pid: proc.pid, startedAt: entry.startTime,
      completion: collectionPromise, stop: () => owner.stop(), readStatus: () => Object.freeze({ running: collectedStatus === undefined,
        exitCode: collectedStatus?.exitCode ?? null, signal: collectedStatus?.signal ?? null, timedOut: collectedStatus?.timedOut ?? timedOut,
        stdoutTail: entry.stdout.join(''), stderrTail: entry.stderr.join(''), stdoutOverflowed, stderrOverflowed,
        ...(collectedStatus === undefined ? {} : { completedAt: collectedStatus.completedAt }) }) }));
    return result;
  }

  /** Adopt an already-contained owned execution without spawning a host process. */
  async trackOwnedBoundary(execution: OwnedBoundaryExecution): Promise<BgCommandResult> {
    if (this._closed) { await execution.stop(); throw new Error('ProcessManager is closed'); }
    const id = `bg_owned_${this.newId().slice(3)}`;
    const entry: BackgroundProcess = {
      id, pid: 0, cmd: execution.cmd, startTime: Date.now(), stdout: [], stderr: [],
      exitCode: null, done: false, killDeadline: null, startedBy: callingAgentId(),
    };
    this._processes.set(id, entry);
    this._boundaryExecutions.set(id, execution);
    const shutdown: ManagedProcessShutdown = {
      killOnClose: true, stopRequested: false,
      stop: async () => {
        shutdown.stopRequested = true;
        try { await execution.stop(); await execution.completion; }
        finally { this._shutdowns.delete(id); }
      },
      detach: () => {}, // Boundary lifetimes are never detached from this runtime.
    };
    this._shutdowns.set(id, shutdown);
    void execution.completion.then((result) => {
      entry.exitCode = result.exit_code;
      entry.timedOut = result.timed_out;
      entry.signal = result.cancelled || result.timed_out || (result.exit_code === null && !result.success) ? 'SIGKILL' : null;
      entry.done = true;
      entry.completedAt = Date.now();
      this._shutdowns.delete(id);
      if (!this._processes.has(id)) this._boundaryExecutions.delete(id);
      this.pruneCompletedProcesses();
    }, () => {
      entry.exitCode = null; entry.signal = 'SIGKILL'; entry.done = true; entry.completedAt = Date.now();
      this._shutdowns.delete(id);
      if (!this._processes.has(id)) this._boundaryExecutions.delete(id);
      this.pruneCompletedProcesses();
    });
    const admission = (async (): Promise<BgCommandResult> => {
      try {
        const readiness = await Promise.race([
          execution.started.then((started) => ({ kind: 'started' as const, started })),
          execution.completion.then((completed) => ({ kind: 'completed' as const, completed })),
        ]);
        if (readiness.kind === 'started') entry.pid = readiness.started.pid;
        if (this._closed) throw new Error('ProcessManager is closed');
        const observed = await execution.readOutput();
        if (readiness.kind === 'completed') {
          this._processes.delete(id); this._boundaryExecutions.delete(id);
          return observed;
        }
        const started = readiness.started;
        if (observed.denied || observed.cancelled || observed.timed_out) {
          await shutdown.stop();
          this._processes.delete(id); this._boundaryExecutions.delete(id);
          return observed;
        }
        return { cmd: execution.cmd, exit_code: null, stdout: execution.includeReadyOutput ? observed.stdout : '', stderr: execution.includeReadyOutput ? observed.stderr : '', success: true, process_id: id, pid: started.pid };
      } catch (error) {
        try { await shutdown.stop(); }
        finally { this._processes.delete(id); this._boundaryExecutions.delete(id); }
        throw error;
      }
    })();
    this._launches.add(admission);
    try { return await admission; } finally { this._launches.delete(admission); }
  }

  /** Await only this authority's active executions before its result is judged. */
  async waitOwnedBoundaries(owner: object, signal?: AbortSignal): Promise<void> {
    while (true) {
      const active = [...this._boundaryExecutions].filter(([id, item]) => item.owner === owner && this._shutdowns.has(id));
      if (active.length === 0) return;
      await executePolicyCheck(() => Promise.all(active.map(([, item]) => item.completion)), signal);
    }
  }

  /** Cancel and reap only this authority before terminal events/view disposal. */
  async stopOwnedBoundaries(owner: object): Promise<void> {
    const active = [...this._boundaryExecutions].filter(([id, item]) => item.owner === owner && this._shutdowns.has(id));
    const results = await Promise.allSettled(active.map(([, item]) => item.stop()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Captured execution shutdown failed');
  }

  /** Authority-scoped bg_* access. Another captured caller cannot inspect/stop it. */
  async handleOwnedBoundaryCommand(cmd: string, owner: object): Promise<BgCommandResult | null> {
    // `bg_output <id> [from=<byte> | tail=<bytes>]`, as for any background process; status and stop take the id alone.
    const match = cmd.match(/^bg_(status|output|stop)\s+(\S+)((?:\s+\S+)*)\s*$/);
    if (cmd.trim() === 'bg_list') {
      const ids = new Set([...this._boundaryExecutions].filter(([, item]) => item.owner === owner).map(([id]) => id));
      for (const id of ids) await this._boundaryExecutions.get(id)?.readOutput();
      return { cmd, exit_code: 0, stdout: JSON.stringify([...this._processes.values()].filter((entry) => ids.has(entry.id)).map((entry) => ({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status: describeProcessStatus(entry), done: entry.done }))), stderr: '', success: true };
    }
    if (!match) return null;
    const id = match[2]!;
    const execution = this._boundaryExecutions.get(id);
    if (!execution || execution.owner !== owner || !this._processes.has(id))
      return { cmd, exit_code: 1, stdout: '', stderr: 'Unknown process in this execution authority', success: false };
    const extra = (match[3] ?? '').trim();
    if (extra.length > 0 && match[1] !== 'output')
      return { cmd, exit_code: 1, stdout: '', stderr: `bg_${match[1]} takes only the process id, not "${extra}".`, success: false };
    const range = parseOutputRange(extra);
    if (typeof range === 'string') return { cmd, exit_code: 1, stdout: '', stderr: range, success: false };
    if (match[1] === 'stop') {
      await execution.stop();
      this._processes.delete(id); this._boundaryExecutions.delete(id);
      return { cmd, exit_code: 0, stdout: `Stopped ${id}`, stderr: '', success: true };
    }
    const output = await execution.readOutput();
    if (match[1] === 'output') {
      if (range.from === undefined && range.tail === undefined) return { ...output, cmd };
      // A captured run keeps its output in memory (no spill file), so the range is read from what it kept.
      return { ...output, cmd, stdout: readOutputRange([output.stdout], undefined, range), stderr: readOutputRange([output.stderr], undefined, range) };
    }
    const entry = this._processes.get(id);
    if (!entry) return { cmd, exit_code: 1, stdout: '', stderr: 'Unknown process in this execution authority', success: false };
    return { cmd, exit_code: 0, stdout: JSON.stringify({ id, pid: entry.pid, cmd: entry.cmd,
      status: describeProcessStatus(entry), exit_code: entry.exitCode, signal: entry.signal ?? null,
      timed_out: entry.timedOut === true, duration_ms: (entry.completedAt ?? Date.now()) - entry.startTime }), stderr: '', success: true };
  }

  /**
   * Resolve once the process has finished or has no record, the time limit has
   * passed, or the signal aborts, whichever is first. Never rejects: the caller
   * reads `getStatus` afterwards to learn which.
   */
  whenSettled(id: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const entry = this._processes.get(id);
    if (!entry || entry.done || timeoutMs <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this._settledWaiters.get(id) ?? new Set<() => void>();
      this._settledWaiters.set(id, waiters);
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        waiters.delete(finish);
        if (waiters.size === 0 && this._settledWaiters.get(id) === waiters) this._settledWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', finish, { once: true });
      waiters.add(finish);
    });
  }

  /** Get the status record for a background process, or undefined if not found. */
  getStatus(id: string): BackgroundProcess | undefined {
    return this._processes.get(id);
  }

  /** Get the accumulated stdout/stderr for a background process. */
  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    const entry = this._processes.get(id);
    if (!entry) return undefined;
    return {
      stdout: entry.stdout.join(''),
      stderr: entry.stderr.join(''),
    };
  }

  /** Write and flush an existing native stdin pipe. Cancellation prevents later
   * operations and a successful receipt; bytes already handed to the child
   * cannot be recalled. This never closes stdin or terminates its process. */
  async writeInput(id: string, data: string, options: ProcessInputOptions = {}): Promise<number> {
    if (typeof data !== 'string') throw new TypeError('Process input must be a string');
    const entry = this._processes.get(id);
    const input = this._inputs.get(id);
    if (!entry) throw new Error(`Unknown process: ${id}`);
    if (!input) throw new Error(`Process stdin pipe is unavailable: ${id}`);
    const signal = options.signal;
    const callerCurrent = options.assertCurrent;
    const { pid, cmd, startTime } = entry;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertSynchronousAdmission(callerCurrent, 'input');
      signal?.throwIfAborted();
      if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new Error('Process input ownership changed');
      if (this._closed) throw new Error('ProcessManager is closed');
      if (this._processes.get(id) !== entry || this._inputs.get(id) !== input || input.entry !== entry
        || this._shutdowns.get(id) !== input.shutdown || entry.id !== id || entry.pid !== pid
        || entry.cmd !== cmd || entry.startTime !== startTime || input.child.pid !== pid
        || entry.done || input.child.exitCode !== null || input.shutdown.stopRequested
        || input.child.stdin !== input.pipe || input.pipe.write !== input.write || input.pipe.flush !== input.flush) {
        throw new Error(`Process input is no longer current: ${id}`);
      }
      signal?.throwIfAborted();
      if (this._closed || this._processes.get(id) !== entry || this._inputs.get(id) !== input
        || input.shutdown.stopRequested) throw new Error(`Process input is no longer current: ${id}`);
    };
    assertCurrent();
    const written = await executePolicyCheck(() => {
      assertCurrent();
      return input.write.call(input.pipe, data);
    }, signal);
    assertCurrent();
    await executePolicyCheck(() => {
      assertCurrent();
      return input.flush.call(input.pipe);
    }, signal);
    assertCurrent();
    return written;
  }

  /**
   * Stop a background process by ID.
   * Returns true if termination was requested, false if unknown. The visible
   * record is removed immediately; close() still drains its owned termination.
   */
  stop(id: string): boolean {
    const entry = this._processes.get(id);
    if (!entry) return false;

    const owner = this._shutdowns.get(id);
    if (owner) void owner.stop().catch((error: unknown) => {
      logger.warn('Background process stop failed', { processId: id, error: summarizeError(error) });
    }).then(() => this.releaseSpills(id));
    else void this.releaseSpills(id);
    if (!entry.done) this.announceStopped(id);
    // Preserve bg_stop's immediate record removal, but retain the owned handle
    // until exit/output collection completes so close() can still drain it.
    this._processes.delete(id);
    this._inputs.delete(id);
    // A pending boundary remains discoverable to its owner's settlement drain.
    if (!this._shutdowns.has(id)) this._boundaryExecutions.delete(id);
    return true;
  }

  /**
   * Stop a background process and wait for its termination to be confirmed. `stop` only requests it and
   * drops the record at once; this says whether the process actually ended, so a caller can report
   * "stopped" truthfully.
   */
  async stopConfirmed(id: string): Promise<'stopped' | 'unconfirmed' | 'unknown'> {
    const entry = this._processes.get(id);
    if (!entry) return 'unknown';
    // Observers hear the stop when it is asked for, not as an exit with the stop signal.
    if (!entry.done) this.announceStopped(id);
    const owner = this._shutdowns.get(id);
    let confirmed = true;
    if (owner) {
      try { await owner.stop(); await this.releaseSpills(id); }
      catch (error: unknown) {
        confirmed = false;
        logger.warn('Background process stop failed', { processId: id, error: summarizeError(error) });
      }
    } else await this.releaseSpills(id);
    this._processes.delete(id);
    this._inputs.delete(id);
    if (!this._shutdowns.has(id)) this._boundaryExecutions.delete(id);
    return confirmed ? 'stopped' : 'unconfirmed';
  }

  /**
   * `handleCommand` for callers that can wait: `bg_stop` answers only after the process is confirmed ended,
   * or says plainly that the stop was requested but not confirmed. Every other command is unchanged.
   */
  async handleCommandAsync(cmd: string): Promise<BgCommandResult | null> {
    const stopMatch = cmd.match(/^bg_stop\s+(\S+)$/);
    if (!stopMatch || this._boundaryExecutions.has(stopMatch[1]!)) return this.handleCommand(cmd);
    const id = stopMatch[1]!;
    const outcome = await this.stopConfirmed(id);
    if (outcome === 'unknown') return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${id}`, success: false };
    if (outcome === 'unconfirmed') {
      return { cmd, exit_code: 1, stdout: '', stderr: `A stop was requested for ${id} but the process did not confirm it ended; it may still be running. Check the host's process list before starting another.`, success: false };
    }
    return { cmd, exit_code: 0, stdout: `Stopped ${id}`, stderr: '', success: true };
  }

  /** Runtime cleanup can distinguish retained boundaries without exposing their owner token. */
  hasBoundaryOwner(id: string): boolean { return this._boundaryExecutions.has(id); }

  /**
   * How many processes `bg_list` would show as running, counted in place: no
   * copy, no prune. Cheap enough for every frame.
   */
  runningCount(): number {
    let running = 0;
    for (const entry of this._processes.values()) if (!entry.done && !this._boundaryExecutions.has(entry.id)) running++;
    return running;
  }

  /** List tracked processes with authoritative completion and display status. */
  list(): Array<{ id: string; pid: number; cmd: string; status: string; done: boolean; startedBy?: string | undefined }> {
    return Array.from(this._processes.values()).map((e) => ({
      id: e.id,
      pid: e.pid,
      cmd: e.cmd,
      status: describeProcessStatus(e),
      done: e.done,
      startedBy: e.startedBy,
    }));
  }

  /**
   * Handle bg_status / bg_output / bg_stop / bg_list special commands.
   * Returns a BgCommandResult if the command was handled, null otherwise.
   */
  handleCommand(cmd: string): BgCommandResult | null {
    const boundaryMatch = cmd.match(/^bg_(?:status|output|stop)\s+(\S+)(?:\s.*)?$/);
    if (boundaryMatch && this._boundaryExecutions.has(boundaryMatch[1]!))
      return { cmd, exit_code: 1, stdout: '', stderr: 'This process requires its captured execution authority', success: false };
    // bg_status <id>
    const statusMatch = cmd.match(/^bg_status\s+(\S+)$/);
    if (statusMatch) {
      const entry = this._processes.get(statusMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: this.unknownProcess(statusMatch[1]!), success: false };
      }
      const status = describeProcessStatus(entry);
      return {
        cmd,
        exit_code: 0,
        stdout: JSON.stringify({
          id: entry.id,
          pid: entry.pid,
          cmd: entry.cmd,
          status,
          exit_code: entry.exitCode,
          signal: entry.signal ?? null,
          timed_out: entry.timedOut === true,
          duration_ms: (entry.completedAt ?? Date.now()) - entry.startTime,
        }),
        stderr: '',
        success: true,
      };
    }

    // bg_output <id> [from=<byte> | tail=<bytes>]
    const outputMatch = cmd.match(/^bg_output\s+(\S+)((?:\s+\S+)*)\s*$/);
    if (outputMatch) {
      const entry = this._processes.get(outputMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: this.unknownProcess(outputMatch[1]!), success: false };
      }
      const range = parseOutputRange(outputMatch[2] ?? '');
      if (typeof range === 'string') return { cmd, exit_code: 1, stdout: '', stderr: range, success: false };
      if (range.from === undefined && range.tail === undefined) {
        return { cmd, exit_code: 0, stdout: entry.stdout.join(''), stderr: entry.stderr.join(''), success: true };
      }
      const files = this._spillFiles.get(entry.id);
      try {
        return {
          cmd,
          exit_code: 0,
          stdout: readOutputRange(entry.stdout, files?.stdout, range),
          stderr: readOutputRange(entry.stderr, files?.stderr, range),
          success: true,
        };
      } catch (error) {
        return { cmd, exit_code: 1, stdout: '', stderr: `The saved output of ${entry.id} could not be read (${summarizeError(error)}); "bg_output ${entry.id}" shows the most recent output.`, success: false };
      }
    }

    // bg_stop <id>
    const stopMatch = cmd.match(/^bg_stop\s+(\S+)$/);
    if (stopMatch) {
      const found = this.stop(stopMatch[1]!);
      if (!found) {
        return { cmd, exit_code: 1, stdout: '', stderr: this.unknownProcess(stopMatch[1]!), success: false };
      }
      return { cmd, exit_code: 0, stdout: `Stop requested for ${stopMatch[1]!}; its termination was signalled and has not been confirmed.`, stderr: '', success: true };
    }

    // bg_list
    if (cmd.trim() === 'bg_list') {
      return { cmd, exit_code: 0, stdout: JSON.stringify(this.list().filter((entry) => !this._boundaryExecutions.has(entry.id))), stderr: '', success: true };
    }

    return null;
  }

  /**
   * Drops finished records past their retention (age or count). Runs where a
   * process starts or finishes, and from a timer set for the moment the oldest
   * kept record expires; no read prunes.
   */
  private pruneCompletedProcesses(now = Date.now()): void {
    // Every path that finishes a process prunes, so this is where observers
    // hear it finished, before an expired record could be dropped below.
    for (const [id, pid] of this._announced) {
      const entry = this._processes.get(id);
      if (entry && !entry.done) continue;
      this._announced.delete(id);
      if (!entry) { this.announce({ kind: 'stopped', id, pid }); continue; }
      this.announce({ kind: 'finished', id, pid, exitCode: entry.exitCode, signal: entry.signal ?? null, timedOut: entry.timedOut === true });
    }
    const completed = [...this._processes.values()]
      .filter((entry) => entry.done)
      .sort((a, b) => (b.completedAt ?? b.startTime) - (a.completedAt ?? a.startTime));
    let oldestKept: number | undefined;
    for (let i = 0; i < completed.length; i++) {
      const entry = completed[i]!;
      const completedAt = entry.completedAt ?? entry.startTime;
      if (now - completedAt <= COMPLETED_PROCESS_TTL_MS && i < MAX_COMPLETED_PROCESSES) {
        oldestKept = completedAt;
        continue;
      }
      this._processes.delete(entry.id);
      this._inputs.delete(entry.id);
      this._boundaryExecutions.delete(entry.id);
      this._expired.set(entry.id, completedAt);
      if (this._expired.size > MAX_EXPIRED_PROCESSES) this._expired.delete(this._expired.keys().next().value!);
      void this.releaseSpills(entry.id);
    }
    if (this._pruneTimer !== undefined) clearTimeout(this._pruneTimer);
    this._pruneTimer = undefined;
    if (oldestKept !== undefined && !this._closed) {
      this._pruneTimer = setTimeout(() => {
        this._pruneTimer = undefined;
        this.pruneCompletedProcesses();
      }, Math.max(0, oldestKept + COMPLETED_PROCESS_TTL_MS + 1 - now));
      this._pruneTimer.unref?.();
    }
    // Every path that finishes a process prunes, so this is where its waiters wake.
    for (const [id, waiters] of this._settledWaiters) {
      const entry = this._processes.get(id);
      if (entry && !entry.done) continue;
      for (const finish of [...waiters]) finish();
    }
  }

  /** An id with no record: one that expired says when it finished and that its output is gone. */
  private unknownProcess(id: string): string {
    const completedAt = this._expired.get(id);
    if (completedAt === undefined) return `Unknown process: ${id}. List the current ones with "bg_list".`;
    return `Process ${id} finished at ${new Date(completedAt).toISOString()}; its record and output were discarded `
      + `(finished processes are kept for ${COMPLETED_PROCESS_TTL_MS / 60_000} minutes, at most ${MAX_COMPLETED_PROCESSES} of them). Run the command again to see its output.`;
  }

  /** Once its record is gone nothing can name the spill file again, so it is removed. */
  private async releaseSpills(id: string): Promise<void> {
    const directories = this._spills.get(id);
    this._spills.delete(id);
    this._spillFiles.delete(id);
    await Promise.all((directories ?? []).map((directory) => rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
      logger.debug('Background output spill directory could not be removed', { processId: id, error: summarizeError(error) });
    })));
  }
}

/**
 * One status line that never claims success it cannot prove: a timed-out or
 * signalled process reads as such rather than as "done (exit null)".
 */
export function describeProcessStatus(entry: BackgroundProcess): string {
  if (!entry.done) return 'running';
  if (entry.timedOut === true && entry.leftRunningAtTimeout !== true) {
    return entry.signal ? `timed out (signal ${entry.signal})` : `timed out (exit ${entry.exitCode})`;
  }
  if (entry.signal) return `killed by ${entry.signal}`;
  return entry.timedOut === true ? `done (exit ${entry.exitCode}; ran past its timeout)` : `done (exit ${entry.exitCode})`;
}

/**
 * Reads the terminating signal off a finished Bun subprocess handle without
 * asserting a shape the runtime does not guarantee.
 */
function readSignalCode(proc: ReturnType<typeof Bun.spawn>): string | null {
  const candidate = (proc as unknown as { signalCode?: unknown }).signalCode;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function killTrackedProcess(proc: ReturnType<typeof Bun.spawn>, signal: Parameters<ReturnType<typeof Bun.spawn>['kill']>[0], id: string): void {
  try {
    proc.kill(signal);
  } catch (error) {
    logger.debug('Background process kill failed; process may already be exited', {
      processId: id,
      signal,
      error: summarizeError(error),
    });
  }
}

/**
 * Drains a child stream into `sink` as chunks arrive, so `bg_output` on a
 * running process and an on-exit trigger's tail see what it printed up to now.
 *
 * `sink` holds the most recent `previewBytes` of the stream: once the stream
 * is longer, the oldest chunks are dropped from the front and `sink[0]` is a
 * one-line note saying how much was left out and how to read it. The complete
 * stream is kept in a private spill file (up to `spillBytes`), which only the
 * process manager reads, for `bg_output <id> from=` and `tail=`; the spill
 * path is reported through `onSpillFile`, never shown to the model.
 */
export async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
  cancelSignal?: AbortSignal,
  onChunk?: (chunk: string) => void,
  spillDirectories?: string[],
  limits: { readonly previewBytes: number; readonly spillBytes: number } = { previewBytes: MAX_PROCESS_OUTPUT_BYTES, spillBytes: MAX_PROCESS_SPILL_BYTES },
  onSpillFile?: (path: string) => void,
  onSpillFailed?: (reason: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let spill: FileHandle | undefined;
  let spilled = 0;
  let spillFull = false;
  // Why saving the output stopped (the spill could not be created, opened or written), once it has.
  let spillFailure: string | undefined;
  // The recent-output window: `held` bytes in sink chunks after the note, `dropped` bytes shifted out.
  let held = 0;
  let dropped = 0;
  const limitNote = (): string => (spillFull ? ` [goodvibes: output limit of ${limits.spillBytes} bytes reached; later output was not saved]` : '')
    + (spillFailure !== undefined ? ` [goodvibes: output could not be saved past this point (${spillFailure}); later output is shown here only]` : '');
  const note = (): string => `[goodvibes: ${dropped} earlier bytes are not shown here; this is the most recent output.`
    + ' Read the saved output with "bg_output <id> from=<byte>" or "bg_output <id> tail=<bytes>".]' + limitNote() + '\n';
  const keep = (text: string): void => {
    if (text.length === 0) return;
    sink.push(text);
    held += Buffer.byteLength(text);
    while (held > limits.previewBytes) {
      const first = dropped > 0 ? 1 : 0;
      // The newest chunk always stays, whatever its size.
      if (sink.length - first <= 1) break;
      const oldest = sink.splice(first, 1)[0]!;
      const bytes = Buffer.byteLength(oldest);
      held -= bytes;
      if (dropped === 0) sink.unshift('');
      dropped += bytes;
    }
    if (dropped > 0) sink[0] = note();
  };
  /**
   * A spill that cannot be created, opened or written ends the saving, never
   * the reading: the handle is closed, the window says so, and the pipe keeps
   * being drained into the window so the child never blocks on a full pipe.
   */
  const stopSaving = async (error: unknown): Promise<void> => {
    if (spillFailure !== undefined) return;
    spillFailure = summarizeError(error);
    const handle = spill;
    spill = undefined;
    try { await handle?.close(); } catch { /* The handle is already unusable; the saving has stopped either way. */ }
    if (dropped > 0) sink[0] = note();
    else sink.push(`${limitNote().trim()}\n`);
    onSpillFailed?.(spillFailure);
  };
  // Writes up to the spill cap, then stops keeping a copy; the window still shows the latest output.
  const writeSpill = async (text: string): Promise<void> => {
    if (!spill || spillFull || text.length === 0) return;
    try {
      const bytes = Buffer.byteLength(text);
      if (spilled + bytes > limits.spillBytes) {
        spillFull = true;
        await spill.writeFile(`\n[goodvibes: output limit of ${limits.spillBytes} bytes reached; later output was not saved]\n`);
        if (dropped > 0) sink[0] = note();
        else sink.push(`${limitNote().trim()}\n`);
        return;
      }
      spilled += bytes;
      await spill.writeFile(text);
    } catch (error) {
      await stopSaving(error);
    }
  };
  let cancellation: Promise<void> | undefined;

  // Abort releases the read loop for a pipe whose write end a surviving
  // descendant still holds; without it the pending read outlives the process.
  const onAbort = (): void => {
    cancellation ??= reader.cancel().catch(() => {
      /* the stream is already gone; nothing to release */
    });
  };
  if (cancelSignal?.aborted === true) onAbort();
  else cancelSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      if (!spill && spillFailure === undefined && total + value.byteLength > limits.previewBytes) {
        try {
          const directory = await mkdtemp(join(tmpdir(), 'goodvibes-process-output-'));
          spillDirectories?.push(directory);
          const path = join(directory, 'output.log');
          spill = await open(path, 'wx', 0o600);
          onSpillFile?.(path);
        } catch (error) {
          await stopSaving(error);
        }
        // Nothing has been dropped yet, so the window is the whole stream so far.
        await writeSpill(sink.join(''));
      }
      if (spill) await writeSpill(decoded);
      keep(decoded);
      total += value.byteLength;
      if (decoded.length > 0) onChunk?.(decoded);
    }
    const tail = decoder.decode();
    if (spill) await writeSpill(tail);
    keep(tail);
    if (tail.length > 0) onChunk?.(tail);
  } finally {
    try { await spill?.close(); }
    finally {
      cancelSignal?.removeEventListener('abort', onAbort);
      try { await cancellation; } finally { reader.releaseLock(); }
    }
  }
}



/** A bounded observation window whose timer never outlives the observed work. */
async function settleWithin(work: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  } finally { clearTimeout(timer); }
}

/** Groups are reachable only for children this manager spawned with detached:true. */
function ownedGroupExists(pid: number): boolean {
  assertOwnedGroupId(pid);
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalOwnedGroup(pid: number, signal: NodeJS.Signals): void {
  assertOwnedGroupId(pid);
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForOwnedGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (ownedGroupExists(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }
  return true;
}

async function terminateOwnedGroup(pid: number, graceMs: number): Promise<void> {
  if (!ownedGroupExists(pid)) return;
  signalOwnedGroup(pid, 'SIGTERM');
  if (await waitForOwnedGroupExit(pid, graceMs)) return;
  logger.warn('Background process group did not exit after SIGTERM, killing', { groupId: pid, signal: 'SIGKILL' });
  signalOwnedGroup(pid, 'SIGKILL');
  // Reap the direct child through its collection promise; orphan descendants
  // are reaped by the OS. Do not claim shutdown if the owned group stays live.
  if (!await waitForOwnedGroupExit(pid, 5_000)) throw new Error(`Owned process group ${pid} remains observable after SIGKILL; cannot verify release`);
}

function assertOwnedGroupId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned process group');
}

function assertTimerRange(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a finite number from 0 to 2147483647 milliseconds`);
  }
}
