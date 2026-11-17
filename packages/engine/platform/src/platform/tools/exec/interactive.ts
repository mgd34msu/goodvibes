import { commitExecPromptAnswer, discardExecPromptAnswer } from '../../runtime/permissions/autonomous-tool-prompts.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { decisionOrClassic } from '../../runtime/decision-policy.js';
/**
 * interactive.ts, PTY-backed prompt-answer path for the exec tool.
 *
 * PROBLEM. All exec spawn paths pipe stdout/stderr and leave stdin unwired, so
 * a child that stops to ask a question (an `ssh` host-key confirmation, a
 * `gh auth login` flow, a `sudo` password ask) hangs until the timeout and the
 * exchange is lost. Many of those prompts are written to and read from the
 * controlling terminal (`/dev/tty`), so even piping stdin would not reach them
 *, the child needs a real PTY.
 *
 * APPROACH. A command with `interactive: true`, and a piped command that
 * failed because it needed a terminal (rerun once, see runtime.ts), run under a PTY allocated by the host's `script(1)`
 * binary (util-linux on Linux, the BSD variant on macOS). The PTY wrapper is
 * nested INSIDE the sandbox argv, `[...sandboxArgv, script, ...]`, so when the
 * per-command bwrap boundary is active it stays the outermost layer and holds
 * unchanged under the PTY. When output goes quiet on an unterminated last
 * line and Jev reads that line as a question waiting for an answer, the
 * pending prompt text is surfaced through the injected `requestPromptAnswer`
 * seam, wired at the composition root to the SAME approval broker as a
 * permission ask, so every surface's existing approval/attention machinery
 * renders it. The typed answer is written to the PTY and the run continues;
 * the full exchange (prompt, echoed answer, subsequent output) lands in the
 * tool result transcript.
 *
 * READINGS. No reading decides whether a command takes the PTY path: that is
 * the caller's `interactive` flag or the failed run's own terminal-required
 * error, so a command starts with no model request. The one reading is
 * `engine.tools.exec-prompt` `awaiting_input` (tools/batteries/exec-prompt.ts):
 * whether a quiet, unterminated last line is a question. Code only
 * supplies the structure: a PTY backend exists, the process is alive, output
 * has been quiet for the window, and the last line has no newline after it.
 * Each quiet tail is read once. A no-echo password read that printed nothing
 * leaves no line to read. A prompt that is never answered (seam unwired,
 * surface ignored it, or the human walked away) ends in the normal timeout,
 * with the detected prompt text reported on the result (`pending_prompt`) so
 * the failure is diagnosable instead of a silent hang. A run with no timeout_ms
 * is stopped once its prompt has stood unanswered for `unansweredPromptLimitMs`. PTY output merges
 * stderr into stdout by nature; interactive results carry the merged
 * transcript in `stdout` and note `pty: true`.
 */

import { spawnSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { sleep } from '../../utils/concurrency.js';
import { killProcessTree } from './process-tree.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '../../gate/judgment-result.js';
import { execPrompt, pendingPromptView } from '../batteries/exec-prompt.js';
import type { ExecCommandInput, ExecCommandResult } from './schema.js';

// ── Availability (honest, probed, never faked) ───────────────────────────────

/** The honest, host-probed availability of the PTY backend. */
export interface PtyAvailability {
  readonly available: boolean;
  readonly backend: 'script' | 'none';
  /** Resolved `script` path when available. */
  readonly scriptPath?: string | undefined;
  /** util-linux (`script -qefc cmd /dev/null`) vs BSD (`script -q /dev/null sh -c cmd`) argv shape. */
  readonly flavor?: 'util-linux' | 'bsd' | undefined;
  /** Stated reason, a diagnosis when unavailable, a one-line summary when available. */
  readonly reason: string;
}

/** Raw host-probe inputs so {@link detectPtyAvailability} stays pure and unit-testable. */
export interface PtyHostProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** Resolved `script` path, or null when not on PATH. */
  readonly scriptPath: string | null;
}

/** Decide PTY availability from a host probe. Pure. */
export function detectPtyAvailability(probe: PtyHostProbe): PtyAvailability {
  if (probe.platform !== 'linux' && probe.platform !== 'darwin') {
    return {
      available: false,
      backend: 'none',
      reason: `exec PTY prompt-answer path unavailable: no script(1) argv shape is wired for platform ${probe.platform}`,
    };
  }
  if (!probe.scriptPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'exec PTY prompt-answer path unavailable: script(1) was not found on PATH',
    };
  }
  return {
    available: true,
    backend: 'script',
    scriptPath: probe.scriptPath,
    flavor: probe.platform === 'linux' ? 'util-linux' : 'bsd',
    reason: `PTY prompt-answer path available via ${probe.scriptPath} (${probe.platform === 'linux' ? 'util-linux' : 'bsd'} flavor)`,
  };
}

/** Probe the real host for a `script` binary. Impure; non-PTY platforms short-circuit. */
export function probePtyHost(): PtyHostProbe {
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { platform, scriptPath: null };
  }
  const resolved = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8', timeout: 5000 });
  const scriptPath = resolved.status === 0 ? resolved.stdout.trim() || null : null;
  return { platform, scriptPath };
}

// ── PTY argv (pure) ───────────────────────────────────────────────────────────

/**
 * Construct the PTY wrapper argv that REPLACES `['/bin/sh','-c',cmd]`. The
 * caller prepends the sandbox argv unchanged, so the boundary (when active)
 * wraps the PTY allocation itself: `[...sandboxArgv, ...buildPtyArgv(...)]`.
 */
export function buildPtyArgv(availability: PtyAvailability, command: string): string[] {
  if (!availability.available || !availability.scriptPath) {
    throw new Error(`buildPtyArgv called without an available PTY backend: ${availability.reason}`);
  }
  if (availability.flavor === 'bsd') {
    return [availability.scriptPath, '-q', '/dev/null', '/bin/sh', '-c', command];
  }
  // util-linux: -q quiet, -e return child exit code, -f flush per write, -c command
  return [availability.scriptPath, '-qefc', command, '/dev/null'];
}

// ── Missing-terminal diagnosis ───────────────────────────────────────────────

const TERMINAL_REQUIRED = /no tty present|\/dev\/tty: No such device or address|cannot open \/dev\/tty|a terminal is required|sudo: a password is required/iu;

/**
 * A plain-language note when a piped (non-PTY) command failed because it needed
 * a controlling terminal, else undefined. Piped foreground commands run in
 * their own session with no terminal, which `sudo`, `ssh` and the like report
 * only with a terse error that reads as a permissions or network failure.
 */
export function terminalRequiredNote(stderr: string): string | undefined {
  if (!TERMINAL_REQUIRED.test(stderr)) return undefined;
  return 'The command needs a terminal and this run has none (it ran with piped output). Rerun it with interactive: true so it gets a terminal and any password or confirmation prompt is put to the user, or use a non-interactive form such as sudo -n (fail instead of asking) or sudo -S (read the password from stdin).';
}

// ── Prompt readings (tools/batteries/exec-prompt.ts) ─────────────────────────

const AWAITING_INPUT_SITE = 'tools.exec.awaiting-input';

/**
 * The unterminated last line of a transcript (no newline after it), or null
 * when the transcript ends on a newline or the last line is blank. This is
 * structure only; whether the line is a question is {@link readPendingPrompt}.
 */
export function pendingPromptLine(transcript: string): string | null {
  if (transcript.length === 0 || transcript.endsWith('\n')) return null;
  const trimmed = transcript.slice(transcript.lastIndexOf('\n') + 1).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The pending prompt of a quiet transcript, or null. Jev reads whether the
 * unterminated last line is a question waiting for an answer. Only an acting
 * yes surfaces it; the complete output remains available to the reading.
 */
export async function readPendingPrompt(command: string, transcript: string, signal?: AbortSignal): Promise<string | null> {
  return decisionOrClassic(() => readDecisionPendingPrompt(command, transcript, signal), () => {
    signal?.throwIfAborted();
    const line = pendingPromptLine(transcript);
    // Present a literal terminal question to the owner; never answer it automatically.
    return line && /(?:[:?]|\[[yYnN/]+\])\s*$/u.test(line) ? line : null;
  });
}

async function readDecisionPendingPrompt(command: string, transcript: string, signal?: AbortSignal): Promise<string | null> {
  snapshotJudgmentInput({ command, transcript });
  const line = pendingPromptLine(transcript);
  if (line === null) return null;
  const recentOutput = transcript.slice(0, transcript.lastIndexOf('\n') + 1);
  const owner = captureJudgmentPort(AWAITING_INPUT_SITE, { signal, prepareResultCapture: prepareJudgmentResult });
  const run = await executePolicyCheck(() => execPrompt.run(owner.port, pendingPromptView(command, line, recentOutput), {
    site: AWAITING_INPUT_SITE,
    signal: owner.signal, beforeAttempt: owner.assertCurrent,
    only: ['awaiting_input'],
  }), signal);
  owner.assertCurrent();
  const awaiting = run.readings.awaiting_input.outcome === 'act' && run.readings.awaiting_input.verdict === 'yes';
  if (run.readings.awaiting_input.outcome === 'act') run.recordAction(awaiting ? 'surfaced pending prompt' : 'not a prompt');
  owner.assertCurrent();
  return awaiting ? line : null;
}

// ── The interaction runtime (seam wired at the composition root) ─────────────

/** A pending prompt surfaced through the approval/attention machinery. */
export interface ExecPromptAsk {
  readonly command: string;
  /** The detected prompt line (the unterminated output tail). */
  readonly prompt: string;
  /** Bounded recent transcript for context (last ~2000 chars). */
  readonly recentOutput: string;
  readonly workingDirectory?: string | undefined;
}

/** The surface's answer. `answered: false` means the ask was declined. */
export interface ExecPromptExecution {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}

export interface ExecPromptAnswer {
  readonly answered: boolean;
  /** The text to feed the waiting child (a trailing newline is appended). */
  readonly text?: string | undefined;
  /** Why a declined prompt was not answered: no person could be asked, or the person declined. */
  readonly declined?: 'unattended' | 'refused' | undefined;
}

/**
 * The resolved interactive context the exec runtime threads per call. Null on
 * a createExecTool with no interactive wiring, then every command runs the
 * unchanged pipe-based path.
 */
export interface ExecInteractionRuntime {
  readonly availability: PtyAvailability;
  /**
   * Broker a pending-prompt answer through the approval broker. Wired at the
   * composition root (see runtime/permissions/exec-prompt-wiring.ts). When
   * absent, prompts are still detected and reported on the result, but cannot
   * be answered.
   */
  readonly requestPromptAnswer?: ((ask: ExecPromptAsk, execution?: ExecPromptExecution) => Promise<ExecPromptAnswer>) | undefined;
  /** Quiet window before an unterminated last line is read as a possible prompt. Default 1200ms. */
  readonly quietWindowMs?: number | undefined;
  /**
   * How long a detected prompt may stand unanswered, with no new output, in a
   * run that set no timeout_ms, before the run is stopped and reported with the
   * prompt. Default 5 minutes. An explicit timeout_ms governs instead.
   */
  readonly unansweredPromptLimitMs?: number | undefined;
}

const DEFAULT_QUIET_WINDOW_MS = 1200;
const DEFAULT_UNANSWERED_PROMPT_LIMIT_MS = 300_000;
const QUIET_POLL_INTERVAL_MS = 150;

/**
 * Whether this command takes the PTY path from the start: only on an explicit
 * `interactive: true`, and only when the host actually has a PTY backend
 * (never faked). Decided in code; no request.
 */
export function shouldRunInteractive(interaction: ExecInteractionRuntime | null, cmdInput: ExecCommandInput): boolean {
  if (!interaction?.availability.available) return false;
  if (cmdInput.background || cmdInput.until) return false;
  return cmdInput.interactive === true;
}

/**
 * Whether a piped run that just failed should be run again, once, under the
 * PTY: it failed with the terminal-required signature, the caller did not
 * force the pipe, and the host has a PTY backend.
 */
export function shouldRerunUnderPty(interaction: ExecInteractionRuntime | null, cmdInput: ExecCommandInput, result: ExecCommandResult): boolean {
  if (!interaction?.availability.available || cmdInput.interactive === false) return false;
  if (cmdInput.background || cmdInput.until || result.success || result.pty || result.denied || result.cancelled) return false;
  return terminalRequiredNote(result.stderr) !== undefined;
}

// ── The interactive runner ────────────────────────────────────────────────────

interface InteractiveRunInput {
  readonly beforeSpawn?: (() => void) | undefined;
  /** Trusted boundary resources and delivery checks; never model arguments. */
  readonly extraStdio?: readonly number[] | undefined;
  readonly beforeOutput?: (() => Promise<void>) | undefined;
  readonly cmdStr: string;
  readonly cwd: string | undefined;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly startTime: number;
  /** Sandbox argv prefix, prepended UNCHANGED so the boundary wraps the PTY. */
  readonly sandboxArgv: readonly string[];
  readonly interaction: ExecInteractionRuntime;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run a command under a PTY with the prompt-answer loop. The transcript
 * (stdout+stderr merged by the PTY) accumulates in `stdout`; each detected
 * prompt is brokered through `requestPromptAnswer` and the answer is written
 * back to the child's terminal. See the module doc for detection limits.
 */
export async function runInteractiveCommand(input: InteractiveRunInput): Promise<ExecCommandResult> {
  const { cmdStr, cwd, env, timeoutMs, startTime, interaction, signal } = input;
  const ptyArgv = buildPtyArgv(interaction.availability, cmdStr);
  const quietWindowMs = interaction.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
  const lifetime = new AbortController();
  const policySignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;

  signal?.throwIfAborted();
  input.beforeSpawn?.();
  const proc = Bun.spawn([...input.sandboxArgv, ...ptyArgv], {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    stdio: ['pipe', 'pipe', 'pipe', ...(input.extraStdio ?? [])],
  } as Parameters<typeof Bun.spawn>[1]);

  let transcript = '';
  let lastDataAt = Date.now();
  let exited = false;
  let timedOut = false;
  let cancelled = false;
  let promptsAnswered = 0;
  let promptDeclined = false;
  let declinedPrompt: { readonly prompt: string; readonly unattended: boolean } | undefined;
  let promptsDropped = 0;
  let pendingPrompt: string | undefined;
  // The transcript length when the prompt was read: output past it means the child went on, so the prompt no longer blocks it.
  let pendingPromptAtLength = 0;
  /** Transcript length at the last brokered ask, re-ask only on NEW output. */
  let askedAtLength = -1;
  let askInFlight = false;
  let stoppedForUnansweredPrompt = false;

  const kill = async (): Promise<void> => {
    lifetime.abort();
    try {
      // Signalling the wrapper alone leaves anything it started (a `nohup`ed
      // grandchild) running; the pty puts them in another session, so the
      // whole tree is walked instead of a process group.
      await killProcessTree(proc.pid);
      proc.kill('SIGKILL');
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] kill failed (process may have exited)', { error: String(err) });
    }
  };

  const killTimer = timeoutMs > 0 ? setTimeout(() => {
    // A cancel that already started the kill owns the outcome.
    if (cancelled) return;
    timedOut = true;
    void kill();
  }, timeoutMs) : undefined;
  killTimer?.unref?.();

  const onAbort = (): void => {
    if (timedOut || cancelled) return;
    cancelled = true;
    clearTimeout(killTimer);
    void kill();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const readStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // PTYs emit CRLF; normalize so transcripts and prompt tails are stable.
        transcript += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        lastDataAt = Date.now();
      }
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] stream read ended with error', { error: summarizeError(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const writeAnswer = (text: string): void => {
    try {
      const stdin = proc.stdin as { write: (chunk: string) => unknown; flush?: () => unknown };
      stdin.write(`${text}\n`);
      stdin.flush?.();
    } catch (err: unknown) {
      logger.warn('[ExecInteractive] failed to write prompt answer to PTY', { error: summarizeError(err) });
    }
  };

  const brokerPrompt = async (prompt: string): Promise<void> => {
    askInFlight = true;
    const expectedTranscript = transcript;
    let outputArrived = false;
    const assertCurrent = () => {
      policySignal.throwIfAborted();
      if (!exited && !timedOut && !cancelled && transcript !== expectedTranscript) outputArrived = true;
      if (exited || timedOut || cancelled || transcript !== expectedTranscript || pendingPromptLine(transcript) !== prompt) throw new Error('Terminal prompt changed before response');
    };
    let answer: ExecPromptAnswer | undefined;
    try {
      await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      answer = await executePolicyCheck(() => interaction.requestPromptAnswer!({
        command: cmdStr,
        prompt,
        recentOutput: transcript.slice(-8000),
        ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
      }, { signal: policySignal, assertCurrent }), policySignal);
      await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      if (exited || timedOut || cancelled) return;
      if (answer.answered && typeof answer.text === 'string') {
        commitExecPromptAnswer(answer, assertCurrent);
        pendingPrompt = undefined;
        promptsAnswered += 1;
        writeAnswer(answer.text);
      } else {
        // Declined: the honest move is to stop the run now, not burn the
        // remaining timeout on a child that will never get its answer.
        promptDeclined = true;
        declinedPrompt = { prompt, unattended: answer.declined === 'unattended' };
        void kill();
      }
    } catch (err: unknown) {
      if (policySignal.aborted) return;
      // The quiet-window watcher reads the new tail and asks again; the result
      // says an answer was lost so the caller is not left guessing.
      if (outputArrived) promptsDropped += 1;
      logger.warn('[ExecInteractive] prompt-answer broker failed; prompt left pending', { error: summarizeError(err) });
    } finally {
      if (answer) discardExecPromptAnswer(answer);
      askInFlight = false;
    }
  };

  // The quiet-window watcher: an unterminated last line + no new output
  // while the child is still alive is read once for whether it is a pending
  // prompt. A reading taken while new output arrived is stale and ignored.
  let readAtLength = -1;
  let judgmentFailure: unknown;
  const watcher = (async (): Promise<void> => {
    while (!exited && !timedOut && !cancelled) {
      await sleep(QUIET_POLL_INTERVAL_MS);
      if (exited || timedOut || cancelled || promptDeclined) continue;
      if (pendingPrompt !== undefined && transcript.length !== pendingPromptAtLength) pendingPrompt = undefined;
      // While the owner is being asked, his answer is what ends the wait; stopping
      // the run then would throw the answer away.
      if (askInFlight) continue;
      // With no timeout_ms nothing else ends a prompt nobody answers.
      if (timeoutMs === 0 && pendingPrompt !== undefined
        && Date.now() - lastDataAt >= (interaction.unansweredPromptLimitMs ?? DEFAULT_UNANSWERED_PROMPT_LIMIT_MS)) {
        stoppedForUnansweredPrompt = true;
        timedOut = true;
        void kill();
        continue;
      }
      if (Date.now() - lastDataAt < quietWindowMs) continue;
      if (transcript.length === readAtLength || pendingPromptLine(transcript) === null) continue;
      const readLength = transcript.length;
      readAtLength = readLength;
      let prompt: string | null;
      try {
        await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
        prompt = await readPendingPrompt(cmdStr, transcript.slice(-8000), policySignal);
        await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      } catch (err: unknown) {
        if (exited || timedOut || cancelled || promptDeclined) return;
        judgmentFailure = err;
        await kill();
        return;
      }
      if (!prompt || transcript.length !== readLength) continue;
      pendingPrompt = prompt;
      pendingPromptAtLength = readLength;
      if (interaction.requestPromptAnswer && transcript.length !== askedAtLength) {
        askedAtLength = transcript.length;
        void brokerPrompt(prompt);
      }
    }
  })();

  const io = Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  const exitCode = await proc.exited;
  exited = true;
  lifetime.abort();
  clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  // Bounded drain, a PTY grandchild can hold the pipe open past the kill.
  await Promise.race([io.then(() => undefined, () => undefined), sleep(500)]);
  await watcher;
  if (judgmentFailure !== undefined) throw judgmentFailure;

  const duration = Date.now() - startTime;
  const base: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: timedOut || cancelled ? null : exitCode,
    stdout: transcript,
    stderr: stoppedForUnansweredPrompt
      ? `Stopped: no timeout_ms was set and the prompt ${JSON.stringify(pendingPrompt)} stayed unanswered (${Math.round((interaction.unansweredPromptLimitMs ?? DEFAULT_UNANSWERED_PROMPT_LIMIT_MS) / 1000)}s with no new output). Answer it by passing input the command can read, or run it again with a timeout_ms.`
      : declinedPrompt
        ? declinedPrompt.unattended
          ? `Stopped: the command asked ${JSON.stringify(declinedPrompt.prompt)} and no one is attached to answer it. Run it again with the value supplied non-interactively (a flag, an environment variable or piped input).`
          : `Stopped: the command asked ${JSON.stringify(declinedPrompt.prompt)} and the answer was declined, so nothing was typed.`
        : '',
    success: !timedOut && !cancelled && !promptDeclined && exitCode === 0,
    duration_ms: duration,
    cwd,
    pty: true,
    ...(promptsAnswered > 0 ? { prompts_answered: promptsAnswered } : {}),
    ...(pendingPrompt !== undefined ? { pending_prompt: pendingPrompt } : {}),
    ...(promptDeclined ? { prompt_declined: true } : {}),
    ...(promptsDropped > 0 ? { prompts_dropped: promptsDropped } : {}),
    ...(timedOut ? { timed_out: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
  return base;
}
