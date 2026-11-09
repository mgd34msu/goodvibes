import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions, receiptEnvironmentKey: string): number {
  const spawn =
    options.spawn ??
    ((execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) =>
      spawnSync(execPath, [...argv], { stdio: 'inherit', env }).status);
  const status = spawn(options.execPath, options.argv, {
    ...options.env,
    [receiptEnvironmentKey]: options.fromVersion,
  });
  return status ?? 1;
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
