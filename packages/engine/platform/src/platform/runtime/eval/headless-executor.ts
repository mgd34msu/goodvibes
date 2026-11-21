/**
 * The real session behind a task suite: each task's instruction runs as one
 * headless `goodvibes run --output json` in the task's directory, so the eval
 * exercises the shipped program (provider, tools, gate, turn loop) and the
 * task's own verification script decides pass or fail. The run's documented
 * exit codes say whether it finished (docs/exit-codes.md): 0 finished; 124 the
 * timeout stopped it; anything else failed, with the reason from its output.
 */
import { spawn } from 'node:child_process';
import type { TaskSessionExecutor } from './task-suite.js';

export interface HeadlessRunExecutorOptions {
  /** The program and leading arguments to run; defaults to `goodvibes` on PATH. */
  readonly command?: readonly string[] | undefined;
  /** Per-task limit when the task names none, in ms. */
  readonly defaultTimeoutMs?: number | undefined;
  /** Environment for the run; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** The last JSON object the run printed, when it printed one. */
function lastJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(start));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not the start of the final object; keep looking.
    }
  }
  return undefined;
}

/** A task executor that runs each instruction through the headless `goodvibes run`. */
export function createHeadlessRunExecutor(options: HeadlessRunExecutorOptions = {}): TaskSessionExecutor {
  const [program, ...lead] = options.command && options.command.length > 0 ? options.command : ['goodvibes'];
  return (ctx) => new Promise((resolve) => {
    const timeoutMs = ctx.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = [...lead, 'run', '--output', 'json', '--timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, ctx.instruction];
    if (ctx.signal?.aborted) {
      resolve({ completed: false, summary: 'stopped by the owner' });
      return;
    }
    // The owner stopping the suite ends the run with SIGTERM, which it answers by stopping its turn.
    const child = spawn(program!, args, {
      cwd: ctx.taskDir,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(ctx.signal ? { signal: ctx.signal, killSignal: 'SIGTERM' as const } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    // The run stops itself at --timeout; this only ends a run that ignored it.
    const backstop = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 30_000);
    child.on('error', (error) => {
      // An abort reports here as well; the run's own end is awaited on 'close'.
      if (ctx.signal?.aborted) return;
      clearTimeout(backstop);
      resolve({ completed: false, summary: `could not start ${program}: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(backstop);
      if (ctx.signal?.aborted) {
        resolve({ completed: false, summary: 'stopped by the owner' });
        return;
      }
      const result = lastJson(stdout);
      const reported = result?.['stopReason'];
      const stopReason = typeof reported === 'string' ? reported : undefined;
      if (code === 0) {
        resolve({ completed: true, ...(stopReason ? { summary: stopReason } : {}) });
        return;
      }
      const why = code === 124 ? `the run reached its ${timeoutMs} ms limit`
        : signal ? `the run was stopped (${signal})`
          : `the run exited ${code}${stopReason ? ` (${stopReason})` : ''}`;
      const detail = stderr.trim().split('\n').at(-1);
      resolve({ completed: false, summary: detail ? `${why}: ${detail}` : why });
    });
  });
}
