import net from 'node:net';
import { spawnSync } from 'node:child_process';
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
  return status ?? 0;
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
