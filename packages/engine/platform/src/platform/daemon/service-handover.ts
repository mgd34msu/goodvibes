import { spawn } from 'node:child_process';

/** Accepted means the manager accepted a job, never that its replacement is healthy. */
export interface ServiceHandoverOutcome {
  readonly status: 'accepted' | 'failed' | 'unsupported' | 'unknown';
  readonly detail?: string | undefined;
}

/** A runner must observe command completion, and release its child on abort. */
export type ServiceCommandRunner = (
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<ServiceHandoverOutcome>;

/** How much of a refusing command's stderr is kept: enough for its last few lines. */
const STDERR_TAIL_BYTES = 4096;

/** The command as the owner would type it: the program and the words before the unit name. */
function commandName(argv: readonly string[]): string {
  return argv.filter(word => !word.endsWith('.service')).slice(0, 4).join(' ');
}

/** The service manager's own sentence for a refusal: the last non-empty line it wrote. */
function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0);
  return lines.at(-1)?.slice(0, 300);
}

/** Own both spawn errors (including asynchronous ENOENT) and command completion. */
export function createServiceCommandRunner(spawnChild: typeof spawn = spawn): ServiceCommandRunner {
  return (argv, signal) => new Promise((resolve) => {
    if (signal.aborted) { resolve({ status: 'unknown', detail: 'command cancelled' }); return; }
    let child: ReturnType<typeof spawn>;
    let settled = false;
    // Only the tail is kept: a manager that writes a lot still costs at most this much memory.
    let stderr = '';
    const finish = (outcome: ServiceHandoverOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = (): void => {
      // This is the short-lived manager client, not the service/job it enqueued.
      try { child.kill('SIGKILL'); } catch { /* The child may already have exited. */ }
      finish({ status: 'unknown', detail: 'command cancelled before completion was observed' });
    };
    try {
      child = spawnChild(argv[0]!, argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      child.once('error', (error) => finish({ status: 'failed', detail: error.message }));
      child.once('close', (code, terminationSignal) => {
        const said = lastLine(stderr);
        finish(code === 0
          ? { status: 'accepted' }
          : code === null
            ? { status: 'unknown', detail: `${commandName(argv)} terminated (${terminationSignal ?? 'no exit status'})${said ? `: ${said}` : ''}` }
            : { status: 'failed', detail: `${commandName(argv)} exited ${code}${said ? `: ${said}` : ''}` });
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    } catch (error) {
      finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

export const runServiceCommand: ServiceCommandRunner = createServiceCommandRunner();

/** Bound even an injected runner that ignores cancellation; own late rejections. */
export function observeServiceCommand(
  runner: ServiceCommandRunner,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ServiceHandoverOutcome> {
  if (signal?.aborted) return Promise.resolve({ status: 'unknown', detail: 'handover cancelled' });
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServiceHandoverOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      finish({ status: 'unknown', detail: 'handover cancelled' });
      controller.abort();
    };
    const timer = setTimeout(() => {
      finish({ status: 'unknown', detail: `command timed out after ${timeoutMs}ms` });
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    // Promise.resolve alone would not catch a synchronous runner throw.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return { status: 'unknown' as const, detail: 'handover cancelled' };
      return runner(argv, controller.signal);
    }).then((result) => finish(result ?? { status: 'unknown', detail: 'command returned no outcome' }),
      (error: unknown) => finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }));
  });
}
