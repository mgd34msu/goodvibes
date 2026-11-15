/**
 * power/child-hygiene.ts, process hygiene shared by every platform seam that
 * runs its sleep-edge watcher as a long-lived child process (dbus-monitor on
 * Linux, `log stream` on macOS).
 *
 * An exiting process must never leave a watcher parented to init: on Linux an
 * accumulation of orphaned monitors exhausts the system D-Bus broker's
 * per-uid connection quota, and on either platform a leaked watcher is a
 * process nobody will ever stop. Every watcher is registered here, and the
 * PowerManager's process-death hook (manager.ts) stops them all together with
 * the inhibitor children, only when the process is really going down.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Injectable spawner for a power child process so unit tests can drive a
 * seam's spawn/parse/reap contract with a fake child instead of launching a
 * real system tool.
 */
export type SleepWatchSpawner = (command: string, args: readonly string[]) => ChildProcess;

/** The default spawner for a sleep-edge watcher: stdout piped, nothing else. */
export function defaultSleepWatchSpawner(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Injectable process-table seams so the reaper is fixture-testable. */
export interface OrphanReaperDeps {
  /** List candidate processes: pid + full command line. Default: the platform's own process-table scan. */
  readonly listProcesses?: (() => ReadonlyArray<{ pid: number; args: string }>) | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  readonly kill?: ((pid: number) => void) | undefined;
  readonly selfPid?: number | undefined;
}

/** True when `pid` names a live process (EPERM: alive, owned by someone else). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live sleep-edge watcher children spawned in this process. */
const liveSleepWatchers = new Set<ChildProcess>();

/**
 * Stop every sleep-edge watcher this process spawned. Synchronous, so it runs
 * from an 'exit' handler. The PowerManager's process-death hook calls it beside
 * releasing the inhibitors: the one owner of "power children die with us".
 */
export function stopAllSleepWatchers(): void {
  for (const child of liveSleepWatchers) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  liveSleepWatchers.clear();
}

/**
 * Track a freshly spawned watcher child: registers it for the process-death
 * cleanup, and deregisters it when it exits on its own or fails to spawn.
 * Returns the stop function the seam's unsubscribe calls.
 */
export function trackSleepWatcher(child: ChildProcess, onSpawnError: (error: Error) => void): () => void {
  liveSleepWatchers.add(child);
  child.once('error', (error: Error) => {
    liveSleepWatchers.delete(child);
    onSpawnError(error);
  });
  child.once('exit', () => {
    liveSleepWatchers.delete(child);
  });
  child.unref?.();
  return () => {
    liveSleepWatchers.delete(child);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  };
}

/**
 * Split a child's stdout into whole lines: a chunk boundary can fall inside a
 * line, so the tail after the last newline is held until the next chunk.
 */
export function onStdoutLines(child: ChildProcess, onLine: (line: string) => void): void {
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf-8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  // The last line of a stream that ends without a newline is still a line.
  child.stdout?.on('end', () => {
    const tail = pending;
    pending = '';
    if (tail.length > 0) onLine(tail);
  });
  // A broken pipe is the watcher dying; the exit hook deregisters it. An
  // unhandled 'error' event would throw out of the stream instead.
  child.stdout?.on('error', () => { pending = ''; });
}
