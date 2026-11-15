import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export interface RestartOntoUpdatedBinaryOptions {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The version that performed the update, the restarted process prints it in its receipt line. */
  readonly fromVersion: string;
  /** Injectable so tests observe the restart instead of spawning a process. */
  readonly spawn?: ((execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) => number | null) | undefined;
}
type ProcessExecve = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;

/**
 * Hands this process over to the (just-swapped) binary at execPath with `argv`
 * and the receipt marker in its environment, never on the command line.
 *
 * Where the runtime can replace the process image (`process.execve`, every
 * platform but Windows) it does: one process, the same pid and terminal, so a
 * supervisor's signal reaches the program that runs and nothing waits behind
 * it. Without that, the new program starts on this terminal and the returned
 * 0 lets the caller exit; nothing blocks on the child. A start that fails
 * returns 1 and says why on stderr.
 */
export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions, receiptEnvironmentKey: string): number {
  const env = { ...options.env, [receiptEnvironmentKey]: options.fromVersion };
  if (options.spawn) return options.spawn(options.execPath, options.argv, env) ?? 1;
  const failed = (error: unknown): number => {
    process.stderr.write(`could not start the updated program at ${options.execPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  };
  const execve = process.platform === 'win32' ? undefined : (process as { execve?: ProcessExecve }).execve;
  if (typeof execve === 'function') {
    try { execve.call(process, options.execPath, [options.execPath, ...options.argv], env); } catch (error) { return failed(error); }
  }
  try {
    const child = spawn(options.execPath, [...options.argv], { stdio: 'inherit', env });
    child.once('error', failed);
    child.unref();
    return 0;
  } catch (error) {
    return failed(error);
  }
}
/** Await the replacement's real close, retaining cancellation ownership while
 * the original image waits without starting another graph. */
export async function restartOntoUpdatedBinaryAsync(
  options: Omit<RestartOntoUpdatedBinaryOptions, 'spawn'> & {
    readonly signal: AbortSignal;
    readonly spawn?: ((execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess) | undefined;
  },
  receiptEnvironmentKey: string,
): Promise<number> {
  const { execPath, argv, fromVersion, signal } = options;
  const env = { ...options.env, [receiptEnvironmentKey]: fromVersion };
  const launch = options.spawn ?? ((path: string, args: readonly string[], environment: NodeJS.ProcessEnv) =>
    spawn(path, [...args], { stdio: 'inherit', env: environment }));
  signal.throwIfAborted();
  return await new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try { child = launch(execPath, [...argv], env); } catch (error) { reject(error); return; }
    let error: unknown, aborted = false, escalation: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* Real close/error still owns completion. */ }
      escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Await close. */ } }, 2_000);
      escalation.unref?.();
    };
    child.once('error', failure => { error = failure; });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(escalation); signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else if (aborted) reject(signal.reason);
      else if (code === null) reject(new Error(`Updated process terminated without an exit status (${terminationSignal ?? 'unknown signal'})`));
      else resolve(code);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function probeTcp(
  host: string,
  port: number,
  timeoutMs = 750,
  dialHost: (host: string) => string = (value) => value,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: dialHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
