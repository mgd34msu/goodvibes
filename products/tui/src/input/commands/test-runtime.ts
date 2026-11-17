import { randomUUID } from 'node:crypto';
import { getContractGateTimeoutMs, projectTestCommandMissing, resolveProjectTestCommand } from '@goodvibes-jev/engine/platform/platform/contract';
import type { ToolCall } from '@goodvibes-jev/engine/platform/platform/types';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';

/**
 * The one /test run of a terminal. Esc and Ctrl-C stop it (the terminal's
 * cancel path calls `cancel`), and closing the terminal kills it (`dispose`),
 * so a run never outlives the app that started it.
 */
export class TestRuns {
  private active: AbortController | null = null;
  private disposed = false;

  /** The new run's signal, or null while another run is going or after shutdown. */
  begin(): AbortSignal | null {
    if (this.disposed || this.active !== null) return null;
    this.active = new AbortController();
    return this.active.signal;
  }

  finish(signal: AbortSignal): void {
    if (this.active?.signal === signal) this.active = null;
  }

  /** Stop the running test; true when one was running. */
  cancel(): boolean {
    const active = this.active;
    this.active = null;
    active?.abort();
    return active !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

/** Exit codes with which a POSIX shell says the command itself could not be run (not found, not executable). */
const NOT_STARTED_EXIT_CODES: ReadonlySet<number> = new Set([126, 127]);

/** How often buffered stdout/stderr lines are flushed to the transcript during
 * a run. Batching avoids hammering the transcript.append_one perf budget
 * (6ms, scripts/perf-baseline.json) with one ctx.print() call per output line. */
const STREAM_FLUSH_INTERVAL_MS = 250;

/** Cap on individually-listed failing test file names before truncating. */
const MAX_FAILING_NAMES_SHOWN = 20;

/** Lines of raw output shown when structured results could not be parsed. */
const RAW_TAIL_LINES = 30;

const FAIL_LINE_RE = /^==> (.+?)\s+\[FAIL\]$/gm;
const SUMMARY_LINE_RE = /^Test files: (\d+), passed: (\d+), failed: (\d+)$/m;
// Plain `bun test` output: " N pass" / " N fail" counters (tests, not files),
// "Ran N tests across M files.", and "(fail) suite > name" per failing test.
const BUN_PASS_RE = /^\s*(\d+) pass\s*$/m;
const BUN_FAIL_RE = /^\s*(\d+) fail\s*$/m;
const BUN_FILES_RE = /across (\d+) files?\./;
const BUN_FAIL_TEST_RE = /^\(fail\) (.+)$/gm;

interface ParsedTestResults {
  totalFiles: number;
  passed: number;
  failed: number;
  failingFiles: string[];
  /** Whether passed/failed count files (goodvibes runner) or tests (bun test). */
  unit: 'files' | 'tests';
}

/**
 * Parse this repo's own scripts/run-tests.ts output shape:
 *   per-file:  `==> path/to/file.test.ts  [FAIL]` (only present on failure)
 *   summary:   `Test files: N, passed: P, failed: F`
 * Returns null when the summary line isn't present at all, the fallback
 * path (raw tail, no fabricated counts) covers a different project's
 * jest/vitest/pytest output, or any run that bypassed run-tests.ts.
 */
export function parseTestOutput(output: string): ParsedTestResults | null {
  const summaryMatch = SUMMARY_LINE_RE.exec(output);
  if (summaryMatch) {
    const failingFiles: string[] = [];
    FAIL_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FAIL_LINE_RE.exec(output)) !== null) {
      failingFiles.push(match[1]!);
    }
    return {
      totalFiles: Number(summaryMatch[1]),
      passed: Number(summaryMatch[2]),
      failed: Number(summaryMatch[3]),
      failingFiles,
      unit: 'files',
    };
  }
  // Plain `bun test`: counts are per-test, failing entries are test names.
  const bunPass = BUN_PASS_RE.exec(output);
  const bunFail = BUN_FAIL_RE.exec(output);
  if (bunPass && bunFail) {
    const failingTests: string[] = [];
    BUN_FAIL_TEST_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BUN_FAIL_TEST_RE.exec(output)) !== null) {
      failingTests.push(match[1]!);
    }
    return {
      totalFiles: Number(BUN_FILES_RE.exec(output)?.[1] ?? 0),
      passed: Number(bunPass[1]),
      failed: Number(bunFail[1]),
      failingFiles: failingTests,
      unit: 'tests',
    };
  }
  return null;
}

/** Reads a ReadableStream<Uint8Array> incrementally, decoding and forwarding
 * each chunk of text as it arrives (display-only accumulation happens in the
 * caller; this just pumps the stream to completion). */
async function pumpStream(
  stream: ReadableStream<Uint8Array> | undefined,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  // A grandchild that escaped the process group keeps the pipe open; cancelling
  // the reader lets the run settle instead of waiting for it to exit.
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * Kill the whole test process tree. The shell runs in its own process group
 * (POSIX), so the group signal reaches the runner's per-file children too;
 * Windows has no process groups, so only the shell itself is killed there.
 */
function killTestTree(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      // group already gone; fall through to the single-process kill
    }
  }
  try {
    proc.kill();
  } catch {
    // already exited
  }
}

// Output already written by a killed tree is drained for this long before the
// readers are cancelled, so a process that escaped the group cannot hold the run.
const KILLED_DRAIN_GRACE_MS = 250;

export function registerTestRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'test',
    aliases: [],
    description: 'Run the project test command (the test gate or the package.json test script) and show pass/fail results; Esc stops it',
    usage: '[pattern]',
    argsHint: '[pattern]',
    async handler(args, ctx) {
      await runTestCommand(args, ctx);
    },
  });
}

/**
 * Core /test implementation, factored out of the registered handler so tests
 * can call it directly with a `timeoutMs` override. The command is the
 * project's one test command (contract/gates.ts `resolveProjectTestCommand`);
 * the time limit is `contract.gateTimeoutMs` unless overridden, 0 for none.
 */
export async function runTestCommand(
  args: string[],
  ctx: CommandContext,
  timeoutMs?: number,
): Promise<void> {
  const cwd = requireShellPaths(ctx).workingDirectory;
  const configManager = ctx.platform.configManager;
  const resolved = await resolveProjectTestCommand(cwd, configManager, args);
  if (!resolved) {
    const reason = projectTestCommandMissing(cwd);
    ctx.print(reason);
    ctx.session.conversationManager.addNotice(`[Test] Not run. ${reason}`, { level: 'error' });
    ctx.renderRequest();
    return;
  }
  const limitMs = timeoutMs ?? getContractGateTimeoutMs(configManager);
  const runs = ctx.testRuns;
  const signal = runs ? runs.begin() : new AbortController().signal;
  if (!signal) {
    ctx.print('A test run is already going; Esc stops it, then run /test again.');
    return;
  }
  try {
    await runResolvedTest(resolved.command, resolved.source, args, cwd, limitMs, signal, ctx);
  } finally {
    runs?.finish(signal);
  }
}

async function runResolvedTest(
  command: string,
  source: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  ctx: CommandContext,
): Promise<void> {
  const pattern = args.length > 0 ? args.join(' ') : undefined;
  const toolCall: ToolCall = { id: `test-run-${randomUUID()}`, name: 'test', arguments: pattern ? { pattern } : {} };

  ctx.print(`Running: ${command} (${source}${timeoutMs > 0 ? `, limit ${Math.round(timeoutMs / 1000)}s` : ''}; Esc stops it)`);

  const startedAt = Date.now();
  const proc = Bun.spawn(['/bin/sh', '-c', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });

  let timedOut = false;
  let stopped = false;
  const pumpAbort = new AbortController();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => {
    killTestTree(proc);
    drainTimer ??= setTimeout(() => pumpAbort.abort(), KILLED_DRAIN_GRACE_MS);
    drainTimer.unref?.();
  };
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs) : undefined;
  timer?.unref?.();
  const stop = (): void => {
    stopped = true;
    kill();
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });

  let combinedOutput = '';
  let pendingDisplay = '';
  const appendChunk = (text: string): void => {
    combinedOutput += text;
    pendingDisplay += text;
  };
  const flushDisplay = (force = false): void => {
    if (!pendingDisplay) return;
    if (force) {
      ctx.print(pendingDisplay);
      pendingDisplay = '';
      return;
    }
    const lastNewline = pendingDisplay.lastIndexOf('\n');
    if (lastNewline === -1) return; // no complete line buffered yet
    const toPrint = pendingDisplay.slice(0, lastNewline);
    pendingDisplay = pendingDisplay.slice(lastNewline + 1);
    if (toPrint) ctx.print(toPrint);
  };
  const flushTimer = setInterval(() => flushDisplay(false), STREAM_FLUSH_INTERVAL_MS);

  let exitCode: number;
  try {
    [exitCode] = await Promise.all([
      proc.exited,
      pumpStream(proc.stdout, appendChunk, pumpAbort.signal),
      pumpStream(proc.stderr, appendChunk, pumpAbort.signal),
    ]);
  } catch (error) {
    // A failed pump must not leave the test tree running unattended.
    killTestTree(proc);
    pumpAbort.abort();
    throw error;
  } finally {
    clearTimeout(timer);
    if (drainTimer) clearTimeout(drainTimer);
    clearInterval(flushTimer);
    signal.removeEventListener('abort', stop);
  }

  const durationMs = Date.now() - startedAt;

  if (stopped && !timedOut) {
    flushDisplay(true);
    ctx.print('Test run stopped.');
    ctx.session.conversationManager.logToolResultBlock(toolCall, 'error', 'stopped', durationMs, 'stopped by the owner');
    ctx.session.conversationManager.addNotice('[Test] Stopped before it finished; no result.', { level: 'info' });
    ctx.renderRequest();
    return;
  }

  if (timedOut) {
    flushDisplay(true);
    const timeoutSeconds = Math.round(timeoutMs / 1000);
    ctx.print(`Test run timed out after ${timeoutSeconds}s and was killed. Raise contract.gateTimeoutMs (0 for no limit) or pass a pattern to run fewer tests.`);
    ctx.session.conversationManager.logToolResultBlock(
      toolCall,
      'error',
      'timed out',
      durationMs,
      `timed out after ${timeoutSeconds}s`,
    );
    // Durable end state: logToolResultBlock (above) renders straight into the
    // display-only history buffer and never touches the real message list, so
    // it does not survive the next full rebuildHistory() (which rebuilds
    // strictly from conversationManager.getMessageSnapshot()), the very next
    // dirty render silently wipes it back to how the transcript looked before
    // /test ran. addNotice persists the same content as a real message
    // (same durable pattern as /rewind's confirm notice in
    // checkpoint-runtime.ts) so the timeout outcome survives like any other
    // command's output. The streamed output during the run is allowed to stay
    // transient, only this final state needs to persist.
    ctx.session.conversationManager.addNotice(
      `[Test] Timed out after ${timeoutSeconds}s and was killed.`,
      { level: 'error' }
    );
    ctx.renderRequest();
    return;
  }

  flushDisplay(true);

  if (NOT_STARTED_EXIT_CODES.has(exitCode)) {
    // The shell, not the tests, answered: the command was not found or not executable.
    const shellLine = combinedOutput.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? `exit code ${exitCode}`;
    const reason = `the test command could not be started: ${shellLine}`;
    ctx.session.conversationManager.logToolResultBlock(toolCall, 'error', 'not started', durationMs, reason);
    ctx.session.conversationManager.addNotice(
      `[Test] Not run: ${reason}. Check the command (${source}) or install the tool it names.`,
      { level: 'error' },
    );
    ctx.renderRequest();
    return;
  }

  const ok = exitCode === 0;
  const parsed = parseTestOutput(combinedOutput);

  if (parsed) {
    const summary = parsed.unit === 'files'
      ? `${parsed.passed}/${parsed.totalFiles} files passed`
      : `${parsed.passed} passed, ${parsed.failed} failed${parsed.totalFiles ? ` across ${parsed.totalFiles} file${parsed.totalFiles === 1 ? '' : 's'}` : ''}`;
    const failedNoun = parsed.unit === 'files' ? 'file' : 'test';
    const errorMsg = ok ? undefined : `${parsed.failed} ${failedNoun}${parsed.failed === 1 ? '' : 's'} failed`;
    ctx.session.conversationManager.logToolResultBlock(toolCall, ok ? 'done' : 'error', summary, durationMs, errorMsg);
    const durableLines = [`[Test] ${summary}${errorMsg ? `: ${errorMsg}` : ''}`];
    if (parsed.failingFiles.length > 0) {
      const shown = parsed.failingFiles.slice(0, MAX_FAILING_NAMES_SHOWN);
      const failListHeader = parsed.unit === 'files' ? 'Failing test files:' : 'Failing tests:';
      const lines = [failListHeader, ...shown.map((f) => `  - ${f}`)];
      const remaining = parsed.failingFiles.length - shown.length;
      if (remaining > 0) lines.push(`  ...and ${remaining} more`);
      ctx.print(lines.join('\n'));
      durableLines.push(...lines);
    }
    // See the timeout branch's comment above: logToolResultBlock's tool-styled
    // render is display-only and does not survive the next full history
    // rebuild. addNotice persists the pass/fail summary AND the
    // failing-file detail as a real message so both remain in the transcript
    // after the command completes, not just during the ~1s before the next
    // render wipes the display-only copy.
    ctx.session.conversationManager.addNotice(durableLines.join('\n'), { level: ok ? 'success' : 'error' });
  } else {
    ctx.session.conversationManager.logToolResultBlock(
      toolCall,
      ok ? 'done' : 'error',
      `exit code ${exitCode}`,
      durationMs,
      ok ? undefined : `exit code ${exitCode}`,
    );
    const tail = combinedOutput.split('\n').slice(-RAW_TAIL_LINES).join('\n');
    ctx.print(`(could not parse structured test results; showing raw tail)\n${tail}`);
    ctx.session.conversationManager.addNotice(
      `[Test] exit code ${exitCode} (could not parse structured test results)`,
      { level: ok ? 'info' : 'error' }
    );
  }

  ctx.renderRequest();
}
