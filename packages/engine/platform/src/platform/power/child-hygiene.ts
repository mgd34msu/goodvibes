/**
 * power/child-hygiene.ts, process hygiene shared by every platform seam that
 * runs its sleep-edge watcher as a long-lived child process (dbus-monitor on
 * Linux, `log stream` on macOS).
 *
 * An exiting process must never leave a watcher parented to init: on Linux an
 * accumulation of orphaned monitors exhausts the system D-Bus broker's
 * per-uid connection quota, and on either platform a leaked watcher is a
 * process nobody will ever stop. The registry + the once-only exit/signal
 * hooks below guarantee every watcher dies with us, the same discipline the
 * inhibitor children get through the PowerManager's process-exit cleanup.
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
let sleepWatcherExitHooksInstalled = false;

/**
 * Signal listeners that only reap sleep watchers. The inhibitor exit hook
 * (manager.ts) must not count them as a host owning shutdown: they never exit
 * the process themselves, and each would otherwise defer to the other so the
 * signal is swallowed.
 */
const sleepWatcherReapers = new WeakSet<object>();

/** Record `listener` as a watcher-reaping signal listener (see `isSleepWatcherReaper`). */
export function markSleepWatcherReaper<T extends (...args: never[]) => void>(listener: T): T {
  sleepWatcherReapers.add(listener);
  return listener;
}

export function isSleepWatcherReaper(listener: unknown): boolean {
  return typeof listener === 'object' || typeof listener === 'function' ? sleepWatcherReapers.has(listener as object) : false;
}

function killAllSleepWatchers(): void {
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
 * Install process exit + SIGINT/SIGTERM/SIGHUP cleanup for sleep-edge watchers
 * ONCE per process. Mirrors the inhibitor exit-hook shape (see manager.ts): a
 * signal handler kills the watchers and re-raises the signal only when it was
 * the sole listener, so a host application that also handles the signal keeps
 * owning shutdown while this handler stays installed to reap the watchers on
 * every later signal too.
 */
function ensureSleepWatcherExitHooks(): void {
  if (sleepWatcherExitHooksInstalled) return;
  sleepWatcherExitHooksInstalled = true;
  process.on('exit', killAllSleepWatchers);
  installSleepWatcherSignalReapers(process);
}

/** The slice of `process` the signal reapers use (injectable for tests). */
export type SleepWatcherSignalProcess = Pick<NodeJS.Process, 'on' | 'removeListener' | 'listenerCount' | 'kill' | 'pid'>;

export function installSleepWatcherSignalReapers(proc: SleepWatcherSignalProcess): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    const reap = (): void => {
      killAllSleepWatchers();
      // Step aside while deciding: with this listener installed the signal
      // always has one, so only its removal shows whether the host has another.
      proc.removeListener(signal, reap);
      if (proc.listenerCount(signal) === 0) {
        proc.kill(proc.pid, signal);
        return;
      }
      // The host handles the signal and may keep running; a watcher spawned
      // later must still be reaped by the next one.
      proc.on(signal, reap);
    };
    markSleepWatcherReaper(reap);
    proc.on(signal, reap);
  }
}

/**
 * Track a freshly spawned watcher child: installs the process-exit reaper (once),
 * registers the child, and deregisters it when it exits on its own or fails to
 * spawn. Returns the stop function the seam's unsubscribe calls.
 */
export function trackSleepWatcher(child: ChildProcess, onSpawnError: (error: Error) => void): () => void {
  ensureSleepWatcherExitHooks();
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
