/** Process-ending decisions of the standalone daemon host, kept apart from the script that runs at import. */
import type { NativeHandover } from './facade-lifecycle.js';

/**
 * Stops the host once however many signals arrive; later calls wait for the
 * first and keep its exit status.
 */
export function createHostShutdown(
  stop: () => Promise<void>,
  finish: (exitCode: number) => void,
): (exitCode?: number) => Promise<void> {
  let running: Promise<void> | undefined;
  return (exitCode = 0) => running ??= (async () => {
    try { await stop(); } finally { finish(exitCode); }
  })();
}

/**
 * Whether the host still serves after `daemon.start()`. A start that handed the
 * runtime to a replacement leaves this process serving nothing, so it ends with
 * a failure status unless the handover was refused before anything stopped.
 */
export async function settleDaemonStart(
  outcome: void | NativeHandover,
  shutdown: (exitCode?: number) => Promise<void>,
  report: (message: string) => void,
): Promise<'serving' | 'ended'> {
  if (!outcome || outcome.state !== 'handover') return 'serving';
  await outcome.drain;
  if (outcome.resumed?.()) return 'serving';
  report('Daemon startup handed over to a managed replacement; this process serves nothing and is ending.');
  await shutdown(1);
  return 'ended';
}
